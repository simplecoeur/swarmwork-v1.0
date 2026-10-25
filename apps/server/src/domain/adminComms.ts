import type { AnnouncementRow, MessageRow, Repos } from '../store/repositories';
import { nowIso, uid } from '../util';
import { notifyOwner } from './notify';

/**
 * v1.5.0 L 管理端沟通运营的域助手：公告发布/触达 + 按空间消息线程。
 * 线程独立建表（message_threads/messages，迁移 022），触达复用站内通知：
 * 公告与管理员新消息都经 notifyOwner 落一条通知（铃铛可见），线程本体在弹窗/收件箱里看。
 */

export function announcementTargets(a: AnnouncementRow, allWorkspaceIds: string[]): string[] {
  if (a.scope === 'all') return allWorkspaceIds;
  try {
    const v = JSON.parse(a.workspace_ids || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 公告发布触达：对每个目标空间落一条 announcement 通知（taskId=公告 id，天然按空间去重一次） */
export function notifyAnnouncement(repos: Repos, a: AnnouncementRow): number {
  const targets = announcementTargets(a, repos.listWorkspaces().map((w) => w.id));
  for (const wsId of targets) {
    notifyOwner(repos, wsId, 'announcement', `平台公告：${a.title}`, a.body.slice(0, 500), a.id);
  }
  return targets.length;
}

export interface ThreadMessageInput {
  senderType: 'admin' | 'owner' | 'system';
  senderUserId: string | null;
  body: string;
  kind?: string;
  teamId?: string | null;
  /** 是否同时落一条站内通知触达对方（管理员→空间所有者时 true；系统消息由调用方决定） */
  notify?: boolean;
}

/** 往某空间线程追加一条消息（线程不存在则建）；返回消息行 */
export function appendThreadMessage(repos: Repos, workspaceId: string, input: ThreadMessageInput): MessageRow {
  const thread = repos.getOrCreateThread(workspaceId);
  const row: MessageRow = {
    id: uid('msg'),
    thread_id: thread.id,
    workspace_id: workspaceId,
    sender_type: input.senderType,
    sender_user_id: input.senderUserId,
    body: input.body,
    kind: input.kind ?? 'chat',
    team_id: input.teamId ?? null,
    admin_read: input.senderType === 'admin' ? 1 : 0,
    owner_read: input.senderType === 'owner' ? 1 : 0,
    created_at: nowIso(),
  };
  repos.insertMessage(row);
  if (input.notify && input.senderType !== 'owner') {
    notifyOwner(repos, workspaceId, 'admin_message', '平台消息', input.body.slice(0, 500), row.id);
  }
  return row;
}

export function messageDto(repos: Repos, m: MessageRow) {
  return {
    id: m.id,
    senderType: m.sender_type,
    senderUserId: m.sender_user_id,
    body: m.body,
    kind: m.kind,
    teamId: m.team_id,
    teamName: m.team_id ? (repos.listTeams(m.workspace_id).find((t) => t.id === m.team_id)?.name ?? null) : null,
    createdAt: m.created_at,
  };
}

export function announcementDto(a: AnnouncementRow) {
  let workspaceIds: string[] = [];
  try {
    const v = JSON.parse(a.workspace_ids || '[]') as unknown;
    workspaceIds = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    workspaceIds = [];
  }
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    scope: a.scope,
    workspaceIds,
    status: a.status,
    publishedAt: a.published_at,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}
