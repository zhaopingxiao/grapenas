// 应用生命周期管理：后台启动登记的应用，PID 按应用 id 记入 .ground_progress
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApps, getApp, addApp, removeApp, getProxies, addProxy, removeProxy, PORT } from './config.js';
import { log } from './logger.js';
import { isReservedPath } from './proxy.js';
import { packagesDir, isStorageConfigured } from './storage.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROGRESS_PATH = path.join(ROOT, '.ground_progress');
const TMP_DIR = path.join(ROOT, 'data', 'tmp');
const APP_LOG_DIR = path.join(ROOT, 'data', 'logs');

// 进程是否存活（signal 0 仅探测不发送）
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveProgress(map) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(map, null, 2));
}

// 核对单个应用：有记录则检测是否死亡，死亡则删除记录。返回运行状态（不启动）
export function checkApp(app) {
  const progress = loadProgress();
  const pid = progress[app.id];
  if (pid != null) {
    if (pidAlive(pid)) return { running: true, pid };
    delete progress[app.id];
    saveProgress(progress);
    log('info', `应用 ${app.id} 的进程记录 (PID ${pid}) 已失效，记录已清除`);
  }
  return { running: false, pid: null };
}

// 正在被主动停止的应用（避免把主动停止误报为意外退出）
const stoppingApps = new Set();

// 标记应用为主动停止（重启整机关闭时预标记，退出事件不报"意外退出"）
export function markAppStopping(id) {
  stoppingApps.add(id);
}

// 启动应用（已运行则跳过并返回现有状态）
export function startApp(app) {
  const status = checkApp(app);
  if (status.running) return status;

  // 端口占用守卫：端口已被占（疑似遗留实例）时不重复启动，避免撞端口崩溃被误报"意外退出"
  if (app.ports.length) {
    const held = app.ports.find((p) => findPidByPort(p) != null);
    if (held != null) {
      log('warn', `应用 ${app.id} 端口 ${held} 已被占用（疑似已有实例在运行），跳过启动，请先停止该应用`);
      return { running: false, pid: null };
    }
  }

  // 隐藏命令行窗口：windowsHide + stdio 重定向到日志文件。
  // 包应用（js-only 约定）：直接 spawn node start.js——detached 全平台，
  // 应用真正脱离 NAS 生命周期（NAS 死亡应用存活，重启后按记录收养），
  // fd 写日志（无管道，不存在 EPIPE/句柄失效问题）
  fs.mkdirSync(APP_LOG_DIR, { recursive: true });
  const logPath = path.join(APP_LOG_DIR, `app-${app.id}.log`);

  let child;
  let script = app.script;
  if (app.package && !script) {
    // 旧版安装的条目缺 script 字段：从 command（"node" "<路径>") 解析
    const m = /^"[^"]+"\s+"([^"]+)"$/.exec(app.command || '');
    script = m ? m[1] : null;
  }
  if (app.package && script) {
    const fd = fs.openSync(logPath, 'a');
    child = spawn(process.execPath, [script], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      cwd: app.dir || ROOT,
    });
    fs.closeSync(fd);
  } else {
    // 手动登记的任意命令：经 cmd 外壳（兼容 .cmd/&& 等）
    child = spawn(app.command, {
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: app.dir || ROOT,
    });
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
  }
  child.unref();
  child.on('error', (err) => log('error', `应用 ${app.id} 启动失败: ${err.message}`));
  child.on('exit', (code, signal) => {
    // 无论何种原因退出都清除记录，保持停止状态（不自动重启）
    const progress = loadProgress();
    if (progress[app.id] === child.pid) {
      delete progress[app.id];
      saveProgress(progress);
    }
    if (stoppingApps.has(app.id)) {
      stoppingApps.delete(app.id);
      log('info', `应用 ${app.id} 已停止`);
    } else {
      log('warn', `应用 ${app.id} 意外退出 (code=${code}, signal=${signal})，保持停止状态`);
    }
  });

  const progress = loadProgress();
  progress[app.id] = child.pid;
  saveProgress(progress);
  log('info', `应用 ${app.name} (${app.id}) 已启动，PID ${child.pid}`);
  return { running: true, pid: child.pid };
}

// Unix 下向进程组发信号（应用以 setsid/detached 启动，自成进程组，可整组终止）
function killProcessGroup(pid) {
  const signal = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig); // 组不存在时退回单进程
      } catch {
        /* 已退出 */
      }
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 3000).unref();
}

// 按端口找占用进程 PID（Windows: netstat，Unix: lsof）
export function findPidByPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        if (line.includes(`:${port} `) && line.includes('LISTENING')) {
          const pid = parseInt(line.trim().split(/\s+/).pop(), 10);
          if (Number.isInteger(pid)) return pid;
        }
      }
      return null;
    }
    const out = execFileSync('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    const pids = out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n));
    return pids[0] ?? null;
  } catch {
    return null;
  }
}

// 停止应用：杀整个进程树并等待真正退出，然后删除记录。
// 记录缺失时按端口找僵尸进程一并清理（防止"启动撞端口崩溃"的死循环）
export async function stopApp(id) {
  stoppingApps.add(id); // 标记为主动停止，退出事件不再报"意外退出"
  const app = getApp(id);
  const progress = loadProgress();
  const pid = progress[id];
  if (pid != null && pidAlive(pid)) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      killProcessGroup(pid);
    }
    // 等待进程真正退出（最多 5 秒），避免后续操作（如删包目录）撞到文件占用
    const deadline = Date.now() + 5000;
    while (pidAlive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    log('info', `应用 ${id} 已停止 (PID ${pid})`);
  }
  // 记录缺失但端口仍被占：按端口找僵尸进程清掉
  if (app && app.ports.length) {
    for (const port of app.ports) {
      const zPid = findPidByPort(port);
      if (zPid != null && zPid !== pid) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(zPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          killProcessGroup(zPid);
        }
        log('info', `应用 ${id} 端口 ${port} 的僵尸进程 (PID ${zPid}) 已清理`);
      }
    }
  }
  if (progress[id] != null) {
    delete progress[id];
    saveProgress(progress);
  }
  return { running: false, pid: null };
}

// 服务启动时：按核对逻辑启动所有应用（已存活的跳过，不重复启动）
export function ensureAppsRunning() {
  if (!isStorageConfigured()) {
    log('warn', '尚未配置存储位置，跳过应用启动');
    return;
  }
  for (const app of getApps()) {
    try {
      startApp(app);
    } catch (err) {
      log('error', `应用 ${app.id} 启动异常: ${err.message}`);
    }
  }
}

// 同步应用的代理规则：第一个端口 -> /<id>，其余 -> /<id>-<port>。
// 应用规则带 app 字段标识，先清后建，不触碰手动添加的规则。
export function syncAppProxyRules(app) {
  for (const rule of getProxies().filter((r) => r.app === app.id)) {
    removeProxy(rule.path);
  }
  app.ports.forEach((port, i) => {
    const p = i === 0 ? `/${app.id}` : `/${app.id}-${port}`;
    if (isReservedPath(p)) {
      log('warn', `代理路径 ${p} 为系统保留路径，应用 ${app.id} 的端口 ${port} 跳过映射`);
      return;
    }
    if (getProxies().some((r) => r.path === p)) {
      log('warn', `代理路径 ${p} 已被占用，应用 ${app.id} 的端口 ${port} 跳过映射`);
      return;
    }
    addProxy({ path: p, port, app: app.id });
    log('info', `应用 ${app.id} 代理: ${p} -> 127.0.0.1:${port}`);
  });
}

export function removeAppProxyRules(id) {
  for (const rule of getProxies().filter((r) => r.app === id)) {
    removeProxy(rule.path);
  }
}

// 应用是否有 WebUI：代理规则中存在映射到 /<应用id> 的
export function appHasWebui(id) {
  return getProxies().some((r) => r.path === '/' + id);
}

// ========== 应用包（.tar）格式：暂存 / 安装 / 卸载 ==========
// 包结构：config.json（id/name/description(markdown)/icon/port?）+ 图标 + start/stop 程序

const ICON_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

// 运行外部命令并等待结束（失败按退出码/输出报错）
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '';
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(out.trim() || `退出码 ${code}`))));
  });
}

// Windows 10+ 自带 bsdtar，macOS/Linux 均有 tar
async function tarExtract(tarPath, destDir, entries = []) {
  await fs.promises.mkdir(destDir, { recursive: true });
  await run('tar', ['-xf', tarPath, '-C', destDir, ...entries]);
}

// 启动/停止程序统一为 start.js / stop.js（全平台，由 node 执行）；
// 需要特殊脚本操作时在 js 内自行调用（child_process 跑 bat/ps1/sh 等）
function findProgram(dir, base) {
  const f = base + '.js';
  return fs.existsSync(path.join(dir, f)) ? { file: f, node: true } : null;
}

// 把查到的程序拼成可执行命令（统一用当前 node 跑 .js）
function programCommand(dir, prog) {
  return `"${process.execPath}" "${path.join(dir, prog.file)}"`;
}

// 读取包内 config.json（容忍 UTF-8 BOM）
async function readPkgJson(file) {
  const raw = await fs.promises.readFile(file, 'utf8');
  return JSON.parse(raw.replace(/^﻿/, ''));
}

function validatePackageMeta(meta) {
  const id = String(meta.id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
    throw new Error('包 config.json 的 id 无效（字母数字及 - _，≤32 字符）');
  }
  if (getApp(id)) throw new Error(`应用 ${id} 已存在`);
  const name = String(meta.name || '').trim() || id;
  const description = typeof meta.description === 'string' ? meta.description : '';
  let icon = null;
  if (meta.icon) {
    icon = String(meta.icon).replace(/\\/g, '/');
    if (icon.startsWith('/') || icon.includes('..') || /^[A-Za-z]:/.test(icon)) {
      throw new Error('图标路径非法');
    }
  }
  let port = null;
  if (meta.port != null) {
    port = Number(meta.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('webui 端口须为 1-65535 的整数');
    if (port === PORT) throw new Error('webui 端口不可为 NAS 自身端口');
    if (isReservedPath('/' + id)) {
      throw new Error(`应用 id「${id}」与系统保留路径冲突（/api、/auth、/ws 等不可作为应用 id）`);
    }
  }
  return { id, name, description, icon, port };
}

// 暂存上传的 tar：解出 config.json 与图标用于预览，tar 本体保留供安装
export async function stageTar(buffer) {
  await fs.promises.mkdir(TMP_DIR, { recursive: true });
  const token = crypto.randomBytes(12).toString('hex');
  const tarPath = path.join(TMP_DIR, `${token}.tar`);
  await fs.promises.writeFile(tarPath, buffer);

  const extractDir = path.join(TMP_DIR, token);
  const cleanup = async () => {
    await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(tarPath, { force: true }).catch(() => {});
  };

  let meta;
  try {
    await tarExtract(tarPath, extractDir, ['config.json']);
    meta = await readPkgJson(path.join(extractDir, 'config.json'));
  } catch {
    await cleanup();
    throw new Error('不是有效的应用包（缺少可解析的 config.json）');
  }

  let info;
  try {
    info = validatePackageMeta(meta);
  } catch (err) {
    await cleanup();
    throw err;
  }

  // 提取图标（可选，缺失不阻断预览）。realpath 包含校验防符号链接逃逸
  let iconDataUri = null;
  if (info.icon) {
    try {
      await tarExtract(tarPath, extractDir, [info.icon]);
      const iconPath = path.join(extractDir, info.icon);
      const realBase = fs.realpathSync(extractDir);
      const realIcon = fs.realpathSync(iconPath);
      if (!realIcon.startsWith(realBase + path.sep)) {
        throw new Error('图标越界');
      }
      const buf = await fs.promises.readFile(iconPath);
      const mime = ICON_MIME[path.extname(info.icon).toLowerCase()] || 'application/octet-stream';
      iconDataUri = `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      iconDataUri = null;
    }
  }

  await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  return { token, meta: { ...info, iconDataUri } };
}

// 安装已暂存的 tar：完整解压到 <存储位置>/.package/<id>，登记应用并自启动
export async function installStagedTar(token) {
  if (!/^[a-f0-9]{24}$/.test(String(token))) throw new Error('无效的安装凭证');
  const tarPath = path.join(TMP_DIR, `${token}.tar`);
  if (!fs.existsSync(tarPath)) throw new Error('安装凭证已过期，请重新上传');
  const packagesRoot = packagesDir();
  if (!packagesRoot) throw new Error('尚未配置存储位置，请先在 选项 > 存储设置 > 存储位置 配置');

  // 先读 config.json 拿 id
  const peekDir = path.join(TMP_DIR, `peek-${token}`);
  let info;
  try {
    await tarExtract(tarPath, peekDir, ['config.json']);
    const meta = await readPkgJson(path.join(peekDir, 'config.json'));
    info = validatePackageMeta(meta);
  } finally {
    await fs.promises.rm(peekDir, { recursive: true, force: true }).catch(() => {});
  }

  // 完整解压到包目录
  const pkgDir = path.join(packagesRoot, info.id);
  await fs.promises.rm(pkgDir, { recursive: true, force: true }).catch(() => {});
  await tarExtract(tarPath, pkgDir);
  await fs.promises.rm(tarPath, { force: true }).catch(() => {}); // 清理暂存 tar

  // 解压后自动补 package.json：隔离 NAS 自身的 "type": "module"，包内 .js 默认按 CommonJS 解析。
  // 包作者需要 ESM 时可在包内自带 package.json（已存在则不覆盖）
  const pkgTypeFile = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgTypeFile)) {
    await fs.promises.writeFile(pkgTypeFile, JSON.stringify({ type: 'commonjs' }));
  }

  // 校验启动程序存在
  const start = findProgram(pkgDir, 'start');
  if (!start) {
    await fs.promises.rm(pkgDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('包内缺少启动程序（start.js）');
  }

  const app = {
    id: info.id,
    name: info.name,
    description: info.description,
    icon: info.icon,
    script: path.join(pkgDir, start.file),
    command: programCommand(pkgDir, start),
    ports: info.port ? [info.port] : [],
    dir: pkgDir,
    package: true,
  };
  addApp(app);
  syncAppProxyRules(app);
  startApp(app); // 安装完成即启动
  log('info', `应用 ${info.name} (${info.id}) 安装完成`);
  return app;
}

// 卸载应用：先运行停止程序，再停进程、清代理、删包目录、删配置
export async function uninstallApp(app) {
  stoppingApps.add(app.id); // 卸载全程视为主动停止
  if (app.package && app.dir) {
    const stop = findProgram(app.dir, 'stop');
    if (stop) {
      try {
        await runProgram(programCommand(app.dir, stop), app.dir);
        log('info', `应用 ${app.id} 停止程序已执行`);
      } catch (err) {
        log('warn', `应用 ${app.id} 停止程序执行失败: ${err.message}`);
      }
    }
  }
  await stopApp(app.id);
  removeAppProxyRules(app.id);
  if (app.package && app.dir) {
    try {
      await fs.promises.rm(app.dir, { recursive: true, force: true });
      log('info', `应用 ${app.id} 包文件已删除`);
    } catch (err) {
      log('warn', `删除包目录失败: ${err.message}`);
    }
  }
  // 清理应用运行日志
  await fs.promises.rm(path.join(APP_LOG_DIR, `app-${app.id}.log`), { force: true }).catch(() => {});
  removeApp(app.id);
}

function runProgram(cmd, cwd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, { shell: true, cwd, stdio: 'ignore' });
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('执行超时'));
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
