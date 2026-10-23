import * as crypto from 'crypto';
import argon2 from 'argon2';

/**
 * 账号安全（方案 §2.2）：密码 argon2id 哈希；服务端 session（库里只存 token 哈希）；
 * Cookie HttpOnly + SameSite=Lax，Secure 由环境变量 SWARM_COOKIE_SECURE=1 开启（HTTPS 部署时打开）。
 */
export const SESSION_COOKIE = 'swarm_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 滑动续期：剩余有效期不足一半时续到 7 天 */
export const SESSION_RENEW_BELOW_MS = SESSION_TTL_MS / 2;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

/**
 * 注册风控（一期简单规则，方案 §2 v2 两档开通）：
 * 同 IP 在窗口内注册达到上限 → 走 pending 待管理员审核；或平台全局开关 requireApproval 开启 → pending。
 * 其余个人空间即时开通（active + 自动建个人 workspace）。
 */
export const REGISTRATION_RISK = {
  WINDOW_MS: 10 * 60 * 1000,
  MAX_PER_IP: 3,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function cookieSecure(): boolean {
  return process.env.SWARM_COOKIE_SECURE === '1';
}

export function sessionCookieHeader(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (cookieSecure()) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader(): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (cookieSecure()) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** 管理员重置/初始口令等场景的临时密码（只出现一次，不落日志） */
export function generateTempPassword(): string {
  return crypto.randomBytes(9).toString('base64url');
}
