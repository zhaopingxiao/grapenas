// 测试应用启动程序（全平台，由 node 执行）
// 注意：不要用 stdio 'inherit'（Windows 上会新建控制台窗口），
// 继承父进程的 stdout/stderr 文件句柄（已重定向到日志）即可
const { spawn } = require('child_process');
const path = require('path');

const child = spawn(process.execPath, [path.join(__dirname, 'testtask.js')], {
  stdio: ['ignore', 1, 2],
  windowsHide: true,
});
child.on('exit', (code) => process.exit(code == null ? 0 : code));
