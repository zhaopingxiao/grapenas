// 葡萄云重启助手（Node 版）：由服务端"重启葡萄云"拉起的独立进程，
// 停止旧实例（只杀服务进程本身，不杀进程树，避免把助手自己连带杀掉）
// 然后启动新实例
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processCommandLine, pidBelongsToApp } from './server/apps.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9643;
const LOG = path.join(ROOT, 'data', 'grapenas.log');
// 服务端启动助手时传入自己的 PID；没有时退回按端口查找
const pidArg = parseInt(process.argv[2], 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function note(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toLocaleString()}] INFO  ${msg}\n`);
  } catch {
    /* 忽略 */
  }
}

// 进程是不是葡萄云服务本身（PID 会被系统回收复用，杀之前必须核对命令行）
// 返回 null 表示判断不了（取不到命令行），此时沿用老行为，避免"关不掉旧实例"卡住重启。
function looksLikeServer(pid) {
  const line = processCommandLine(pid);
  if (!line) return null;
  return /server[\\/]index\.js/i.test(line);
}

// 直接读配置里的应用登记（不用 server/config.js 的 loadConfig：配置损坏时它会 process.exit）
function loadAppsForVerify() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw);
    return Array.isArray(cfg.apps) ? cfg.apps : [];
  } catch {
    return null; // 读不出来就不做归属校验
  }
}

// 杀进程树（Windows 用 taskkill /T /F；Unix 杀进程组），带 error 监听
function killTree(pid) {
  if (process.platform === 'win32') {
    const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => note(`taskkill 失败 (PID ${pid}): ${err.message}`));
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已退出 */
    }
  }
}

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.setTimeout(300);
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
    s.on('error', () => resolve(false));
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

async function findServerPid() {
  if (!(await portOpen())) return null;
  if (Number.isInteger(pidArg)) {
    // 只在"能确认是服务进程"或"判断不了"时使用传入的 PID；
    // 若明确判断出它不是服务进程（PID 已被系统回收复用），改为按端口查找
    const ok = looksLikeServer(pidArg);
    if (ok !== false) return pidArg;
    note(`传入的 PID ${pidArg} 命令行不像 server/index.js（疑似已被回收复用），改为按端口查找`);
  }
  try {
    if (process.platform === 'win32') {
      const out = await run('netstat', ['-ano']);
      for (const line of out.split(/\r?\n/)) {
        if (line.includes(`:${PORT} `) && line.includes('LISTENING')) {
          const pid = parseInt(line.trim().split(/\s+/).pop(), 10);
          if (Number.isInteger(pid)) return pid;
        }
      }
      return null;
    }
    // Linux：优先 ss（iproute2 自带），没有时退回 lsof
    try {
      const out = await run('ss', ['-ltnp']);
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(`:${PORT} `)) continue;
        const m = line.match(/pid=(\d+)/);
        if (m) return parseInt(m[1], 10);
      }
      return null;
    } catch {
      /* 没有 ss */
    }
    const out = await run('lsof', ['-iTCP:9643', '-sTCP:LISTEN', '-t']);
    const pids = out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n));
    return pids[0] ?? null;
  } catch {
    return null;
  }
}

// 只终止服务进程本身（Windows：taskkill /F；Unix：进程组 TERM）
// 这里刻意不加 /T：助手是被服务进程拉起的子进程，/T 会把助手自己一起杀掉
function killServer(pid) {
  if (process.platform === 'win32') {
    const child = spawn('taskkill', ['/pid', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => note(`taskkill 服务进程失败 (PID ${pid}): ${err.message}`));
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* 已退出 */
      }
    }
  }
}

// 关闭 = 应用一并关闭：按 .ground_progress 记录杀全部应用进程树，并清空记录。
// （记录是异常死亡时的兜底；正常关闭走这里显式结束应用）
function killAllApps() {
  let progress = {};
  try {
    progress = JSON.parse(fs.readFileSync(path.join(ROOT, '.ground_progress'), 'utf8'));
  } catch {
    return;
  }
  const apps = loadAppsForVerify();
  for (const [id, pid] of Object.entries(progress)) {
    if (pid == null) continue;
    // PID 会被系统回收复用：能确认这个进程不属于该应用时绝不盲杀
    // （历史上就这样误杀过一次用户正在后台跑的 gnconnect 隧道）
    const app = apps ? apps.find((a) => a.id === id) : null;
    if (app && pidBelongsToApp(pid, app) === false) {
      note(`跳过应用 ${id} 的 PID ${pid}：命令行与它不匹配，疑似 PID 已被回收复用`);
      continue;
    }
    killTree(pid);
    note(`重启关闭应用 ${id} (PID ${pid})`);
  }
  fs.writeFileSync(path.join(ROOT, '.ground_progress'), '{}');
}

function startServer() {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  // detached 全平台 + fd 写日志：助手退出后新实例完全独立，不随助手死亡
  const fd = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  child.unref();
  child.on('error', (err) => note(`新实例启动失败: ${err.message}`));
}

note('重启助手已启动');

// 应用随机关闭（记录兜底在此显式执行）
killAllApps();

for (let i = 0; i < 30; i++) {
  const pid = await findServerPid();
  if (pid == null) break;
  killServer(pid);
  await sleep(400);
}

if ((await findServerPid()) == null) {
  note('旧实例已停止，启动新实例');
  startServer();
  note('新实例启动完成');
} else {
  note('旧实例未能停止，放弃重启');
}

// 等端口起来后退出
for (let i = 0; i < 40; i++) {
  if (await portOpen()) process.exit(0);
  await sleep(300);
}
process.exit(1);
