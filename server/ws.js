// WebSocket 服务：所有数据通讯的唯一通道，握手时校验 cookie 中的临时令牌
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { validateToken, changeAccessCode } from './auth.js';
import { isAccessCodeSet, getProxies, addProxy, removeProxy, getApps, getApp, addApp, updateApp, removeApp, PORT } from './config.js';
import { log, getLogs, clearLogs, onLog } from './logger.js';
import { parseCookies } from './util.js';
import { normalizeProxyPath, isReservedPath, findProxyRule, proxyWsUpgrade } from './proxy.js';
import { checkApp, startApp, stopApp, markAppStopping, syncAppProxyRules, removeAppProxyRules, appHasWebui, uninstallApp } from './apps.js';
import { isStorageConfigured, getStoragePath, resolveStoragePath, setStoragePath } from './storage.js';

export const COOKIE_NAME = 'grapenas_token';

// WebSocket 认证：cookie 令牌 > Authorization: Bearer 头 > ?token= 查询参数
// 葡萄云不设独立 WS 密钥，复用访问码签发的临时令牌
function wsAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (validateToken(cookies[COOKIE_NAME])) return true;
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ') && validateToken(auth.slice(7).trim())) return true;
  try {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (token && validateToken(token)) return true;
  } catch {
    /* 忽略无效 URL */
  }
  return false;
}

export function setupWebSocket(server) {
  // noServer 模式：自行接管 upgrade，以便同时处理反向代理路径上的 WebSocket
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const pathname = url.pathname;

    // NAS 自身通讯通道（令牌校验在 connection 中处理，保持 4401 语义）
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }

    // 反向代理的 WebSocket（如 /opencode/websocket -> 127.0.0.1:4096/websocket）
    const rule = findProxyRule(pathname);
    if (rule) {
      const cookies = parseCookies(req.headers.cookie);
      if (!validateToken(cookies[COOKIE_NAME]) && !wsAuthed(req)) {
        log('warn', `已拒绝未认证的代理 WebSocket: ${pathname}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      log('info', `WebSocket 隧道: ${pathname} -> 127.0.0.1:${rule.port}`);
      proxyWsUpgrade(req, socket, head, rule, pathname, url.search);
      return;
    }

    log('warn', `已拒绝未知 WebSocket 路径: ${pathname}`);
    socket.destroy();
  });

  // 新日志实时推送给所有已认证客户端
  onLog((entry) => {
    const data = JSON.stringify({ type: 'event', event: 'log', data: entry });
    for (const client of wss.clients) {
      if (client.readyState === 1 && client.authed) client.send(data);
    }
  });

  // 心跳保活：设备断网/合盖/杀进程时 TCP 无 FIN，close 不会触发，
  // 定时 ping，连续无响应的连接判定假死并 terminate 回收
  const HEARTBEAT_MS = 30 * 1000;
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        log('info', '回收假死的 WebSocket 连接');
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (err) => log('warn', `WebSocket 错误: ${err.message}`));

    const cookies = parseCookies(req.headers.cookie);
    if (!validateToken(cookies[COOKIE_NAME])) {
      log('warn', `WebSocket 令牌无效，已关闭 (${req.socket.remoteAddress})`);
      ws.send(JSON.stringify({ type: 'error', code: 'unauthorized', message: '未认证或令牌已过期' }));
      ws.close(4401, 'unauthorized');
      return;
    }
    ws.authed = true;

    log('info', `WebSocket 客户端已连接 (${req.socket.remoteAddress})`);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      const reply = (payload) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ id: msg.id, ...payload }));
      };
      try {
        const handler = handlers[msg.type];
        if (!handler) throw new Error(`未知消息类型: ${msg.type}`);
        const result = await handler(msg.data || {}, req);
        reply({ type: `${msg.type}.result`, ok: true, data: result });
      } catch (err) {
        reply({ type: `${msg.type}.result`, ok: false, error: err.message });
      }
    });

    ws.on('close', () => log('info', 'WebSocket 客户端已断开'));
  });

  return wss;
}

// 消息处理器：后续功能（文件管理等）都往这里挂
const handlers = {
  ping: () => ({ pong: Date.now() }),

  'sys.info': () => ({
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpuModel: os.cpus()[0]?.model || '未知',
    cpuCores: os.cpus().length,
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    osUptime: os.uptime(),
    serverUptime: process.uptime(),
    nodeVersion: process.version,
    serverTime: Date.now(),
  }),

  'settings.get': () => ({
    accessCodeSet: isAccessCodeSet(),
  }),

  'settings.setAccessCode': (data) => {
    if (!changeAccessCode(data.oldCode, data.newCode)) {
      throw new Error('修改失败：当前访问码错误或新访问码格式不正确（需 8 位数字）');
    }
    log('info', '访问码已通过设置页修改');
    return { changed: true };
  },

  'proxy.list': () => getProxies(),

  'proxy.add': (data) => {
    const p = normalizeProxyPath(data.path);
    const port = Number(data.port);
    if (!p) throw new Error('子路径格式不正确（仅支持字母、数字及 - _ /）');
    if (isReservedPath(p)) throw new Error('该子路径为系统保留，不可用于代理');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('端口须为 1-65535 的整数');
    }
    if (port === PORT) throw new Error('不可代理到 NAS 自身端口');
    if (getProxies().some((r) => r.path === p)) throw new Error('该子路径已存在代理规则');
    addProxy({ path: p, port });
    log('info', `已添加反向代理: ${p} -> 127.0.0.1:${port}`);
    return { added: true };
  },

  'proxy.remove': (data) => {
    const p = String(data.path || '');
    const rule = getProxies().find((r) => r.path === p);
    if (!rule) throw new Error('未找到该代理规则');
    if (rule.app) throw new Error(`该规则由应用「${rule.app}」管理，请在应用页操作`);
    removeProxy(p);
    log('info', `已删除反向代理: ${p}`);
    return { removed: true };
  },

  'logs.list': () => getLogs(),

  'logs.clear': () => {
    clearLogs();
    log('info', '日志已清空');
    return { cleared: true };
  },

  // 应用列表：打开应用页时逐个核对（清理死亡进程记录）
  'apps.list': () =>
    getApps().map((app) => {
      const st = checkApp(app);
      return {
        id: app.id,
        name: app.name,
        description: app.description || '',
        icon: Boolean(app.icon),
        package: Boolean(app.package),
        command: app.command,
        ports: app.ports,
        running: st.running,
        pid: st.pid,
        webui: appHasWebui(app.id),
      };
    }),

  'apps.add': (data) => {
    const input = validateAppInput(data);
    if (getApp(input.id)) throw new Error('该应用 ID 已存在');
    checkPortConflicts(input, null);
    addApp(input);
    syncAppProxyRules(input);
    log('info', `已添加应用: ${input.name} (${input.id})`);
    return { added: true };
  },

  'apps.update': (data) => {
    const id = String(data.id || '');
    const app = getApp(id);
    if (!app) throw new Error('未找到该应用');
    const input = validateAppInput({ ...data, id }); // id 不可修改
    checkPortConflicts(input, id);
    updateApp(id, { name: input.name, command: input.command, ports: input.ports });
    syncAppProxyRules(getApp(id));
    log('info', `应用 ${id} 设置已更新`);
    return { updated: true };
  },

  'apps.remove': async (data) => {
    const app = getApp(String(data.id || ''));
    if (!app) throw new Error('未找到该应用');
    await uninstallApp(app);
    log('info', `应用 ${app.id} 已卸载`);
    return { removed: true };
  },

  'apps.start': (data) => {
    const app = getApp(String(data.id || ''));
    if (!app) throw new Error('未找到该应用');
    return startApp(app);
  },

  'apps.stop': (data) => {
    const id = String(data.id || '');
    if (!getApp(id)) throw new Error('未找到该应用');
    return stopApp(id);
  },

  'system.restart': () => {
    // 重启 = 整机关闭：先标记所有应用为主动停止（随机关闭，不报"意外退出"）
    for (const app of getApps()) markAppStopping(app.id);
    restartServer();
    return { restarting: true };
  },

  // ---- 存储位置 ----
  'storage.get': () => ({
    configured: isStorageConfigured(),
    path: getStoragePath() || null,
  }),

  'storage.set': (data) => ({
    path: setStoragePath(data.path),
  }),

  // ---- 文件管理（存储位置内） ----
  'files.list': (data) => {
    const dir = resolveStoragePath(data.path);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      throw new Error('路径不存在');
    }
    if (!st.isDirectory()) throw new Error('不是目录');
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .map((e) => {
        const full = path.join(dir, e.name);
        let size = 0;
        let mtime = 0;
        try {
          const s = fs.statSync(full);
          size = s.size;
          mtime = s.mtimeMs;
        } catch {
          /* 忽略 */
        }
        return { name: e.name, dir: e.isDirectory(), size, mtime };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { path: String(data.path || ''), entries };
  },

  'files.mkdir': (data) => {
    const name = String(data.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error('文件夹名非法');
    }
    const dir = resolveStoragePath(data.path);
    fs.mkdirSync(path.join(dir, name));
    return { created: true };
  },

  'files.delete': (data) => {
    const target = resolveStoragePath(data.path);
    if (target === resolveStoragePath('')) throw new Error('不能删除存储根目录');
    fs.rmSync(target, { recursive: true, force: true });
    log('info', `文件管理已删除: ${data.path}`);
    return { deleted: true };
  },
};

// 重启葡萄云：拉起独立的重启助手进程（等旧实例退出后启动新实例）
// 服务端自身不退出，由助手 kill 掉；助手是子进程但带 DETACHED，且助手只杀服务进程本身，
// 不会杀到进程树里的自己（taskkill /T 会把助手连带杀掉，故只用 /F）
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function restartServer() {
  log('info', '收到重启请求，正在重启葡萄云…');
  // 重启助手为独立 Node 进程（process.execPath 即当前 node，无需额外运行时）
  const helper = spawn(process.execPath, ['restart_helper.js'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  helper.unref();
  helper.on('error', (err) => log('error', `重启助手启动失败: ${err.message}`));
}

// 校验应用表单输入
function validateAppInput(data) {
  const id = String(data.id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
    throw new Error('ID 必填，仅支持字母、数字及 - _（不超过 32 字符）');
  }
  const command = String(data.command || '').trim();
  if (!command) throw new Error('主程序命令必填');
  const name = String(data.name || '').trim() || id;

  let ports = [];
  if (Array.isArray(data.ports)) {
    ports = data.ports.map(Number);
  } else if (typeof data.ports === 'string') {
    ports = data.ports.split(/[,，\s]+/).filter(Boolean).map(Number);
  }
  ports = [...new Set(ports)];
  for (const p of ports) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('端口须为 1-65535 的整数');
    if (p === PORT) throw new Error('端口不可为 NAS 自身端口');
  }
  return { id, name, command, ports };
}

// 端口/代理路径冲突检查（excludeId：编辑时排除自身）
function checkPortConflicts(input, excludeId) {
  for (const other of getApps()) {
    if (other.id === excludeId) continue;
    for (const p of other.ports) {
      if (input.ports.includes(p)) throw new Error(`端口 ${p} 已被应用 ${other.id} 使用`);
    }
  }
  if (input.ports.length > 0) {
    const first = '/' + input.id;
    if (isReservedPath(first)) throw new Error(`代理路径 ${first} 为系统保留`);
    const existing = getProxies().find((r) => r.path === first);
    if (existing && existing.app !== input.id) throw new Error(`代理路径 ${first} 已被占用`);
  }
}
