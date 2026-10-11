// 通用工具函数

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      // 畸形百分号编码（如 Cookie: a=%）会让 decodeURIComponent 抛 URIError。
      // 必须在这里兜住：WebSocket 升级阶段也调它，抛出去会毁掉整个握手流程。
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value; // 解不开就按原样保留（反正校验不过）
    }
  }
  return out;
}

// 从 Authorization: Bearer <token> 请求头取令牌（浏览器外的客户端用）
export function getBearerToken(req) {
  const auth = String(req.headers.authorization || '');
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}

// 人类可读的请求体上限（用于报错文案，避免文案与实际 limit 写歪）
function formatLimit(bytes) {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)}MB` : `${Math.round(bytes / 1024)}KB`;
}

// 请求体超限时的统一收尾：**不要 req.destroy()**——那会把 socket 一起毁掉，
// 调用方随后写出的 4xx 响应根本发不出去，客户端只会看到"连接被重置"。
// 这里只停止收集、把剩余数据丢弃（resume），让请求自然结束，由调用方回错误。
function overflow(req, chunks, limit) {
  chunks.length = 0;
  req.resume();
  return new Error(`请求体过大（上限 ${formatLimit(limit)}）`);
}

export function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        reject(overflow(req, chunks, limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

// 读取原始二进制请求体（用于 tar 应用包与文件上传）
export function readRawBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        reject(overflow(req, chunks, limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(obj));
}

export function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location });
  res.end();
}
