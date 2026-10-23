import { nowIso } from '../util';
import { assertSafeOutboundUrl } from './ssrf';
import { signWebhookBody } from './webhookService';

/**
 * 渠道适配器（方案 §12.4）：一切外部平台对接收敛为 ChannelAdapter 接口，内核只依赖接口。
 * 三类方法：authBind（绑定与授权状态）/ pushPublish（成果推送，含状态回查）/ fetchMetrics（表现数据回流）。
 * 新增渠道 = 新写一个适配器 + 在空间设置登记渠道配置，内核与飞轮零改动。
 * G-17 起注册表含 generic_webhook（通用 Webhook 适配器，与 MJ 并列）——ChannelAdapter 即插件足点。
 */
export interface ChannelConfig {
  baseUrl: string;
  /** 访问令牌（明文仅服务端内存/加密存储中出现，不出 DTO） */
  token: string;
  account?: string;
  /** G-17 通用 Webhook：接收端 URL（MJ 渠道不用，走 baseUrl） */
  url?: string;
  /** G-17 通用 Webhook：HMAC 签名密钥（明文仅服务端内存/加密存储中出现） */
  secret?: string;
  /** G-17 通用 Webhook：订阅事件（当前仅 'delivered'） */
  events?: string[];
}

export interface ChannelBindResult {
  bound: boolean;
  accountLabel: string;
  message: string;
}

export interface ChannelPushResult {
  /** accepted = MJ 接收进队列；success = 通用 Webhook 已接收（2xx）；failed 如实落账 */
  status: 'accepted' | 'success' | 'failed';
  remoteRef: string;
  message: string;
}

export interface ChannelMetricsResult {
  ok: boolean;
  /** G-17：渠道是否支持数据回流；false 时 UI 显示「该渠道不支持数据回流」 */
  supported?: boolean;
  /** 通用指标位：具体指标由适配器映射进此结构（如 views/likes/comments/revenue） */
  metrics: Record<string, number>;
  message: string;
}

export interface PublishPayload {
  title: string;
  content: string;
  kind: 'task_result' | 'project_bundle';
  /** 本地溯源 id（任务或项目） */
  localRef: string;
  /** G-17：交付页链接（相对路径 /d/<token>，路由层为本次推送新建交付链接后填入） */
  deliveryUrl?: string;
  /** G-17：用量摘要文案（tokens + 成本） */
  usageSummary?: string;
  totalTokens?: number;
  totalCostYuan?: number;
}

export interface ChannelAdapter {
  readonly type: string;
  authBind(config: ChannelConfig): Promise<ChannelBindResult>;
  pushPublish(config: ChannelConfig, payload: PublishPayload): Promise<ChannelPushResult>;
  fetchMetrics(config: ChannelConfig, remoteRef: string): Promise<ChannelMetricsResult>;
}

const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * MJ 平台适配器（§11.2 直推）：对接 MJ（MediaCMS 二开）侧的蜂群交付接口契约——
 *   绑定校验 GET  {baseUrl}/api/v1/users/me（Bearer 令牌）
 *   推送     POST {baseUrl}/api/v1/swarm/deliveries {title, content, kind, local_ref} → {id}
 *   回查     GET  {baseUrl}/api/v1/swarm/deliveries/{id} → {status, views, likes, comments}
 * 注意：MJ 生产侧尚未实现该组接口（生产联调未做），现网推送会以失败状态落账并写明原因，不假装成功。
 */
export class MjChannelAdapter implements ChannelAdapter {
  readonly type = 'mj';

  async authBind(config: ChannelConfig): Promise<ChannelBindResult> {
    if (!config.baseUrl) return { bound: false, accountLabel: '', message: '未配置 MJ 平台地址' };
    if (!config.token) return { bound: false, accountLabel: '', message: '未配置 MJ 访问令牌' };
    try {
      const r = await fetchWithTimeout(`${config.baseUrl.replace(/\/$/, '')}/api/v1/users/me`, {
        headers: { authorization: `Bearer ${config.token}` },
      });
      if (r.ok) {
        const j = (await r.json().catch(() => ({}))) as { username?: string; name?: string };
        return { bound: true, accountLabel: j.username || j.name || config.account || '', message: '绑定成功' };
      }
      return { bound: false, accountLabel: '', message: `MJ 校验失败（HTTP ${r.status}）` };
    } catch (e) {
      return { bound: false, accountLabel: '', message: `MJ 连接失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async pushPublish(config: ChannelConfig, payload: PublishPayload): Promise<ChannelPushResult> {
    if (!config.baseUrl || !config.token) {
      return { status: 'failed', remoteRef: '', message: 'MJ 渠道未绑定（先在设置里绑定 MJ 账号）' };
    }
    try {
      const r = await fetchWithTimeout(`${config.baseUrl.replace(/\/$/, '')}/api/v1/swarm/deliveries`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          title: payload.title,
          content: payload.content,
          kind: payload.kind,
          local_ref: payload.localRef,
        }),
      });
      if (r.ok) {
        const j = (await r.json().catch(() => ({}))) as { id?: string | number };
        return { status: 'accepted', remoteRef: String(j.id ?? ''), message: 'MJ 已接收，进入待发布队列' };
      }
      const text = await r.text().catch(() => '');
      return {
        status: 'failed',
        remoteRef: '',
        message: `MJ 推送失败（HTTP ${r.status}）${text ? `：${text.slice(0, 200)}` : ''}`,
      };
    } catch (e) {
      return { status: 'failed', remoteRef: '', message: `MJ 推送连接失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async fetchMetrics(config: ChannelConfig, remoteRef: string): Promise<ChannelMetricsResult> {
    if (!config.baseUrl || !config.token || !remoteRef) {
      return { ok: false, metrics: {}, message: 'MJ 渠道未绑定或缺少远程引用' };
    }
    try {
      const r = await fetchWithTimeout(
        `${config.baseUrl.replace(/\/$/, '')}/api/v1/swarm/deliveries/${encodeURIComponent(remoteRef)}`,
        { headers: { authorization: `Bearer ${config.token}` } },
      );
      if (!r.ok) return { ok: false, metrics: {}, message: `MJ 回查失败（HTTP ${r.status}）` };
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      const metrics: Record<string, number> = {};
      for (const k of ['views', 'likes', 'comments', 'shares', 'revenue']) {
        const v = j[k];
        if (typeof v === 'number') metrics[k] = v;
      }
      return { ok: true, metrics, message: String(j.status ?? 'ok') };
    } catch (e) {
      return { ok: false, metrics: {}, message: `MJ 回查连接失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

/**
 * 通用 Webhook 适配器（G-17）：把交付成果 POST 到用户自己的任意 HTTPS 端点。
 * - authBind：向 url 发 bind.ping 探活（HMAC 签名，signer 与 G-07 共用 signWebhookBody），
 *   2xx 才算绑定成功；探活失败把 HTTP 状态/响应摘要如实回给前端。
 * - pushPublish：payload = 标题 + 成果全文 + 交付页链接 + 用量摘要，事件 delivered；
 *   结果由路由层落 channel_pushes（success/failed 如实记）。
 * - fetchMetrics：明确 unsupported（通用端点无回流契约），UI 显示「该渠道不支持数据回流」。
 * - URL 安全：保存/探活/推送前一律走共用 SSRF 守卫 assertSafeOutboundUrl（domain/ssrf.ts 单点）。
 */
export class GenericWebhookAdapter implements ChannelAdapter {
  readonly type = 'generic_webhook';

  private endpoint(config: ChannelConfig): string {
    return (config.url ?? config.baseUrl ?? '').replace(/\/$/, '');
  }
  private secret(config: ChannelConfig): string {
    return config.secret ?? config.token ?? '';
  }

  async authBind(config: ChannelConfig): Promise<ChannelBindResult> {
    const url = this.endpoint(config);
    const secret = this.secret(config);
    if (!url) return { bound: false, accountLabel: '', message: '未配置 Webhook URL' };
    if (!secret) return { bound: false, accountLabel: '', message: '未配置签名密钥（secret）' };
    try {
      await assertSafeOutboundUrl(url);
    } catch (e) {
      return { bound: false, accountLabel: '', message: e instanceof Error ? e.message : String(e) };
    }
    const body = JSON.stringify({
      event: 'bind.ping',
      channelType: 'generic_webhook',
      occurredAt: nowIso(),
    });
    try {
      const r = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-swarm-signature': signWebhookBody(secret, body),
          'x-swarm-event': 'bind.ping',
        },
        body,
      });
      if (r.ok) {
        return { bound: true, accountLabel: url, message: '绑定成功（探活 bind.ping 已通过）' };
      }
      const text = await r.text().catch(() => '');
      return {
        bound: false,
        accountLabel: '',
        message: `探活失败（HTTP ${r.status}）${text ? `：${text.slice(0, 200)}` : ''}`,
      };
    } catch (e) {
      return {
        bound: false,
        accountLabel: '',
        message: `连接失败：${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async pushPublish(config: ChannelConfig, payload: PublishPayload): Promise<ChannelPushResult> {
    const url = this.endpoint(config);
    const secret = this.secret(config);
    if (!url || !secret) {
      return {
        status: 'failed',
        remoteRef: '',
        message: '通用 Webhook 渠道未绑定（先在设置里保存 URL 与密钥并测试绑定）',
      };
    }
    if (config.events && config.events.length > 0 && !config.events.includes('delivered')) {
      return { status: 'failed', remoteRef: '', message: '该 Webhook 未订阅 delivered 事件，未推送' };
    }
    try {
      await assertSafeOutboundUrl(url);
    } catch (e) {
      return { status: 'failed', remoteRef: '', message: e instanceof Error ? e.message : String(e) };
    }
    const body = JSON.stringify({
      event: 'delivered',
      channelType: 'generic_webhook',
      title: payload.title,
      content: payload.content,
      kind: payload.kind,
      localRef: payload.localRef,
      deliveryUrl: payload.deliveryUrl ?? null,
      usageSummary: payload.usageSummary ?? '',
      totalTokens: payload.totalTokens ?? 0,
      totalCostYuan: payload.totalCostYuan ?? 0,
      occurredAt: nowIso(),
    });
    try {
      const r = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-swarm-signature': signWebhookBody(secret, body),
          'x-swarm-event': 'delivered',
        },
        body,
      });
      if (r.ok) {
        return { status: 'success', remoteRef: '', message: `Webhook 已接收（HTTP ${r.status}）` };
      }
      const text = await r.text().catch(() => '');
      return {
        status: 'failed',
        remoteRef: '',
        message: `Webhook 推送失败（HTTP ${r.status}）${text ? `：${text.slice(0, 200)}` : ''}`,
      };
    } catch (e) {
      return {
        status: 'failed',
        remoteRef: '',
        message: `Webhook 推送连接失败：${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async fetchMetrics(): Promise<ChannelMetricsResult> {
    return { ok: false, supported: false, metrics: {}, message: '该渠道不支持数据回流' };
  }
}

/** 适配器注册表：channel_type → 适配器实例（新增渠道在此登记一行） */
export const CHANNEL_ADAPTERS: Record<string, ChannelAdapter> = {
  mj: new MjChannelAdapter(),
  generic_webhook: new GenericWebhookAdapter(),
};

export function getChannelAdapter(type: string): ChannelAdapter | undefined {
  return CHANNEL_ADAPTERS[type];
}
