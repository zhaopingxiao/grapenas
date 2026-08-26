// GrapeNAS 葡萄云 入口：HTTP 服务（9643）+ WebSocket
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, isAccessCodeSet, getApp, PORT } from './config.js';
import {
  verifyAccessCode,
  setupAccessCode,
  createToken,
  validateToken,
  revokeToken,
  isValidCodeFormat,
} from './auth.js';
import { setupWebSocket, COOKIE_NAME } from './ws.js';
import { log } from './logger.js';
import { parseCookies, readBody, readRawBody, sendJson, redirect, getBearerToken } from './util.js';
import { findProxyRule, proxyHttpRequest, toTargetPath, findRefererRule } from './proxy.js';
import { ensureAppsRunning, stageTar, installStagedTar } from './apps.js';
import { resolveStoragePath } from './storage.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB_DIR = path.join(ROOT, 'web');
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 秒

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

// 简单防爆破：同一 IP 连续失败 5 次锁定 30 秒
const MAX_FAILS = 5;
const LOCK_MS = 30 * 1000;
const attempts = new Map(); // ip -> { fails, lockUntil }

function isLocked(ip) {
  const rec = attempts.get(ip);
  return Boolean(rec && rec.lockUntil > Date.now());
}

function recordFail(ip) {
  const rec = attempts.get(ip) || { fails: 0, lockUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) {
    rec.lockUntil = Date.now() + LOCK_MS;
    rec.fails = 0;
  }
  attempts.set(ip, rec);
}

function isAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  // cookie 或请求头带令牌均可（请求头供浏览器外的客户端使用）
  return validateToken(cookies[COOKIE_NAME]) || validateToken(getBearerToken(req));
}

// 防开放重定向：只允许站内相对路径
function safeRedirectPath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/';
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // html/js/css 禁止缓存，避免拿到旧版前端
    if (ext === '.html' || ext === '.js' || ext === '.css') {
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function resolveStatic(pathname) {
  const filePath = path.normalize(path.join(WEB_DIR, pathname));
  if (!filePath.startsWith(WEB_DIR)) return null;
  try {
    return fs.statSync(filePath).isFile() ? filePath : null;
  } catch {
    return null;
  }
}

// 应用图标：data/packages/<id>/<config.json 中声明的图标>
// 双重防穿越：词法前缀检查 + realpath 真实路径包含检查（防符号链接逃逸）
function serveAppIcon(res, id) {
  const app = /^[A-Za-z0-9_-]{1,32}$/.test(String(id || '')) ? getApp(id) : null;
  if (!app || !app.icon || !app.dir) {
    res.writeHead(404);
    res.end();
    return;
  }
  const dir = path.normalize(app.dir);
  const filePath = path.normalize(path.join(dir, app.icon));
  if (!filePath.startsWith(dir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const realDir = fs.realpathSync(dir);
    const realFile = fs.realpathSync(filePath);
    if (!realFile.startsWith(realDir + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  serveFile(res, filePath);
}

async function handleAuth(req, res) {
  const ip = req.socket.remoteAddress;
  if (isLocked(ip)) {
    return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 30 秒后再试' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: '请求体无效' });
  }

  const code = body?.code;
  if (!isValidCodeFormat(code)) {
    return sendJson(res, 400, { ok: false, error: '访问码须为 8 位数字' });
  }

  const settingUp = !isAccessCodeSet();
  const ok = settingUp ? setupAccessCode(code) : verifyAccessCode(code);
  if (!ok) {
    recordFail(ip);
    log('warn', `访问码验证失败 (${ip})`);
    return sendJson(res, 401, { ok: false, error: '访问码错误' });
  }

  attempts.delete(ip);
  const token = createToken();
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_MAX_AGE}`
  );
  log('info', settingUp ? `访问码初始化完成 (${ip})` : `登录成功 (${ip})`);
  sendJson(res, 200, { ok: true, redirect: safeRedirectPath(body.redirect) });
}

function handleLogout(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  revokeToken(cookies[COOKIE_NAME]);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  log('info', '用户已退出登录');
  sendJson(res, 200, { ok: true });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // ---- 无需令牌的白名单 ----
  if (pathname === '/api/auth/status' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, needSetup: !isAccessCodeSet(), authed: isAuthed(req) });
  }
  if (pathname === '/api/auth' && req.method === 'POST') {
    return handleAuth(req, res);
  }
  if (pathname === '/auth' && req.method === 'GET') {
    if (isAuthed(req)) return redirect(res, '/');
    return serveFile(res, path.join(WEB_DIR, 'auth.html'));
  }
  if (pathname === '/grape.svg') {
    return serveFile(res, path.join(WEB_DIR, 'grape.svg'));
  }

  // ---- 其余一律先校验令牌 ----
  if (!isAuthed(req)) {
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 401, { ok: false, error: '未认证' });
    }
    // 仅页面导航重定向到访问码页；静态资源等直接 401，
    // 避免资源请求被 302 到登录页导致浏览器缓存污染（如图标被替换成 NAS 的）
    const accept = String(req.headers.accept || '');
    if (!accept.includes('text/html')) {
      return sendJson(res, 401, { ok: false, error: '未认证' });
    }
    const back = pathname === '/' ? '/' : pathname + url.search;
    return redirect(res, `/auth?redirect=${encodeURIComponent(back)}`);
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    return handleLogout(req, res);
  }

  // ---- 应用包接口 ----
  if (pathname === '/api/apps/upload' && req.method === 'POST') {
    try {
      const body = await readRawBody(req);
      if (!body.length) return sendJson(res, 400, { ok: false, error: '未收到文件' });
      const result = await stageTar(body);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }
  if (pathname === '/api/apps/install' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const app = await installStagedTar(body?.token);
      return sendJson(res, 200, { ok: true, app });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }
  if (pathname === '/api/apps/icon' && req.method === 'GET') {
    return serveAppIcon(res, url.searchParams.get('id'));
  }

  // ---- 文件管理 ----
  if (pathname === '/api/files/download' && req.method === 'GET') {
    try {
      const fp = resolveStoragePath(url.searchParams.get('path'));
      if (!fs.statSync(fp).isFile()) throw new Error('不是文件');
      // 强制下载（可预览的文件类型也一律附件下载）
      const name = encodeURIComponent(path.basename(fp));
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
      });
      fs.createReadStream(fp).pipe(res);
      return;
    } catch {
      return sendJson(res, 404, { ok: false, error: '文件不存在' });
    }
  }
  if (pathname === '/api/files/upload' && req.method === 'POST') {
    try {
      const dir = resolveStoragePath(url.searchParams.get('path'));
      const name = String(url.searchParams.get('name') || '');
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
        throw new Error('文件名非法');
      }
      const body = await readRawBody(req, 200 * 1024 * 1024);
      fs.writeFileSync(path.join(dir, name), body);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  // 所有内置页面共用同一个壳页面 "/"
  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(res, path.join(WEB_DIR, 'index.html'));
  }

  // 反向代理（HTTP 部分；WebSocket 部分在 upgrade 处理中）
  const rule = findProxyRule(pathname);
  if (rule) {
    // 命中规则根路径时补尾部斜杠，保证被代理应用的相对路径资源解析正确
    if (pathname === rule.path) return redirect(res, rule.path + '/' + (url.search || ''));
    return proxyHttpRequest(req, res, rule, toTargetPath(rule, pathname, url.search));
  }

  // 静态资源
  const staticFile = resolveStatic(pathname);
  if (staticFile) return serveFile(res, staticFile);

  // 绝对路径资源回退：被代理应用以 / 开头引用的资源会请求到根路径，
  // 按 Referer 判断其所属代理规则
  const refRule = findRefererRule(req);
  if (refRule) return proxyHttpRequest(req, res, refRule, pathname + url.search);

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}

// 进程级兜底：任何异常都不应让服务无声退出
process.on('uncaughtException', (err) => log('error', `未捕获异常: ${err.stack || err}`));
process.on('unhandledRejection', (reason) => log('error', `未处理的 Promise 拒绝: ${reason}`));

loadConfig();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    log('error', `请求处理异常: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务器内部错误' });
  });
});

setupWebSocket(server);

server.listen(PORT, () => {
  log('info', `GrapeNAS 葡萄云已启动: http://0.0.0.0:${PORT}`);
  if (!isAccessCodeSet()) log('warn', '尚未设置访问码，首次访问将要求初始化');
  ensureAppsRunning(); // 后台启动所有登记的应用（已存活的跳过）
});

// 端口被占用时友好提示并退出（而不是被 uncaughtException 兜底后僵住）
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用：葡萄云可能已在运行。请用面板停止，或先关闭占用该端口的进程。`);
  } else {
    console.error('服务启动失败:', err.message);
  }
  process.exit(1);
});
