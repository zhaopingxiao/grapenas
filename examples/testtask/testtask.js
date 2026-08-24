// 测试应用（无 WebUI）：每 3 秒向 heartbeat.log 写一行心跳
const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'heartbeat.log');
const started = Date.now();

function beat() {
  const line = `${new Date().toISOString()} 心跳 #${Math.floor((Date.now() - started) / 3000) + 1}`;
  fs.appendFileSync(logFile, line + '\n');
}

beat();
setInterval(beat, 3000);
console.log('测试任务已启动，心跳日志: ' + logFile);
