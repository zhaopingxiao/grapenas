// 反向代理：将本机（127.0.0.1）指定端口的服务映射到子路径
// HTTP 与 WebSocket 同时生效：如 4096 -> /opencode，则其 /websocket 即为 /opencode/websocket
import http from 'node:http';
import net from 'node:net';
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

// 系统保留路径，不可被代理占用
const RESERVED = ['/api', '/auth', '/ws', '/favicon.svg'];

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
const HOP_BY_HOP = new Set([
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
function rewriteHtml(body, prefix) {
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
function shimScript(prefix) {
  return (
    `<script data-grapenas-shim>(function(){var p=${JSON.stringify(prefix)};` +
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

function injectShim(body, prefix) {
  const shim = shimScript(prefix);
  const head = /<head(\s[^>]*)?>/i.exec(body);
  if (head) {
    const at = head.index + head[0].length;
    return body.slice(0, at) + shim + body.slice(at);
  }
  return shim + body;
}

function rewriteHeaders(headers, rule) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key)) continue;
    // 需要注入子路径适配脚本，移除 CSP 防止拦截内联脚本（目标均为本机可信服务）
    if (key === 'content-security-policy' || key === 'content-security-policy-report-only') continue;
    // 绝对路径重定向也落到子路径下
    if (
      key === 'location' &&
      typeof value === 'string' &&
      value.startsWith('/') &&
      value !== rule.path &&
      !value.startsWith(rule.path + '/')
    ) {
      out[key] = rule.path + value;
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
      const isHtml = String(proxyRes.headers['content-type'] || '').includes('text/html');
      if (!isHtml) {
        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        proxyRes.pipe(res);
        return;
      }
      // HTML：缓冲后改写绝对路径（长度变化，移除 content-length）
      delete outHeaders['content-length'];
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        body = injectShim(rewriteHtml(body, rule.path), rule.path);
        res.writeHead(proxyRes.statusCode || 200, outHeaders);
        res.end(body);
      });
    }
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('502 Bad Gateway：目标服务无响应');
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
