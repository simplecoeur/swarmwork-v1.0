import { nowIso } from '../util';
import type { Repos } from '../store/repositories';

/**
 * 站内提醒（M8 §9 + G-03 站内完整化）：待裁决 / 余额耗尽 / 打回满次转裁决 → 直达空间所有者。
 * 去重口径：同一空间+类型+任务已有未读提醒时不重复生成（引擎每 tick 可能反复命中同一停工原因）。
 *
 * G-03 通道与偏好：
 * - type 枚举扩展：新增 balance_low（G-08）/ schedule_result（G-10）/ webhook_failed（G-07）/
 *   impersonation（G-14）/ transfer（G-15）——本条只落通道与偏好，触发点在各来源条目内注册。
 * - 落库前查空间所有者的 notifyPrefs（user_preferences）：inapp[<type>] === false 则不落站内通知。
 * - 分发结构按「站内 channel 已实现、mail channel 未启用即跳过」落码：邮件通道暂缓，
 *   settings.notifyConfig 的 mailChannel 恒为 'reserved-not-implemented'，本模块不发信；
 *   notifyPrefs.mail 字段位已预留，待 G-01 接回后在此分发 mail channel 并放出 UI 开关。
 */
export type NotificationType =
  | 'adjudication'
  | 'balance'
  | 'trial_exhausted'
  | 'reject_max'
  | 'balance_low'
  | 'schedule_result'
  | 'webhook_failed'
  | 'impersonation'
  | 'transfer';

export const NOTIFICATION_TYPES: NotificationType[] = [
  'adjudication',
  'balance',
  'trial_exhausted',
  'reject_max',
  'balance_low',
  'schedule_result',
  'webhook_failed',
  'impersonation',
  'transfer',
];

export interface NotifyPrefs {
  inapp: { [type: string]: boolean };
  /** 预留位：邮件逐类型开关（邮件暂缓，本版不消费、不展示） */
  mail?: { [type: string]: boolean };
}

/** 读某用户的通知偏好（缺省全开）；解析失败按全开处理，绝不因偏好损坏吞掉提醒 */
export function getNotifyPrefs(repos: Repos, userId: string): NotifyPrefs {
  const raw = repos.getPreference<NotifyPrefs | null>(userId, 'notifyPrefs', null);
  const inapp =
    raw && typeof raw === 'object' && raw.inapp && typeof raw.inapp === 'object' ? raw.inapp : {};
  return { inapp, mail: raw?.mail };
}

/** 站内开关：显式 false 才关，其余（未设/true）为开 */
export function inappEnabled(repos: Repos, userId: string, type: NotificationType): boolean {
  return getNotifyPrefs(repos, userId).inapp[type] !== false;
}

export function notifyOwner(
  repos: Repos,
  workspaceId: string,
  type: NotificationType,
  title: string,
  body: string,
  taskId: string | null,
): void {
  const ws = repos.getWorkspace(workspaceId);
  const ownerId = ws?.owner_user_id ?? null;

  /* ---- mail channel（暂缓）：notifyConfig.mailChannel='reserved-not-implemented' 即未启用，跳过 ---- */
  const cfg = repos.getSetting<{ emailEnabled?: boolean; email?: string }>(
    'notifyConfig',
    { emailEnabled: false, email: '' },
    workspaceId,
  );
  const mailChannel: string = 'reserved-not-implemented';
  if (mailChannel !== 'reserved-not-implemented' && cfg.emailEnabled && cfg.email) {
    // 接回点（G-01 落地后）：按 notifyPrefs.mail[<type>] 分发邮件。本版恒不进入。
  }

  /* ---- inapp channel：偏好关掉该类型则不落库 ---- */
  if (ownerId && !inappEnabled(repos, ownerId, type)) return;

  if (repos.hasUnreadNotification(workspaceId, type, taskId)) return;
  repos.insertNotification({
    workspace_id: workspaceId,
    user_id: ownerId,
    type,
    title,
    body,
    task_id: taskId,
    read_at: null,
    created_at: nowIso(),
  });
}
