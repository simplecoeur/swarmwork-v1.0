import * as crypto from 'crypto';
import * as os from 'os';

/**
 * API Key 落盘加密（设计 §11 本地版口径：机器派生密钥）。
 * 派生材料 = 主机名 + 用户名（scrypt），AES-256-GCM；密文格式 v1:base64(iv|tag|cipher)。
 * 换机器/换用户将无法解密 → 返回空并由上层提示重新填 Key。
 */
let cachedKey: Buffer | null = null;

function machineKey(): Buffer {
  if (!cachedKey) {
    const material = `agent-swarm:${os.hostname()}:${os.userInfo().username}`;
    cachedKey = crypto.scryptSync(material, 'agent-swarm-key-v1', 32);
  }
  return cachedKey;
}

export function encryptKey(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', machineKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptKey(enc: string): string {
  if (!enc) return '';
  if (!enc.startsWith('v1:')) return '';
  try {
    const buf = Buffer.from(enc.slice(3), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', machineKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** 掩码：仅保留前 3 与后 4（设计 §11），响应与日志只允许出现掩码 */
export function maskKey(plain: string): string {
  if (!plain) return '';
  if (plain.length <= 7) return '••••';
  return plain.slice(0, 3) + '••••' + plain.slice(-4);
}
