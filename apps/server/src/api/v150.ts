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
import { notifyOwner } from '../domain/notify';
import { copySkillSnapshot } from '../domain/skillService';
import { importSkillsFromGithub } from '../domain/skillImportService';
import { estimateTokens } from '../llm/parse';
import type { Logger } from '../logger';
import type { AnnouncementRow, KbRow, Repos, SkillRow } from '../store/repositories';
import { nowIso, uid } from '../util';
import { skillDto, type M7Helpers } from './m7';
import {
  announcementCreateSchema,
  announcementUpdateSchema,
  kbSearchTestSchema,
  messageSendSchema,
  platformSkillUpdateSchema,
  skillImportSchema,
  skillPushSchema,
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

  /* ================= K 技能下发：GitHub 导入（许可证预检）→ 平台草稿 → 上架 / 推送下发 ================= */
  app.post('/api/admin/skill-imports', async (req) => {
    const ctx = requireAdmin(req);
    const body = skillImportSchema.parse(req.body ?? {});
    const outcome = await importSkillsFromGithub(repos, { repoUrl: body.repoUrl, importedBy: ctx.user.id });
    audit(
      req, ctx, 'skill_import', 'skill_source', outcome.record.repo || body.repoUrl,
      `status=${outcome.record.status} license=${outcome.record.license} created=${outcome.createdSkillIds.length}｜${outcome.record.detail}`,
    );
    return { ok: true, record: outcome.record, createdSkillIds: outcome.createdSkillIds };
  });
  app.get('/api/admin/skill-imports', async (req) => {
    requireAdmin(req);
    return { ok: true, imports: repos.listSkillSourceImports(50) };
  });
  app.get('/api/admin/platform-skills', async (req) => {
    requireAdmin(req);
    return { ok: true, skills: repos.listPlatformSkills().map((s) => skillDto(repos, s)) };
  });
  app.put('/api/admin/skills/:id', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const cur = repos.getSkill(id);
    if (!cur || cur.owner_type !== 'platform') fail(ErrorCode.NOT_FOUND, '平台技能不存在', 404);
    const body = platformSkillUpdateSchema.parse(req.body ?? {});
    const next: SkillRow = {
      ...cur!,
      name: body.name ?? cur!.name,
      description: body.description ?? cur!.description,
      role: body.role ?? cur!.role,
      prompt_template: body.promptTemplate ?? cur!.prompt_template,
      output_spec: body.outputSpec ?? cur!.output_spec,
      updated_at: nowIso(),
    };
    repos.updateSkill(next);
    audit(req, ctx, 'platform_skill_update', 'skill', id, next.name);
    return { ok: true, skill: skillDto(repos, next) };
  });
  app.post('/api/admin/skills/:id/publish', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const cur = repos.getSkill(id);
    if (!cur || cur.owner_type !== 'platform') fail(ErrorCode.NOT_FOUND, '平台技能不存在', 404);
    const next: SkillRow = {
      ...cur!,
      status: 'published',
      visibility: 'public',
      listed_at: cur!.listed_at ?? nowIso(),
      updated_at: nowIso(),
    };
    repos.updateSkill(next);
    audit(req, ctx, 'platform_skill_publish', 'skill', id, `${next.name} v${next.version}`);
    return { ok: true, skill: skillDto(repos, next) };
  });
  app.post('/api/admin/skills/:id/push', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const skill = repos.getSkill(id);
    if (!skill || skill.owner_type !== 'platform') fail(ErrorCode.NOT_FOUND, '平台技能不存在', 404);
    if (skill!.status !== 'published') fail(ErrorCode.VALIDATION, '先上架再推送下发');
    const body = skillPushSchema.parse(req.body ?? {});
    const targets =
      body.workspaceIds === 'all'
        ? repos.listWorkspaces().map((w) => w.id)
        : [...new Set(body.workspaceIds)];
    let installed = 0;
    let upgraded = 0;
    let skipped = 0;
    for (const wsId of targets) {
      if (!repos.getWorkspace(wsId)) continue;
      const existing = repos.findInstalledCopy(wsId, skill!.id);
      let copyId: string;
      let action: 'installed' | 'upgraded';
      if (existing && existing.source_version === skill!.version) {
        skipped++;
        continue;
      } else if (existing) {
        repos.updateSkill({
          ...existing,
          name: skill!.name,
          description: skill!.description,
          role: skill!.role,
          prompt_template: skill!.prompt_template,
          input_schema: skill!.input_schema,
          kb_binding: skill!.kb_binding,
          output_spec: skill!.output_spec,
          example_input: skill!.example_input,
          example_output: skill!.example_output,
          source_version: skill!.version,
          updated_at: nowIso(),
        });
        copyId = existing.id;
        action = 'upgraded';
        upgraded++;
      } else {
        const copy = copySkillSnapshot(repos, skill!, wsId, ctx.user.id);
        copyId = copy.id;
        action = 'installed';
        installed++;
      }
      repos.insertSkillPush({
        id: uid('skpush'),
        skill_id: skill!.id,
        workspace_id: wsId,
        version: skill!.version,
        copy_skill_id: copyId,
        pushed_by: ctx.user.id,
        created_at: nowIso(),
      });
      notifyOwner(
        repos, wsId, 'skill_pushed',
        `平台下发技能：${skill!.name}`,
        `管理员把技能「${skill!.name}」v${skill!.version} ${action === 'installed' ? '装入' : '更新到'}了本空间，在技能库里带「平台下发」徽标。`,
        copyId,
      );
      // L 衔接：线程里同步落一条下发说明（带 skill 名与版本）
      appendThreadMessage(repos, wsId, {
        senderType: 'admin',
        senderUserId: ctx.user.id,
        body:
          `平台下发了技能「${skill!.name}」v${skill!.version}` +
          (skill!.source_repo ? `（来源 ${skill!.source_repo}·${skill!.source_author ?? ''}·${skill!.source_license ?? ''}）` : '') +
          `，已${action === 'installed' ? '装入' : '更新到'}本空间技能库，发单时可直接套用。` +
          (body.note ? `\n管理员附言：${body.note}` : ''),
        kind: 'skill_push',
      });
    }
    audit(
      req, ctx, 'skill_push', 'skill', id,
      `${skill!.name} v${skill!.version} → 目标 ${targets.length} 空间：新装 ${installed}、升级 ${upgraded}、跳过 ${skipped}`,
    );
    return { ok: true, installed, upgraded, skipped, targets: targets.length };
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
