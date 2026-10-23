/**
 * 渠道适配器（方案 §12.4）：一切外部平台对接收敛为 ChannelAdapter 接口，内核只依赖接口。
 * 三类方法：authBind（绑定与授权状态）/ pushPublish（成果推送，含状态回查）/ fetchMetrics（表现数据回流）。
 * 新增渠道 = 新写一个适配器 + 在空间设置登记渠道配置，内核与飞轮零改动。
 */
export interface ChannelConfig {
  baseUrl: string;
  /** 访问令牌（明文仅服务端内存/加密存储中出现，不出 DTO） */
  token: string;
  account?: string;
}

export interface ChannelBindResult {
  bound: boolean;
  accountLabel: string;
  message: string;
}

export interface ChannelPushResult {
  status: 'accepted' | 'failed';
  remoteRef: string;
  message: string;
}

export interface ChannelMetricsResult {
  ok: boolean;
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

/** 适配器注册表：channel_type → 适配器实例（新增渠道在此登记一行） */
export const CHANNEL_ADAPTERS: Record<string, ChannelAdapter> = {
  mj: new MjChannelAdapter(),
};

export function getChannelAdapter(type: string): ChannelAdapter | undefined {
  return CHANNEL_ADAPTERS[type];
}
