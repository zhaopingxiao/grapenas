// 控制桌面：管理 webpg 桌面控制工具子进程（仅 Windows）
// 原理：webpg 持续截屏以 JPEG 串流推给浏览器，浏览器回传鼠标/键盘事件注入系统。
// 葡萄云把它作为内部子服务拉起，并通过 /desktop 内部代理 + iframe 呈现。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDesktopPath } from './config.js';
import { findPidByPort } from './apps.js';
import { log } from './logger.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_TOOL_PATH = 'D:\\code\\webpg';
const DESKTOP_PORT = 18000;

let child = null;
let token = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function desktopSupported() {
  return process.platform === 'win32';
}

export function desktopToolPath() {
  return getDesktopPath() || DEFAULT_TOOL_PATH;
}

function toolOk() {
  try {
    return fs.existsSync(path.join(desktopToolPath(), 'server.js'));
  } catch {
    return false;
  }
}

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(DESKTOP_PORT, '127.0.0.1');
    s.setTimeout(300);
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
    s.on('error', () => resolve(false));
  });
}

// 内部代理规则（不写入用户代理配置）
export function desktopRule() {
  return { path: '/desktop', port: DESKTOP_PORT };
}

export function desktopStatus() {
  return {
    supported: desktopSupported(),
    toolOk: toolOk(),
    toolPath: desktopToolPath(),
    running: child != null && child.exitCode === null,
    token,
  };
}

export async function startDesktop() {
  if (!desktopSupported()) throw new Error('仅 Windows 系统支持控制桌面');
  if (!toolOk()) throw new Error(`未找到桌面控制工具（${desktopToolPath()}）`);
  if (child && child.exitCode === null && (await portOpen())) {
    return { running: true, token };
  }
  // 清理残留实例（NAS 异常退出后遗留的孤儿进程）
  if (await portOpen()) {
    const pid = findPidByPort(DESKTOP_PORT);
    if (pid != null) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      await sleep(600);
    }
  }
  token = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(path.join(ROOT, 'data', 'logs'), { recursive: true });
  const fd = fs.openSync(path.join(ROOT, 'data', 'logs', 'desktop.log'), 'a');
  child = spawn(
    process.execPath,
    ['server.js', '--host', '127.0.0.1', '--port', String(DESKTOP_PORT), '--token', token],
    {
      cwd: desktopToolPath(),
      detached: false,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    }
  );
  fs.closeSync(fd);
  child.on('exit', (code) => {
    log('info', `桌面控制服务已退出 (code=${code})`);
    child = null;
  });
  child.on('error', (err) => log('error', `桌面控制服务启动失败: ${err.message}`));

  for (let i = 0; i < 40; i++) {
    if (await portOpen()) {
      log('info', '桌面控制服务已启动');
      return { running: true, token };
    }
    await sleep(250);
  }
  throw new Error('桌面控制服务启动超时');
}

export function stopDesktop() {
  if (child && child.exitCode === null) {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  }
  child = null;
}
