import * as crypto from 'crypto';
import { TaskStatus, WEBHOOK_DELIVERY } from '@swarm/shared';
import type { Logger } from '../logger';
import { decryptKey } from '../store/crypto';
import type { Repos, TaskRow, WebhookDeliveryRow, WebhookRow } from '../store/repositories';
import { nowIso } from '../util';
import { notifyOwner } from './notify';

/**
 * Webhook 事件外推（G-07）：任务终态 → webhook_deliveries 行 → 独立投递循环 POST。
 * 与 G-17 渠道适配器（成果推送）是两回事：本条只推「状态事件」，表与触发点各自独立；
 * 仅共用 HMAC 签名工具（signWebhookBody）与 SSRF 守卫（domain/ssrf.ts）。
 *
 * 触发点：domain 状态机统一迁移函数 transitionTask 在成功迁移后旁路调用
 * enqueueTaskEventDeliveries（done→task.done、转待裁决→task.adjudication、已取消→task.failed），
 * 落行失败吞掉记日志，绝不阻断状态迁移（口径同 task_events/task_steps 旁路）。
 * task.failed 口径：本状态机无独立 failed 状态，终局失败 = 已取消终态
 * （含停工后老板取消等路径），以 task_events 的 to_status='已取消' 为准。
 */

/** HMAC 签名（G-07 与 G-17 共用 signer）：X-Swarm-Signature: sha256=<hex> */
export function signWebhookBody(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** 终态映射：状态机状态 → Webhook 事件名（非终态返回 null） */
export function webhookEventForStatus(status: string): string | null {
  if (status === TaskStatus.DONE) return 'task.done';
  if (status === TaskStatus.ADJUDICATION) return 'task.adjudication';
  if (status === TaskStatus.CANCELLED) return 'task.failed';
  return null;
}

function parseEvents(json: string): string[] {
  try {
    const v = JSON.parse(json || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 任务终态事件 → 为本空间每个启用且订阅了该事件的 Webhook 生成一条 pending 投递 */
export function enqueueTaskEventDeliveries(repos: Repos, task: TaskRow, logger?: Logger): void {
  try {
    const event = webhookEventForStatus(task.status);
    if (!event) return;
    const workspaceId = task.workspace_id ?? null;
    if (!workspaceId) return;
    const hooks = repos
      .listWebhooks(workspaceId)
      .filter((h) => h.enabled === 1 && parseEvents(h.events).includes(event));
    if (!hooks.length) return;
    const payload = JSON.stringify({
      event,
      taskId: task.id,
      workspaceId,
      task: {
        id: task.id,
        title: task.title,
        type: task.type,
        status: task.status,
        projectId: task.project_id,
        totalTokens: task.total_tokens,
      },
      occurredAt: nowIso(),
    });
    for (const h of hooks) {
      repos.insertWebhookDelivery({
        webhook_id: h.id,
        workspace_id: workspaceId,
        event,
        task_id: task.id,
        payload,
        status: 'pending',
        attempts: 0,
        last_error: null,
        next_retry_at: nowIso(),
        created_at: nowIso(),
        updated_at: nowIso(),
      });
    }
  } catch (e) {
    logger?.warn('webhook', `投递落行失败（已忽略）：${e instanceof Error ? e.message : String(e)}`, {
      taskId: task.id,
    });
  }
}

/** 重试退避（ms）：默认设计口径 1m/5m/15m；测试可用 SWARM_WEBHOOK_RETRY_DELAYS_MS="100,200,300" 覆盖 */
export function retryDelaysMs(): number[] {
  const raw = process.env.SWARM_WEBHOOK_RETRY_DELAYS_MS;
  if (raw) {
    const parsed = raw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (parsed.length) return parsed;
  }
  return [...WEBHOOK_DELIVERY.RETRY_DELAYS_MS];
}

async function postWithTimeout(
  url: string,
  body: string,
  signature: string,
  event: string,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), WEBHOOK_DELIVERY.TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-swarm-signature': signature,
        'x-swarm-event': event,
      },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * 尝试投递一条：2xx → success；失败 attempts+1，未达上限按退避排下次，
 * 达上限（总尝试 3 次）→ failed + notifyOwner(type='webhook_failed') 通知空间所有者。
 * 返回投递后的最新行。网络异常按失败处理（原文进 last_error）。
 */
export async function attemptWebhookDelivery(
  repos: Repos,
  delivery: WebhookDeliveryRow,
  logger?: Logger,
): Promise<WebhookDeliveryRow> {
  const hook = repos.getWebhook(delivery.webhook_id);
  if (!hook) {
    repos.updateWebhookDelivery(delivery.id, { status: 'failed', last_error: 'Webhook 已删除' });
    return repos.getWebhookDelivery(delivery.id) ?? delivery;
  }
  const secret = decryptKey(hook.secret_enc);
  const signature = signWebhookBody(secret, delivery.payload);
  const attempts = delivery.attempts + 1;
  let errorText: string | null = null;
  try {
    const r = await postWithTimeout(hook.url, delivery.payload, signature, delivery.event);
    if (r.ok) {
      repos.updateWebhookDelivery(delivery.id, {
        status: 'success',
        attempts,
        last_error: null,
        next_retry_at: null,
      });
      logger?.info('webhook', `投递成功 ${delivery.event} → ${hook.url}（第 ${attempts} 次）`, {
        taskId: delivery.task_id ?? undefined,
      });
      return repos.getWebhookDelivery(delivery.id) ?? delivery;
    }
    const text = await r.text().catch(() => '');
    errorText = `HTTP ${r.status}${text ? `：${text.slice(0, 200)}` : ''}`;
  } catch (e) {
    errorText = e instanceof Error ? e.message : String(e);
  }
  if (attempts >= WEBHOOK_DELIVERY.MAX_ATTEMPTS) {
    repos.updateWebhookDelivery(delivery.id, {
      status: 'failed',
      attempts,
      last_error: errorText,
      next_retry_at: null,
    });
    logger?.warn('webhook', `投递终败 ${delivery.event} → ${hook.url}：${errorText}`, {
      taskId: delivery.task_id ?? undefined,
    });
    // 终败通知所有者（G-03 通道 type='webhook_failed' 已注册；同任务未读去重口径不变）
    try {
      notifyOwner(
        repos,
        delivery.workspace_id,
        'webhook_failed',
        'Webhook 投递失败',
        `Webhook「${hook.url}」的 ${delivery.event} 事件投递连续失败 ${attempts} 次：${errorText ?? ''}`,
        delivery.task_id,
      );
    } catch {
      /* 通知失败不影响投递状态落库 */
    }
  } else {
    const delays = retryDelaysMs();
    const delay = delays[Math.min(attempts - 1, delays.length - 1)] ?? 60_000;
    repos.updateWebhookDelivery(delivery.id, {
      status: 'pending',
      attempts,
      last_error: errorText,
      next_retry_at: new Date(Date.now() + delay).toISOString(),
    });
    logger?.warn('webhook', `投递失败（第 ${attempts} 次，${delay}ms 后重试）：${errorText}`, {
      taskId: delivery.task_id ?? undefined,
    });
  }
  return repos.getWebhookDelivery(delivery.id) ?? delivery;
}

/** 投递循环一轮：处理全部到期 pending（由 index.ts 的独立 interval 驱动，节奏见 SWARM_WEBHOOK_TICK_MS） */
export async function processDueWebhookDeliveries(repos: Repos, logger?: Logger): Promise<number> {
  const due = repos.listDueWebhookDeliveries(nowIso(), 20);
  for (const d of due) {
    try {
      await attemptWebhookDelivery(repos, d, logger);
    } catch (e) {
      logger?.error('webhook', `投递处理异常：${e instanceof Error ? e.message : String(e)}`, {
        taskId: d.task_id ?? undefined,
      });
    }
  }
  return due.length;
}

/** Webhook 行 → 对外 DTO 拼装辅助（secret 只出掩码） */
export function webhookDtoOf(hook: WebhookRow, mask: (plain: string) => string): {
  id: string;
  url: string;
  secretMasked: string;
  hasSecret: boolean;
  events: string[];
  enabled: boolean;
  createdAt: string;
} {
  const secret = decryptKey(hook.secret_enc);
  return {
    id: hook.id,
    url: hook.url,
    secretMasked: secret ? mask(secret) : '',
    hasSecret: !!secret,
    events: parseEvents(hook.events),
    enabled: hook.enabled === 1,
    createdAt: hook.created_at,
  };
}
