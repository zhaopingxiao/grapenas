// 葡萄云示例应用：免访问码入口（nocodeport）
//
// 同一个 HTTP 服务监听两个端口，交给葡萄云的两条代理规则用：
//   port      = 18991 -> /nocode-demo/          需要访问码
//   nocodeport= 18992 -> /nocode/nocode-demo/   不需要访问码
//
// 只装一个入口也行：把 config.json 里的 port 删掉，只留 nocodeport。
// 页面里的资源与接口都请用相对路径（style.css、api/info），反代到子路径后依然正确。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CONF = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const WEB_DIR = path.join(__dirname, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

let hits = 0;
const startedAt = Date.now();

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function handle(req, res) {
  // 请求行里的畸形百分号编码（例如 /% ）会让 decodeURIComponent 抛 URIError。
  // 这里必须自己兜住：http 的请求回调里抛出的异常是"未捕获异常"，会让整个应用进程直接退出；
  // 而这个免访问码入口谁都能访问，等于一个请求就能把应用打崩。
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendJson(res, 400, { ok: false, error: '请求路径非法' });
  }

  // 后端接口：页面上的按钮会调它（相对路径 api/info）
  if (pathname === '/api/info') {
    hits += 1;
    console.log(`[${new Date().toISOString()}] api/info 第 ${hits} 次调用`);
    return sendJson(res, 200, {
      app: CONF.id,
      pid: process.pid,
      hits,
      uptimeSec: Math.round(process.uptime()),
      startedAt: new Date(startedAt).toISOString(),
      now: new Date().toISOString(),
      // 应用只看到被剥掉前缀后的路径，前缀由葡萄云的反代负责
      serverPath: pathname,
      clientPath: req.headers.referer || '(无)',
    });
  }

  // 静态文件（web/ 目录，防路径穿越）
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep)) {
    return sendJson(res, 403, { ok: false, error: '路径越界' });
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const servers = [];
for (const [label, port] of [
  ['需要访问码', CONF.port],
  ['免访问码', CONF.nocodeport],
]) {
  if (!port) continue;
  const server = http.createServer(handle);
  server.listen(port, '127.0.0.1', () => {
    console.log(`[nocode-demo] ${label}入口已监听 127.0.0.1:${port}`);
  });
  server.on('error', (err) => console.error(`[nocode-demo] 端口 ${port} 启动失败: ${err.message}`));
  servers.push(server);
}

console.log(`[nocode-demo] 应用 ${process.env.GRAPENAS_APP_ID || CONF.id} 已启动 (PID ${process.pid})`);
console.log(`[nocode-demo] 免访问码地址 /nocode/${CONF.id}/ ，需要访问码的地址 /${CONF.id}/`);

// main.js 退出即应用停止。注意：葡萄云在 Windows 下用 taskkill /F 硬杀进程，
// 收不到 SIGINT/SIGTERM，所以这段收尾只在 Unix、或手动 Ctrl+C 调试时才会执行。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[nocode-demo] 收到 ${sig}，正在关闭…`);
    for (const s of servers) s.close();
    process.exit(0);
  });
}
