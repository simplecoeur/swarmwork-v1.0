import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '@swarm/shared';
import {
  announcementDto,
  appendThreadMessage,
  messageDto,
  notifyAnnouncement,
} from '../domain/adminComms';
import {
  aiOpsCatalogText,
  createAiOpsRun,
  executeAiOpsRun,
  parseAiOpsPlan,
  parseRunPlan,
  rollbackAiOpsStep,
} from '../domain/aiOpsService';
import { getAgentSyncSources } from '../domain/agentSyncService';
import { kbCapTokens, kbScopeRank, selectKbForInjection } from '../domain/kbService';
import { importSkillsFromGithub, pushSkillToWorkspaces } from '../domain/skillImportService';
import { createProvider } from '../llm/gateway';
import { estimateTokens } from '../llm/parse';
import type { Logger } from '../logger';
import type { AiOpsRunRow, AnnouncementRow, KbRow, Repos, SkillRow } from '../store/repositories';
import { nowIso, uid } from '../util';
import { skillDto, type M7Helpers } from './m7';
import {
  aiOpsExecuteSchema,
  aiOpsPlanSchema,
  announcementCreateSchema,
  announcementUpdateSchema,
  kbSearchTestSchema,
  messageSendSchema,
  platformSkillUpdateSchema,
  reviewBatchSchema,
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
    const out = pushSkillToWorkspaces(repos, skill!, targets, ctx.user.id, body.note);
    audit(
      req, ctx, 'skill_push', 'skill', id,
      `${skill!.name} v${skill!.version} → 目标 ${targets.length} 空间：新装 ${out.installed}、升级 ${out.upgraded}、跳过 ${out.skipped}`,
    );
    return { ok: true, installed: out.installed, upgraded: out.upgraded, skipped: out.skipped, targets: targets.length };
  });

  /* ================= D 统一审核中心：三队列聚合 + 批量过/驳（语义与各自单项端点一致） ================= */
  const agentDiffSummary = (t: ReturnType<Repos['listAgentTemplates']>[number]): string => {
    if (t.status !== 'public' && !t.pub_name) return '首次上架（无已发布版本）';
    const changed: string[] = [];
    if (t.draft_name !== t.pub_name) changed.push('名称');
    if (t.draft_specialty !== t.pub_specialty) changed.push('专长');
    if (t.draft_role !== t.pub_role) changed.push('工种');
    if (t.draft_persona !== t.pub_persona) changed.push('人设');
    return changed.length ? `变更：${changed.join('、')}` : '无内容变更';
  };
  app.get('/api/admin/review-center', async (req) => {
    requireAdmin(req);
    const items: Array<Record<string, unknown>> = [];
    for (const s of repos.listPendingReviewSkills()) {
      items.push({
        type: 'skill',
        id: s.id,
        title: s.name,
        subtitle: `v${s.version} · ${s.role}`,
        changeSummary: s.changelog ? `变更说明：${s.changelog}` : `v${s.version} 上架申请`,
        workspaceId: s.workspace_id,
        createdAt: s.updated_at,
        riskFlags: [],
      });
    }
    for (const t of repos.listPendingStyleTemplates()) {
      // 风格审核含图片内容审核：把色板/家具数/招牌/待审图 id 一并带出，前端渲染缩略图供肉眼过审
      let styleDetail: Record<string, unknown> | null = null;
      try {
        const cfg = JSON.parse(t.config || '{}') as {
          palette?: { wall?: string; floor?: string; accent?: string };
          floorPattern?: string;
          furniture?: Record<string, unknown>;
          sign?: { mode?: string; text?: string; imageFileId?: string };
          poster?: { imageFileId?: string };
        };
        const images: Array<{ label: string; id: string }> = [];
        if (cfg.poster?.imageFileId) images.push({ label: '海报', id: cfg.poster.imageFileId });
        if (cfg.sign?.mode === 'image' && cfg.sign.imageFileId) images.push({ label: '招牌图', id: cfg.sign.imageFileId });
        styleDetail = {
          wall: cfg.palette?.wall ?? '',
          floor: cfg.palette?.floor ?? '',
          accent: cfg.palette?.accent ?? '',
          floorPattern: cfg.floorPattern ?? '',
          furnitureCount: Object.values(cfg.furniture ?? {}).filter(Boolean).length,
          signText: cfg.sign?.mode === 'text' ? (cfg.sign.text ?? '') : '',
          images,
        };
      } catch {
        styleDetail = null;
      }
      items.push({
        type: 'style',
        id: t.id,
        title: t.name,
        subtitle: '风格模板',
        changeSummary: styleDetail
          ? `配色 ${styleDetail.wall}/${styleDetail.floor}/${styleDetail.accent} · 家具 ${styleDetail.furnitureCount} 件`
          : '配置解析失败',
        workspaceId: t.workspace_id,
        createdAt: t.updated_at,
        riskFlags: [],
        styleDetail,
      });
    }
    for (const t of repos.listAgentTemplates()) {
      if (t.status !== 'pending_review' && t.has_pending_update !== 1) continue;
      let riskFlags: string[] = [];
      try {
        const v = JSON.parse(t.risk_flags || '[]') as unknown;
        riskFlags = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        riskFlags = [];
      }
      items.push({
        type: 'agent',
        id: t.id,
        title: t.draft_name,
        subtitle: `${t.source_repo}/${t.source_path}`,
        changeSummary: agentDiffSummary(t),
        workspaceId: null,
        createdAt: t.updated_at,
        riskFlags,
      });
    }
    items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return { ok: true, items };
  });
  app.post('/api/admin/review-center/batch', async (req) => {
    const ctx = requireAdmin(req);
    const body = reviewBatchSchema.parse(req.body ?? {});
    if (body.action === 'reject' && !body.reason?.trim()) {
      fail(ErrorCode.VALIDATION, '驳回原因必填');
    }
    const results: Array<{ type: string; id: string; ok: boolean; error?: string }> = [];
    const noteTargets = new Map<string, string>(); // workspaceId -> 标题（驳回附言落线程）
    for (const item of body.items) {
      try {
        if (item.type === 'skill') {
          const cur = repos.getSkill(item.id);
          if (!cur) throw new Error('skill 不存在');
          if (cur.visibility !== 'pending_review') throw new Error('不在待审核状态');
          if (body.action === 'approve') {
            const contributor = cur.created_by ? repos.getUser(cur.created_by) : undefined;
            const ws = cur.workspace_id ? repos.getWorkspace(cur.workspace_id) : undefined;
            repos.updateSkill({
              ...cur,
              visibility: 'public',
              status: 'published',
              listed_at: nowIso(),
              contributor_name: contributor?.display_name ?? '',
              contributor_workspace_name: ws?.name ?? '',
              updated_at: nowIso(),
            });
          } else {
            repos.updateSkill({ ...cur, visibility: 'workspace', updated_at: nowIso() });
            if (body.note?.trim() && cur.workspace_id) noteTargets.set(cur.workspace_id, cur.name);
          }
        } else if (item.type === 'style') {
          const row = repos.getStyleTemplate(item.id);
          if (!row) throw new Error('风格模板不存在');
          if (row.visibility !== 'pending_review') throw new Error('不在待审核状态');
          repos.updateStyleTemplate({
            ...row,
            visibility: body.action === 'approve' ? 'public' : 'workspace',
            updated_at: nowIso(),
          });
          if (body.action === 'reject' && body.note?.trim() && row.workspace_id) {
            noteTargets.set(row.workspace_id, row.name);
          }
        } else {
          const t = repos.getAgentTemplate(item.id);
          if (!t) throw new Error('智能体模板不存在');
          if (t.status !== 'pending_review' && t.has_pending_update !== 1) throw new Error('不在待审状态');
          if (body.action === 'approve') {
            repos.updateAgentTemplate({
              ...t,
              pub_name: t.draft_name,
              pub_specialty: t.draft_specialty,
              pub_persona: t.draft_persona,
              pub_role: t.draft_role,
              status: 'public',
              has_pending_update: 0,
              reject_reason: '',
              updated_at: nowIso(),
              pub_at: nowIso(),
            });
          } else if (t.status === 'public') {
            repos.updateAgentTemplate({
              ...t,
              draft_name: t.pub_name ?? t.draft_name,
              draft_specialty: t.pub_specialty ?? t.draft_specialty,
              draft_persona: t.pub_persona ?? t.draft_persona,
              draft_role: t.pub_role ?? t.draft_role,
              has_pending_update: 0,
              reject_reason: body.reason!.trim(),
              updated_at: nowIso(),
            });
          } else {
            repos.updateAgentTemplate({ ...t, status: 'rejected', reject_reason: body.reason!.trim(), updated_at: nowIso() });
          }
        }
        audit(
          req, ctx, `review_center_${body.action}`, item.type, item.id,
          body.action === 'reject' ? `原因：${body.reason}` : '批量审核通过',
        );
        results.push({ type: item.type, id: item.id, ok: true });
      } catch (e) {
        results.push({ type: item.type, id: item.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    // L 衔接：驳回附言按空间合并成一条线程消息
    if (body.action === 'reject' && body.note?.trim()) {
      for (const [wsId, title] of noteTargets) {
        appendThreadMessage(repos, wsId, {
          senderType: 'admin',
          senderUserId: ctx.user.id,
          body: `审核驳回说明（${title}）：原因「${body.reason}」。补充说明：${body.note.trim()}`,
          kind: 'review_note',
          notify: true,
        });
      }
    }
    return { ok: true, results };
  });

  /* ================= M AI 平台运营官（一期）：计划 → 预览/确认破坏性步骤 → 执行 → 报告/回滚 ================= */
  const aiOpsRunDto = (run: AiOpsRunRow) => ({
    id: run.id,
    instruction: run.instruction,
    status: run.status,
    steps: parseRunPlan(run).steps,
    report: (() => {
      try {
        return run.report ? (JSON.parse(run.report) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })(),
    createdBy: run.created_by,
    createdAt: run.created_at,
    finishedAt: run.finished_at,
  });
  app.post('/api/admin/ai-ops/plan', async (req) => {
    const ctx = requireAdmin(req);
    const body = aiOpsPlanSchema.parse(req.body ?? {});
    const trial = repos.getTrialApi();
    if (!trial) {
      fail(
        ErrorCode.VALIDATION,
        '尚未配置平台级 API：请先到管理台「体验额度」配置平台体验 API（AI 运营官用它解析指令），配置前运营官不可用',
      );
    }
    const provider = createProvider(trial!);
    const system = [
      '你是蜂群平台的 AI 运营官，负责把管理员的一句话指令拆成结构化执行计划。',
      '只能从下面的动作目录里选 op，参数必须符合各自的参数说明；空间/用户/技能等对象用管理员在指令里给出的名称或 id 原样填入（执行时会解析）。',
      '只输出一个 JSON 对象，不要任何解释文字：{"steps":[{"op":"...","params":{...}}]}。',
      '可用的动作目录：',
      aiOpsCatalogText(),
    ].join('\n');
    let text: string;
    try {
      const out = await provider.chat({
        model: trial!.model,
        system,
        messages: [{ role: 'user', content: body.instruction }],
        temperature: 0,
        maxTokens: 2000,
        timeoutMs: 60000,
      });
      text = out.text;
    } catch (e) {
      fail('UPSTREAM', `运营官模型调用失败：${e instanceof Error ? e.message : String(e)}`, 502);
    }
    let plan;
    try {
      plan = parseAiOpsPlan(text!);
    } catch (e) {
      fail(ErrorCode.VALIDATION, `计划解析失败（未执行任何动作）：${e instanceof Error ? e.message : String(e)}`);
    }
    const run = createAiOpsRun(repos, body.instruction, plan!, ctx.user.id);
    audit(req, ctx, 'ai_ops_plan', 'ai_ops_run', run.id, `指令：${body.instruction}｜共 ${plan!.steps.length} 步`);
    return { ok: true, run: aiOpsRunDto(run), needsConfirm: plan!.steps.some((s) => s.destructive) };
  });
  app.post('/api/admin/ai-ops/runs/:id/execute', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = aiOpsExecuteSchema.parse(req.body ?? {});
    const auditFn = (action: string, targetType: string, targetId: string, detail: string) =>
      audit(req, ctx, action, targetType, targetId, detail);
    const run = await executeAiOpsRun(repos, id, auditFn, { confirmDestructive: !!body.confirmDestructive });
    return { ok: true, run: aiOpsRunDto(run) };
  });
  app.get('/api/admin/ai-ops/runs', async (req) => {
    requireAdmin(req);
    return { ok: true, runs: repos.listAiOpsRuns(50).map(aiOpsRunDto) };
  });
  app.get('/api/admin/ai-ops/runs/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const run = repos.getAiOpsRun(id);
    if (!run) fail(ErrorCode.NOT_FOUND, '运营 run 不存在', 404);
    return { ok: true, run: aiOpsRunDto(run!) };
  });
  app.post('/api/admin/ai-ops/runs/:id/rollback/:stepIndex', async (req) => {
    const ctx = requireAdmin(req);
    const { id, stepIndex } = req.params as { id: string; stepIndex: string };
    const auditFn = (action: string, targetType: string, targetId: string, detail: string) =>
      audit(req, ctx, action, targetType, targetId, detail);
    const out = await rollbackAiOpsStep(repos, id, Number(stepIndex), auditFn);
    const run = repos.getAiOpsRun(id);
    return { ok: true, ...out, run: run ? aiOpsRunDto(run) : null };
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
