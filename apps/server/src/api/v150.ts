import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '@swarm/shared';
import {
  announcementDto,
  appendThreadMessage,
  messageDto,
  notifyAnnouncement,
} from '../domain/adminComms';
import { getAgentSyncSources } from '../domain/agentSyncService';
import { kbCapTokens, kbScopeRank, selectKbForInjection } from '../domain/kbService';
import { estimateTokens } from '../llm/parse';
import type { Logger } from '../logger';
import type { AnnouncementRow, KbRow, Repos } from '../store/repositories';
import { nowIso, uid } from '../util';
import type { M7Helpers } from './m7';
import {
  announcementCreateSchema,
  announcementUpdateSchema,
  kbSearchTestSchema,
  messageSendSchema,
} from './schemas';

function fail(code: string, message: string, status = 400): never {
  throw Object.assign(new Error(message), { code, statusCode: status });
}

function parseTags(tagsJson: string): string[] {
  try {
    const v = JSON.parse(tagsJson || '[]') as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function kbEntryDto(k: KbRow) {
  return {
    id: k.id,
    title: k.title,
    body: k.body,
    scope: k.scope,
    scopeId: k.scope_id,
    tags: parseTags(k.tags),
    enabled: k.enabled === 1,
    createdAt: k.created_at,
    updatedAt: k.updated_at,
  };
}

/**
 * v1.5.0 路由组（三库归一 + 平台知识补齐 + 同步自动化一期 + 管理端技能下发 + 沟通运营 L + AI 运营官 M）。
 * 管理动作一律走 requireAdmin + audit；用户侧端点走 wsAuth 并按当前空间隔离。
 */
export function registerV150Routes(
  app: FastifyInstance,
  deps: { repos: Repos; logger: Logger; dataDir: string },
  helpers: M7Helpers,
): void {
  const { repos } = deps;
  const { wsAuth, requireAdmin, audit } = helpers;
  void fail;
  void ErrorCode;

  /* ================= A 平台知识维护（管理台）：列表带注入计数；增删改走既有 /api/kb（已管理员收口） ================= */
  app.get('/api/admin/platform-kb', async (req) => {
    requireAdmin(req);
    const counts = repos.countTaskInjectionsByKb();
    return {
      ok: true,
      entries: repos.listPlatformKb().map((k) => ({ ...kbEntryDto(k), injectedCount: counts[k.id] ?? 0 })),
    };
  });

  /* ================= C 同步流水线看板：run 列表 + 每源健康度（最近成功/连续失败/待审数） ================= */
  app.get('/api/admin/agent-sync-runs', async (req) => {
    requireAdmin(req);
    const runs = repos.listAgentSyncRuns(100);
    const templates = repos.listAgentTemplates();
    const board = getAgentSyncSources(repos).map((s) => {
      const srcRuns = runs.filter((r) => r.source_id === s.id);
      const lastSuccess = srcRuns.find((r) => r.status === 'success');
      let consecutiveFailures = 0;
      for (const r of srcRuns) {
        if (r.status === 'failed') consecutiveFailures++;
        else break;
      }
      return {
        sourceId: s.id,
        repo: s.repo,
        paused: !!s.paused,
        pauseReason: s.pauseReason ?? '',
        lastRunAt: srcRuns[0]?.created_at ?? null,
        lastSuccessAt: lastSuccess?.finished_at ?? null,
        lastStatus: srcRuns[0]?.status ?? null,
        lastCommit: srcRuns.find((r) => r.source_commit)?.source_commit ?? '',
        consecutiveFailures,
        pendingCount: templates.filter(
          (t) => t.source_repo === s.repo && (t.status === 'pending_review' || t.has_pending_update === 1),
        ).length,
      };
    });
    return {
      ok: true,
      board,
      runs: runs.map((r) => ({
        id: r.id,
        sourceId: r.source_id,
        sourceRepo: r.source_repo,
        trigger: r.trigger_type,
        status: r.status,
        sourceCommit: r.source_commit,
        fetched: r.fetched,
        created: r.created,
        updated: r.updated,
        unchanged: r.unchanged,
        failed: r.failed,
        failedDetails: (() => {
          try {
            const v = JSON.parse(r.failed_details || '[]') as unknown;
            return Array.isArray(v) ? v : [];
          } catch {
            return [];
          }
        })(),
        error: r.error,
        durationMs: r.duration_ms,
        createdAt: r.created_at,
        finishedAt: r.finished_at,
      })),
    };
  });

  /* ================= L 平台公告：管理员发布/编辑/撤下（audit）；用户端只见已发布且投放范围命中的 ================= */
  app.get('/api/admin/announcements', async (req) => {
    requireAdmin(req);
    return { ok: true, announcements: repos.listAnnouncements().map(announcementDto) };
  });
  app.post('/api/admin/announcements', async (req) => {
    const ctx = requireAdmin(req);
    const body = announcementCreateSchema.parse(req.body ?? {});
    const ts = nowIso();
    const row: AnnouncementRow = {
      id: uid('ann'),
      title: body.title,
      body: body.body,
      scope: body.scope,
      workspace_ids: JSON.stringify(body.scope === 'selected' ? (body.workspaceIds ?? []) : []),
      status: 'published',
      created_by: ctx.user.id,
      published_at: ts,
      created_at: ts,
      updated_at: ts,
    };
    repos.insertAnnouncement(row);
    const reached = notifyAnnouncement(repos, row);
    audit(req, ctx, 'announcement_publish', 'announcement', row.id, `范围=${row.scope} 触达 ${reached} 个空间`);
    return { ok: true, announcement: announcementDto(row), reached };
  });
  app.put('/api/admin/announcements/:id', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const cur = repos.getAnnouncement(id);
    if (!cur) fail(ErrorCode.NOT_FOUND, '公告不存在', 404);
    const body = announcementUpdateSchema.parse(req.body ?? {});
    const next: AnnouncementRow = {
      ...cur!,
      title: body.title ?? cur!.title,
      body: body.body ?? cur!.body,
      scope: body.scope ?? cur!.scope,
      workspace_ids:
        body.workspaceIds !== undefined
          ? JSON.stringify(body.workspaceIds)
          : body.scope === 'all'
            ? '[]'
            : cur!.workspace_ids,
      updated_at: nowIso(),
    };
    repos.updateAnnouncement(next);
    audit(req, ctx, 'announcement_update', 'announcement', id, next.title);
    return { ok: true, announcement: announcementDto(next) };
  });
  app.post('/api/admin/announcements/:id/withdraw', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const cur = repos.getAnnouncement(id);
    if (!cur) fail(ErrorCode.NOT_FOUND, '公告不存在', 404);
    repos.updateAnnouncement({ ...cur!, status: 'withdrawn', updated_at: nowIso() });
    audit(req, ctx, 'announcement_withdraw', 'announcement', id, cur!.title);
    return { ok: true };
  });
  app.get('/api/announcements', async (req) => {
    const ctx = wsAuth(req);
    const list = repos
      .listPublishedAnnouncementsFor(ctx.workspaceId)
      .map(announcementDto)
      .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    return { ok: true, announcements: list };
  });

  /* ================= L 按空间消息线程：管理台收件箱 + 用户端消息入口（收件人恒为空间所有者） ================= */
  app.get('/api/admin/threads', async (req) => {
    requireAdmin(req);
    const wsById = new Map(repos.listWorkspaces().map((w) => [w.id, w]));
    const threads = repos.listThreads().map((t) => {
      const last = repos.listMessages(t.id, 1)[0];
      const ws = wsById.get(t.workspace_id);
      const owner = ws ? repos.getUser(ws.owner_user_id) : null;
      return {
        workspaceId: t.workspace_id,
        workspaceName: ws?.name ?? t.workspace_id,
        ownerName: owner?.display_name ?? owner?.email ?? '',
        unread: repos.countUnreadMessages(t.id, 'admin'),
        lastMessage: last ? { body: last.body, senderType: last.sender_type, createdAt: last.created_at } : null,
        updatedAt: t.updated_at,
      };
    });
    return { ok: true, threads };
  });
  app.get('/api/admin/threads/:workspaceId', async (req) => {
    requireAdmin(req);
    const { workspaceId } = req.params as { workspaceId: string };
    const thread = repos.getThreadByWorkspace(workspaceId);
    if (!thread) return { ok: true, messages: [] };
    return { ok: true, messages: repos.listMessages(thread.id, 200).map((m) => messageDto(repos, m)) };
  });
  app.post('/api/admin/threads/:workspaceId/messages', async (req) => {
    const ctx = requireAdmin(req);
    const { workspaceId } = req.params as { workspaceId: string };
    if (!repos.getWorkspace(workspaceId)) fail(ErrorCode.NOT_FOUND, '空间不存在', 404);
    const body = messageSendSchema.parse(req.body ?? {});
    if (body.teamId && !repos.listTeams(workspaceId).some((t) => t.id === body.teamId)) {
      fail(ErrorCode.VALIDATION, '小组不属于该空间');
    }
    const msg = appendThreadMessage(repos, workspaceId, {
      senderType: 'admin',
      senderUserId: ctx.user.id,
      body: body.body,
      kind: 'chat',
      teamId: body.teamId ?? null,
      notify: true,
    });
    audit(req, ctx, 'admin_message_send', 'workspace', workspaceId, body.body.slice(0, 120));
    return { ok: true, message: messageDto(repos, msg) };
  });
  app.post('/api/admin/threads/:workspaceId/read', async (req) => {
    requireAdmin(req);
    const { workspaceId } = req.params as { workspaceId: string };
    const thread = repos.getThreadByWorkspace(workspaceId);
    if (thread) repos.markThreadRead(thread.id, 'admin');
    return { ok: true };
  });
  app.get('/api/messages/thread', async (req) => {
    const ctx = wsAuth(req);
    const thread = repos.getThreadByWorkspace(ctx.workspaceId);
    return {
      ok: true,
      messages: thread ? repos.listMessages(thread.id, 200).map((m) => messageDto(repos, m)) : [],
      unread: thread ? repos.countUnreadMessages(thread.id, 'owner') : 0,
    };
  });
  app.post('/api/messages/thread/messages', async (req) => {
    const ctx = wsAuth(req);
    const body = messageSendSchema.parse(req.body ?? {});
    if (body.teamId && !repos.listTeams(ctx.workspaceId).some((t) => t.id === body.teamId)) {
      fail(ErrorCode.VALIDATION, '小组不属于本空间');
    }
    const msg = appendThreadMessage(repos, ctx.workspaceId, {
      senderType: 'owner',
      senderUserId: ctx.user.id,
      body: body.body,
      kind: 'chat',
      teamId: body.teamId ?? null,
    });
    return { ok: true, message: messageDto(repos, msg) };
  });
  app.post('/api/messages/thread/read', async (req) => {
    const ctx = wsAuth(req);
    const thread = repos.getThreadByWorkspace(ctx.workspaceId);
    if (thread) repos.markThreadRead(thread.id, 'owner');
    return { ok: true };
  });
  app.get('/api/messages/unread', async (req) => {
    const ctx = wsAuth(req);
    const thread = repos.getThreadByWorkspace(ctx.workspaceId);
    return { ok: true, threadUnread: thread ? repos.countUnreadMessages(thread.id, 'owner') : 0 };
  });
  /* 管理台发消息时选「关联小组」用：读任意空间的小组名单（只读、管理员） */
  app.get('/api/admin/workspaces/:workspaceId/teams', async (req) => {
    requireAdmin(req);
    const { workspaceId } = req.params as { workspaceId: string };
    return {
      ok: true,
      teams: repos.listTeams(workspaceId).map((t) => ({ id: t.id, name: t.name })),
    };
  });

  /* ================= E KB 搜索测试：纯读 selectKbForInjection，按当前注入策略回放命中与排序档 ================= */
  app.post('/api/kb/search-test', async (req) => {
    const ctx = wsAuth(req);
    const body = kbSearchTestSchema.parse(req.body ?? {});
    const teams = repos.listTeams(ctx.workspaceId);
    const teamId = body.teamId ?? teams[0]?.id ?? '';
    if (body.teamId && !teams.some((t) => t.id === body.teamId)) {
      fail(ErrorCode.VALIDATION, '小组不存在或不属于本空间');
    }
    const cap = kbCapTokens(0, 0);
    const sel = selectKbForInjection(
      repos.listKb(ctx.workspaceId),
      { teamId, memberId: body.memberId ?? null, userId: ctx.user.id, queryText: body.query },
      cap,
    );
    const rankLabel = (r: number): string =>
      r === -2 ? '平台公共（最高）' : r === 0 ? '公司级' : r === 1 ? '本组' : r === 2 ? '本人成员级' : r === 3 ? '他组' : '不纳入';
    return {
      ok: true,
      capTokens: cap,
      totalTokens: sel.totalTokens,
      hits: sel.entries.map((e) => ({
        ...kbEntryDto(e),
        rank: kbScopeRank(e, { teamId, memberId: body.memberId ?? null, userId: ctx.user.id, queryText: body.query }),
        rankLabel: rankLabel(kbScopeRank(e, { teamId, memberId: body.memberId ?? null, userId: ctx.user.id, queryText: body.query })),
        tokens: estimateTokens(`## ${e.title}\n${e.body}`),
      })),
    };
  });
}
