// 存储位置管理：<存储位置>/user（我的文件）+ <存储位置>/.package（应用数据）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStoragePath as cfgGet, setStoragePath as cfgSet, getApps, updateApp } from './config.js';
import { log } from './logger.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LEGACY_PACKAGES = path.join(ROOT, 'data', 'packages');

export function isStorageConfigured() {
  return Boolean(cfgGet());
}

export function getStoragePath() {
  return cfgGet();
}

// 应用包目录：<存储位置>/.package（未配置时返回 null）
export function packagesDir() {
  const root = cfgGet();
  return root ? path.join(root, '.package') : null;
}

// 校验并规范化存储路径：绝对路径、不得在源码目录内、不得为磁盘根
export function validateStoragePath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('请填写存储位置');
  const resolved = path.resolve(p.trim());
  if (resolved === ROOT || resolved.startsWith(ROOT + path.sep)) {
    throw new Error('存储位置不可位于葡萄云源码目录内');
  }
  if (path.parse(resolved).root === resolved) throw new Error('存储位置不可为磁盘根目录');
  return resolved;
}

// 存储根下的安全解析（防路径穿越），rel 为空表示根
export function resolveStoragePath(rel) {
  const root = cfgGet();
  if (!root) throw new Error('尚未配置存储位置');
  const target = path.resolve(root, String(rel || ''));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('路径越界');
  return target;
}

function ensureLayout(root) {
  fs.mkdirSync(path.join(root, 'user'), { recursive: true });
  fs.mkdirSync(path.join(root, '.package'), { recursive: true });
}

// 跨卷移动：rename 失败（EXDEV）时复制+删除
function moveEntry(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV' && err.code !== 'EPERM') throw err;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// 迁移已安装应用的 dir/script/command 到新包目录
function migrateAppPaths(oldPackages, newPackages) {
  if (!fs.existsSync(newPackages)) fs.mkdirSync(newPackages, { recursive: true });
  for (const app of getApps()) {
    if (!app.dir || !app.dir.startsWith(oldPackages + path.sep)) continue;
    const rel = path.relative(oldPackages, app.dir);
    const newDir = path.join(newPackages, rel);
    const scriptName = app.script ? path.basename(app.script) : null;
    updateApp(app.id, {
      dir: newDir,
      script: scriptName ? path.join(newDir, scriptName) : app.script,
      command: scriptName ? `"${process.execPath}" "${path.join(newDir, scriptName)}"` : app.command,
    });
    log('info', `应用 ${app.id} 路径已迁移: ${app.dir} -> ${newDir}`);
  }
}

// 设置存储位置（含数据迁移）
export function setStoragePath(p) {
  const newPath = validateStoragePath(p);
  const oldPath = cfgGet();
  if (oldPath === newPath) return newPath;
  if (oldPath && (newPath.startsWith(oldPath + path.sep) || oldPath.startsWith(newPath + path.sep))) {
    throw new Error('新存储位置不可与当前存储位置互相包含');
  }

  if (oldPath && fs.existsSync(oldPath)) {
    // 重新设置：把当前存储位置的数据剪切到新位置
    ensureLayout(newPath);
    for (const entry of fs.readdirSync(oldPath)) {
      moveEntry(path.join(oldPath, entry), path.join(newPath, entry));
    }
    migrateAppPaths(path.join(oldPath, '.package'), path.join(newPath, '.package'));
    log('info', `存储位置已迁移: ${oldPath} -> ${newPath}`);
  } else {
    // 首次配置：创建布局，并把历史 data/packages 迁入 <新位置>/.package
    ensureLayout(newPath);
    const newPackages = path.join(newPath, '.package');
    if (fs.existsSync(LEGACY_PACKAGES)) {
      for (const entry of fs.readdirSync(LEGACY_PACKAGES)) {
        moveEntry(path.join(LEGACY_PACKAGES, entry), path.join(newPackages, entry));
      }
      migrateAppPaths(LEGACY_PACKAGES, newPackages);
      log('info', `历史应用包已迁移到存储: ${newPackages}`);
    }
  }
  cfgSet(newPath);
  return newPath;
}
