import { nowIso } from '../util';
import type { Repos } from '../store/repositories';

/**
 * 站内提醒（M8 §9）：待裁决 / 余额耗尽 / 打回满次转裁决 → 直达空间所有者。
 * 去重口径：同一空间+类型+任务已有未读提醒时不重复生成（引擎每 tick 可能反复命中同一停工原因）。
 * 邮件通道仅留配置位（settings.notifyConfig），本模块不发信。
 */
export type NotificationType = 'adjudication' | 'balance' | 'trial_exhausted' | 'reject_max';

export function notifyOwner(
  repos: Repos,
  workspaceId: string,
  type: NotificationType,
  title: string,
  body: string,
  taskId: string | null,
): void {
  if (repos.hasUnreadNotification(workspaceId, type, taskId)) return;
  const ws = repos.getWorkspace(workspaceId);
  repos.insertNotification({
    workspace_id: workspaceId,
    user_id: ws?.owner_user_id ?? null,
    type,
    title,
    body,
    task_id: taskId,
    read_at: null,
    created_at: nowIso(),
  });
}
