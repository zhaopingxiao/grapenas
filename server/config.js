// 配置持久化（data/config.json）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const PORT = 9643;

const config = {
  accessCodeHash: null,
  accessCodeSalt: null,
  storagePath: null, // 存储位置（我的文件 user/ 与 应用数据 .package/）
  proxies: [], // 反向代理规则: [{ path: '/opencode', port: 4096, app?: '<应用id>' }]
  apps: [], // 应用: [{ id, name, command, ports: [] }]
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
