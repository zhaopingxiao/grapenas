"use strict";

const fs = require("fs");
const path = require("path");
const koffi = require("koffi");

const user32 = koffi.load("user32.dll");
const shell32 = koffi.load("shell32.dll");

// Make this process DPI-aware so cursor coordinates match the physical
// pixels reported by the screen capture (important on Hi-DPI displays).
const SetProcessDPIAware = user32.func("bool __stdcall SetProcessDPIAware()");
try {
  SetProcessDPIAware();
} catch (err) {
  /* already set or unavailable */
}

const { Monitor } = require("node-screenshots");
const sharp = require("sharp");

// ---------------------------------------------------------------- Win32 input

const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
  dx: "int32",
  dy: "int32",
  mouseData: "uint32",
  dwFlags: "uint32",
  time: "uint32",
  dwExtraInfo: "uintptr_t",
});
const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
  wVk: "uint16",
  wScan: "uint16",
  dwFlags: "uint32",
  time: "uint32",
  dwExtraInfo: "uintptr_t",
});
const HARDWAREINPUT = koffi.struct("HARDWAREINPUT", {
  uMsg: "uint32",
  wParamL: "uint16",
  wParamH: "uint16",
});
const INPUT_UNION = koffi.union("INPUT_UNION", {
  mi: MOUSEINPUT,
  ki: KEYBDINPUT,
  hi: HARDWAREINPUT,
});
const INPUT = koffi.struct("INPUT", { type: "uint32", u: INPUT_UNION });
const INPUT_SIZE = koffi.sizeof(INPUT);

const SetCursorPos = user32.func("bool __stdcall SetCursorPos(int x, int y)");
const POINT = koffi.struct("POINT", { x: "int32", y: "int32" });
const CURSORINFO = koffi.struct("CURSORINFO", {
  cbSize: "uint32",
  flags: "uint32",
  hCursor: "uintptr_t",
  ptScreenPos: POINT,
});
const GetCursorInfo = user32.func("bool __stdcall GetCursorInfo(_Inout_ CURSORINFO *pci)");
const LoadCursorW = user32.func("uintptr_t __stdcall LoadCursorW(void *hInstance, intptr_t lpCursorName)");

// 标准光标句柄 → 形状名（用于网页端渲染相同形状的光标）
const STANDARD_CURSORS = {
  arrow: 32512,
  ibeam: 32513,
  wait: 32514,
  crosshair: 32515,
  uparrow: 32516,
  sizenwse: 32642,
  sizenesw: 32643,
  sizewe: 32644,
  sizens: 32645,
  sizeall: 32646,
  no: 32648,
  hand: 32649,
  appstarting: 32650,
  help: 32651,
};
const cursorShapeMap = new Map();
for (const [name, id] of Object.entries(STANDARD_CURSORS)) {
  try {
    const handle = LoadCursorW(null, id);
    if (handle) {
      const key = String(handle);
      // appstarting（后台运行+等待）与 help 归入相近形状
      if (!cursorShapeMap.has(key)) {
        cursorShapeMap.set(key, name === "appstarting" ? "wait" : name === "help" ? "arrow" : name);
      }
    }
  } catch {
    /* 忽略加载失败 */
  }
}
const SendInput = user32.func(
  "uint32 __stdcall SendInput(uint32 nInputs, const INPUT *pInputs, int cbSize)"
);
const VkKeyScanW = user32.func("int16 __stdcall VkKeyScanW(uint16 ch)");

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_XDOWN = 0x0080;
const MOUSEEVENTF_XUP = 0x0100;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;

const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;

const WHEEL_DELTA = 120;

function sendMouseInput(flags, mouseData = 0) {
  SendInput(
    1,
    [
      {
        type: INPUT_MOUSE,
        u: {
          mi: {
            dx: 0,
            dy: 0,
            mouseData: mouseData >>> 0,
            dwFlags: flags,
            time: 0,
            dwExtraInfo: 0,
          },
        },
      },
    ],
    INPUT_SIZE
  );
}

const BUTTON_FLAGS = {
  left: [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
  right: [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
  middle: [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP],
  x1: [MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP],
  x2: [MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP],
};
const XBUTTON_DATA = { x1: 1, x2: 2 };

// Keys that must be sent with the extended-key flag.
const EXTENDED_VKS = new Set([
  0x21, // PageUp
  0x22, // PageDown
  0x23, // End
  0x24, // Home
  0x25, // ArrowLeft
  0x26, // ArrowUp
  0x27, // ArrowRight
  0x28, // ArrowDown
  0x2c, // PrintScreen
  0x2d, // Insert
  0x2e, // Delete
  0x5d, // ContextMenu
  0x6f, // NumpadDivide
  0x90, // NumLock
  0xa3, // ControlRight
  0xa5, // AltRight
]);

const VK_MAP = {};
for (let i = 0; i < 26; i++) VK_MAP[`Key${String.fromCharCode(65 + i)}`] = 65 + i;
for (let i = 0; i < 10; i++) {
  VK_MAP[`Digit${i}`] = 48 + i;
  VK_MAP[`Numpad${i}`] = 96 + i;
}
for (let i = 1; i <= 24; i++) VK_MAP[`F${i}`] = 0x6f + i;
Object.assign(VK_MAP, {
  Backquote: 0xc0,
  Minus: 0xbd,
  Equal: 0xbb,
  BracketLeft: 0xdb,
  BracketRight: 0xdd,
  Backslash: 0xdc,
  Semicolon: 0xba,
  Quote: 0xde,
  Comma: 0xbc,
  Period: 0xbe,
  Slash: 0xbf,
  IntlBackslash: 0xe2,
  Escape: 0x1b,
  Tab: 0x09,
  CapsLock: 0x14,
  Enter: 0x0d,
  Backspace: 0x08,
  Space: 0x20,
  Insert: 0x2d,
  Delete: 0x2e,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  PrintScreen: 0x2c,
  ScrollLock: 0x91,
  Pause: 0x13,
  NumLock: 0x90,
  ContextMenu: 0x5d,
  NumpadMultiply: 0x6a,
  NumpadAdd: 0x6b,
  NumpadSubtract: 0x6d,
  NumpadDecimal: 0x6e,
  NumpadDivide: 0x6f,
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
});

function vkFromChar(char) {
  if (typeof char !== "string" || char.length !== 1) return null;
  const result = VkKeyScanW(char.charCodeAt(0));
  if (result === -1) return null;
  return result & 0xff || null;
}

// ------------------------------------------------- 桌面快捷方式列表

const SHGetFolderPathW = shell32.func(
  "int __stdcall SHGetFolderPathW(uintptr_t hwnd, int csidl, uintptr_t hToken, uint32 dwFlags, _Out_ uint16 *pszPath)"
);

const CSIDL_DESKTOPDIRECTORY = 0x0010;
const CSIDL_COMMON_DESKTOPDIRECTORY = 0x0019;

// 取桌面文件夹路径（用户桌面 / 公用桌面），缓存
const desktopDirCache = new Map();
function desktopDir(csidl) {
  if (desktopDirCache.has(csidl)) return desktopDirCache.get(csidl);
  let result = null;
  try {
    const buf = Buffer.alloc(520);
    if (SHGetFolderPathW(0, csidl, 0, 0, buf) === 0) {
      const p = buf.toString("utf16le").replace(/\0[\s\S]*$/, "").trim();
      if (p) result = p;
    }
  } catch (err) {
    /* 忽略 */
  }
  desktopDirCache.set(csidl, result);
  return result;
}

// 列出用户桌面 + 公用桌面中的所有 .lnk 快捷方式
function listDesktopShortcuts() {
  const items = [];
  const seen = new Set();
  const scopes = [
    { scope: "user", csidl: CSIDL_DESKTOPDIRECTORY },
    { scope: "common", csidl: CSIDL_COMMON_DESKTOPDIRECTORY },
  ];
  for (const { scope, csidl } of scopes) {
    const dir = desktopDir(csidl);
    if (!dir) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".lnk")) continue;
      const lnk = path.join(dir, entry.name);
      const key = lnk.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ name: entry.name.replace(/\.lnk$/i, ""), lnk, scope });
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return items;
}

class InputController {
  move(nx, ny, region) {
    const x = Math.round(region.left + Number(nx) * (region.width - 1));
    const y = Math.round(region.top + Number(ny) * (region.height - 1));
    SetCursorPos(x, y);
  }

  // 读取系统光标位置与形状，位置换算为该区域内的归一化坐标；visible 表示是否在区域内
  cursorInfo(region) {
    const ci = { cbSize: koffi.sizeof(CURSORINFO) };
    if (!GetCursorInfo(ci)) return null;
    const rawNx = (ci.ptScreenPos.x - region.left) / Math.max(1, region.width - 1);
    const rawNy = (ci.ptScreenPos.y - region.top) / Math.max(1, region.height - 1);
    const shape = cursorShapeMap.get(String(ci.hCursor)) || "arrow";
    return {
      nx: Math.min(Math.max(rawNx, 0), 1),
      ny: Math.min(Math.max(rawNy, 0), 1),
      shape,
      visible: rawNx >= 0 && rawNx <= 1 && rawNy >= 0 && rawNy <= 1,
    };
  }

  pressButton(name) {
    const flags = BUTTON_FLAGS[name];
    if (!flags) return;
    sendMouseInput(flags[0], XBUTTON_DATA[name] || 0);
  }

  releaseButton(name) {
    const flags = BUTTON_FLAGS[name];
    if (!flags) return;
    sendMouseInput(flags[1], XBUTTON_DATA[name] || 0);
  }

  scroll(clicksX, clicksY) {
    if (clicksX) sendMouseInput(MOUSEEVENTF_HWHEEL, clicksX * WHEEL_DELTA);
    if (clicksY) sendMouseInput(MOUSEEVENTF_WHEEL, clicksY * WHEEL_DELTA);
  }

  keyDown(vk) {
    this._key(vk, false);
  }

  keyUp(vk) {
    this._key(vk, true);
  }

  releaseKeys(vks) {
    for (const vk of vks) {
      try {
        this._key(vk, true);
      } catch (err) {
        /* ignore */
      }
    }
  }

  _key(vk, up) {
    let flags = up ? KEYEVENTF_KEYUP : 0;
    if (EXTENDED_VKS.has(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
    SendInput(
      1,
      [
        {
          type: INPUT_KEYBOARD,
          u: {
            ki: { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
          },
        },
      ],
      INPUT_SIZE
    );
  }
}

// -------------------------------------------------------------- screen capture

class ScreenGrabber {
  constructor() {
    this.monitors = [];
    this.refresh();
  }

  refresh() {
    this.monitors = Monitor.all().map((monitor, index) => ({
      id: index,
      name: monitor.name() || `显示器 ${index + 1}`,
      x: monitor.x(),
      y: monitor.y(),
      width: monitor.width(),
      height: monitor.height(),
      primary: monitor.isPrimary(),
      monitor,
    }));
  }

  list() {
    return this.monitors.map(({ id, name, width, height }) => ({
      id,
      name: name || `显示器 ${id + 1}`,
      width,
      height,
    }));
  }

  region(index) {
    const monitor = this.monitors[index] || this.monitors[0];
    if (!monitor) return { left: 0, top: 0, width: 0, height: 0 };
    return {
      left: monitor.x,
      top: monitor.y,
      width: monitor.width,
      height: monitor.height,
    };
  }

  async grabJpeg(index, quality, scale) {
    const monitor = this.monitors[index] || this.monitors[0];
    if (!monitor) throw new Error("no monitor available");
    const image = await monitor.monitor.captureImage();
    const raw = await image.toRaw();
    let width = image.width;
    let height = image.height;
    let pipeline = sharp(raw, {
      raw: { width, height, channels: 4 },
    });
    if (scale && scale < 1) {
      width = Math.max(1, Math.round(image.width * scale));
      height = Math.max(1, Math.round(image.height * scale));
      pipeline = pipeline.resize(width, height, { fit: "fill" });
    }
    const data = await pipeline
      .jpeg({ quality: Math.round(quality) })
      .toBuffer();
    return { data, width, height, region: this.region(index) };
  }
}

module.exports = {
  ScreenGrabber,
  InputController,
  VK_MAP,
  vkFromChar,
  listDesktopShortcuts,
};
