// 配置持久化（data/config.json）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const PORT = 9643;

// 葡萄云所有内置路径都挂在这个前缀下：/grapenas/ws、/grapenas/api/...、/grapenas/style.css
// 只有壳页面本身留在 /（方便直接打开站点根）。应用与手动反向代理挂在根下 /<路径>，
// 因此应用 id 与代理路径不能再叫 grapenas。
export const BASE_PATH = '/grapenas';

// 免访问码前缀：应用用 config.json 的 nocodeport 声明的 Web 服务代理到 /nocode/<应用id>，
// 这一路径下的请求（含 WebSocket）不校验访问码，方便别的设备直接打开。
export const NOCODE_PREFIX = '/nocode';

export function isNoCodePath(p) {
  const s = String(p == null ? '' : p);
  return s === NOCODE_PREFIX || s.startsWith(NOCODE_PREFIX + '/');
}

// 登录 cookie 的 Path 用站点根：壳页面在 "/"，若把 cookie 限定在 BASE_PATH，
// 浏览器访问 "/" 时不会带上它，会出现"登录成功 -> 跳 / -> 又弹回登录页"的死循环。
export const COOKIE_PATH = '/';

// 给站内绝对路径加上前缀：withBase('/api') -> '/grapenas/api'
// 系统保留的路径段：应用 id / 手动代理路径不能占用（grapenas 是内置前缀，nocode 是免访问码段）
export const RESERVED_SEGMENTS = ['grapenas', 'nocode'];

export function isReservedSegment(seg) {
  return RESERVED_SEGMENTS.includes(String(seg == null ? '' : seg).toLowerCase());
}

export function withBase(p) {
  const s = String(p == null ? '' : p);
  if (!s.startsWith('/')) return BASE_PATH + '/' + s;
  return s === '/' ? BASE_PATH + '/' : BASE_PATH + s;
}

const config = {
  accessCodeHash: null,
  accessCodeSalt: null,
  storagePath: null, // 存储位置（我的文件 user/ 与 应用数据 .package/）
  themeMode: 'dark', // 背景模式：dark / light
  themePair: 'purple', // 主题配色对：purple / blue / orange / yellow / mono
  proxies: [], // 反向代理规则: [{ path: '/opencode', port: 4096, app?: '<应用id>', nocode?: true }]
  apps: [], // 应用: [{ id, name, command, ports: [], nocodeport?: 端口 }]
  shortcuts: [], // 桌面快捷方式: [{ id, name, lnk }]
};

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return;
  let raw;
  try {
    // 剥掉 UTF-8 BOM：用记事本「另存为 UTF-8」会带上它，JSON.parse 会直接失败
    raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    Object.assign(config, JSON.parse(raw));
  } catch (err) {
    // 配置损坏时**绝不能用默认配置继续跑**：accessCodeHash 变成 null 会让面板认为
    // "从未设置过访问码"，于是任何访问者都能设置一个新访问码接管面板，
    // 同时存储位置与应用登记一并丢失。这里备份后直接退出，等人工修复。
    const bad = CONFIG_PATH + '.bad';
    try {
      fs.copyFileSync(CONFIG_PATH, bad);
    } catch {
      /* 备份失败也要退出，不能拿默认配置起服务 */
    }
    console.error(`配置损坏（${err.message}），已备份为 ${bad}，请修复后再启动。`);
    process.exit(1);
  }
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 原子落盘：先写临时文件再改名，避免断电/崩溃把 config.json 写成半截（读不回来）
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

export function isAccessCodeSet() {
  return Boolean(config.accessCodeHash);
}

export function getAccessCodeSecret() {
  return { hash: config.accessCodeHash, salt: config.accessCodeSalt };
}

export function saveAccessCode(hash, salt) {
  config.accessCodeHash = hash;
  config.accessCodeSalt = salt;
  persist();
}

export function getProxies() {
  return config.proxies;
}

export function addProxy(rule) {
  config.proxies.push(rule);
  persist();
}

export function removeProxy(path) {
  const idx = config.proxies.findIndex((r) => r.path === path);
  if (idx === -1) return false;
  config.proxies.splice(idx, 1);
  persist();
  return true;
}

export function getApps() {
  return config.apps;
}

export function getApp(id) {
  return config.apps.find((a) => a.id === id);
}

export function addApp(app) {
  config.apps.push(app);
  persist();
}

export function updateApp(id, data) {
  const app = getApp(id);
  if (!app) return false;
  Object.assign(app, data);
  persist();
  return true;
}

export function removeApp(id) {
  const idx = config.apps.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  config.apps.splice(idx, 1);
  persist();
  return true;
}

export function getStoragePath() {
  return config.storagePath;
}

export function setStoragePath(p) {
  config.storagePath = p;
  persist();
}

// ---- 桌面快捷方式（应用页图标，指向桌面 .lnk） ----

export function getShortcuts() {
  return config.shortcuts || [];
}

export function findShortcut(id) {
  return (config.shortcuts || []).find((s) => s.id === id);
}

export function addShortcut(shortcut) {
  if (!config.shortcuts) config.shortcuts = [];
  config.shortcuts.push(shortcut);
  persist();
}

export function removeShortcut(id) {
  const list = config.shortcuts || [];
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  persist();
  return true;
}

export function getThemeMode() {
  return config.themeMode === 'light' ? 'light' : 'dark';
}

export function getThemePair() {
  return config.themePair || 'purple';
}

export function setTheme(mode, pair) {
  if (mode != null) config.themeMode = mode;
  if (pair != null) config.themePair = pair;
  persist();
}
