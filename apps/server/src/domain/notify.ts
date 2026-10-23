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
  | 'transfer'
  | 'skill_featured'
  | 'skill_unfeatured'
  | 'checkin_reminder'
  | 'daily_briefing';

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
  'skill_featured',
  'skill_unfeatured',
  'checkin_reminder',
  'daily_briefing',
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

/**
 * 邮件旁路（v1.3.0 G 晨报预留，与 G-01 共用同一接入点，不另写第二套发信）：
 * notifyConfig 的真实形状 = settings(key='notifyConfig', workspace 维度) 的 {emailEnabled?: boolean, email?: string}，
 * 且 notify.ts 内的 mailChannel 为硬编码常量 'reserved-not-implemented'（无 SMTP 主机/发件配置字段）。
 * 因此本版恒跳过：只有 mailChannel 不再是该保留值时才走后续发信实现（G-01 落地后在此补齐）。
 */
export function maybeMailDaily(
  repos: Repos,
  workspaceId: string,
  _subject: string,
  _body: string,
): void {
  const cfg = repos.getSetting<{ emailEnabled?: boolean; email?: string }>(
    'notifyConfig',
    { emailEnabled: false, email: '' },
    workspaceId,
  );
  const mailChannel: string = 'reserved-not-implemented';
  if (mailChannel === 'reserved-not-implemented' || !cfg.emailEnabled || !cfg.email) {
    return; // G-01 未落地：邮件通道未启用，晨报只落站内通知
  }
  // 接回点（G-01）：在此按 notifyConfig 的 SMTP 配置发送 _subject/_body，不另建发信通道。
}

/**
 * 通知指定用户（G-15 转让的接收侧 / 原所有者留痕侧）：与 notifyOwner 同一套口径
 * （查接收人 notifyPrefs、站内 channel、mail channel 暂缓跳过），差别只在接收人——
 * notifyOwner 恒投空间当前所有者，转让落定后原所有者已不是所有者，必须按人投递。
 * 去重按（空间 + 接收人 + 类型 + 任务）未读维度，不与所有者通知互相压制。
 */
export function notifyUser(
  repos: Repos,
  userId: string,
  workspaceId: string,
  type: NotificationType,
  title: string,
  body: string,
  taskId: string | null = null,
): void {
  if (!inappEnabled(repos, userId, type)) return;
  if (repos.hasUnreadNotificationForUser(workspaceId, userId, type, taskId)) return;
  repos.insertNotification({
    workspace_id: workspaceId,
    user_id: userId,
    type,
    title,
    body,
    task_id: taskId,
    read_at: null,
    created_at: nowIso(),
  });
}
