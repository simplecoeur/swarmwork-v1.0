import * as dns from 'dns';
import * as net from 'net';
import { DomainError } from './taskService';

/**
 * 出站 URL SSRF 守卫（G-07 落地、G-17 渠道适配器共用——单点实现，勿写第二份）。
 * 落点：domain/ssrf.ts 的 assertSafeOutboundUrl()。G-17 的 GenericWebhookAdapter 在
 * 保存配置/绑定探活前必须调用同一函数校验渠道 url，与 Webhook 创建校验完全同口径。
 *
 * 口径（沿用 VULN-003 教训）：
 * - 仅允许 https；开发例外须显式开关 SWARM_WEBHOOK_ALLOW_INSECURE=1（允许 http + 私网，绝不默认开）。
 * - 主机名解析后的任一 IP 落在 loopback / link-local（含云元数据 169.254.169.254）/
 *   私网 / 组播 / 未指定段 → 拒绝创建。字面 IP 直接判定；域名经 DNS 解析后逐个判定。
 * - 解析失败按拒绝处理（无法证明安全即不放行）。
 */
export function webhookAllowInsecure(): boolean {
  return process.env.SWARM_WEBHOOK_ALLOW_INSECURE === '1';
}

function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map((s) => Number(s));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 未指定/源地址段
  if (a === 10) return true; // 私网
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local（含 169.254.169.254 云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网
  if (a === 192 && b === 168) return true; // 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 共享段
  if (a === 192 && b === 0) return true; // IETF 特殊段
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试段
  if (a >= 224) return true; // 组播 + 保留（含 255.255.255.255）
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / 未指定
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA 私网
  if (lower.startsWith('ff')) return true; // 组播
  // IPv4-mapped（::ffff:a.b.c.d）按内嵌 v4 判定
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  return false;
}

export function ipBlocked(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Blocked(ip);
  if (fam === 6) return ipv6Blocked(ip);
  return true;
}

/**
 * 校验出站 URL 安全性；不安全抛 DomainError(VALIDATION)（路由层回 400）。
 * allowInsecure 缺省读环境开关；显式传参供单测/特殊调用点覆盖。
 */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  opts: { allowInsecure?: boolean } = {},
): Promise<URL> {
  const allowInsecure = opts.allowInsecure ?? webhookAllowInsecure();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainError('VALIDATION', `URL 格式不正确：${rawUrl}`);
  }
  if (allowInsecure) return url; // 开发例外（显式开关）：跳过协议与私网校验，仅本地联调用
  if (url.protocol !== 'https:') {
    throw new DomainError('VALIDATION', 'Webhook URL 仅允许 https（开发例外须显式开启 SWARM_WEBHOOK_ALLOW_INSECURE）');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new DomainError('VALIDATION', 'URL 缺少主机名');
  if (host.toLowerCase() === 'localhost') {
    throw new DomainError('VALIDATION', 'Webhook URL 指向本机/内网地址，已拒绝（SSRF 守卫）');
  }
  let ips: string[];
  if (net.isIP(host)) {
    ips = [host];
  } else {
    try {
      const records = await dns.promises.lookup(host, { all: true, verbatim: true });
      ips = records.map((r) => r.address);
    } catch {
      throw new DomainError('VALIDATION', `Webhook URL 主机名无法解析：${host}`);
    }
    if (!ips.length) throw new DomainError('VALIDATION', `Webhook URL 主机名无法解析：${host}`);
  }
  for (const ip of ips) {
    if (ipBlocked(ip)) {
      throw new DomainError(
        'VALIDATION',
        `Webhook URL 解析到本机/内网/云元数据地址（${ip}），已拒绝（SSRF 守卫）`,
      );
    }
  }
  return url;
}
