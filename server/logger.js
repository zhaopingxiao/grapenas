// 内存环形日志缓冲，支持订阅（用于 WebSocket 实时推送）
const MAX_LOGS = 500;
const logs = [];
const listeners = new Set();

export function log(level, message) {
  const entry = { time: new Date().toISOString(), level, message };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  for (const cb of listeners) cb(entry);
  console.log(`[${entry.time}] ${level.toUpperCase().padEnd(5)} ${message}`);
}

export function getLogs() {
  return logs.slice();
}

export function clearLogs() {
  logs.length = 0;
}

export function onLog(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
