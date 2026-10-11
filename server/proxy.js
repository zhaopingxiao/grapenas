// 反向代理：将本机（127.0.0.1）指定端口的服务映射到子路径
// HTTP 与 WebSocket 同时生效：如 4096 -> /opencode，则其 /websocket 即为 /opencode/websocket
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { getProxies } from './config.js';

// 规范化子路径：补前导斜杠、去尾部斜杠，仅允许字母数字及 - _ /
export function normalizeProxyPath(p) {
  if (typeof p !== 'string') return null;
  let path = p.trim();
  if (!path) return null;
  if (!path.startsWith('/')) path = '/' + path;
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (!/^\/[A-Za-z0-9\-_/]+$/.test(path)) return null;
  return path;
}

// 系统保留路径，不可被手动代理占用
// （/nocode 是应用的免访问码段，只由应用包 config.json 的 nocodeport 生成规则）
const RESERVED = ['/api', '/auth', '/ws', '/grape.svg', '/grapenas', '/nocode'];

export function isReservedPath(p) {
  if (p === '/') return true;
  return RESERVED.some((r) => p === r || p.startsWith(r + '/'));
}

// 查找匹配规则（最长路径优先）
export function findProxyRule(pathname) {
  let best = null;
  for (const rule of getProxies()) {
    if (pathname === rule.path || pathname.startsWith(rule.path + '/')) {
      if (!best || rule.path.length > best.path.length) best = rule;
    }
  }
  return best;
}

function stripPrefix(pathname, prefix) {
  const rest = pathname.slice(prefix.length);
  return rest === '' ? '/' : rest;
}

// 直接命中规则时计算目标路径（剥掉子路径前缀）
export function toTargetPath(rule, pathname, search) {
  return stripPrefix(pathname, rule.path) + (search || '');
}

// 未直接命中规则时，按 Referer 判断请求所属的代理子路径。
// 被代理应用以 / 开头的绝对路径资源（CSS/JS/图标/manifest 及运行时 fetch）
// 会请求到根路径下，此时用 Referer 归属到对应规则。
export function findRefererRule(req) {
  const referer = req.headers.referer;
  if (!referer) return null;
  try {
    return findProxyRule(new URL(referer).pathname);
  } catch {
    return null;
  }
}

// 逐跳头部不应转发
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-authenticate',
]);

// 重写 HTML 中的绝对路径属性：href/src/action="/x" -> "/<子路径>/x"
export function rewriteHtml(body, prefix) {
  const bare = prefix.slice(1); // '/opencode' -> 'opencode'
  return body.replace(
    /(\s(?:href|src|action)\s*=\s*["'])\/(?!\/)([^"']*)/g,
    (match, attr, rest) => {
      if (rest === bare || rest.startsWith(bare + '/')) return match; // 已带前缀
      return `${attr}${prefix}/${rest}`;
    }
  );
}

// 子路径适配脚本：注入为 <head> 内第一个脚本，先于应用代码执行。
// - 包装 history.pushState/replaceState：SPA 前端路由写绝对路径时自动加上子路径前缀，
//   地址栏始终留在 /<子路径>/* 下（后退不掉出应用，刷新能命中代理规则）。
// - 包装 WebSocket 构造器：应用连接同源根路径 WS（如 ws://host/websocket）时
//   自动改连 /<子路径>/websocket，与 WS 代理映射对应。
// nonce：应用的 CSP 若带 script-src，我们会把同一个 nonce 注进策略里，
// 这样内联脚本能执行、应用自己的策略又不用整段丢掉。
export function shimScript(prefix, nonce) {
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  return (
    `<script data-grapenas-shim${nonceAttr}>(function(){var p=${JSON.stringify(prefix)};` +
    `function fix(u){if(typeof u!=='string')return u;if(u.indexOf(location.origin)===0)u=u.slice(location.origin.length);` +
    `return u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u!==p&&u.indexOf(p+'/')!==0?p+u:u;}` +
    `var ps=history.pushState,rs=history.replaceState;` +
    `history.pushState=function(s,t,u){return ps.call(this,s,t,fix(u));};` +
    `history.replaceState=function(s,t,u){return rs.call(this,s,t,fix(u));};` +
    `var WS=window.WebSocket;` +
    `function PWS(u,pr){try{var d=new URL(u,location.href);` +
    `if(d.host===location.host&&(d.protocol==='ws:'||d.protocol==='wss:')&&d.pathname!==p&&d.pathname.indexOf(p+'/')!==0){d.pathname=p+d.pathname;u=d.href;}}catch(e){}` +
    `return new WS(u,pr);};` +
    `PWS.prototype=WS.prototype;Object.setPrototypeOf(PWS,WS);window.WebSocket=PWS;` +
    `})();</script>`
  );
}

// 给应用的 CSP 添加上本次注入脚本的 nonce（保留它自己的策略，只多放行我们这一个脚本）。
// 返回 null 表示"不猜、不改"：调用方会退回移除 CSP 的老做法——
// 放宽策略总好过猜错把应用自己的脚本全挡死。
function cspWithNonce(csp, nonce) {
  const parts = String(csp || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  let touched = false;
  const out = parts.map((s) => {
    if (/^script-src(-elem)?\b/i.test(s)) {
      touched = true;
      return `${s} 'nonce-${nonce}'`;
    }
    return s;
  });
  if (touched) return out.join('; ');
  const def = parts.find((s) => /^default-src\b/i.test(s));
  if (!def) return null;
  // 没有 script-src 时脚本回落到 default-src：新建的 script-src 必须原样带上它的取值，
  // 否则应用自己的脚本会被这条新策略挡死
  return [...out, `script-src ${def.replace(/^default-src\s*/i, '')} 'nonce-${nonce}'`].join('; ');
}

function injectShim(body, prefix, nonce) {
  const shim = shimScript(prefix, nonce);
  const head = /<head(\s[^>]*)?>/i.exec(body);
  if (head) {
    const at = head.index + head[0].length;
    return body.slice(0, at) + shim + body.slice(at);
  }
  return shim + body;
}

// 重定向目标收进子路径：相对路径补前缀，指向本机的绝对 URL 改写成子路径
function rewriteLocation(value, rule) {
  if (value.startsWith('/')) {
    if (value === rule.path || value.startsWith(rule.path + '/')) return value; // 已带前缀
    return rule.path + value;
  }
  try {
    const u = new URL(value);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1') {
      return `${rule.path}${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    /* 不是绝对 URL（相对路径 / javascript: 等），原样返回 */
  }
  return value;
}

// 应用的 cookie 收进自己的子路径：Path=/ 会扩散到整个站点（连 /grapenas 面板一起吃）
function rewriteCookiePath(cookie, prefix) {
  const s = String(cookie);
  if (/;\s*path\s*=\s*\/\s*(?:;|$)/i.test(s)) return s.replace(/;\s*path\s*=\s*\/\s*/i, `; Path=${prefix}/`);
  return s;
}

function rewriteHeaders(headers, rule) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key)) continue;
    // 绝对路径重定向也落到子路径下
    if (key === 'location' && typeof value === 'string') {
      out[key] = rewriteLocation(value, rule);
      continue;
    }
    if (key === 'set-cookie') {
      out[key] = Array.isArray(value)
        ? value.map((c) => rewriteCookiePath(c, rule.path))
        : rewriteCookiePath(value, rule.path);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function proxyHttpRequest(req, res, rule, targetPath) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key)) headers[key] = value;
  }
  headers.host = `127.0.0.1:${rule.port}`;
  headers['accept-encoding'] = 'identity'; // 需要改写 HTML，要求上游不压缩

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: rule.port,
      path: targetPath,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      const outHeaders = rewriteHeaders(proxyRes.headers, rule);
      const html = String(proxyRes.headers['content-type'] || '').includes('text/html');
      if (!html) {
        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        proxyRes.pipe(res);
        return;
      }
      // HTML：缓冲后改写绝对路径（长度变化，移除 content-length）
      delete outHeaders['content-length'];
      // CSP：优先把本次注入脚本的 nonce 加进应用自己的策略（策略其余部分原样保留）；
      // 策略无法安全改写时才退回"移除 CSP"的老做法——总比猜错把应用的脚本全挡死好。
      const csp = proxyRes.headers['content-security-policy'];
      const nonce = crypto.randomBytes(9).toString('base64');
      const patchedCsp = csp == null ? null : cspWithNonce(csp, nonce);
      if (csp != null) {
        if (patchedCsp) outHeaders['content-security-policy'] = patchedCsp;
        else delete outHeaders['content-security-policy'];
      }
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        body = injectShim(rewriteHtml(body, rule.path), rule.path, patchedCsp ? nonce : null);
        res.writeHead(proxyRes.statusCode || 200, outHeaders);
        res.end(body);
      });
    }
  );
  // 上游连上却不回包时不能永远挂着
  proxyReq.setTimeout(30000, () => proxyReq.destroy(new Error('上游响应超时')));
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('502 Bad Gateway：目标服务无响应');
  });
  // 浏览器中途断开时把上游连接一起收掉，避免连接泄漏
  res.on('close', () => {
    if (!res.writableEnded) proxyReq.destroy();
  });
  req.pipe(proxyReq);
}

// WebSocket 代理：重写请求行与 Host 后做 TCP 双向透传
export function proxyWsUpgrade(req, socket, head, rule, pathname, search) {
  const targetPath = stripPrefix(pathname, rule.path) + (search || '');
  // TCP keepalive：浏览器断网/合盖无 FIN，保活探测用于回收死隧道
  socket.setKeepAlive(true, 30000);
  const upstream = net.connect(rule.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${targetPath} HTTP/${req.httpVersion}`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === 'host') continue;
      lines.push(`${key}: ${value}`);
    }
    lines.push(`host: 127.0.0.1:${rule.port}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.setKeepAlive(true, 30000);
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
}
