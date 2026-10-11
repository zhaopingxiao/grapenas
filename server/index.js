// GrapeNAS 葡萄云 入口：HTTP 服务（9643）+ WebSocket
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadConfig, isAccessCodeSet, getApp, PORT, BASE_PATH, COOKIE_PATH, withBase, isReservedSegment, isNoCodePath } from './config.js';
import {
  verifyAccessCode,
  setupAccessCode,
  createToken,
  validateToken,
  isValidCodeFormat,
} from './auth.js';
import { setupWebSocket, COOKIE_NAME, broadcastEvent, sidebarEntriesFor } from './ws.js';
import { log } from './logger.js';
import { parseCookies, readBody, readRawBody, sendJson, redirect, getBearerToken } from './util.js';
import { findProxyRule, proxyHttpRequest, toTargetPath, findRefererRule } from './proxy.js';
import { ensureAppsRunning, stageTar, installStagedTar, readAppSidebar } from './apps.js';
import { resolveStoragePath } from './storage.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB_DIR = path.join(ROOT, 'web');

// 未带 /grapenas 前缀时禁止直接访问的内置路径段（应用/反代路径不受影响）
const BUILTIN_SEGMENTS = new Set(['/api', '/auth', '/ws', '/grape.svg', '/icons']);
// 未带前缀时禁止的静态文件后缀：避免 /style.css、/app.js 这类被静态兜底命中
const STATIC_EXT_RE = /\.(?:css|js|mjs|map|svg|png|jpe?g|webp|gif|ico|woff2?|json|txt|html?)$/i;
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 秒
const UPLOAD_MAX = 200 * 1024 * 1024; // 单文件上传上限

// 文件名非法判定：路径分隔符、上跳、控制字符，
// 以及 Windows 会特殊对待的保留设备名（CON/NUL/COM1…）与结尾的点/空格。
function isBadFileName(name) {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return true;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return true;
  if (/[. ]$/.test(name)) return true;
  const base = name.replace(/\.[^.]*$/, '') || name;
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(base);
}

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
const attempts = new Map(); // ip -> { fails, lockUntil, lastAt }

function isLocked(ip) {
  const rec = attempts.get(ip);
  return Boolean(rec && rec.lockUntil > Date.now());
}

function recordFail(ip) {
  const rec = attempts.get(ip) || { fails: 0, lockUntil: 0, lastAt: 0 };
  rec.fails += 1;
  rec.lastAt = Date.now();
  if (rec.fails >= MAX_FAILS) {
    rec.lockUntil = Date.now() + LOCK_MS;
    rec.fails = 0;
  }
  attempts.set(ip, rec);
}

// 定期清理记录表：只靠写入的话，被扫描的源 IP 会一直堆积（无界内存增长）。
// 锁已过期且 10 分钟没再尝试过的条目直接删掉。
setInterval(
  () => {
    const now = Date.now();
    for (const [ip, rec] of attempts) {
      if (rec.lockUntil < now && now - rec.lastAt > 10 * 60 * 1000) attempts.delete(ip);
    }
  },
  5 * 60 * 1000
).unref();

function isAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  // cookie 或请求头带令牌均可（请求头供浏览器外的客户端使用）
  return validateToken(cookies[COOKIE_NAME]) || validateToken(getBearerToken(req));
}

// 防开放重定向：只允许站内相对路径。
// 除了 // 开头，还要挡掉反斜杠：浏览器把 "\" 等同于 "/"，所以 "/\evil.com" 会被
// 解析成 "//evil.com"（协议相对 URL）跳到外站。控制字符一并拒绝。
function safeRedirectPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) return '/';
  // eslint-disable-next-line no-control-regex
  if (p.includes('\\') || /[\u0000-\u001f]/.test(p)) return '/';
  return p;
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff', // 不允许浏览器嗅探类型（防把文本当脚本执行）
    };
    // 页面与前端资源一律不缓存：避免升级后浏览器仍用旧版 HTML/JS/CSS（引着老路径的资源）；
    // 图标等其余静态资源走协商缓存即可，别让浏览器无限期沿用旧图。
    if (ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json') {
      headers['Cache-Control'] = 'no-store';
    } else {
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// 未认证/未命中时的文本响应：显式禁止缓存，避免浏览器把 401/404 存下来，
// 登录成功后仍显示"样式/脚本没了"
function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function resolveStatic(pathname) {
  const filePath = path.normalize(path.join(WEB_DIR, pathname));
  // 必须按"目录 + 分隔符"比较，否则将来的 web2/ 这类同前缀兄弟目录会漏出去
  if (filePath !== WEB_DIR && !filePath.startsWith(WEB_DIR + path.sep)) return null;
  try {
    return fs.statSync(filePath).isFile() ? filePath : null;
  } catch {
    return null;
  }
}

// 应用侧边栏：把应用包目录内的相对路径解析成安全绝对路径（前缀 + realpath 双重防穿越）
function resolveAppFile(app, rel) {
  if (!app || !app.dir) return null;
  const raw = String(rel || '').replace(/\\/g, '/').trim();
  if (!raw || raw.startsWith('/') || raw.includes('..') || /^[A-Za-z]:/.test(raw)) return null;
  const dir = path.normalize(app.dir);
  const filePath = path.normalize(path.join(dir, raw));
  if (!filePath.startsWith(dir)) return null;
  try {
    const realDir = fs.realpathSync(dir);
    const realFile = fs.realpathSync(filePath);
    if (!realFile.startsWith(realDir + path.sep)) return null;
    return realFile;
  } catch {
    return null;
  }
}

// 应用 id 不能占用保留段本身（grapenas / nocode，否则代理路径会与内置或免访问码路径冲突）
function isReservedAppId(id) {
  return isReservedSegment(id);
}

function appById(id) {
  return /^[A-Za-z0-9_-]{1,32}$/.test(String(id || '')) ? getApp(id) : null;
}

const SIDEBAR_MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// 侧边栏图标 / 片段内静态资源：kind = 'icon' | 'asset'
// 入口定位：entry 是 sidebar.json 里的下标；不带 entry 时回退到 config.json 的单入口
function sidebarEntryOf(app, entryRaw) {
  const entries = readAppSidebar(app);
  if (entries && entries.length) {
    const idx = entryRaw == null || entryRaw === '' ? 0 : Number(entryRaw);
    return Number.isInteger(idx) && idx >= 0 && idx < entries.length ? entries[idx] : null;
  }
  if (app && app.sidebar && (entryRaw == null || entryRaw === '' || Number(entryRaw) === 0)) return app.sidebar;
  return null;
}

function serveAppSidebarFile(res, id, entry, kind, file) {
  const app = appById(id);
  const item = sidebarEntryOf(app, entry);
  const rel = kind === 'icon' ? item?.iconsvg : file;
  const filePath = resolveAppFile(app, rel);
  if (!filePath) {
    sendText(res, 404, '404 Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': SIDEBAR_MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// 侧边栏页面片段：读应用包里的 page，并把相对资源改写成 sidebar-asset 接口（带 entry 下标），
// 这样片段注入到壳页面后，图片/CSS 仍能正确加载。
function serveAppSidebarPage(res, id, entry) {
  const app = appById(id);
  const item = sidebarEntryOf(app, entry);
  const filePath = resolveAppFile(app, item?.page);
  if (!filePath) {
    sendText(res, 404, '404 Not Found');
    return;
  }
  const idx = entry == null || entry === '' ? 0 : Number(entry);
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) {
      res.writeHead(404).end();
      return;
    }
    const base = `/api/apps/sidebar-asset?id=${encodeURIComponent(app.id)}&entry=${idx}&file=`;
    const pageDir = path.posix.dirname(String(item.page).replace(/\\/g, '/'));
    const body = html.replace(
      /(\s(?:src|href)\s*=\s*["'])([^"']+)/g,
      (match, attr, value) => {
        if (/^(?:[a-z]+:|\/\/|#|data:|blob:)/i.test(value)) return match;
        const rel = value.startsWith('/')
          ? value.slice(1)
          : path.posix.normalize(path.posix.join(pageDir === '.' ? '' : pageDir, value));
        return `${attr}${base}${encodeURIComponent(rel)}`;
      }
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(body);
  });
}

// 应用图标：data/packages/<id>/<config.json 中声明的图标>
// 双重防穿越：词法前缀检查 + realpath 真实路径包含检查（防符号链接逃逸）
function serveAppIcon(res, id) {  const app = /^[A-Za-z0-9_-]{1,32}$/.test(String(id || '')) ? getApp(id) : null;
  if (!app || !app.icon || !app.dir) {
    res.writeHead(404);
    res.end();
    return;
  }
  const dir = path.normalize(app.dir);
  const filePath = path.normalize(path.join(dir, app.icon));
  if (!filePath.startsWith(dir)) {
    res.writeHead(403, { 'Cache-Control': 'no-store' });
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

// 密钥比较：用定时安全比较（timingSafeEqual 要求等长，长度不同直接判否）
function secretEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
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
    `${COOKIE_NAME}=${token}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_MAX_AGE}`
  );
  log('info', settingUp ? `访问码初始化完成 (${ip})` : `登录成功 (${ip})`);
  sendJson(res, 200, { ok: true, redirect: safeRedirectPath(body.redirect) });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // 路径约定：
  //   内置路径（HTML 之外的接口/静态/WS）都在 /grapenas 前缀下：/grapenas/api/...、/grapenas/style.css、/grapenas/ws
  //   应用与手动反向代理挂在根下：/<应用id>/...
  //   应用的免访问码代理挂在 /nocode/<应用id>/...（见 config.json 的 nocodeport）
  //   壳页面在 "/"（/index.html 同义）
  if (url.pathname === '/index.html') {
    return serveFile(res, path.join(WEB_DIR, 'index.html'));
  }
  if (url.pathname === BASE_PATH || url.pathname.startsWith(BASE_PATH + '/')) {
    url.pathname = url.pathname.slice(BASE_PATH.length) || '/';
  } else if (!isNoCodePath(url.pathname)) {
    // 没带前缀时：内置路径与"根级静态文件"（/style.css、/app.js）一律拒绝，
    // 只有应用/反代路径留在根下。子路径（/<应用id>/x.css）要放行，否则被代理应用的
    // 静态资源会全部 404（HTML 绝对路径改写后正是这种形态）。
    const firstSeg = url.pathname.split('/')[1] || '';
    const rootStatic = /^\/[^/]+$/.test(url.pathname) && STATIC_EXT_RE.test(url.pathname);
    if (BUILTIN_SEGMENTS.has('/' + firstSeg) || rootStatic) {
      sendText(res, 404, `404 Not Found（内置路径统一在 ${BASE_PATH} 前缀下）`);
      return;
    }
  }
  const pathname = url.pathname;

  // ---- 无需令牌的白名单 ----
  // 应用用自己的密钥调用的接口（不是浏览器会话，因此放在鉴权门之前）
  // 应用运行时刷新自己的侧边栏入口：POST /grapenas/api/reload_sidebar/<appid>
  // 需要该应用的密钥（安装时生成，通过环境变量 GRAPENAS_APP_SECRET 下发）；
  // secret 允许走查询参数，方便应用用最朴素的方式调用。
  if (pathname.startsWith('/api/reload_sidebar/') && req.method === 'POST') {
    let appId;
    try {
      appId = decodeURIComponent(pathname.slice('/api/reload_sidebar/'.length));
    } catch {
      // 畸形百分号编码不能让整个请求变成 500
      return sendJson(res, 400, { ok: false, error: '应用 id 编码无效' });
    }
    const app = appById(appId);
    if (!app) return sendJson(res, 404, { ok: false, error: '应用不存在' });
    // 密钥走请求头（推荐）或 ?secret= 查询参数（方便应用用最朴素的方式调用），二者都校验
    const provided = String(req.headers['x-grapenas-app-secret'] || url.searchParams.get('secret') || '');
    if (!app.secret || !secretEquals(provided, app.secret)) {
      log('warn', `应用 ${appId} 刷新侧边栏被拒：密钥无效`);
      return sendJson(res, 401, { ok: false, error: '密钥无效' });
    }
    const entries = readAppSidebar(app) || [];
    broadcastEvent('sidebar', { app: app.id, entries: sidebarEntriesFor(app) });
    log('info', `应用 ${appId} 侧边栏已刷新（${entries.length} 个入口）`);
    return sendJson(res, 200, { ok: true, app: app.id, count: entries.length });
  }

  // 壳页面本身放行：未登录也返回外壳，前端发现未认证会自动跳登录页。
  // 这样即使 cookie 作用域异常，也不会出现"登录成功却打不开 /"的死循环。
  if (pathname === '/' && req.method === 'GET') {
    return serveFile(res, path.join(WEB_DIR, 'index.html'));
  }
  // 外壳自身的前端资源也放行：壳页面既然公开，它的样式与脚本就不能要令牌，
  // 否则未登录时会看到"只有 HTML、CSS/JS 全 401"的破页面。
  // 注意：这些只是前端代码，任何数据接口与 WebSocket 仍然要令牌。
  if (req.method === 'GET' && (pathname === '/style.css' || pathname === '/app.js')) {
    return serveFile(res, path.join(WEB_DIR, pathname.slice(1)));
  }
  if (pathname === '/api/auth/status' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, needSetup: !isAccessCodeSet(), authed: isAuthed(req) });
  }
  if (pathname === '/api/auth' && req.method === 'POST') {
    return handleAuth(req, res);
  }
  if (pathname === '/auth' && req.method === 'GET') {
    if (isAuthed(req)) return redirect(res, withBase('/'));
    return serveFile(res, path.join(WEB_DIR, 'auth.html'));
  }
  if (pathname === '/grape.svg') {
    return serveFile(res, path.join(WEB_DIR, 'grape.svg'));
  }

  // ---- 其余一律先校验令牌 ----
  // 例外：/nocode/<应用id>/... 是应用声明的免访问码入口（config.json 的 nocodeport），
  // 整段路径直接放行到下面的反代逻辑，不校验访问码。
  if (!isNoCodePath(pathname) && !isAuthed(req)) {
    if (pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 401, { ok: false, error: '未认证' });
    }
    // 仅页面导航重定向到访问码页；静态资源等直接 401，
    // 避免资源请求被 302 到登录页导致浏览器缓存污染（如图标被替换成 NAS 的）
    const accept = String(req.headers.accept || '');
    if (!accept.includes('text/html')) {
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 401, { ok: false, error: '未认证' });
    }
    const back = pathname === '/' ? '/' : pathname + url.search;
    return redirect(res, withBase(`/auth?redirect=${encodeURIComponent(back)}`));
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
  // 应用侧边栏：图标、页面片段与片段内的静态资源（都从应用包目录里取，路径防穿越）
  if (pathname === '/api/apps/sidebar-icon' && req.method === 'GET') {
    return serveAppSidebarFile(res, url.searchParams.get('id'), url.searchParams.get('entry'), 'icon', null);
  }
  if (pathname === '/api/apps/sidebar-asset' && req.method === 'GET') {
    return serveAppSidebarFile(
      res,
      url.searchParams.get('id'),
      url.searchParams.get('entry'),
      'asset',
      url.searchParams.get('file')
    );
  }
  if (pathname === '/api/apps/sidebar' && req.method === 'GET') {
    return serveAppSidebarPage(res, url.searchParams.get('id'), url.searchParams.get('entry'));
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
    let dir;
    try {
      dir = resolveStoragePath(url.searchParams.get('path'));
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
    const name = String(url.searchParams.get('name') || '');
    if (isBadFileName(name)) return sendJson(res, 400, { ok: false, error: '文件名非法' });

    // 流式落盘：不再把整个文件读进内存（200MB 上限时峰值会吃掉约 400MB）。
    // 先写 <名字>.grapenas-part，成功后再改名，避免失败时留下半截文件/毁掉原文件。
    const target = path.join(dir, name);
    const tmp = `${target}.grapenas-part`;
    let size = 0;
    let failed = null;
    const guard = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > UPLOAD_MAX) {
          failed = `文件超过 ${UPLOAD_MAX / 1024 / 1024}MB 上限`;
          cb(new Error(failed));
          return;
        }
        cb(null, chunk);
      },
    });
    const out = fs.createWriteStream(tmp);
    // 注意：这里不能用 stream.pipeline——它出错时会连 req 一起 destroy，
    // socket 一毁，下面的 4xx 响应就发不出去了（客户端只看到连接被重置）。
    const settled = new Promise((resolve) => {
      out.on('finish', () => resolve(null));
      out.on('error', resolve);
      guard.on('error', resolve);
      req.on('error', resolve);
    });
    req.pipe(guard).pipe(out);
    const err = await settled;
    if (err) {
      req.unpipe(guard);
      guard.unpipe(out);
      out.destroy();
      req.resume(); // 丢弃剩余上传数据，让错误响应能正常发出
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      return sendJson(res, 400, { ok: false, error: failed || err.message });
    }
    try {
      await fs.promises.rename(tmp, target);
    } catch (renameErr) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      return sendJson(res, 400, { ok: false, error: `保存失败: ${renameErr.message}` });
    }
    return sendJson(res, 200, { ok: true });
  }

  // 所有内置页面共用同一个壳页面 "/"
  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(res, path.join(WEB_DIR, 'index.html'));
  }

  // 反向代理（HTTP 部分；WebSocket 部分在 upgrade 处理中）
  const rule = findProxyRule(pathname);
  // 免访问码路径只认应用自己声明的 nocodeport 规则：没有匹配的规则就到此为止。
  // 绝不能继续往下走静态资源 / Referer 兜底——否则任何未认证的人只要伪造 Referer，
  // 就能把请求隧道进任意应用端口（等于绕过访问码）。
  if (isNoCodePath(pathname) && !rule) return sendText(res, 404, '404 Not Found');
  if (rule) {
    // 命中规则根路径时补尾部斜杠，保证被代理应用的相对路径资源解析正确。
    // 用 308 而不是 302：302 会把 POST/PUT/DELETE 变成 GET 并丢掉请求体。
    // 应用与代理路径挂在站点根下，这里不能加 /grapenas 前缀（withBase 只用于内置路径）
    if (pathname === rule.path) return redirect(res, rule.path + '/' + (url.search || ''), 308);
    return proxyHttpRequest(req, res, rule, toTargetPath(rule, pathname, url.search));
  }

  // 静态资源
  const staticFile = resolveStatic(pathname);
  if (staticFile) return serveFile(res, staticFile);

  // 绝对路径资源回退：被代理应用以 / 开头引用的资源会请求到根路径，
  // 按 Referer 判断其所属代理规则（免访问码路径不走这条，上面那道门已经拦下了）
  const refRule = isNoCodePath(pathname) ? null : findRefererRule(req);
  if (refRule) return proxyHttpRequest(req, res, refRule, pathname + url.search);

  sendText(res, 404, '404 Not Found');
}

// 进程级兜底：兜住请求/升级处理之外的意外异常（正常请求路径都有各自的 try/catch）。
// 这里**只记日志不退出**：本机没有守护进程会把它拉起来，为一个坏请求把整个面板带走
// 对使用者更糟。但反过来——日志里出现「未捕获异常」就说明有 bug，必须当成 bug 处理。
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
  log('info', `GrapeNAS 葡萄云已启动: http://0.0.0.0:${PORT}` + `（站内路径前缀 ${BASE_PATH}）`);
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
