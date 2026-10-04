// 访问码与临时令牌管理 + 用户（管理员账号）管理
// 登录分两关：访问码（保留）→ 账号密码（用户管理开启时才要）。
// 令牌带"等级"，开启用户管理后，只有走完全部关卡签发的令牌才算已认证。
import crypto from 'node:crypto';
import {
  getAccessCodeSecret,
  saveAccessCode,
  isAccessCodeSet,
  getUser,
  hasUser,
  saveUser,
  getUserAuthEnabled,
} from './config.js';

const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 临时令牌有效期 7 天
const tokens = new Map(); // token -> { expiresAt, level }
export const LEVEL_CODE = 'code'; // 只过了访问码
export const LEVEL_FULL = 'full'; // 访问码 + 账号密码

function hashCode(code, salt) {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

export function isValidCodeFormat(code) {
  return typeof code === 'string' && /^\d{8}$/.test(code);
}

export function verifyAccessCode(code) {
  if (!isAccessCodeSet() || !isValidCodeFormat(code)) return false;
  const { hash, salt } = getAccessCodeSecret();
  const candidate = hashCode(code, salt);
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}

// 首次初始化（仅当未设置过时可用）
export function setupAccessCode(code) {
  if (isAccessCodeSet() || !isValidCodeFormat(code)) return false;
  const salt = crypto.randomBytes(16).toString('hex');
  saveAccessCode(hashCode(code, salt), salt);
  return true;
}

export function changeAccessCode(oldCode, newCode) {
  if (!verifyAccessCode(oldCode) || !isValidCodeFormat(newCode)) return false;
  const salt = crypto.randomBytes(16).toString('hex');
  saveAccessCode(hashCode(newCode, salt), salt);
  return true;
}

// ---------- 用户（测试阶段：只有一个管理员） ----------

// 是否需要校验账号密码：开关开着、并且真的建过账号
export function userAuthRequired() {
  return getUserAuthEnabled() && hasUser();
}

// 直接复用 config 里的判断（供 ws / index 层用）
export { hasUser, getUser, getUserAuthEnabled };

export function isValidUsername(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{2,32}$/.test(name);
}

export function isValidPassword(pwd) {
  return typeof pwd === 'string' && pwd.length >= 6 && pwd.length <= 128;
}

// scrypt 加盐哈希：密码不落明文
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, user) {
  if (!user || !user.hash || !user.salt) return false;
  const candidate = crypto.scryptSync(String(password || ''), user.salt, 64).toString('hex');
  const a = Buffer.from(candidate);
  const b = Buffer.from(user.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 创建/修改管理员账号（测试阶段固定一个用户）
export function setAdminUser(username, password) {
  if (!isValidUsername(username)) return { ok: false, error: '账号需 2-32 位字母、数字、下划线、点或短横线' };
  if (!isValidPassword(password)) return { ok: false, error: '密码至少 6 位' };
  const { hash, salt } = hashPassword(password);
  saveUser({ username: String(username), hash, salt, createdAt: Date.now() });
  return { ok: true };
}

export function userInfo() {
  const u = getUser();
  return {
    enabled: getUserAuthEnabled(),
    username: u ? u.username : null,
    hasUser: Boolean(u),
    createdAt: u ? u.createdAt : null,
  };
}

// ---------- 临时令牌 ----------

export function createToken(level = LEVEL_FULL) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { expiresAt: Date.now() + TOKEN_TTL, level });
  return token;
}

export function validateToken(token) {
  if (!token) return false;
  const rec = tokens.get(token);
  if (!rec) return false;
  if (Date.now() > rec.expiresAt) {
    tokens.delete(token);
    return false;
  }
  // 开启用户管理后，只过了访问码的令牌不算通过
  if (userAuthRequired() && rec.level !== LEVEL_FULL) return false;
  return true;
}

export function tokenLevel(token) {
  const rec = token ? tokens.get(token) : null;
  return rec ? rec.level : null;
}

// 让所有已签发的令牌作废（用户管理开关变化时用：避免留下半认证会话）
export function revokeAllTokens() {
  const count = tokens.size;
  tokens.clear();
  return count;
}

// 定期清理过期令牌
setInterval(() => {
  const now = Date.now();
  for (const [token, rec] of tokens) {
    if (now > rec.expiresAt) tokens.delete(token);
  }
}, 60 * 1000).unref();
