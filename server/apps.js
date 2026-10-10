// 应用生命周期管理：后台启动登记的应用，PID 按应用 id 记入 .ground_progress
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApps, getApp, addApp, removeApp, getProxies, addProxy, removeProxy, PORT, BASE_PATH, NOCODE_PREFIX, RESERVED_SEGMENTS, isReservedSegment } from './config.js';
import { log } from './logger.js';
import { isReservedPath } from './proxy.js';
import { packagesDir, isStorageConfigured } from './storage.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROGRESS_PATH = path.join(ROOT, '.ground_progress');
const TMP_DIR = path.join(ROOT, 'data', 'tmp');
const APP_LOG_DIR = path.join(ROOT, 'data', 'logs');

// 应用实际监听的端口：config.json 的 port（映射到 /<id>）与 nocodeport（映射到 /nocode/<id>）。
// 用于端口占用守卫、PID 校正与僵尸进程清理（代理映射只认 app.ports，见 syncAppProxyRules）。
function listenPorts(app) {
  return [...new Set([...(app?.ports || []), ...(app?.nocodeport ? [app.nocodeport] : [])])];
}

// 进程是否存活（signal 0 仅探测不发送）
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// 取某进程的子进程列表（Windows 用 PowerShell 的 CIM 查询——新版 Windows 已移除 wmic；Unix 用 ps）
function childPids(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 }
      );
      return out
        .split(/\r?\n/)
        .map((l) => parseInt(l.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0);
    }
    const out = execFileSync('ps', ['-o', 'pid=', '--ppid', String(pid)], { encoding: 'utf8' });
    return out
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

// 沿子进程树往下找最底层的进程：手动命令是用 cmd 外壳拉起的，
// cmd 的 PID 不等于应用进程，这里换成真正的应用进程
function deepestChildPid(pid, depth = 0) {
  if (depth > 6) return pid;
  const kids = childPids(pid).filter((k) => k !== pid);
  if (!kids.length) return pid;
  // 只跟踪第一个子进程（应用通常是一条链：cmd -> node）
  return deepestChildPid(kids[0], depth + 1);
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
export async function startApp(app) {
  const status = checkApp(app);
  if (status.running) return status;

  // 端口占用守卫：端口已被占（疑似遗留实例）时不重复启动，避免撞端口崩溃被误报"意外退出"
  const ports = listenPorts(app);
  if (ports.length) {
    const held = ports.find((p) => findPidByPort(p) != null);
    if (held != null) {
      log('warn', `应用 ${app.id} 端口 ${held} 已被占用（疑似已有实例在运行），跳过启动，请先停止该应用`);
      return { running: false, pid: null };
    }
  }

  // 隐藏命令行窗口：windowsHide + stdio 重定向到日志文件。
  // 包应用：直接 spawn node main.js——detached 全平台，
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
    // 应用运行时信息：密钥与回调地址（应用可读包内 .grapenas.json，也可用同名环境变量）
    const runtimeFile = runtimeInfoFile(app);
    if (runtimeFile && app.secret) {
      try {
        fs.writeFileSync(
          runtimeFile,
          JSON.stringify(
            {
              id: app.id,
              secret: app.secret,
              base_url: `http://127.0.0.1:${PORT}${BASE_PATH}`,
              reload_sidebar: `/api/reload_sidebar/${app.id}`,
            },
            null,
            2
          )
        );
      } catch (err) {
        log('warn', `应用 ${app.id} 写入 .grapenas.json 失败: ${err.message}`);
      }
    }
    child = spawn(process.execPath, [script], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      cwd: app.dir || ROOT,
      env: {
        ...process.env,
        GRAPENAS_APP_ID: app.id,
        GRAPENAS_APP_SECRET: app.secret || '',
        GRAPENAS_BASE_URL: `http://127.0.0.1:${PORT}${BASE_PATH}`,
        GRAPENAS_DATA_DIR: app.dir || ROOT,
      },
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

  // 记录「应用自身」的 PID：Windows 下手动命令是经 cmd 外壳拉起的，
  // child.pid 是 cmd.exe 而不是真正的应用进程，因此这里再校正一次：
  //   1) 有端口时，端口占用者就是应用进程本身（最准）
  //   2) 否则沿子进程树找到最底层那个（去掉 shell 包装层）
  const spawnPid = child.pid;
  let realPid = spawnPid;
  if (ports.length) {
    for (let i = 0; i < 12 && ports.length; i++) {
      const owner = ports.map((p) => findPidByPort(p)).find((p) => p != null);
      if (owner != null) {
        realPid = owner;
        break;
      }
      await new Promise((r) => setTimeout(r, 250)); // 等应用把端口监听起来
    }
  } else if (process.platform === 'win32') {
    realPid = deepestChildPid(spawnPid);
  }

  child.on('exit', (code, signal) => {
    // 只有当前记录的进程就是本次拉起的进程时才清记录（避免与重启后的新进程互相覆盖）
    const progress = loadProgress();
    if (progress[app.id] === spawnPid || progress[app.id] === realPid) {
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
  progress[app.id] = realPid;
  saveProgress(progress);
  log('info', `应用 ${app.name} (${app.id}) 已启动，PID ${realPid}`);
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
  const ports = app ? listenPorts(app) : [];
  if (ports.length) {
    for (const port of ports) {
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
export async function ensureAppsRunning() {
  if (!isStorageConfigured()) {
    log('warn', '尚未配置存储位置，跳过应用启动');
    return;
  }
  for (const app of getApps()) {
    try {
      await startApp(app);
    } catch (err) {
      log('error', `应用 ${app.id} 启动异常: ${err.message}`);
    }
  }
}

// 同步应用的代理规则：第一个端口 -> /<id>，其余 -> /<id>-<port>；
// config.json 里声明了 nocodeport 时，额外生成 /nocode/<id>（该路径不校验访问码）。
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

  // 免访问码端口：/nocode/<应用id> -> 127.0.0.1:<nocodeport>
  if (app.nocodeport) {
    const p = `${NOCODE_PREFIX}/${app.id}`;
    if (getProxies().some((r) => r.path === p)) {
      log('warn', `代理路径 ${p} 已被占用，应用 ${app.id} 的 nocodeport ${app.nocodeport} 跳过映射`);
      return;
    }
    addProxy({ path: p, port: app.nocodeport, app: app.id, nocode: true });
    log('warn', `应用 ${app.id} 免访问码代理已开启: ${p} -> 127.0.0.1:${app.nocodeport}（该路径无需访问码）`);
  }
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
// 包结构：config.json（id/name/description(markdown)/icon/port?/nocodeport?/sidebar?）+ 图标 + main.js

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

// 应用包唯一入口：main.js（由 node 执行）。
// 不再区分 start/stop：进程 PID 记在 .ground_progress 里用于校验，
// main.js 一退出就等于应用停止（需要收尾就在 main.js 里监听 SIGINT/SIGTERM）
export const APP_ENTRY = 'main.js';

function findEntry(dir) {
  return fs.existsSync(path.join(dir, APP_ENTRY)) ? { file: APP_ENTRY, node: true } : null;
}

// 拼成可执行命令（统一用当前 node 跑 main.js）
function programCommand(dir) {
  return `"${process.execPath}" "${path.join(dir, APP_ENTRY)}"`;
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
  if (isReservedSegment(id)) {
    throw new Error(`应用 id 不可为 ${RESERVED_SEGMENTS.join(' / ')}（与系统保留路径冲突）`);
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
  // 免访问码端口：该端口的服务代理到 /nocode/<id>，此路径不校验访问码
  let nocodeport = null;
  if (meta.nocodeport != null) {
    nocodeport = Number(meta.nocodeport);
    if (!Number.isInteger(nocodeport) || nocodeport < 1 || nocodeport > 65535) {
      throw new Error('nocodeport 须为 1-65535 的整数');
    }
    if (nocodeport === PORT) throw new Error('nocodeport 不可为 NAS 自身端口');
  }

  // 可选：侧边栏入口（iconsvg / sidebar_name / page，均为包内相对路径）
  let sidebar = null;
  if (meta.sidebar && typeof meta.sidebar === 'object') {
    const rel = (v, label) => {
      const p = String(v || '').replace(/\\/g, '/').trim();
      if (!p) throw new Error(`sidebar 缺少 ${label}`);
      if (p.startsWith('/') || p.includes('..') || /^[A-Za-z]:/.test(p)) {
        throw new Error(`sidebar.${label} 路径非法`);
      }
      return p;
    };
    const sidebarName = String(meta.sidebar.sidebar_name || '').trim();
    if (!sidebarName) throw new Error('sidebar 缺少 sidebar_name');
    sidebar = {
      iconsvg: rel(meta.sidebar.iconsvg, 'iconsvg'),
      sidebar_name: sidebarName,
      page: rel(meta.sidebar.page, 'page'),
    };
  }
  return { id, name, description, icon, port, nocodeport, sidebar };
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

  // 校验入口存在
  const entry = findEntry(pkgDir);
  if (!entry) {
    await fs.promises.rm(pkgDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`包内缺少入口程序（${APP_ENTRY}）`);
  }

  // 侧边栏：声明的图标与页面片段必须真实存在于包内
  if (info.sidebar) {
    for (const [field, rel] of [
      ['iconsvg', info.sidebar.iconsvg],
      ['page', info.sidebar.page],
    ]) {
      const target = path.join(pkgDir, rel);
      if (!target.startsWith(pkgDir + path.sep) || !fs.existsSync(target)) {
        await fs.promises.rm(pkgDir, { recursive: true, force: true }).catch(() => {});
        throw new Error(`sidebar.${field} 指向的文件不存在: ${rel}`);
      }
    }
  }

  const app = {
    id: info.id,
    name: info.name,
    description: info.description,
    icon: info.icon,
    script: path.join(pkgDir, entry.file),
    command: programCommand(pkgDir),
    ports: info.port ? [info.port] : [],
    dir: pkgDir,
    package: true,
    // 每应用密钥：应用调 /api/reload_sidebar 等接口时用它证明身份
    secret: crypto.randomBytes(16).toString('hex'),
  };
  // 免访问码端口（可选）：映射到 /nocode/<id>，不需要访问码即可访问
  if (info.nocodeport) app.nocodeport = info.nocodeport;
  if (info.sidebar) app.sidebar = info.sidebar;

  // 侧边栏入口：sidebar.json（多入口）为主，config.json 的 sidebar（单入口）兼容保留
  const sidebarEntries = readAppSidebar(app);
  if (sidebarEntries) {
    for (const [i, entry] of sidebarEntries.entries()) {
      for (const rel of [entry.iconsvg, entry.page]) {
        const target = path.join(pkgDir, rel);
        if (!target.startsWith(pkgDir + path.sep) || !fs.existsSync(target)) {
          await fs.promises.rm(pkgDir, { recursive: true, force: true }).catch(() => {});
          throw new Error(`sidebar.json 第 ${i + 1} 项的 ${rel} 不存在`);
        }
      }
    }
    log('info', `应用 ${info.id} 声明了 ${sidebarEntries.length} 个侧边栏入口`);
  }
  addApp(app);
  syncAppProxyRules(app);
  await startApp(app); // 安装完成即启动
  log('info', `应用 ${info.name} (${info.id}) 安装完成`);
  return app;
}

// 卸载应用：停掉 main.js（连同子进程）→ 清代理 → 删包目录 → 删配置
// 不再有 stop.js：需要收尾就在 main.js 里监听 SIGTERM
// 读取应用包里的 sidebar.json（侧边栏入口声明，可选）。
// 格式：[{ "iconsvg": "icon.svg", "sidebar_name": "名字", "page": "web/x.html" }, ...]
// 返回 null 表示包里没有这个文件；返回 [] 表示有文件但没有任何有效入口。
export function readAppSidebar(app) {
  if (!app || !app.dir) return null;
  const file = path.join(app.dir, 'sidebar.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    log('warn', `应用 ${app.id} 的 sidebar.json 不是合法 JSON: ${err.message}`);
    return [];
  }
  if (!Array.isArray(list)) {
    log('warn', `应用 ${app.id} 的 sidebar.json 必须是数组`);
    return [];
  }
  const out = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const name = String(item.sidebar_name || '').trim();
    const page = String(item.page || '').replace(/\\/g, '/').trim();
    const icon = String(item.iconsvg || '').replace(/\\/g, '/').trim();
    if (!name || !page || !icon) {
      log('warn', `应用 ${app.id} 的 sidebar.json 第 ${i + 1} 项缺少 sidebar_name/page/iconsvg，已跳过`);
      return;
    }
    const bad = (p) => p.startsWith('/') || p.includes('..') || /^[A-Za-z]:/.test(p);
    if (bad(page) || bad(icon)) {
      log('warn', `应用 ${app.id} 的 sidebar.json 第 ${i + 1} 项路径非法，已跳过`);
      return;
    }
    out.push({ iconsvg: icon, sidebar_name: name, page });
  });
  return out;
}

// 应用自身进程可读的运行时信息（密钥等）
export function runtimeInfoFile(app) {
  return app && app.dir ? path.join(app.dir, '.grapenas.json') : null;
}

export async function uninstallApp(app) {
  stoppingApps.add(app.id); // 卸载全程视为主动停止
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
