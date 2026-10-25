import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ErrorCode,
  milliToYuan,
  TaskStatus,
  type ChannelPushDto,
  type DeliveryLinkDto,
  type SkillDto,
} from '@swarm/shared';
import { verifyPassword } from '../auth/auth';
import { attachAssetRefs } from '../domain/assetService';
import { getChannelAdapter, type ChannelConfig } from '../domain/channels';
import { assertSafeOutboundUrl } from '../domain/ssrf';
import {
  createDeliveryLink,
  deliveryTokenHash,
  projectToCsv,
  projectToMarkdown,
  renderDeliveryHtml,
  renderDeliveryPasswordHtml,
  taskToCsv,
  taskToMarkdown,
} from '../domain/deliveryService';
import { renderShareCardSvg } from '../domain/visitService';
import {
  copySkillSnapshot,
  createTaskFromSkill,
  parseInputSchema,
  parseJsonObject,
  parseKbBinding,
  skillVisibleToWorkspace,
} from '../domain/skillService';
import type { Logger } from '../logger';
import { decryptKey, encryptKey, maskKey } from '../store/crypto';
import type {
  DeliveryLinkRow,
  Repos,
  SessionRow,
  SkillRow,
  UserRow,
} from '../store/repositories';
import { nowIso, uid } from '../util';
import {
  channelBindSchema,
  channelPushSchema,
  deliveryCreateSchema,
  skillDispatchSchema,
  skillInstallSchema,
  skillSaveSchema,
  skillTestRunSchema,
} from './schemas';

/** 与 routes.ts 的 AuthCtx 结构一致的最小契约（helpers 由 registerRoutes 注入，避免循环依赖） */
export interface RouteCtx {
  user: UserRow;
  session: SessionRow;
  workspaceId: string | null;
}
export interface M7Helpers {
  auth: (req: FastifyRequest) => RouteCtx;
  wsAuth: (req: FastifyRequest) => RouteCtx & { workspaceId: string };
  requireAdmin: (req: FastifyRequest) => RouteCtx;
  audit: (
    req: FastifyRequest,
    ctx: RouteCtx,
    action: string,
    targetType?: string,
    targetId?: string,
    detail?: string,
  ) => void;
}

function fail(code: string, message: string, status = 400): never {
  throw Object.assign(new Error(message), { code, statusCode: status });
}

/**
 * v1.3.0 B 公开署名解析：platform 官方 skill 无个人署名（null，前端以「官方」标区分）；
 * workspace skill 优先行内快照（approve 时落定的 contributor_name/contributor_workspace_name），
 * 快照非空必须用快照原值（源用户改名/注销后仍保留）；两者皆空才回退实时查
 * （贡献者显示名 ?? '已注销用户'、空间名 ?? '已注销空间'）。
 */
export function contributorOf(
  repos: Repos,
  row: SkillRow,
): { name: string | null; workspaceName: string | null } {
  if (row.owner_type === 'platform') return { name: null, workspaceName: null };
  // 快照以空串落定表示「当时取不到」→ 视同未落定，仍走实时回退（approve 端约定）
  const snapName = row.contributor_name?.trim() ? row.contributor_name : null;
  const snapWs = row.contributor_workspace_name?.trim() ? row.contributor_workspace_name : null;
  if (snapName !== null || snapWs !== null) return { name: snapName, workspaceName: snapWs };
  const user = row.created_by ? repos.getUser(row.created_by) : undefined;
  const ws = row.workspace_id ? repos.getWorkspace(row.workspace_id) : undefined;
  return {
    name: user?.display_name ?? '已注销用户',
    workspaceName: ws?.name ?? '已注销空间',
  };
}

export function skillDto(repos: Repos, row: SkillRow, forWorkspaceId?: string): SkillDto & { installedCopyId: string | null } {
  let hasNewerSource = false;
  if (row.source_skill_id && row.source_version != null) {
    const src = repos.getSkill(row.source_skill_id);
    hasNewerSource = !!src && src.version > row.source_version;
  }
  const installedCopyId =
    forWorkspaceId && row.workspace_id !== forWorkspaceId
      ? (repos.findInstalledCopy(forWorkspaceId, row.id)?.id ?? null)
      : null;
  return {
    id: row.id,
    slug: row.slug,
    ownerType: row.owner_type,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    role: row.role,
    promptTemplate: row.prompt_template,
    inputSchema: parseInputSchema(row.input_schema),
    kbBinding: parseKbBinding(row.kb_binding),
    outputSpec: row.output_spec,
    exampleInput: parseJsonObject(row.example_input),
    exampleOutput: row.example_output,
    version: row.version,
    changelog: row.changelog,
    status: row.status as SkillDto['status'],
    visibility: row.visibility as SkillDto['visibility'],
    sourceSkillId: row.source_skill_id,
    sourceVersion: row.source_version,
    installCount: row.install_count,
    featured: row.featured === 1,
    featuredAt: row.featured_at ?? null,
    listedAt: row.listed_at ?? null,
    contributorName: contributorOf(repos, row).name,
    contributorWorkspaceName: contributorOf(repos, row).workspaceName,
    hasNewerSource,
    verifiedNotes: row.verified_notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    installedCopyId,
  };
}

function deliveryDto(row: DeliveryLinkRow): DeliveryLinkDto {
  return {
    id: row.id,
    kind: row.kind === 'visit' ? 'visit' : 'delivery',
    scope: row.scope as 'task' | 'project' | 'workspace',
    taskId: row.task_id,
    projectId: row.project_id,
    title: row.title,
    hasPassword: !!row.password_hash,
    expiresAt: row.expires_at,
    revoked: row.revoked === 1,
    viewCount: row.view_count,
    createdAt: row.created_at,
  };
}

/** token 哈希与 deliveryService.deliveryTokenHash 同一实现（交付/参观共用口径） */
const tokenHash = deliveryTokenHash;

interface ChannelsSetting {
  mj?: { baseUrl: string; tokenEnc: string; account: string };
  /** G-17 通用 Webhook：secret 与 MJ token 同加密口径（encryptKey）存 settings.channels */
  generic_webhook?: { url: string; secretEnc: string; events: string[] };
}

export function registerM7Routes(
  app: FastifyInstance,
  deps: { repos: Repos; logger: Logger },
  helpers: M7Helpers,
): void {
  const { repos, logger } = deps;
  const { wsAuth, requireAdmin, audit } = helpers;

  // 交付页口令表单走原生 form POST（application/x-www-form-urlencoded），Fastify 默认不解析，需补解析器
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const out: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(body as string)) out[k] = v;
        done(null, out);
      } catch (e) {
        done(e as Error, undefined);
      }
    },
  );

  /* ================= skill 系统（§7） ================= */
  const getSkillOr404 = (id: string): SkillRow => {
    const s = repos.getSkill(id);
    if (!s) fail(ErrorCode.NOT_FOUND, 'skill 不存在', 404);
    return s!;
  };
  /** 可编辑口径：本空间自有行（作者本人；空间所有者亦可）或平台行（仅管理员） */
  const assertEditable = (ctx: RouteCtx & { workspaceId: string }, s: SkillRow): void => {
    if (s.owner_type === 'platform') {
      if (ctx.user.is_platform_admin !== 1) fail(ErrorCode.FORBIDDEN, '平台官方 skill 仅管理员可改', 403);
      return;
    }
    if (s.workspace_id !== ctx.workspaceId) fail(ErrorCode.NOT_FOUND, 'skill 不存在', 404);
    const membership = repos.getMembership(ctx.user.id, ctx.workspaceId);
    if (s.created_by !== ctx.user.id && membership?.role !== 'owner') {
      fail(ErrorCode.FORBIDDEN, '只能编辑自己创建的 skill', 403);
    }
  };

  app.get('/api/skills', async (req) => {
    const ctx = wsAuth(req);
    const own = repos
      .listWorkspaceSkills(ctx.workspaceId)
      .filter((s) => s.created_by === ctx.user.id || s.visibility !== 'private');
    const ownIds = new Set(own.map((s) => s.id));
    const library = repos.listLibrarySkills().filter((s) => !ownIds.has(s.id));
    return {
      ok: true,
      skills: [...own, ...library].map((s) => skillDto(repos, s, ctx.workspaceId)),
    };
  });

  app.get('/api/skills/:id', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const s = getSkillOr404(id);
    if (!skillVisibleToWorkspace(s, ctx.workspaceId) && s.created_by !== ctx.user.id) {
      fail(ErrorCode.NOT_FOUND, 'skill 不存在', 404);
    }
    if (s.workspace_id !== ctx.workspaceId && s.visibility === 'private' && s.created_by !== ctx.user.id) {
      fail(ErrorCode.NOT_FOUND, 'skill 不存在', 404);
    }
    return { ok: true, skill: skillDto(repos, s, ctx.workspaceId) };
  });

  app.post('/api/skills', async (req) => {
    const ctx = wsAuth(req);
    const { skill: b } = skillSaveSchema.parse(req.body ?? {});
    const ts = nowIso();
    let slug = (b.slug || '').trim();
    if (!slug) {
      slug = /^[a-z0-9-_]+$/i.test(b.name) ? b.name.toLowerCase() : `s-${uid('').slice(2, 10)}`;
    }
    const dup = repos
      .listWorkspaceSkills(ctx.workspaceId)
      .some((s) => s.slug === slug && s.status !== 'archived');
    if (dup) fail(ErrorCode.VALIDATION, `本空间已有 slug 为「${slug}」的 skill`);
    const visibility = b.visibility ?? 'private';
    const row: SkillRow = {
      id: uid('skill'),
      slug,
      owner_type: visibility === 'private' ? 'user' : 'workspace',
      owner_id: visibility === 'private' ? ctx.user.id : null,
      workspace_id: ctx.workspaceId,
      name: b.name,
      description: b.description,
      role: b.role,
      prompt_template: b.promptTemplate,
      input_schema: JSON.stringify(b.inputSchema),
      kb_binding: JSON.stringify(b.kbBinding),
      output_spec: b.outputSpec,
      example_input: JSON.stringify(b.exampleInput),
      example_output: b.exampleOutput,
      version: 1,
      changelog: b.changelog || '初始版本',
      status: 'draft',
      visibility,
      source_skill_id: null,
      source_version: null,
      install_count: 0,
      verified_notes: '',
      created_by: ctx.user.id,
      created_at: ts,
      updated_at: ts,
      featured: 0,
      featured_at: null,
      listed_at: null,
      contributor_name: null,
      contributor_workspace_name: null,
    };
    repos.insertSkill(row);
    audit(req, ctx, 'create_skill', 'skill', row.id, row.name);
    return { ok: true, id: row.id, skill: skillDto(repos, row, ctx.workspaceId) };
  });

  app.put('/api/skills/:id', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const cur = getSkillOr404(id);
    assertEditable(ctx, cur);
    const { skill: b } = skillSaveSchema.parse(req.body ?? {});
    const contentChanged =
      b.name !== cur.name ||
      b.promptTemplate !== cur.prompt_template ||
      JSON.stringify(b.inputSchema) !== cur.input_schema ||
      JSON.stringify(b.kbBinding) !== cur.kb_binding ||
      b.outputSpec !== cur.output_spec ||
      b.role !== cur.role;
    if (contentChanged && !b.changelog.trim()) {
      fail(ErrorCode.VALIDATION, '修改 skill 内容需填写本次修改说明（changelog）');
    }
    const next: SkillRow = {
      ...cur,
      name: b.name,
      description: b.description,
      role: b.role,
      prompt_template: b.promptTemplate,
      input_schema: JSON.stringify(b.inputSchema),
      kb_binding: JSON.stringify(b.kbBinding),
      output_spec: b.outputSpec,
      example_input: JSON.stringify(b.exampleInput),
      example_output: b.exampleOutput,
      version: contentChanged ? cur.version + 1 : cur.version,
      changelog: contentChanged ? b.changelog.trim() : cur.changelog,
      updated_at: nowIso(),
    };
    repos.updateSkill(next);
    audit(req, ctx, 'update_skill', 'skill', id, `v${next.version}`);
    return { ok: true, skill: skillDto(repos, next, ctx.workspaceId) };
  });

  app.post('/api/skills/:id/publish', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const cur = getSkillOr404(id);
    assertEditable(ctx, cur);
    const next: SkillRow = {
      ...cur,
      status: 'published',
      visibility: cur.visibility === 'private' ? 'workspace' : cur.visibility,
      owner_type: cur.owner_type === 'user' ? 'workspace' : cur.owner_type,
      owner_id: cur.owner_type === 'user' ? null : cur.owner_id,
      updated_at: nowIso(),
    };
    repos.updateSkill(next);
    audit(req, ctx, 'publish_skill', 'skill', id);
    return { ok: true, skill: skillDto(repos, next, ctx.workspaceId) };
  });

  app.post('/api/skills/:id/archive', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const cur = getSkillOr404(id);
    assertEditable(ctx, cur);
    repos.updateSkill({ ...cur, status: 'archived', updated_at: nowIso() });
    audit(req, ctx, 'archive_skill', 'skill', id);
    return { ok: true };
  });

  app.post('/api/skills/:id/submit-review', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const cur = getSkillOr404(id);
    if (cur.workspace_id !== ctx.workspaceId) fail(ErrorCode.NOT_FOUND, 'skill 不存在', 404);
    if (cur.owner_type === 'platform') fail(ErrorCode.VALIDATION, '官方 skill 已在平台库');
    if (cur.visibility === 'public') fail(ErrorCode.VALIDATION, '该 skill 已上架平台库');
    repos.updateSkill({
      ...cur,
      status: 'published',
      visibility: 'pending_review',
      updated_at: nowIso(),
    });
    audit(req, ctx, 'submit_skill_review', 'skill', id, cur.name);
    return { ok: true };
  });

  app.post('/api/skills/:id/install', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const { upgrade } = skillInstallSchema.parse(req.body ?? {});
    const src = getSkillOr404(id);
    if (!skillVisibleToWorkspace(src, ctx.workspaceId) || src.workspace_id === ctx.workspaceId) {
      fail(ErrorCode.VALIDATION, '只能安装平台库/他人空间的 skill 到本空间');
    }
    if (src.status !== 'published') fail(ErrorCode.VALIDATION, '该 skill 未发布，不可安装');
    const existing = repos.findInstalledCopy(ctx.workspaceId, src.id);
    if (existing && !upgrade) {
      return { ok: true, id: existing.id, alreadyInstalled: true, skill: skillDto(repos, existing, ctx.workspaceId) };
    }
    if (existing && upgrade) {
      const next: SkillRow = {
        ...existing,
        name: src.name,
        description: src.description,
        role: src.role,
        prompt_template: src.prompt_template,
        input_schema: src.input_schema,
        kb_binding: src.kb_binding,
        output_spec: src.output_spec,
        example_input: src.example_input,
        example_output: src.example_output,
        source_version: src.version,
        version: existing.version + 1,
        changelog: `升级到源 v${src.version}（快照复制）`,
        updated_at: nowIso(),
      };
      repos.updateSkill(next);
      audit(req, ctx, 'upgrade_skill_install', 'skill', existing.id, `源 v${src.version}`);
      return { ok: true, id: existing.id, upgraded: true, skill: skillDto(repos, next, ctx.workspaceId) };
    }
    const copy = copySkillSnapshot(repos, src, ctx.workspaceId, ctx.user.id);
    audit(req, ctx, 'install_skill', 'skill', copy.id, `${src.name}（源 ${src.id} v${src.version}）`);
    return { ok: true, id: copy.id, skill: skillDto(repos, copy, ctx.workspaceId) };
  });

  app.post('/api/skills/:id/dispatch', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const body = skillDispatchSchema.parse(req.body ?? {});
    const skill = getSkillOr404(id);
    if (!skillVisibleToWorkspace(skill, ctx.workspaceId)) fail(ErrorCode.NOT_FOUND, 'skill 不存在', 404);
    if (skill.status !== 'published') fail(ErrorCode.VALIDATION, 'skill 尚未发布，先发布再发单（或用试运行验证草稿）');
    if (body.projectId && !repos.getProject(body.projectId, ctx.workspaceId)) {
      fail(ErrorCode.NOT_FOUND, '项目不存在', 404);
    }
    if (body.assetRefs?.length) {
      for (const ref of body.assetRefs) {
        if (!repos.getAsset(ref.assetId, ctx.workspaceId)) {
          fail(ErrorCode.NOT_FOUND, `资产「${ref.assetId}」不存在`, 404);
        }
      }
    }
    const task = createTaskFromSkill(repos, {
      skill,
      params: body.params,
      teamId: body.teamId,
      projectId: body.projectId ?? null,
      workspaceId: ctx.workspaceId,
      userId: ctx.user.id,
      titleOverride: body.title,
    });
    if (body.assetRefs?.length) attachAssetRefs(repos, task.id, ctx.workspaceId, body.assetRefs);
    audit(req, ctx, 'skill_dispatch', 'skill', id, `任务 ${task.id}`);
    return { ok: true, id: task.id, taskId: task.id };
  });

  app.post('/api/skills/:id/test-run', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const body = skillTestRunSchema.parse(req.body ?? {});
    const skill = getSkillOr404(id);
    if (skill.workspace_id !== ctx.workspaceId && !skillVisibleToWorkspace(skill, ctx.workspaceId)) {
      fail(ErrorCode.NOT_FOUND, 'skill 不存在', 404);
    }
    const params = { ...parseJsonObject(skill.example_input), ...(body.params ?? {}) };
    const task = createTaskFromSkill(repos, {
      skill,
      params,
      teamId: body.teamId,
      workspaceId: ctx.workspaceId,
      userId: ctx.user.id,
      isTest: true,
    });
    audit(req, ctx, 'skill_test_run', 'skill', id, `任务 ${task.id}（试运行照常记账）`);
    return { ok: true, id: task.id, taskId: task.id };
  });

  /* ----- 平台库上架审核（管理员） ----- */
  app.get('/api/admin/skills/pending', async (req) => {
    requireAdmin(req);
    return { ok: true, skills: repos.listPendingReviewSkills().map((s) => skillDto(repos, s)) };
  });
  app.post('/api/admin/skills/:id/approve', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const cur = getSkillOr404(id);
    if (cur.visibility !== 'pending_review') fail(ErrorCode.VALIDATION, '该 skill 不在待审核状态');
    // v1.3.0 B：上架即落定——listed_at + 署名快照（当前贡献者显示名/当前空间名，能取到必须落真实值；
    // 取不到写空串，contributorOf 把空串视同未落定、仍走实时回退）。
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
    audit(req, ctx, 'admin_approve_skill', 'skill', id, cur.name);
    return { ok: true };
  });
  app.post('/api/admin/skills/:id/reject', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    const cur = getSkillOr404(id);
    if (cur.visibility !== 'pending_review') fail(ErrorCode.VALIDATION, '该 skill 不在待审核状态');
    repos.updateSkill({ ...cur, visibility: 'workspace', updated_at: nowIso() });
    audit(req, ctx, 'admin_reject_skill', 'skill', id, body.reason || '未写原因');
    return { ok: true };
  });

  /* ================= 交付闭环（§11.2） ================= */
  app.post('/api/deliveries', async (req) => {
    const ctx = wsAuth(req);
    const body = deliveryCreateSchema.parse(req.body ?? {});
    let title = body.title ?? '';
    if (body.scope === 'task') {
      const t = body.taskId ? repos.getTask(body.taskId, ctx.workspaceId) : undefined;
      if (!t) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
      if (!title) title = t!.title;
    } else {
      const p = body.projectId ? repos.getProject(body.projectId, ctx.workspaceId) : undefined;
      if (!p) fail(ErrorCode.NOT_FOUND, '项目不存在', 404);
      if (!title) title = p!.name;
    }
    // 创建走 deliveryService.createDeliveryLink 唯一 domain 入口（G-13 起交付/参观共用、扩 kind 参数）
    const { row, path } = await createDeliveryLink(repos, {
      workspaceId: ctx.workspaceId,
      kind: 'delivery',
      scope: body.scope,
      taskId: body.scope === 'task' ? (body.taskId ?? null) : null,
      projectId: body.scope === 'project' ? (body.projectId ?? null) : null,
      title,
      password: body.password,
      expiresInDays: body.expiresInDays,
      createdBy: ctx.user.id,
    });
    audit(req, ctx, 'create_delivery', 'delivery', row.id, title);
    return { ok: true, delivery: { ...deliveryDto(row), path } };
  });

  app.get('/api/deliveries', async (req) => {
    const ctx = wsAuth(req);
    return { ok: true, deliveries: repos.listDeliveries(ctx.workspaceId).map(deliveryDto) };
  });

  app.post('/api/deliveries/:id/revoke', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    if (!repos.getDelivery(id, ctx.workspaceId)) fail(ErrorCode.NOT_FOUND, '交付页不存在', 404);
    repos.revokeDelivery(id);
    audit(req, ctx, 'revoke_delivery', 'delivery', id);
    return { ok: true };
  });

  const exportFile = async (
    req: FastifyRequest,
    reply: { header: (k: string, v: string) => void; send: (b: string) => unknown },
    kind: 'task' | 'project',
    id: string,
  ) => {
    const ctx = wsAuth(req);
    const format = ((req.query as { format?: string })?.format ?? 'md').toLowerCase();
    let content: string;
    let filename: string;
    if (kind === 'task') {
      const t = repos.getTask(id, ctx.workspaceId);
      if (!t) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
      content = format === 'csv' ? taskToCsv(t!) : taskToMarkdown(t!);
      filename = `task-${id}.${format === 'csv' ? 'csv' : 'md'}`;
    } else {
      const p = repos.getProject(id, ctx.workspaceId);
      if (!p) fail(ErrorCode.NOT_FOUND, '项目不存在', 404);
      content = format === 'csv' ? projectToCsv(repos, p!) : projectToMarkdown(repos, p!);
      filename = `project-${id}.${format === 'csv' ? 'csv' : 'md'}`;
    }
    reply.header('content-type', format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    return reply.send(content);
  };
  app.get('/api/tasks/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    return exportFile(req, reply as never, 'task', id);
  });
  app.get('/api/projects/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    return exportFile(req, reply as never, 'project', id);
  });

  /** 只读交付页（公开，不走 /api 会话守卫）：只有 token 命中的那一份内容 */
  const deliveryContent = (row: DeliveryLinkRow): { title: string; body: string; meta: string } => {
    if (row.scope === 'task' && row.task_id) {
      const t = repos.getTask(row.task_id, row.workspace_id);
      if (!t) return { title: row.title, body: '（成果已不存在）', meta: '' };
      return {
        title: row.title || t.title,
        body: taskToMarkdown(t),
        meta: `任务成果 · ${t.type} · ${t.status}`,
      };
    }
    if (row.scope === 'project' && row.project_id) {
      const p = repos.getProject(row.project_id, row.workspace_id);
      if (!p) return { title: row.title, body: '（项目已不存在）', meta: '' };
      return {
        title: row.title || p.name,
        body: projectToMarkdown(repos, p),
        meta: `项目交付 · ${p.status}`,
      };
    }
    return { title: row.title, body: '（交付内容不存在）', meta: '' };
  };
  const serveDelivery = async (
    req: FastifyRequest,
    reply: { type: (t: string) => void; status: (n: number) => { send: (b: string) => unknown }; send: (b: string) => unknown },
  ) => {
    const { token } = req.params as { token: string };
    const row = repos.getDeliveryByTokenHash(tokenHash(token));
    if (!row || row.revoked === 1) {
      reply.type('text/html');
      return reply.status(410).send(renderDeliveryHtml('交付页不可用', '该交付链接不存在或已被撤销。', ''));
    }
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      reply.type('text/html');
      return reply.status(410).send(renderDeliveryHtml('交付页已过期', '该交付链接已超过有效期。', ''));
    }
    if (row.password_hash) {
      const given = (req.body as { password?: string } | undefined)?.password ?? '';
      if (!given || !(await verifyPassword(row.password_hash, given))) {
        reply.type('text/html');
        return reply.send(renderDeliveryPasswordHtml(row.title, !!given));
      }
    }
    repos.bumpDeliveryView(row.id);
    const c = deliveryContent(row);
    // G-13：任务交付页内嵌同款分享卡图（带 token 的卡图 URL，token 校验同交付页，见下方路由）
    const extra =
      row.scope === 'task' && row.task_id
        ? `<img class="sharecard" src="/d/${(req.params as { token: string }).token}/share-card.svg" alt="成果分享卡"/>`
        : '';
    reply.type('text/html');
    return reply.send(renderDeliveryHtml(c.title, c.body, c.meta, extra));
  };
  app.get('/d/:token', async (req, reply) => serveDelivery(req, reply as never));
  app.post('/d/:token', async (req, reply) => serveDelivery(req, reply as never));

  /**
   * 交付页内嵌分享卡图（G-13）：token 校验同交付页（不存在/已撤销/已过期一律 404）。
   * 卡面只有成果标题+摘要+空间名（交付页本身即对 token 持有者公开同一内容），不另泄漏。
   */
  app.get('/d/:token/share-card.svg', async (req, reply) => {
    const { token } = req.params as { token: string };
    const row = repos.getDeliveryByTokenHash(deliveryTokenHash(token));
    if (
      !row ||
      row.kind !== 'delivery' ||
      row.revoked === 1 ||
      (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) ||
      row.scope !== 'task' ||
      !row.task_id
    ) {
      return reply.status(404).send('Not Found');
    }
    const t = repos.getTask(row.task_id, row.workspace_id);
    if (!t) return reply.status(404).send('Not Found');
    const ws = repos.getWorkspace(row.workspace_id);
    reply.type('image/svg+xml');
    return reply.send(
      renderShareCardSvg({
        title: row.title || t.title,
        result: t.result,
        workspaceName: ws?.name ?? '',
        date: (t.finished_at ?? t.created_at).slice(0, 10),
      }),
    );
  });

  /* ================= 渠道适配器（§12.4）+ MJ 直推（§11.2）+ 通用 Webhook（G-17） ================= */
  const readChannels = (workspaceId: string): ChannelsSetting =>
    repos.getSetting<ChannelsSetting>('channels', {}, workspaceId);
  /** 按渠道类型取配置（G-17 起多渠道并存；MJ 口径与原实现一致） */
  const channelConfigFor = (raw: ChannelsSetting, type: string): ChannelConfig => {
    if (type === 'generic_webhook') {
      const g = raw.generic_webhook;
      return {
        baseUrl: '',
        token: '',
        url: g?.url ?? '',
        secret: g ? decryptKey(g.secretEnc) : '',
        events: g?.events ?? ['delivered'],
      };
    }
    const mj = raw.mj;
    return {
      baseUrl: mj?.baseUrl ?? '',
      token: mj ? decryptKey(mj.tokenEnc) : '',
      account: mj?.account ?? '',
    };
  };

  app.get('/api/channels', async (req) => {
    const ctx = wsAuth(req);
    const raw = readChannels(ctx.workspaceId);
    const mj = channelConfigFor(raw, 'mj');
    const gw = channelConfigFor(raw, 'generic_webhook');
    return {
      ok: true,
      channels: [
        {
          type: 'mj',
          name: 'MJ 平台',
          baseUrl: mj.baseUrl,
          account: mj.account ?? '',
          hasToken: !!mj.token,
          bound: !!(mj.baseUrl && mj.token),
        },
        {
          type: 'generic_webhook',
          name: '通用 Webhook',
          baseUrl: '',
          account: '',
          hasToken: !!gw.secret,
          bound: !!(gw.url && gw.secret),
          url: gw.url ?? '',
          hasSecret: !!gw.secret,
          secretMasked: gw.secret ? maskKey(gw.secret) : '',
          events: gw.events ?? ['delivered'],
          supportsMetrics: false,
        },
      ],
    };
  });

  app.post('/api/channels/bind', async (req) => {
    const ctx = wsAuth(req);
    const body = channelBindSchema.parse(req.body ?? {});
    const adapter = getChannelAdapter(body.channelType);
    if (!adapter) fail(ErrorCode.VALIDATION, `未知渠道类型「${body.channelType}」`);
    const raw = readChannels(ctx.workspaceId);
    if (body.channelType === 'generic_webhook') {
      // G-17：url/secret 表单；保存前先过共用 SSRF 守卫（不安全直接 400，不落配置）
      const prev = channelConfigFor(raw, 'generic_webhook');
      const url = (body.url ?? body.baseUrl ?? prev.url ?? '').trim();
      if (!url) fail(ErrorCode.VALIDATION, 'Webhook URL 必填');
      await assertSafeOutboundUrl(url);
      const secret = body.clearSecret
        ? ''
        : body.secret && body.secret !== ''
          ? body.secret
          : (prev.secret ?? '');
      if (!secret) fail(ErrorCode.VALIDATION, '签名密钥（secret）必填');
      const events = body.events && body.events.length ? body.events : (prev.events ?? ['delivered']);
      const next: ChannelsSetting = {
        ...raw,
        generic_webhook: { url, secretEnc: encryptKey(secret), events },
      };
      repos.setSetting('channels', next, ctx.workspaceId);
      const result = await adapter!.authBind({ baseUrl: '', token: '', url, secret, events });
      audit(req, ctx, 'bind_channel', 'channel', body.channelType, result.bound ? '绑定成功' : result.message);
      return { ok: true, bind: result };
    }
    const cfg = channelConfigFor(raw, 'mj');
    if (!body.baseUrl) fail(ErrorCode.VALIDATION, '渠道地址必填');
    const token = body.clearToken ? '' : body.token && body.token !== '' ? body.token : cfg.token;
    const next: ChannelsSetting = {
      ...raw,
      mj: { baseUrl: body.baseUrl, tokenEnc: encryptKey(token), account: body.account ?? cfg.account ?? '' },
    };
    repos.setSetting('channels', next, ctx.workspaceId);
    const result = await adapter!.authBind({ baseUrl: body.baseUrl, token, account: body.account });
    audit(req, ctx, 'bind_channel', 'channel', body.channelType, result.bound ? '绑定成功' : result.message);
    return { ok: true, bind: result };
  });

  app.post('/api/channels/push', async (req) => {
    const ctx = wsAuth(req);
    const body = channelPushSchema.parse(req.body ?? {});
    const adapter = getChannelAdapter(body.channelType);
    if (!adapter) fail(ErrorCode.VALIDATION, `未知渠道类型「${body.channelType}」`);
    const cfg = channelConfigFor(readChannels(ctx.workspaceId), body.channelType);
    let title = '';
    let content = '';
    let totalTokens = 0;
    let totalCostMilli = 0;
    if (body.taskId) {
      const t = repos.getTask(body.taskId, ctx.workspaceId);
      if (!t) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
      if (t!.status !== TaskStatus.DONE) fail(ErrorCode.VALIDATION, '只有已完成的成果可推送');
      title = t!.title;
      content = t!.result;
      totalTokens = t!.total_tokens;
      totalCostMilli = t!.total_cost_milli;
    } else if (body.projectId) {
      const p = repos.getProject(body.projectId, ctx.workspaceId);
      if (!p) fail(ErrorCode.NOT_FOUND, '项目不存在', 404);
      title = p!.name;
      content = projectToMarkdown(repos, p!);
      for (const t of repos.listTasks(ctx.workspaceId).filter((x) => x.project_id === p!.id)) {
        totalTokens += t.total_tokens;
        totalCostMilli += t.total_cost_milli;
      }
    } else {
      fail(ErrorCode.VALIDATION, '需要提供 taskId 或 projectId');
    }
    // G-17：通用 Webhook 的 payload 需带可打开的交付页链接——为本次推送新建一条交付链接
    // （交付链接只存 token 哈希，存量链接无法反推 URL，故按推送新建，口径同手动建交付页）。
    let deliveryUrl: string | undefined;
    if (body.channelType === 'generic_webhook') {
      const link = await createDeliveryLink(repos, {
        workspaceId: ctx.workspaceId,
        kind: 'delivery',
        scope: body.taskId ? 'task' : 'project',
        taskId: body.taskId ?? null,
        projectId: body.projectId ?? null,
        title,
        createdBy: ctx.user.id,
      });
      deliveryUrl = link.path;
    }
    const ts = nowIso();
    const pushId = repos.insertChannelPush({
      workspace_id: ctx.workspaceId,
      channel_type: body.channelType,
      task_id: body.taskId ?? null,
      project_id: body.projectId ?? null,
      status: 'pending',
      remote_ref: '',
      message: '',
      created_at: ts,
      updated_at: ts,
    });
    const result = await adapter.pushPublish(cfg, {
      title,
      content,
      kind: body.taskId ? 'task_result' : 'project_bundle',
      localRef: body.taskId ?? body.projectId ?? '',
      deliveryUrl,
      usageSummary: `共 ${totalTokens} tokens，成本 ¥${milliToYuan(totalCostMilli)}`,
      totalTokens,
      totalCostYuan: milliToYuan(totalCostMilli),
    });
    repos.updateChannelPush(pushId, result.status, result.remoteRef, result.message);
    const row = repos.getChannelPush(pushId, ctx.workspaceId)!;
    logger.info('channel', `渠道推送 ${body.channelType} → ${result.status}：${result.message}`, { taskId: body.taskId ?? undefined });
    audit(req, ctx, 'channel_push', 'channel', body.channelType, result.message);
    const dto: ChannelPushDto = {
      id: row.id,
      channelType: row.channel_type,
      taskId: row.task_id,
      projectId: row.project_id,
      status: row.status,
      remoteRef: row.remote_ref,
      message: row.message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    return { ok: true, push: dto };
  });

  app.get('/api/channels/pushes', async (req) => {
    const ctx = wsAuth(req);
    const pushes: ChannelPushDto[] = repos.listChannelPushes(ctx.workspaceId).map((r) => ({
      id: r.id,
      channelType: r.channel_type,
      taskId: r.task_id,
      projectId: r.project_id,
      status: r.status,
      remoteRef: r.remote_ref,
      message: r.message,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    return { ok: true, pushes };
  });

  app.post('/api/channels/pushes/:id/refresh', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const row = repos.getChannelPush(Number(id), ctx.workspaceId);
    if (!row) fail(ErrorCode.NOT_FOUND, '推送记录不存在', 404);
    const adapter = getChannelAdapter(row!.channel_type);
    if (!adapter) fail(ErrorCode.VALIDATION, `未知渠道类型「${row!.channel_type}」`);
    const cfg = channelConfigFor(readChannels(ctx.workspaceId), row!.channel_type);
    const metrics = await adapter.fetchMetrics(cfg, row!.remote_ref);
    if (metrics.ok) {
      repos.updateChannelPush(row!.id, row!.status, row!.remote_ref, `回查：${metrics.message}；指标 ${JSON.stringify(metrics.metrics)}`);
    }
    return { ok: true, metrics };
  });
}
