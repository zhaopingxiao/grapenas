// 访问码与临时令牌管理
import crypto from 'node:crypto';
import { getAccessCodeSecret, saveAccessCode, isAccessCodeSet } from './config.js';

const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 临时令牌有效期 7 天
const tokens = new Map(); // token -> expiresAt

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

export function createToken() {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, Date.now() + TOKEN_TTL);
  return token;
}

export function validateToken(token) {
  if (!token) return false;
  const expiresAt = tokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    tokens.delete(token);
    return false;
  }
  return true;
}

export function revokeToken(token) {
  tokens.delete(token);
}

// 定期清理过期令牌
setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of tokens) {
    if (now > expiresAt) tokens.delete(token);
  }
}, 60 * 1000).unref();
