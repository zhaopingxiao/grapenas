// 配置持久化（data/config.json）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const PORT = 9643;

// 葡萄云所有内置路径都挂在这个前缀下：/grapenas/ws、/grapenas/api/...、/grapenas/style.css
// 只有壳页面本身留在 /（方便直接打开站点根）。应用与手动反向代理也会挂在 /grapenas/<路径> 下，
// 因此应用 id 不能再叫 grapenas。
export const BASE_PATH = '/grapenas';

// 登录 cookie 的 Path 用站点根：壳页面在 "/"，若把 cookie 限定在 BASE_PATH，
// 浏览器访问 "/" 时不会带上它，会出现"登录成功 -> 跳 / -> 又弹回登录页"的死循环。
export const COOKIE_PATH = '/';

// 给站内绝对路径加上前缀：withBase('/api') -> '/grapenas/api'
// 保留的路径段：应用 id / 手动代理路径不能占用
export const RESERVED_SEGMENT = 'grapenas';

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
  proxies: [], // 反向代理规则: [{ path: '/opencode', port: 4096, app?: '<应用id>' }]
  apps: [], // 应用: [{ id, name, command, ports: [] }]
  shortcuts: [], // 桌面快捷方式: [{ id, name, lnk }]
  desktopUi: false, // beta：桌面 UI（壁纸 + 图标 + 可拖拽窗口）
};

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    }
  } catch (err) {
    console.error('读取配置失败，使用默认配置:', err.message);
  }
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
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

// ---- beta：桌面 UI 开关 ----

export function getDesktopUi() {
  return Boolean(config.desktopUi);
}

export function setDesktopUi(on) {
  config.desktopUi = Boolean(on);
  persist();
  return config.desktopUi;
}

export function setTheme(mode, pair) {
  if (mode != null) config.themeMode = mode;
  if (pair != null) config.themePair = pair;
  persist();
}
