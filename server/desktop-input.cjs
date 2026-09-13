"use strict";

const fs = require("fs");
const path = require("path");
const koffi = require("koffi");

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
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

// ------------------------------------------------- 桌面图标识别（拖拽添加用）

const FindWindowW = user32.func("uintptr_t __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)");
const FindWindowExW = user32.func(
  "uintptr_t __stdcall FindWindowExW(uintptr_t hWndParent, uintptr_t hWndChildAfter, str16 lpszClass, str16 lpszWindow)"
);
const EnumWindowsProc = koffi.proto("bool __stdcall EnumWindowsProc(uintptr_t hwnd, intptr_t lParam)");
const EnumWindows = user32.func("bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)");
const WindowFromPoint = user32.func("uintptr_t __stdcall WindowFromPoint(POINT pt)");
const GetWindowThreadProcessId = user32.func(
  "uint32 __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32 *lpdwProcessId)"
);
const ClientToScreen = user32.func("bool __stdcall ClientToScreen(uintptr_t hwnd, _Inout_ POINT *lpPoint)");
const SendMessageTimeoutW = user32.func(
  "uintptr_t __stdcall SendMessageTimeoutW(uintptr_t hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam, uint32 fuFlags, uint32 uTimeout, _Out_ uintptr_t *lpdwResult)"
);
const SHGetFolderPathW = shell32.func(
  "int __stdcall SHGetFolderPathW(uintptr_t hwnd, int csidl, uintptr_t hToken, uint32 dwFlags, _Out_ uint16 *pszPath)"
);

const OpenProcess = kernel32.func(
  "uintptr_t __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)"
);
const VirtualAllocEx = kernel32.func(
  "uintptr_t __stdcall VirtualAllocEx(uintptr_t hProcess, uintptr_t lpAddress, size_t dwSize, uint32 flAllocationType, uint32 flProtect)"
);
const VirtualFreeEx = kernel32.func(
  "bool __stdcall VirtualFreeEx(uintptr_t hProcess, uintptr_t lpAddress, size_t dwSize, uint32 dwFreeType)"
);
const WriteProcessMemory = kernel32.func(
  "bool __stdcall WriteProcessMemory(uintptr_t hProcess, uintptr_t lpBaseAddress, const void *lpBuffer, size_t nSize, void *lpNumberOfBytesWritten)"
);
const ReadProcessMemory = kernel32.func(
  "bool __stdcall ReadProcessMemory(uintptr_t hProcess, uintptr_t lpBaseAddress, void *lpBuffer, size_t nSize, void *lpNumberOfBytesRead)"
);
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(uintptr_t hObject)");

const LVM_FIRST = 0x1000;
const LVM_HITTEST = LVM_FIRST + 18; // 0x1012
const LVM_GETITEMTEXTW = LVM_FIRST + 115; // 0x1073
const LVIF_TEXT = 0x0001;
const SMTO_ABORTIFHUNG = 0x0002;
const PROCESS_VM_ACCESS = 0x0008 | 0x0010 | 0x0020; // OPERATION | READ | WRITE
const MEM_COMMIT_RESERVE = 0x1000 | 0x2000;
const MEM_RELEASE = 0x8000;
const PAGE_READWRITE = 0x04;
const CSIDL_DESKTOPDIRECTORY = 0x0010;
const CSIDL_COMMON_DESKTOPDIRECTORY = 0x0019;

// 桌面图标所在的 ListView（普通情况在 Progman 下；壁纸轮播时在某个 WorkerW 下）
function findDesktopListView() {
  try {
    const progman = FindWindowW("Progman", "Program Manager");
    let defView = progman ? FindWindowExW(progman, 0, "SHELLDLL_DefView", null) : 0;
    if (!defView) {
      EnumWindows((hwnd) => {
        const dv = FindWindowExW(hwnd, 0, "SHELLDLL_DefView", null);
        if (dv) {
          defView = dv;
          return false;
        }
        return true;
      }, 0);
    }
    if (!defView) return 0;
    return FindWindowExW(defView, 0, "SysListView32", "FolderView") || 0;
  } catch (err) {
    return 0;
  }
}

// 桌面文件夹（用户桌面 + 公共桌面），缓存
let desktopDirsCache = null;
function desktopDirs() {
  if (desktopDirsCache) return desktopDirsCache;
  const dirs = [];
  for (const csidl of [CSIDL_DESKTOPDIRECTORY, CSIDL_COMMON_DESKTOPDIRECTORY]) {
    try {
      const buf = Buffer.alloc(520);
      if (SHGetFolderPathW(0, csidl, 0, 0, buf) === 0) {
        const p = buf.toString("utf16le").replace(/\0[\s\S]*$/, "").trim();
        if (p) dirs.push(p);
      }
    } catch (err) {
      /* 忽略单个目录失败 */
    }
  }
  desktopDirsCache = dirs;
  return dirs;
}

function resolveDesktopLnk(name) {
  for (const dir of desktopDirs()) {
    const p = path.join(dir, name + ".lnk");
    try {
      if (fs.existsSync(p)) return p;
    } catch (err) {
      /* 忽略 */
    }
  }
  return null;
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

  // 该屏幕坐标下是否是桌面图标；返回 { name, lnk }（lnk 为 null 表示非 .lnk 文件）
  // 通过向 explorer 的桌面 ListView 发 LVM_HITTEST / LVM_GETITEMTEXTW 实现，
  // 消息里的指针需要落在目标进程内存中，故用 VirtualAllocEx + 读写进程内存。
  desktopIconAt(screenX, screenY) {
    const listview = findDesktopListView();
    if (!listview) return null;
    const pt = { x: Math.round(screenX), y: Math.round(screenY) };
    if (Number(WindowFromPoint(pt)) !== Number(listview)) return null;

    const origin = { x: 0, y: 0 };
    if (!ClientToScreen(listview, origin)) return null;
    const clientX = pt.x - origin.x;
    const clientY = pt.y - origin.y;

    const pidOut = [0];
    GetWindowThreadProcessId(listview, pidOut);
    const pid = pidOut[0];
    if (!pid) return null;
    const hProc = OpenProcess(PROCESS_VM_ACCESS, false, pid);
    if (!hProc) return null;

    let remote = 0;
    try {
      remote = Number(VirtualAllocEx(hProc, 0, 1024, MEM_COMMIT_RESERVE, PAGE_READWRITE));
      if (!remote) return null;
      const resultBuf = Buffer.alloc(8);

      // 1) 命中测试：LVHITTESTINFO { POINT pt; UINT flags; int iItem; ... }
      const hitBuf = Buffer.alloc(24);
      hitBuf.writeInt32LE(clientX, 0);
      hitBuf.writeInt32LE(clientY, 4);
      if (!WriteProcessMemory(hProc, remote, hitBuf, 24, null)) return null;
      SendMessageTimeoutW(listview, LVM_HITTEST, 0, remote, SMTO_ABORTIFHUNG, 1000, resultBuf);
      const hitBack = Buffer.alloc(24);
      if (!ReadProcessMemory(hProc, remote, hitBack, 24, null)) return null;
      const index = hitBack.readInt32LE(12);
      if (index < 0) return null;

      // 2) 取图标文字：LVITEMW 与文本缓冲都放目标进程
      const itemRemote = remote + 128;
      const textRemote = remote + 256;
      const lvitem = Buffer.alloc(88);
      lvitem.writeUInt32LE(LVIF_TEXT, 0);
      lvitem.writeInt32LE(index, 4);
      lvitem.writeInt32LE(0, 8);
      lvitem.writeBigUInt64LE(BigInt(textRemote), 24);
      lvitem.writeInt32LE(260, 32);
      if (!WriteProcessMemory(hProc, itemRemote, lvitem, 88, null)) return null;
      SendMessageTimeoutW(listview, LVM_GETITEMTEXTW, index, itemRemote, SMTO_ABORTIFHUNG, 1000, resultBuf);
      const textBuf = Buffer.alloc(520);
      if (!ReadProcessMemory(hProc, textRemote, textBuf, 520, null)) return null;
      const name = textBuf.toString("utf16le").replace(/\0[\s\S]*$/, "").trim();
      if (!name) return null;

      return { name, lnk: resolveDesktopLnk(name) };
    } catch (err) {
      return null;
    } finally {
      try {
        if (remote) VirtualFreeEx(hProc, remote, 0, MEM_RELEASE);
      } catch (err) {
        /* 忽略 */
      }
      CloseHandle(hProc);
    }
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
};
