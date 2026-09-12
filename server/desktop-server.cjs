#!/usr/bin/env node
/**
 * Web Desktop - view and control this computer's desktop from a browser.
 *
 * Usage:
 *   node server.js                       # random access token
 *   node server.js --token mysecret      # fixed access token
 *   node server.js --port 9000 --fps 20  # custom port and frame rate
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const { ScreenGrabber, InputController, VK_MAP, vkFromChar } = require("./desktop-input.cjs");

const STATIC_DIR = path.join(__dirname, "..", "web", "desktop");

const DEFAULTS = {
  monitor: 0,
  quality: 70,
  fps: 30,
  scale: 1.0,
  mode: "window", // desktop=整个桌面 / window=单独窗口（默认）
};

// 枚举桌面应用（桌面快捷方式 + 开始菜单快捷方式）
function listApps() {
  const dirs = [
    path.join(os.homedir(), "Desktop"),
    "C:\\Users\\Public\\Desktop",
    path.join(process.env.APPDATA || "", "Microsoft\\Windows\\Start Menu\\Programs"),
    "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  ];
  const apps = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) walk(full, depth + 1);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".lnk")) continue;
      const name = entry.name.replace(/\.lnk$/i, "");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      apps.push({ name, lnk: full });
    }
  };
  for (const dir of dirs) walk(dir, 0);
  apps.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return apps;
}

// 系统窗口标题黑名单（不显示在启动台）
const SYSTEM_TITLES = [
  "program manager",
  "windows input experience",
  "microsoft text input application",
  "windows 输入体验",
  "设置",
];

const grabber = new ScreenGrabber();
const input = new InputController();

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseArgs(argv) {
  const args = {
    host: "0.0.0.0",
    port: 8000,
    token: null,
    monitor: DEFAULTS.monitor,
    quality: DEFAULTS.quality,
    fps: DEFAULTS.fps,
    scale: DEFAULTS.scale,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`缺少参数值: ${arg}`);
      return argv[++i];
    };
    switch (arg) {
      case "--host":
        args.host = next();
        break;
      case "--port":
        args.port = parseInt(next(), 10);
        break;
      case "--token":
        args.token = next();
        break;
      case "--monitor":
        args.monitor = parseInt(next(), 10);
        break;
      case "--quality":
        args.quality = parseInt(next(), 10);
        break;
      case "--fps":
        args.fps = parseInt(next(), 10);
        break;
      case "--scale":
        args.scale = parseFloat(next());
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        console.error(`未知参数: ${arg}`);
        args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(
    [
      "usage: node server.js [options]",
      "",
      "options:",
      "  --host HOST        bind address (default 0.0.0.0)",
      "  --port PORT        bind port (default 8000)",
      "  --token TOKEN      access token (default: random)",
      "  --monitor INDEX    initial monitor index (default 0)",
      "  --quality QUALITY  JPEG quality 10-95 (default 70)",
      "  --fps FPS          target frames per second 1-60 (default 30)",
      "  --scale SCALE      stream scale 0.2-1.0 (default 1.0)",
      "  -h, --help         show this help",
    ].join("\n")
  );
}

function localIPs() {
  const result = new Set();
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === "IPv4" && !info.internal) result.add(info.address);
    }
  }
  return [...result].sort();
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.settings = { ...DEFAULTS };
    this.region = grabber.region(this.settings.monitor);
    this.pressedKeys = new Set();
    this.pressedButtons = new Set();
    this.scrollAcc = [0, 0];
    this.ackResolve = null;
    this.frames = 0;
    this.lastStats = performance.now();
    this.closed = false;
    this.cursorTimer = 0;
    this.activeHwnd = null;
  }

  // 启动台列表：桌面应用 + 已打开窗口（按名称匹配），已打开的带 hwnd
  listLauncher() {
    const windows = input
      .listWindows()
      .filter((w) => !SYSTEM_TITLES.includes(w.title.toLowerCase()));
    const apps = listApps();
    const used = new Set();
    const entries = [];
    for (const app of apps) {
      const lower = app.name.toLowerCase();
      const match = windows.find((w) => !used.has(w.hwnd) && w.title.toLowerCase().includes(lower));
      if (match) used.add(match.hwnd);
      entries.push({
        name: app.name,
        lnk: app.lnk,
        hwnd: match ? match.hwnd : null,
        minimized: match ? match.minimized : false,
      });
    }
    for (const w of windows) {
      if (!used.has(w.hwnd)) {
        entries.push({ name: w.title, lnk: null, hwnd: w.hwnd, minimized: w.minimized });
      }
    }
    return entries;
  }

  // 当前光标推送区域：桌面模式=显示器，窗口模式=活动窗口（无窗口返回 null）
  cursorRegion() {
    if (this.settings.mode !== "window") return this.region;
    if (!this.activeHwnd) return null;
    const rect = input.windowRect(this.activeHwnd);
    if (!rect) return null;
    return { left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
  }

  // 光标位置/形状主动推送（比客户端轮询少一个请求往返，延迟更低）
  startCursorPush() {
    this.stopCursorPush();
    this.cursorTimer = setInterval(() => {
      if (this.closed) return;
      const region = this.cursorRegion();
      if (!region) return;
      const info = input.cursorInfo(region);
      if (info) {
        this.sendJson({ t: "cursor", nx: info.nx, ny: info.ny, shape: info.shape, visible: info.visible });
      }
    }, 50);
  }

  stopCursorPush() {
    if (this.cursorTimer) {
      clearInterval(this.cursorTimer);
      this.cursorTimer = 0;
    }
  }

  start() {
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (err) {
        return;
      }
      try {
        this.handle(message);
      } catch (err) {
        /* ignore bad input */
      }
    });
    this.ws.on("close", () => this.cleanup());
    this.ws.on("error", () => this.cleanup());
    this.startCursorPush();
    this.loop().catch(() => this.cleanup());
  }

  sendJson(message) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  handle(message) {
    switch (message.t) {
      case "ack":
        if (this.ackResolve) this.ackResolve();
        break;
      case "ping":
        this.sendJson({ t: "pong", ts: message.ts });
        break;
      case "mouse":
        this.handleMouse(message);
        break;
      case "key":
        this.handleKey(message);
        break;
      case "settings":
        this.handleSettings(message);
        break;
      case "mode": {
        const mode = message.mode === "desktop" ? "desktop" : "window";
        this.settings.mode = mode;
        this.activeHwnd = null;
        this.sendJson({ t: "mode", mode });
        break;
      }
      case "windows.list":
        this.sendJson({ t: "windows", apps: this.listLauncher() });
        break;
      case "window.show": {
        const hwnd = Number(message.hwnd);
        if (input.windowExists(hwnd) && input.showWindow(hwnd)) {
          this.activeHwnd = hwnd;
          this.sendJson({ t: "window-shown", hwnd });
        } else {
          this.sendJson({ t: "window-gone", hwnd });
        }
        break;
      }
      case "window.minimize": {
        const hwnd = Number(message.hwnd != null ? message.hwnd : this.activeHwnd);
        input.minimizeWindow(hwnd);
        if (this.activeHwnd === hwnd) this.activeHwnd = null;
        this.sendJson({ t: "windows", apps: this.listLauncher() });
        break;
      }
      case "window.close": {
        const hwnd = Number(message.hwnd != null ? message.hwnd : this.activeHwnd);
        input.closeWindow(hwnd);
        if (this.activeHwnd === hwnd) this.activeHwnd = null;
        this.sendJson({ t: "window-closed", hwnd });
        break;
      }
      case "window.launch": {
        const lnk = String(message.lnk || "");
        if (!lnk.toLowerCase().endsWith(".lnk") || !fs.existsSync(lnk)) {
          this.sendJson({ t: "error", message: "应用快捷方式不存在" });
          break;
        }
        try {
          spawn("cmd", ["/c", "start", "", lnk], { windowsHide: true, detached: true }).unref();
          this.sendJson({ t: "launch-ok" });
        } catch (err) {
          this.sendJson({ t: "error", message: "启动失败: " + err.message });
        }
        break;
      }
      case "cursor": {
        const region = this.cursorRegion();
        const pos = region ? input.cursorInfo(region) : null;
        if (pos) {
          this.sendJson({ t: "cursor", nx: pos.nx, ny: pos.ny, shape: pos.shape, visible: pos.visible });
        }
        break;
      }
      default:
        break;
    }
  }

  waitAck(timeout) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ackResolve = null;
        resolve();
      }, timeout);
      this.ackResolve = () => {
        clearTimeout(timer);
        this.ackResolve = null;
        resolve();
      };
    });
  }

  async loop() {
    this.sendJson({
      t: "hello",
      monitors: grabber.list(),
      settings: { ...this.settings },
      version: "1.0",
    });
    while (!this.closed && this.ws.readyState === WebSocket.OPEN) {
      const started = performance.now();
      // 单独窗口模式：没有活动窗口时不发送画面（启动台由前端渲染）
      if (this.settings.mode === "window" && !this.activeHwnd) {
        await sleep(120);
        continue;
      }
      let crop = null;
      if (this.settings.mode === "window" && this.activeHwnd) {
        const rect = input.windowRect(this.activeHwnd);
        if (!rect || rect.minimized) {
          this.sendJson({ t: "window-gone", hwnd: this.activeHwnd });
          this.activeHwnd = null;
          await sleep(120);
          continue;
        }
        crop = {
          left: rect.left - this.region.left,
          top: rect.top - this.region.top,
          width: rect.right - rect.left,
          height: rect.bottom - rect.top,
        };
      }
      let frame;
      try {
        frame = await grabber.grabJpeg(
          this.settings.monitor,
          this.settings.quality,
          this.settings.scale,
          crop
        );
      } catch (err) {
        try {
          grabber.refresh();
        } catch (refreshErr) {
          /* ignore */
        }
        await sleep(500);
        continue;
      }
      this.region = frame.region;
      const captureMs = performance.now() - started;

      const ack = this.waitAck(Math.max(500, 4000 / this.settings.fps));
      this.ws.send(frame.data, { binary: true });
      await ack;

      this.frames += 1;
      const now = performance.now();
      if (now - this.lastStats >= 1000) {
        this.sendJson({
          t: "stats",
          fps: Number(
            (this.frames / ((now - this.lastStats) / 1000)).toFixed(1)
          ),
          capture_ms: Number(captureMs.toFixed(1)),
          width: frame.width,
          height: frame.height,
          monitor: this.settings.monitor,
        });
        this.frames = 0;
        this.lastStats = now;
      }

      const elapsed = performance.now() - started;
      await sleep(Math.max(0, 1000 / this.settings.fps - elapsed));
    }
    this.cleanup();
  }

  handleMouse(message) {
    const action = message.a;
    const region = this.cursorRegion() || this.region;
    if (action === "move") {
      input.move(message.x, message.y, region);
    } else if (action === "down") {
      const button = message.b || "left";
      input.move(message.x, message.y, region);
      input.pressButton(button);
      this.pressedButtons.add(button);
    } else if (action === "up") {
      const button = message.b || "left";
      input.move(message.x, message.y, region);
      input.releaseButton(button);
      this.pressedButtons.delete(button);
    } else if (action === "scroll") {
      const factor = { 0: 1.0, 1: 33.0, 2: 800.0 }[message.mode] || 1.0;
      this.scrollAcc[0] += Number(message.dx || 0) * factor;
      this.scrollAcc[1] += Number(message.dy || 0) * factor;
      const clicksX = Math.trunc(this.scrollAcc[0] / 100);
      const clicksY = Math.trunc(-this.scrollAcc[1] / 100);
      if (clicksX || clicksY) {
        this.scrollAcc[0] -= clicksX * 100;
        this.scrollAcc[1] += clicksY * 100;
        input.scroll(clicksX, clicksY);
      }
    }
  }

  handleKey(message) {
    const code = message.code || "";
    const key = message.key || "";
    let vk = VK_MAP[code];
    if (vk === undefined && typeof key === "string" && key.length === 1) {
      vk = vkFromChar(key);
    }
    if (vk === undefined || vk === null) return;
    if (message.a === "down") {
      input.keyDown(vk);
      this.pressedKeys.add(vk);
    } else {
      input.keyUp(vk);
      this.pressedKeys.delete(vk);
    }
  }

  handleSettings(message) {
    const s = this.settings;
    if (message.quality !== undefined) {
      s.quality = clamp(parseInt(message.quality, 10) || DEFAULTS.quality, 10, 95);
    }
    if (message.fps !== undefined) {
      s.fps = clamp(parseInt(message.fps, 10) || DEFAULTS.fps, 1, 60);
    }
    if (message.scale !== undefined) {
      s.scale = clamp(parseFloat(message.scale) || DEFAULTS.scale, 0.2, 1.0);
    }
    if (message.monitor !== undefined) {
      const count = grabber.monitors.length;
      s.monitor = clamp(parseInt(message.monitor, 10) || 0, 0, Math.max(0, count - 1));
    }
  }

  cleanup() {
    if (this.closed) return;
    this.closed = true;
    this.stopCursorPush();
    if (this.ackResolve) this.ackResolve();
    input.releaseKeys(this.pressedKeys);
    for (const button of this.pressedButtons) {
      try {
        input.releaseButton(button);
      } catch (err) {
        /* ignore */
      }
    }
    this.pressedKeys.clear();
    this.pressedButtons.clear();
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const token = args.token || crypto.randomBytes(6).toString("base64url");
  const defaults = {
    monitor: clamp(args.monitor, 0, Math.max(0, grabber.monitors.length - 1)),
    quality: clamp(args.quality, 10, 95),
    fps: clamp(args.fps, 1, 60),
    scale: clamp(args.scale, 0.2, 1.0),
  };
  Object.assign(DEFAULTS, defaults);

  const app = express();
  app.use("/static", express.static(STATIC_DIR));
  app.get("/", (req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    let provided = "";
    try {
      provided = new URL(req.url, "http://localhost").searchParams.get("token") || "";
    } catch (err) {
      provided = "";
    }
    if (!token || !safeEqual(provided, token)) {
      ws.send(JSON.stringify({ t: "error", message: "访问令牌无效" }));
      ws.close(4003);
      return;
    }
    new Session(ws).start();
  });

  const banner = [
    "",
    "=".repeat(56),
    " Web Desktop (Node.js) 已启动，在浏览器中打开下面的地址：",
    `   本机:   http://127.0.0.1:${args.port}/?token=${token}`,
  ];
  for (const ip of localIPs()) {
    banner.push(`   局域网: http://${ip}:${args.port}/?token=${token}`);
  }
  banner.push(
    ` 访问令牌: ${token}`,
    " 按 Ctrl+C 停止服务",
    "=".repeat(56),
    ""
  );
  console.log(banner.join("\n"));

  server.listen(args.port, args.host, () => {
    /* listening */
  });
  server.on("error", (err) => {
    console.error(`启动失败: ${err.message}`);
    process.exit(1);
  });

  const shutdown = () => {
    for (const client of wss.clients) {
      try {
        client.close(1001);
      } catch (err) {
        /* ignore */
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
