import * as crypto from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ACCOUNT_DELETION_GRACE_MS,
  AVATAR_LIMITS,
  ErrorCode,
  EXPORT_LIMITS,
  IMPORT_LIMITS,
  KB_SCOPES,
  SCHEDULE_SCAN_MS,
  TaskStatus,
  milliToYuan,
  yuanToMilli,
  type AccountDto,
  type ApiTokenDto,
  type AuthSessionDto,
  type DeliveryLinkDto,
  type FeedbackDto,
  type KbImportItemResultDto,
  type OpenTaskDto,
  type ScheduleDto,
  type WebhookDeliveryDto,
  type WebhookDto,
} from '@swarm/shared';
import * as fs from 'fs';
import { clearCookieHeader, verifyPassword } from '../auth/auth';
import {
  AVATAR_EXT_TO_MIME,
  AVATAR_MIME_TO_EXT,
  avatarFilePath,
  avatarUrlOf,
  deleteAvatarFile,
  processDueDeletions,
  saveAvatarFile,
  uaSummary,
} from '../domain/accountService';
import { notifyUser } from '../domain/notify';
import { assetDtoOf, createAsset } from '../domain/assetService';
import {
  buildSummary,
  checkLowBalance,
  effectiveLowBalanceThresholdMilli,
  estimateCost,
} from '../domain/costService';
import {
  createDeliveryLink,
  deliveryTokenHash,
  renderDeliveryHtml,
  renderDeliveryPasswordHtml,
} from '../domain/deliveryService';
import { buildWorkspaceExport } from '../domain/exportService';
import { parseAssetSectionsFromFile, parseKbDrafts } from '../domain/importService';
import { buildVisitPageData, renderShareCardSvg, renderVisitHtml } from '../domain/visitService';
import { createKbEntry } from '../domain/kbService';
import {
  computeNextRunAt,
  parseScheduleParams,
  runDueSchedules,
  validateScheduleInput,
} from '../domain/scheduleService';
import { searchWorkspace } from '../domain/searchService';
import { resolveTypeForSkill } from '../domain/skillService';
import { assertSafeOutboundUrl } from '../domain/ssrf';
import { attemptWebhookDelivery, webhookDtoOf } from '../domain/webhookService';
import type { Logger } from '../logger';
import { encryptKey, maskKey } from '../store/crypto';
import type {
  ApiTokenRow,
  DeliveryLinkRow,
  FeedbackRow,
  Repos,
  ScheduleRow,
  SessionRow,
  TaskRow,
  UserRow,
  WebhookDeliveryRow,
  WebhookRow,
} from '../store/repositories';
import { nowIso, uid } from '../util';
import {
  accountProfileSchema,
  apiTokenCreateSchema,
  assetImportConfirmSchema,
  costSettingsSchema,
  deleteRequestSchema,
  feedbackCreateSchema,
  feedbackHandleSchema,
  kbImportConfirmSchema,
  openTaskCreateSchema,
  scheduleCreateSchema,
  scheduleUpdateSchema,
  visitLinkCreateSchema,
  webhookCreateSchema,
  webhookUpdateSchema,
  workspaceTransferSchema,
} from './schemas';
import type { M7Helpers, RouteCtx } from './m7';

/** routes.ts 的 createOneTask 共用发单路径（G-07 开放面复用，签名与闭包实现一致） */
export type CreateTaskFn = (
  ctx: RouteCtx & { workspaceId: string },
  body: {
    title: string;
    type: string;
    brief: string;
    references?: string;
    teamId: string;
    projectId?: string | null;
    idempotencyKey?: string;
    skillId?: string | null;
    skillVersion?: number | null;
    assetRefs?: Array<{ assetId: string; sections?: string[] }>;
    source?: string;
  },
) => { id: string; duplicated?: boolean };

export interface V120Helpers extends M7Helpers {
  createTask: CreateTaskFn;
}

function fail(code: string, message: string, status = 400): never {
  throw Object.assign(new Error(message), { code, statusCode: status });
}

function feedbackDto(r: FeedbackRow): FeedbackDto {
  return {
    id: r.id,
    userId: r.user_id,
    workspaceId: r.workspace_id,
    category: r.category as FeedbackDto['category'],
    content: r.content,
    contact: r.contact,
    status: r.status as FeedbackDto['status'],
    adminNote: r.admin_note,
    createdAt: r.created_at,
    handledAt: r.handled_at,
  };
}

/** 反馈频率限制（G-05）：同用户 10 分钟 ≤5 条 */
const FEEDBACK_WINDOW_MS = 10 * 60_000;
const FEEDBACK_MAX_IN_WINDOW = 5;

interface MultipartInput {
  filename: string;
  buffer: Buffer;
  fields: Record<string, string>;
}

/**
 * v1.2.0 批次一路由组：
 * - G-05 反馈：POST /api/feedback（登录用户、频率限制）、GET /api/admin/feedback（仅管理员）、
 *   POST /api/admin/feedback/:id/handle（置 handled + 备注，落 audit）。只落库，不做工单流转。
 * - G-08 预估与阈值：GET /api/cost/estimate（退级链）、GET/PUT /api/cost/settings（低余额阈值）。
 *   report 的 summary 段在 costService.buildReport 内拼装（见 routes 的 /api/cost/report）。
 * - G-06 文件导入（两段式）：KB/资产各一对 preview（multipart 解析、只回草案不落库）+
 *   confirm（逐条/整份走现有创建路径落库，导入动作落 audit）。上限按 IMPORT_LIMITS，超限零落库。
 */
export function registerV120Routes(
  app: FastifyInstance,
  deps: { repos: Repos; logger: Logger; dataDir: string },
  helpers: V120Helpers,
): void {
  const { repos, logger } = deps;
  const { auth, wsAuth, requireAdmin, audit } = helpers;

  /* ================= G-05 反馈 ================= */
  app.post('/api/feedback', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const body = feedbackCreateSchema.parse(req.body ?? {});
    const since = new Date(Date.now() - FEEDBACK_WINDOW_MS).toISOString();
    if (repos.countFeedbackSince(ctx.user.id, since) >= FEEDBACK_MAX_IN_WINDOW) {
      fail(ErrorCode.VALIDATION, '提交太频繁了：10 分钟内最多 5 条反馈，请稍后再试');
    }
    const id = repos.insertFeedback({
      user_id: ctx.user.id,
      workspace_id: ctx.workspaceId,
      category: body.category,
      content: body.content,
      contact: body.contact?.trim() ? body.contact.trim() : null,
      status: 'open',
      admin_note: null,
      created_at: nowIso(),
      handled_at: null,
    });
    audit(req, ctx, 'create_feedback', 'feedback', String(id), body.category);
    logger.info('feedback', `收到用户反馈 #${id}（${body.category}）`);
    return { ok: true, id };
  });

  app.get('/api/admin/feedback', async (req: FastifyRequest) => {
    requireAdmin(req);
    const q = (req.query ?? {}) as { status?: string; page?: string; pageSize?: string };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20) || 20));
    const { rows, total } = repos.listFeedback({
      status: q.status ? String(q.status) : undefined,
      page,
      pageSize,
    });
    return { ok: true, feedback: rows.map(feedbackDto), total, page, pageSize };
  });

  app.post('/api/admin/feedback/:id/handle', async (req: FastifyRequest) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const row = repos.getFeedback(Number(id));
    if (!row) fail(ErrorCode.NOT_FOUND, '反馈不存在', 404);
    const body = feedbackHandleSchema.parse(req.body ?? {});
    repos.markFeedbackHandled(Number(id), body.adminNote?.trim() ? body.adminNote.trim() : null);
    audit(req, ctx, 'handle_feedback', 'feedback', String(id), body.adminNote ?? '');
    const next = repos.getFeedback(Number(id));
    return { ok: true, feedback: next ? feedbackDto(next) : undefined };
  });

  /* ================= G-08 预估 + 阈值设置 ================= */
  app.get('/api/cost/estimate', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const q = (req.query ?? {}) as { type?: string; skillId?: string };
    let type = q.type ? String(q.type) : undefined;
    const skillId = q.skillId ? String(q.skillId) : undefined;
    if (skillId) {
      const skill = repos.getSkill(skillId);
      if (!skill) fail(ErrorCode.NOT_FOUND, 'skill 不存在', 404);
      // skill 样本不足退 type 时，type 取该 skill 的派单类型（与发单解析同口径）
      if (!type) type = resolveTypeForSkill(repos, skill!, ctx.workspaceId);
    }
    const estimate = estimateCost(repos, ctx.workspaceId, { type, skillId });
    return { ok: true, estimate };
  });

  app.get('/api/cost/settings', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const explicit = repos.getSetting<number | null>('lowBalanceThresholdMilli', null, ctx.workspaceId);
    const effective = effectiveLowBalanceThresholdMilli(repos, ctx.workspaceId);
    return {
      ok: true,
      settings: {
        lowBalanceThresholdMilli: explicit,
        lowBalanceThresholdYuan: explicit !== null ? milliToYuan(explicit) : null,
        effectiveThresholdMilli: effective,
        effectiveThresholdYuan: effective !== null ? milliToYuan(effective) : null,
      },
      summary: buildSummary(repos, ctx.workspaceId),
    };
  });

  app.put('/api/cost/settings', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const body = costSettingsSchema.parse(req.body ?? {});
    const milli =
      body.lowBalanceThresholdYuan === null ? null : yuanToMilli(body.lowBalanceThresholdYuan);
    repos.setSetting('lowBalanceThresholdMilli', milli, ctx.workspaceId);
    audit(req, ctx, 'update_cost_settings', 'settings', 'lowBalanceThresholdMilli', String(milli));
    // 阈值变更后立即按新线检查一次（改低/改高都可能形成一次上穿/下穿）
    checkLowBalance(repos, ctx.workspaceId, logger);
    const effective = effectiveLowBalanceThresholdMilli(repos, ctx.workspaceId);
    return {
      ok: true,
      settings: {
        lowBalanceThresholdMilli: milli,
        lowBalanceThresholdYuan: milli !== null ? milliToYuan(milli) : null,
        effectiveThresholdMilli: effective,
        effectiveThresholdYuan: effective !== null ? milliToYuan(effective) : null,
      },
    };
  });

  /* ================= G-06 知识 / 资产文件导入（两段式） ================= */

  /** 读 multipart：取（唯一）文件与其余文本字段；文件大小在此按业务上限 5MB 校验（超限 VALIDATION） */
  const readMultipartFile = async (req: FastifyRequest): Promise<MultipartInput> => {
    let filename = '';
    let buffer: Buffer | null = null;
    const fields: Record<string, string> = {};
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          filename = part.filename || '';
          buffer = await part.toBuffer();
        } else {
          fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value ?? '');
        }
      }
    } catch (e) {
      fail(
        ErrorCode.VALIDATION,
        `文件上传解析失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!buffer) fail(ErrorCode.VALIDATION, '请选择要导入的文件');
    if (buffer!.length > IMPORT_LIMITS.MAX_FILE_BYTES) {
      fail(
        ErrorCode.VALIDATION,
        `文件「${filename}」为 ${(buffer!.length / 1024 / 1024).toFixed(1)}MB，超过单文件上限 5MB，请拆分后分批导入`,
      );
    }
    return { filename, buffer: buffer!, fields };
  };

  /**
   * KB scope 归一化：与手建 POST /api/kb 完全同口径（routes.ts normalizeKbScope）——
   * member 折算 personal（以 owner 归属、scopeId 不用）、company/platform/personal 的 scopeId 为 null、
   * team 必须指向本空间存在的小组、platform 仅平台管理员可写。
   */
  const normalizeImportScope = (
    ctx: RouteCtx & { workspaceId: string },
    scopeRaw: string,
    scopeIdRaw: string | null | undefined,
  ): { scope: string; scopeId: string | null } => {
    if (!(KB_SCOPES as readonly string[]).includes(scopeRaw)) {
      fail(ErrorCode.VALIDATION, `不支持的 scope「${scopeRaw}」`);
    }
    if (scopeRaw === 'platform' && ctx.user.is_platform_admin !== 1) {
      fail(ErrorCode.FORBIDDEN, '平台公共知识仅平台管理员可维护', 403);
    }
    const scope = scopeRaw === 'member' ? 'personal' : scopeRaw;
    if (scope === 'company' || scope === 'platform' || scope === 'personal') {
      return { scope, scopeId: null };
    }
    if (!scopeIdRaw) fail(ErrorCode.VALIDATION, `scope=${scope} 时必须指定 scopeId`);
    if (scope === 'team' && !repos.getTeam(scopeIdRaw!, ctx.workspaceId)) {
      fail(ErrorCode.VALIDATION, 'scopeId 指向的小组不存在');
    }
    return { scope, scopeId: scopeIdRaw! };
  };

  /** 资产类型存在性：与手建 POST /api/assets 同口径（注册表可见集内不存在即 VALIDATION） */
  const assertAssetType = (ctx: RouteCtx & { workspaceId: string }, typeId: string): void => {
    const packId = repos.getWorkspace(ctx.workspaceId)?.industry_pack_id ?? null;
    if (!repos.listAssetTypesVisible(ctx.workspaceId, packId).some((t) => t.type_id === typeId)) {
      fail(ErrorCode.VALIDATION, `资产类型「${typeId}」未在注册表中登记`);
    }
  };

  app.post('/api/kb/import/preview', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const { filename, buffer, fields } = await readMultipartFile(req);
    // preview 阶段即校验 scope 口径（与 confirm/手建一致），让错误在落库前暴露
    normalizeImportScope(ctx, (fields.scope || 'company').trim(), fields.scopeId?.trim() || null);
    const drafts = await parseKbDrafts(filename, buffer);
    if (!drafts.length) fail(ErrorCode.VALIDATION, '未能从文件中解析出任何条目，请检查文件内容');
    if (drafts.length > IMPORT_LIMITS.MAX_KB_DRAFTS) {
      fail(
        ErrorCode.VALIDATION,
        `文件解析出 ${drafts.length} 条，超过 KB 单次导入上限 ${IMPORT_LIMITS.MAX_KB_DRAFTS} 条，请拆分文件分批导入`,
      );
    }
    return { ok: true, filename, drafts };
  });

  app.post('/api/kb/import/confirm', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const body = kbImportConfirmSchema.parse(req.body ?? {});
    const { scope, scopeId } = normalizeImportScope(ctx, body.scope, body.scopeId ?? null);
    const results: KbImportItemResultDto[] = [];
    let created = 0;
    body.drafts.forEach((d, index) => {
      const title = d.title.trim();
      if (!title) {
        results.push({ index, title, ok: false, error: '标题必填' });
        return;
      }
      const tags = d.tags.map((t) => t.trim()).filter(Boolean);
      const row = createKbEntry(repos, {
        title,
        body: d.body,
        scope,
        scopeId,
        tags,
        enabled: true,
        workspaceId: scope === 'platform' ? null : ctx.workspaceId,
        ownerUserId: scope === 'personal' ? ctx.user.id : null,
      });
      created++;
      results.push({ index, title, ok: true, id: row.id });
    });
    audit(
      req,
      ctx,
      'import_kb',
      'kb',
      '',
      `${body.filename ?? ''} · 成功 ${created}/${body.drafts.length} 条`,
    );
    logger.info('import', `KB 文件导入：${body.filename ?? ''} 成功 ${created}/${body.drafts.length} 条`);
    return { ok: true, results, created, failed: results.length - created };
  });

  app.post('/api/assets/import/preview', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const { filename, buffer, fields } = await readMultipartFile(req);
    const typeId = (fields.typeId || '').trim();
    if (!typeId) fail(ErrorCode.VALIDATION, '请选择资产类型');
    assertAssetType(ctx, typeId);
    const name = filename.replace(/\.[^.]+$/, '').trim() || '导入资产';
    const sections = await parseAssetSectionsFromFile(filename, buffer, name);
    if (!sections.length) fail(ErrorCode.VALIDATION, '未能从文件中解析出任何分段，请检查文件内容');
    if (sections.length > IMPORT_LIMITS.MAX_ASSET_SECTIONS) {
      fail(
        ErrorCode.VALIDATION,
        `文件解析出 ${sections.length} 个分段，超过资产单次导入上限 ${IMPORT_LIMITS.MAX_ASSET_SECTIONS} 个，请拆分文件分批导入`,
      );
    }
    return { ok: true, filename, name, sections };
  });

  app.post('/api/assets/import/confirm', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const body = assetImportConfirmSchema.parse(req.body ?? {});
    assertAssetType(ctx, body.typeId);
    const row = createAsset(repos, {
      workspaceId: ctx.workspaceId,
      typeId: body.typeId,
      name: body.name,
      content: {
        summary: body.summary ? body.summary : undefined,
        sections: body.sections,
      },
      createdBy: ctx.user.id,
    });
    audit(
      req,
      ctx,
      'import_asset',
      'asset',
      row.id,
      `${body.filename ?? ''} · ${body.sections.length} 个分段`,
    );
    logger.info(
      'import',
      `资产文件导入：${body.filename ?? ''} → 资产 ${row.id}（${body.sections.length} 个分段，v1）`,
    );
    return { ok: true, id: row.id, asset: assetDtoOf(row) };
  });

  /* ================= G-07 对外开放 API + Webhook（批次二） ================= */

  const tokenDto = (r: ApiTokenRow): ApiTokenDto => {
    let scopes: string[] = [];
    try {
      const v = JSON.parse(r.scopes || '[]') as unknown;
      scopes = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      scopes = [];
    }
    return {
      id: r.id,
      name: r.name,
      tokenPrefix: r.token_prefix,
      scopes,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
      createdAt: r.created_at,
    };
  };

  const deliveryDto = (d: WebhookDeliveryRow): WebhookDeliveryDto => ({
    id: d.id,
    webhookId: d.webhook_id,
    event: d.event,
    taskId: d.task_id,
    status: d.status as WebhookDeliveryDto['status'],
    attempts: d.attempts,
    lastError: d.last_error,
    nextRetryAt: d.next_retry_at,
    createdAt: d.created_at,
  });

  /* ----- Token 管理（会话守卫）：明文只在创建响应出现一次 ----- */
  app.post('/api/tokens', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const body = apiTokenCreateSchema.parse(req.body ?? {});
    const plain = 'swk_' + crypto.randomBytes(32).toString('base64url');
    const row: ApiTokenRow = {
      id: uid('tok'),
      user_id: ctx.user.id,
      workspace_id: ctx.workspaceId,
      name: body.name,
      token_hash: crypto.createHash('sha256').update(plain).digest('hex'),
      token_prefix: plain.slice(0, 8),
      scopes: JSON.stringify([...new Set(body.scopes)]),
      last_used_at: null,
      revoked_at: null,
      created_at: nowIso(),
    };
    repos.insertApiToken(row);
    audit(req, ctx, 'create_api_token', 'api_token', row.id, body.name);
    logger.info('openapi', `创建 API Token「${body.name}」（${row.token_prefix}…）`);
    return { ok: true, token: { ...tokenDto(row), token: plain } };
  });

  app.get('/api/tokens', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    return { ok: true, tokens: repos.listApiTokens(ctx.workspaceId).map(tokenDto) };
  });

  app.delete('/api/tokens/:id', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const row = repos.getApiToken(id, ctx.workspaceId);
    if (!row) fail(ErrorCode.NOT_FOUND, 'Token 不存在', 404);
    repos.revokeApiToken(id);
    audit(req, ctx, 'revoke_api_token', 'api_token', id, row!.name);
    return { ok: true };
  });

  /* ----- 开放面 Token 守卫（独立于会话） -----
   * Authorization: Bearer <token> → sha256 哈希查行 → 吊销/用户状态/空间状态校验 →
   * 【membership 校验落点】token 所属用户仍须是该空间 active 成员，失格即 401
   * （G-15 空间转让后原所有者 Token 对该空间自然失效，靠的就是这一处校验）→ scopes 校验。 */
  interface TokenAuth {
    tokenRow: ApiTokenRow;
    user: UserRow;
    workspaceId: string;
    ctx: RouteCtx & { workspaceId: string };
  }
  const tokenAuth = (req: FastifyRequest, scope: string): TokenAuth => {
    const header = String(req.headers.authorization ?? '');
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) fail(ErrorCode.UNAUTHORIZED, '缺少或无效的 API Token', 401);
    const hash = crypto.createHash('sha256').update(m[1]!.trim()).digest('hex');
    const row = repos.getApiTokenByHash(hash);
    if (!row || row.revoked_at) fail(ErrorCode.UNAUTHORIZED, 'API Token 无效或已吊销', 401);
    const user = repos.getUser(row!.user_id);
    if (!user || user!.status !== 'active') fail(ErrorCode.UNAUTHORIZED, 'Token 所属账号不可用', 401);
    const ws = repos.getWorkspace(row!.workspace_id);
    if (!ws || ws!.status !== 'active') fail(ErrorCode.UNAUTHORIZED, 'Token 所属空间不可用', 401);
    const membership = repos.getMembership(user!.id, row!.workspace_id);
    if (!membership || membership.status !== 'active') {
      fail(ErrorCode.UNAUTHORIZED, 'Token 所属用户已不是该空间成员', 401);
    }
    let scopes: string[] = [];
    try {
      const v = JSON.parse(row!.scopes || '[]') as unknown;
      scopes = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      scopes = [];
    }
    if (!scopes.includes(scope)) {
      fail(ErrorCode.FORBIDDEN, `Token 权限不足：需要 ${scope} 权限`, 403);
    }
    repos.touchApiToken(row!.id);
    const ctx: RouteCtx & { workspaceId: string } = {
      user: user!,
      // 开放面无浏览器会话：session 位以空会话占位（createOneTask 只用 user 与 workspaceId）
      session: null as unknown as SessionRow,
      workspaceId: row!.workspace_id,
    };
    return { tokenRow: row!, user: user!, workspaceId: row!.workspace_id, ctx };
  };

  const openTaskDto = (t: TaskRow): OpenTaskDto => {
    const events = repos.listTaskEvents(t.id);
    const source = events.some((e) => String(e.note ?? '').includes('开放 API')) ? 'api' : 'web';
    return {
      id: t.id,
      title: t.title,
      type: t.type,
      status: t.status,
      teamId: t.team_id,
      projectId: t.project_id,
      skillId: t.skill_id ?? null,
      source,
      totalTokens: t.total_tokens,
      totalCostYuan: milliToYuan(t.total_cost_milli),
      createdAt: t.created_at,
      finishedAt: t.finished_at,
    };
  };

  /* ----- 开放面（Token 守卫）：与页面发单共用 createOneTask 同一路径与守卫链 ----- */
  app.post('/api/open/tasks', async (req: FastifyRequest) => {
    const tctx = tokenAuth(req, 'dispatch');
    const body = openTaskCreateSchema.parse(req.body ?? {});
    const r = helpers.createTask(tctx.ctx, {
      title: body.title,
      type: body.type,
      brief: body.brief,
      references: body.references,
      teamId: body.teamId,
      projectId: body.projectId ?? null,
      idempotencyKey: body.idempotencyKey,
      skillId: body.skillId ?? null,
      skillVersion: body.skillVersion ?? null,
      assetRefs: body.assetRefs,
      source: 'api',
    });
    const task = repos.getTask(r.id, tctx.workspaceId);
    logger.info('openapi', `开放 API 发单 → 任务 ${r.id}（Token ${tctx.tokenRow.token_prefix}…）`);
    return { ok: true, id: r.id, ...(r.duplicated ? { duplicated: true } : {}), task: task ? openTaskDto(task) : undefined };
  });

  app.get('/api/open/tasks/:id', async (req: FastifyRequest) => {
    const tctx = tokenAuth(req, 'read');
    const { id } = req.params as { id: string };
    const task = repos.getTask(id, tctx.workspaceId);
    if (!task) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
    return { ok: true, task: openTaskDto(task!) };
  });

  app.get('/api/open/tasks/:id/result', async (req: FastifyRequest) => {
    const tctx = tokenAuth(req, 'read');
    const { id } = req.params as { id: string };
    const task = repos.getTask(id, tctx.workspaceId);
    if (!task) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
    if (task!.status !== TaskStatus.DONE) {
      fail(ErrorCode.VALIDATION, `任务尚未完成（当前「${task!.status}」），暂无成果`);
    }
    return {
      ok: true,
      task: { ...openTaskDto(task!), result: task!.result, reviewNote: task!.review_note },
    };
  });

  /* ----- Webhook 管理（会话守卫）：创建/改址走 SSRF 守卫，secret 加密存、只回掩码 ----- */
  const getWebhookOr404 = (ctx: RouteCtx & { workspaceId: string }, id: string): WebhookRow => {
    const row = repos.getWebhook(id, ctx.workspaceId);
    if (!row) fail(ErrorCode.NOT_FOUND, 'Webhook 不存在', 404);
    return row!;
  };

  app.post('/api/webhooks', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const body = webhookCreateSchema.parse(req.body ?? {});
    await assertSafeOutboundUrl(body.url);
    const secret = body.secret?.trim() ? body.secret.trim() : crypto.randomBytes(24).toString('base64url');
    const row: WebhookRow = {
      id: uid('whk'),
      workspace_id: ctx.workspaceId,
      url: body.url.trim(),
      secret_enc: encryptKey(secret),
      events: JSON.stringify([...new Set(body.events)]),
      enabled: body.enabled ? 1 : 0,
      created_at: nowIso(),
    };
    repos.insertWebhook(row);
    audit(req, ctx, 'create_webhook', 'webhook', row.id, row.url);
    return { ok: true, webhook: webhookDtoOf(row, maskKey) as WebhookDto };
  });

  app.get('/api/webhooks', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    return {
      ok: true,
      webhooks: repos.listWebhooks(ctx.workspaceId).map((h) => webhookDtoOf(h, maskKey) as WebhookDto),
    };
  });

  app.put('/api/webhooks/:id', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const cur = getWebhookOr404(ctx, id);
    const body = webhookUpdateSchema.parse(req.body ?? {});
    if (body.url !== undefined && body.url.trim() !== cur.url) {
      await assertSafeOutboundUrl(body.url.trim());
    }
    const next: WebhookRow = {
      ...cur,
      url: body.url !== undefined ? body.url.trim() : cur.url,
      secret_enc: body.clearSecret
        ? encryptKey('')
        : body.secret?.trim()
          ? encryptKey(body.secret.trim())
          : cur.secret_enc,
      events: body.events ? JSON.stringify([...new Set(body.events)]) : cur.events,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : cur.enabled,
    };
    repos.updateWebhook(next);
    audit(req, ctx, 'update_webhook', 'webhook', id, next.enabled === 1 ? '启用' : '停用');
    return { ok: true, webhook: webhookDtoOf(next, maskKey) as WebhookDto };
  });

  app.delete('/api/webhooks/:id', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    getWebhookOr404(ctx, id);
    repos.deleteWebhook(id);
    audit(req, ctx, 'delete_webhook', 'webhook', id);
    return { ok: true };
  });

  app.get('/api/webhooks/:id/deliveries', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    getWebhookOr404(ctx, id);
    return { ok: true, deliveries: repos.listWebhookDeliveries(id).map(deliveryDto) };
  });

  /** 试投递：生成一条 test 事件投递并立即尝试一次（失败按正常退避排重试） */
  app.post('/api/webhooks/:id/test', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const hook = getWebhookOr404(ctx, id);
    const payload = JSON.stringify({
      event: 'test',
      webhookId: hook.id,
      workspaceId: ctx.workspaceId,
      message: '干活蜂群 Webhook 试投递：你的端点已成功接通时，这条会以 success 落账。',
      occurredAt: nowIso(),
    });
    const deliveryId = repos.insertWebhookDelivery({
      webhook_id: hook.id,
      workspace_id: ctx.workspaceId,
      event: 'test',
      task_id: null,
      payload,
      status: 'pending',
      attempts: 0,
      last_error: null,
      next_retry_at: nowIso(),
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    const fresh = repos.getWebhookDelivery(deliveryId);
    const done = fresh ? await attemptWebhookDelivery(repos, fresh, logger) : fresh;
    audit(req, ctx, 'test_webhook', 'webhook', id, done?.status ?? '');
    return { ok: true, delivery: done ? deliveryDto(done) : undefined };
  });

  /* G-15 页面最小只读补口（批次三）：按邮箱精确查用户，供转让页选目标。
   * 仅登录可达、仅精确匹配、只回 id/邮箱/显示名/状态；查不到 404。转让校验链不变，
   * 最终合法性仍由 POST /api/workspaces/:id/transfer 全链校验（本口不做任何资格判断）。 */
  app.get('/api/users/lookup', async (req: FastifyRequest) => {
    auth(req);
    const email = String((req.query as { email?: string })?.email ?? '').trim();
    if (!email) fail(ErrorCode.VALIDATION, '需要提供 email 查询参数');
    const u = repos.getUserByEmail(email);
    if (!u) fail(ErrorCode.NOT_FOUND, '该邮箱未注册', 404);
    return {
      ok: true,
      user: { id: u!.id, email: u!.email, displayName: u!.display_name, status: u!.status },
    };
  });

  /* ================= G-15 空间所有权转让（批次二接口先行，页面留批次三） =================
   * POST /api/workspaces/:id/transfer { targetUserId, password }：所有者本人 + 验密。
   * 校验链：操作者是该空间 owner（非成员 404 不泄漏存在性、成员非 owner 403）→ 验密 →
   * 目标存在且 status='active'（pending_deletion/disabled/pending 一并在此拒绝）、非本人。
   * 单事务：memberships 目标行 role=owner（无则建）、原所有者行删除、workspaces.owner_user_id 同步
   * （workspaces 自 003 迁移起即有 owner_user_id 列——以它与 memberships role 双写为准）。
   * 连带：空间内 apis/额度/定时计划/Webhook 归空间不随人走；原所有者的 api_tokens 靠 G-07
   * Token 守卫的 membership 校验自然失效；其 personal KB 随 membership 移除按既有口径隐身不删。
   * 管理台不提供强制转让（不开运营越权口子）。 */
  app.post('/api/workspaces/:id/transfer', async (req: FastifyRequest) => {
    const ctx = auth(req);
    const { id } = req.params as { id: string };
    const body = workspaceTransferSchema.parse(req.body ?? {});
    const ws = repos.getWorkspace(id);
    if (!ws || ws.status !== 'active') fail(ErrorCode.NOT_FOUND, '空间不存在', 404);
    const mine = repos.getMembership(ctx.user.id, id);
    if (!mine || mine.status !== 'active') fail(ErrorCode.NOT_FOUND, '空间不存在', 404);
    if (mine!.role !== 'owner') fail(ErrorCode.FORBIDDEN, '只有空间所有者可以转让所有权', 403);
    const okPw = await verifyPassword(ctx.user.password_hash, body.password);
    if (!okPw) fail(ErrorCode.VALIDATION, '密码不正确，转让未执行');
    if (body.targetUserId === ctx.user.id) {
      fail(ErrorCode.VALIDATION, '不能把空间转让给自己');
    }
    const target = repos.getUser(body.targetUserId);
    if (!target) fail(ErrorCode.VALIDATION, '接收人不存在');
    if (target!.status === 'pending_deletion') {
      fail(ErrorCode.VALIDATION, '接收人账号正处于注销冷静期，不能接收空间');
    }
    if (target!.status !== 'active') {
      fail(ErrorCode.VALIDATION, '接收人账号未开通或已停用，不能接收空间');
    }
    repos.tx(() => {
      repos.insertMembership({
        user_id: target!.id,
        workspace_id: id,
        role: 'owner',
        status: 'active',
        joined_at: nowIso(),
      });
      repos.deleteMembership(ctx.user.id, id);
      repos.updateWorkspaceOwner(id, target!.id);
    });
    // 两侧 audit：转出一条（actor=原所有者）+ 接收一条（user_id=新所有者），ledger-view 按空间合并可见
    repos.insertAudit({
      workspace_id: id,
      user_id: ctx.user.id,
      action: 'transfer_workspace_out',
      target_type: 'workspace',
      target_id: id,
      detail: `转让给 ${target!.email}`,
      ip: req.ip ?? '',
    });
    repos.insertAudit({
      workspace_id: id,
      user_id: target!.id,
      action: 'transfer_workspace_in',
      target_type: 'workspace',
      target_id: id,
      detail: `自 ${ctx.user.email} 接收所有权`,
      ip: req.ip ?? '',
    });
    // 两侧通知（type='transfer'，G-03 已注册）：按人投递——此时所有者已变更，notifyOwner 只达新所有者
    notifyUser(repos, target!.id, id, 'transfer', '你已成为空间所有者', `你已成为空间「${ws!.name}」的所有者（由 ${ctx.user.email} 转让）。空间内的 API、额度、定时计划与 Webhook 保持不变。`);
    notifyUser(repos, ctx.user.id, id, 'transfer', '空间所有权已转让', `你已把空间「${ws!.name}」的所有权转让给 ${target!.email}，你不再是该空间成员。`);
    logger.info('workspace', `空间 ${id} 所有权转让：${ctx.user.id} → ${target!.id}`);
    return { ok: true, workspaceId: id, newOwnerUserId: target!.id };
  });

  /* ================= G-09 全局搜索（批次二） ================= */
  app.get('/api/search', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const q = (req.query ?? {}) as { q?: string; types?: string };
    const query = String(q.q ?? '');
    const types = q.types
      ? String(q.types)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const result = searchWorkspace(repos, ctx.workspaceId, ctx.user.id, query, types);
    return { ok: true, ...result };
  });

  /* ================= G-13 办公室参观链接 + 成果分享卡（批次三） =================
   * 参观链接与交付页同一张 delivery_links 表、同一 domain 创建函数（createDeliveryLink
   * 扩 kind='visit'）：token 只存哈希、口令 argon2、有效期/撤销/浏览计数全口径复用。
   * visit 行 scope='workspace'（target 即空间本身），公开面 /v/:token 的数据只经
   * visitService.buildVisitPageData 的字段白名单出口（默认拒绝，零任务内容/金额）。 */
  const visitDto = (r: DeliveryLinkRow): DeliveryLinkDto => ({
    id: r.id,
    kind: 'visit',
    scope: 'workspace',
    taskId: null,
    projectId: null,
    title: r.title,
    hasPassword: !!r.password_hash,
    expiresAt: r.expires_at,
    revoked: r.revoked === 1,
    viewCount: r.view_count,
    createdAt: r.created_at,
  });

  app.post('/api/visit-links', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const body = visitLinkCreateSchema.parse(req.body ?? {});
    const ws = repos.getWorkspace(ctx.workspaceId);
    const { row, path } = await createDeliveryLink(repos, {
      workspaceId: ctx.workspaceId,
      kind: 'visit',
      scope: 'workspace',
      title: ws?.name ?? '',
      password: body.password,
      expiresInDays: body.expiresInDays,
      createdBy: ctx.user.id,
    });
    audit(req, ctx, 'create_visit_link', 'visit_link', row.id, row.title);
    return { ok: true, visitLink: { ...visitDto(row), path } };
  });

  app.get('/api/visit-links', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    return { ok: true, visitLinks: repos.listDeliveries(ctx.workspaceId, 'visit').map(visitDto) };
  });

  app.delete('/api/visit-links/:id', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const row = repos.getDelivery(id, ctx.workspaceId);
    if (!row || row.kind !== 'visit') fail(ErrorCode.NOT_FOUND, '参观链接不存在', 404);
    repos.revokeDelivery(id);
    audit(req, ctx, 'revoke_visit_link', 'visit_link', id, row!.title);
    return { ok: true };
  });

  /** 公开参观页（无登录）：撤销/不存在 → 404；过期/口令行为与交付页同组口径（410/口令表单） */
  const serveVisit = async (req: FastifyRequest, reply: FastifyReply) => {
    const { token } = req.params as { token: string };
    const row = repos.getDeliveryByTokenHash(deliveryTokenHash(token));
    if (!row || row.kind !== 'visit' || row.revoked === 1) {
      reply.type('text/html');
      return reply.status(404).send(renderDeliveryHtml('参观页不可用', '该参观链接不存在或已被撤销。', ''));
    }
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      reply.type('text/html');
      return reply.status(410).send(renderDeliveryHtml('参观页已过期', '该参观链接已超过有效期。', ''));
    }
    if (row.password_hash) {
      const given = (req.body as { password?: string } | undefined)?.password ?? '';
      if (!given || !(await verifyPassword(row.password_hash, given))) {
        reply.type('text/html');
        return reply.send(renderDeliveryPasswordHtml(row.title, !!given));
      }
    }
    repos.bumpDeliveryView(row.id);
    reply.type('text/html');
    return reply.send(renderVisitHtml(buildVisitPageData(repos, row.workspace_id)));
  };
  app.get('/v/:token', async (req, reply) => serveVisit(req, reply));
  app.post('/v/:token', async (req, reply) => serveVisit(req, reply));

  /** 成果分享卡（会话内、仅 done 任务）：1200×630 SVG，文本节点全量 XML 转义（visitService） */
  app.get('/api/tasks/:id/share-card', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const task = repos.getTask(id, ctx.workspaceId);
    if (!task) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
    if (task!.status !== TaskStatus.DONE) {
      fail(ErrorCode.VALIDATION, '只有已完成的任务可以生成分享卡');
    }
    const ws = repos.getWorkspace(ctx.workspaceId);
    reply.type('image/svg+xml');
    return reply.send(
      renderShareCardSvg({
        title: task!.title,
        result: task!.result,
        workspaceName: ws?.name ?? '',
        date: (task!.finished_at ?? task!.created_at).slice(0, 10),
      }),
    );
  });

  /* ================= G-16 所有者一键全量导出（批次三） =================
   * POST /api/workspaces/:id/export（所有者本人，非所有者成员 403、非成员 404 不泄漏存在性）→
   * 同步组装 zip 附件（exportService；密钥零明文）；组装后 >50MB 回 VALIDATION 并提示走
   * 管理员整库备份通道；落 audit（范围与大小）。 */
  app.post('/api/workspaces/:id/export', async (req: FastifyRequest, reply: FastifyReply) => {
    const baseCtx = auth(req);
    const { id } = req.params as { id: string };
    const ws = repos.getWorkspace(id);
    if (!ws || ws.status !== 'active') fail(ErrorCode.NOT_FOUND, '空间不存在', 404);
    const mine = repos.getMembership(baseCtx.user.id, id);
    if (!mine || mine.status !== 'active') fail(ErrorCode.NOT_FOUND, '空间不存在', 404);
    if (mine!.role !== 'owner') fail(ErrorCode.FORBIDDEN, '只有空间所有者可以导出全量数据', 403);
    const ctx = { ...baseCtx, workspaceId: id };
    const { buffer, counts, elapsedMs } = await buildWorkspaceExport(repos, id);
    if (buffer.length > EXPORT_LIMITS.MAX_ZIP_BYTES) {
      fail(
        ErrorCode.VALIDATION,
        `导出包约 ${(buffer.length / 1024 / 1024).toFixed(1)}MB，超过 50MB 上限；请联系平台管理员走整库备份通道导出`,
      );
    }
    audit(
      req,
      ctx,
      'export_workspace',
      'workspace',
      id,
      `全量导出 ${(buffer.length / 1024).toFixed(1)}KB · 任务 ${counts.tasks} / 成果 ${counts.results} / 知识 ${counts.kb} / 资产 ${counts.assets} / skill ${counts.skills}`,
    );
    logger.info(
      'export',
      `空间 ${id} 全量导出 ${(buffer.length / 1024).toFixed(1)}KB，组装耗时 ${elapsedMs}ms`,
    );
    reply.header('content-type', 'application/zip');
    reply.header(
      'content-disposition',
      `attachment; filename="workspace-export-${id}.zip"`,
    );
    return reply.send(buffer);
  });

  /* ================= G-10 定时任务（批次二） =================
   * 建改校验复用发单同一套函数（validateScheduleInput）；next_run_at 服务端按 timezone 计算。
   * 调度器挂在本注册函数末尾的进程内定时扫描上（与 G-11 注销到期扫描共用同一 tick 基础设施）。 */
  const scheduleDto = (r: ScheduleRow): ScheduleDto => ({
    id: r.id,
    kind: r.kind as ScheduleDto['kind'],
    skillId: r.skill_id,
    pipelineTemplateId: r.pipeline_template_id,
    teamId: r.team_id,
    title: r.title,
    brief: r.brief,
    type: r.type,
    params: parseScheduleParams(r),
    freq: r.freq as ScheduleDto['freq'],
    weekday: r.weekday,
    timeLocal: r.time_local,
    timezone: r.timezone,
    enabled: r.enabled === 1,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastTaskId: r.last_task_id,
    lastResult: r.last_result as ScheduleDto['lastResult'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const getScheduleOr404 = (ctx: RouteCtx & { workspaceId: string }, id: string): ScheduleRow => {
    const row = repos.getSchedule(id, ctx.workspaceId);
    if (!row) fail(ErrorCode.NOT_FOUND, '定时计划不存在', 404);
    return row!;
  };

  app.post('/api/schedules', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const body = scheduleCreateSchema.parse(req.body ?? {});
    if (body.freq === 'weekly' && (body.weekday === undefined || body.weekday === null)) {
      fail(ErrorCode.VALIDATION, '每周计划必须指定星期（weekday 0-6）');
    }
    // timezone 缺省取空间设置（settings.timezone，未设时 Asia/Shanghai）
    const timezone =
      (req.body as { timezone?: string } | undefined)?.timezone ??
      repos.getSetting<string>('timezone', 'Asia/Shanghai', ctx.workspaceId);
    const norm = validateScheduleInput(repos, ctx.workspaceId, {
      kind: body.kind,
      skillId: body.skillId ?? null,
      pipelineTemplateId: body.pipelineTemplateId ?? null,
      teamId: body.teamId,
      title: body.title,
      type: body.type,
      params: body.params,
      assetRefs: body.assetRefs,
    });
    const title =
      body.title ||
      (body.kind === 'skill'
        ? (repos.getSkill(norm.skillId ?? '')?.name ?? '定时 skill')
        : body.kind === 'pipeline'
          ? '定时流水线'
          : '');
    const ts = nowIso();
    const row: ScheduleRow = {
      id: uid('sch'),
      workspace_id: ctx.workspaceId,
      created_by_user_id: ctx.user.id,
      kind: body.kind,
      skill_id: norm.skillId,
      pipeline_template_id: norm.pipelineTemplateId,
      team_id: body.teamId,
      title,
      brief: body.brief,
      type: body.type,
      params: JSON.stringify(norm.params),
      freq: body.freq,
      weekday: body.freq === 'weekly' ? (body.weekday ?? null) : null,
      time_local: body.timeLocal,
      timezone,
      enabled: body.enabled ? 1 : 0,
      next_run_at: computeNextRunAt(
        { freq: body.freq, weekday: body.weekday ?? null, time_local: body.timeLocal, timezone },
        new Date(),
      ),
      last_run_at: null,
      last_task_id: null,
      last_result: null,
      created_at: ts,
      updated_at: ts,
    };
    repos.insertSchedule(row);
    audit(req, ctx, 'create_schedule', 'schedule', row.id, `${row.kind} ${row.freq} ${row.time_local}`);
    return { ok: true, schedule: scheduleDto(row) };
  });

  app.get('/api/schedules', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    return { ok: true, schedules: repos.listSchedules(ctx.workspaceId).map(scheduleDto) };
  });

  app.put('/api/schedules/:id', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const cur = getScheduleOr404(ctx, id);
    const body = scheduleUpdateSchema.parse(req.body ?? {});
    const merged = {
      kind: body.kind ?? cur.kind,
      skillId: body.skillId !== undefined ? body.skillId : cur.skill_id,
      pipelineTemplateId:
        body.pipelineTemplateId !== undefined ? body.pipelineTemplateId : cur.pipeline_template_id,
      teamId: body.teamId ?? cur.team_id,
      title: body.title ?? cur.title,
      brief: body.brief ?? cur.brief,
      type: body.type ?? cur.type,
      params: body.params ?? parseScheduleParams(cur),
      freq: body.freq ?? cur.freq,
      weekday: body.weekday !== undefined ? body.weekday : cur.weekday,
      timeLocal: body.timeLocal ?? cur.time_local,
      timezone: body.timezone ?? cur.timezone,
    };
    if (merged.freq === 'weekly' && (merged.weekday === undefined || merged.weekday === null)) {
      fail(ErrorCode.VALIDATION, '每周计划必须指定星期（weekday 0-6）');
    }
    const norm = validateScheduleInput(repos, ctx.workspaceId, {
      kind: merged.kind,
      skillId: merged.skillId,
      pipelineTemplateId: merged.pipelineTemplateId,
      teamId: merged.teamId,
      title: merged.title,
      type: merged.type,
      params: merged.params,
      assetRefs: body.assetRefs,
    });
    const enabled = body.enabled !== undefined ? body.enabled : cur.enabled === 1;
    const next: ScheduleRow = {
      ...cur,
      kind: merged.kind,
      skill_id: norm.skillId,
      pipeline_template_id: norm.pipelineTemplateId,
      team_id: merged.teamId,
      title: merged.title,
      brief: merged.brief,
      type: merged.type,
      params: JSON.stringify(norm.params),
      freq: merged.freq,
      weekday: merged.freq === 'weekly' ? (merged.weekday ?? null) : null,
      time_local: merged.timeLocal,
      timezone: merged.timezone,
      enabled: enabled ? 1 : 0,
      // 任一改动都按新口径重算下一次（从当前时刻起的最近周期），停用时该值保留但不被扫描
      next_run_at: computeNextRunAt(
        {
          freq: merged.freq,
          weekday: merged.weekday ?? null,
          time_local: merged.timeLocal,
          timezone: merged.timezone,
        },
        new Date(),
      ),
      updated_at: nowIso(),
    };
    repos.updateSchedule(next);
    audit(req, ctx, 'update_schedule', 'schedule', id, next.enabled === 1 ? '启用' : '停用');
    return { ok: true, schedule: scheduleDto(next) };
  });

  app.delete('/api/schedules/:id', async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    getScheduleOr404(ctx, id);
    repos.deleteSchedule(id);
    audit(req, ctx, 'delete_schedule', 'schedule', id);
    return { ok: true };
  });

  /* ============================================================
   * G-11 账号设置（批次二；邮箱验证小块暂缓，仅占位文案）
   * - 资料聚合/改名、头像上传与读取、活跃会话定向吊销、注销冷静期。
   * - 冷静期账号的接口白名单收口在 routes.ts 的 onRequest 守卫；注销到期处理
   *   挂在本文件末尾与 G-10 共用的调度 tick（按日节流），不另起进程。
   * ============================================================ */

  app.get('/api/account', async (req) => {
    const ctx = auth(req);
    const u = ctx.user;
    const workspaces = repos.listMembershipsByUser(u.id).map((m) => {
      const w = repos.getWorkspace(m.workspace_id);
      return { id: m.workspace_id, name: w?.name ?? '(已删除的空间)', role: m.role };
    });
    const account: AccountDto = {
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      avatarUrl: avatarUrlOf(u),
      status: u.status,
      isPlatformAdmin: u.is_platform_admin === 1,
      emailVerified: false,
      emailVerificationNote: '邮箱通道接入后可用',
      deletionAt: u.deletion_at ?? null,
      workspaces,
    };
    return { ok: true, account };
  });

  app.put('/api/account/profile', async (req) => {
    const ctx = auth(req);
    const body = accountProfileSchema.parse(req.body ?? {});
    repos.updateUser({ ...ctx.user, display_name: body.displayName });
    audit(req, ctx, 'update_profile', 'user', ctx.user.id, '修改显示名');
    return { ok: true };
  });

  /** 头像上传：multipart 单文件（@fastify/multipart，G-06 已装）；类型白名单 + ≤2MB，旧文件替换删除 */
  app.post('/api/account/avatar', async (req) => {
    const ctx = auth(req);
    const data = await req.file();
    if (!data) fail(ErrorCode.VALIDATION, '请选择要上传的头像图片', 400);
    const ext = AVATAR_MIME_TO_EXT[data!.mimetype];
    if (!ext) {
      fail(
        ErrorCode.VALIDATION,
        `头像只支持图片（PNG/JPEG/WebP/GIF），当前类型：${data!.mimetype || '未知'}`,
        400,
      );
    }
    const buffer = await data!.toBuffer();
    if (buffer.length === 0) fail(ErrorCode.VALIDATION, '头像文件为空', 400);
    if (buffer.length > AVATAR_LIMITS.MAX_BYTES) {
      fail(ErrorCode.VALIDATION, '头像图片不能超过 2MB', 400);
    }
    if (ctx.user.avatar_file && ctx.user.avatar_file !== `${ctx.user.id}.${ext}`) {
      deleteAvatarFile(deps.dataDir, ctx.user);
    }
    const fileName = saveAvatarFile(deps.dataDir, ctx.user.id, ext!, buffer);
    repos.updateUser({ ...ctx.user, avatar_file: fileName });
    audit(req, ctx, 'update_avatar', 'user', ctx.user.id, `更新头像 ${fileName}`);
    return { ok: true, avatarUrl: avatarUrlOf({ ...ctx.user, avatar_file: fileName }) };
  });

  /** 头像读取：会话内任意登录用户可读（顶栏/管理台列表渲染用）；无头像回 SVG 占位（显示名首字） */
  app.get('/api/users/:id/avatar', async (req, reply) => {
    auth(req);
    const { id } = req.params as { id: string };
    const u = repos.getUser(id);
    if (u?.avatar_file) {
      const full = avatarFilePath(deps.dataDir, u.avatar_file);
      if (full && fs.existsSync(full)) {
        const ext = u.avatar_file.split('.').pop() ?? 'png';
        reply.header('cache-control', 'no-cache');
        reply.type(AVATAR_EXT_TO_MIME[ext] ?? 'application/octet-stream');
        return reply.send(fs.readFileSync(full));
      }
    }
    const initial = (u?.display_name || u?.email || '蜂').slice(0, 1);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" fill="#e2574c"/>` +
      `<text x="32" y="42" font-size="30" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${initial}</text></svg>`;
    reply.header('cache-control', 'no-cache');
    reply.type('image/svg+xml');
    return reply.send(svg);
  });

  /** 活跃会话列表：id 用会话行 id 的掩码前缀作定位（原值=token 哈希，不外泄全文） */
  const sessionDto = (row: SessionRow, currentId: string): AuthSessionDto => ({
    id: row.id.slice(0, 16),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    ip: row.created_ip ?? '',
    userAgent: uaSummary(row.user_agent ?? ''),
    isCurrent: row.id === currentId,
  });

  app.get('/api/auth/sessions', async (req) => {
    const ctx = auth(req);
    const now = nowIso();
    const sessions = repos
      .listSessionsByUser(ctx.user.id)
      .filter((s) => s.expires_at > now)
      .map((s) => sessionDto(s, ctx.session.id));
    return { ok: true, sessions };
  });

  /** 定向吊销：只能吊销本人的会话（越权请求回 404 不泄露存在性）；吊销当前会话即登出 */
  app.delete('/api/auth/sessions/:id', async (req, reply) => {
    const ctx = auth(req);
    const { id } = req.params as { id: string };
    const target = repos
      .listSessionsByUser(ctx.user.id)
      .find((s) => s.id.startsWith(id));
    if (!target) fail(ErrorCode.NOT_FOUND, '会话不存在', 404);
    repos.deleteSession(target!.id);
    audit(req, ctx,
      'revoke_session',
      'session',
      target!.id.slice(0, 16),
      target!.id === ctx.session.id ? '吊销当前会话（登出）' : '吊销一个登录会话',
    );
    if (target!.id === ctx.session.id) {
      reply.header('set-cookie', clearCookieHeader());
      return { ok: true, loggedOut: true };
    }
    return { ok: true };
  });

  app.post('/api/auth/sessions/revoke-others', async (req) => {
    const ctx = auth(req);
    repos.deleteSessionsByUser(ctx.user.id, ctx.session.id);
    audit(req, ctx, 'revoke_other_sessions', 'user', ctx.user.id, '吊销除当前外的全部会话');
    return { ok: true };
  });

  /**
   * 注销申请：验密 → 平台管理员不可自助注销 → 名下仍有自有空间（owner）回 VALIDATION 并列出
   * 阻塞空间名（兜底文案：先经 G-15 接口转让或删除空间）。通过 → pending_deletion + 冷静期
   * 到期时刻（now+7d）+ 吊销全部会话（当场登出）。
   */
  app.post('/api/account/delete-request', async (req, reply) => {
    const ctx = auth(req);
    const body = deleteRequestSchema.parse(req.body ?? {});
    const okPw = await verifyPassword(ctx.user.password_hash, body.password);
    if (!okPw) fail(ErrorCode.VALIDATION, '密码不正确，注销申请未提交', 400);
    if (ctx.user.is_platform_admin === 1) {
      fail(ErrorCode.VALIDATION, '平台管理员账号不可自助注销，请先移交管理员权限', 400);
    }
    const blockingWorkspaces = repos
      .listMembershipsByUser(ctx.user.id)
      .filter((m) => m.role === 'owner')
      .map((m) => {
        const w = repos.getWorkspace(m.workspace_id);
        return { id: m.workspace_id, name: w?.name ?? '(已删除的空间)' };
      });
    if (blockingWorkspaces.length > 0) {
      const names = blockingWorkspaces.map((w) => `「${w.name}」`).join('、');
      return reply.status(400).send({
        ok: false,
        error: {
          code: ErrorCode.VALIDATION,
          message: `你还是这些空间的所有者：${names}。请先把空间转让给其他账号或删除空间，再申请注销。`,
        },
        blockingWorkspaces,
      });
    }
    const deletionAt = new Date(Date.now() + ACCOUNT_DELETION_GRACE_MS).toISOString();
    repos.updateUser({ ...ctx.user, status: 'pending_deletion', deletion_at: deletionAt });
    repos.deleteSessionsByUser(ctx.user.id);
    audit(req, ctx, 'account_delete_request', 'user', ctx.user.id, `申请注销账号，冷静期至 ${deletionAt}`);
    logger.info('account', `用户 ${ctx.user.email} 申请注销账号（冷静期至 ${deletionAt}）`);
    reply.header('set-cookie', clearCookieHeader());
    return { ok: true, deletionAt };
  });

  /** 冷静期内撤销注销：恢复 active、清 deletion_at（当前会话保留） */
  app.post('/api/account/delete-cancel', async (req) => {
    const ctx = auth(req);
    if (ctx.user.status !== 'pending_deletion') {
      fail(ErrorCode.VALIDATION, '账号不在注销冷静期，无需撤销', 400);
    }
    repos.updateUser({ ...ctx.user, status: 'active', deletion_at: null });
    audit(req, ctx, 'account_delete_cancel', 'user', ctx.user.id, '撤销注销申请，账号恢复正常');
    return { ok: true };
  });

  /* ================= 定时扫描基础设施（G-10 调度器；G-11 注销到期扫描共用同一 tick） =================
   * 与引擎 1s tick 分开的进程内 interval（默认 SCHEDULE_SCAN_MS=30s，测试可用
   * SWARM_SCHEDULE_TICK_MS 覆盖）；进程未运行期间不发单（页面已注明「平台运行期间生效」）。 */
  const scheduleTickMs = Number(process.env.SWARM_SCHEDULE_TICK_MS || SCHEDULE_SCAN_MS) || SCHEDULE_SCAN_MS;
  /* G-11 注销到期扫描共用本 tick（同一套定时基础设施，不另起进程）：按日节流；
   * lastDeletionScanAt 初值 0 → 进程启动后首个 tick 即扫一次（到期处理幂等）。 */
  let lastDeletionScanAt = 0;
  const scheduleTimer = setInterval(() => {
    try {
      runDueSchedules(repos, { createTask: helpers.createTask, logger }, new Date());
    } catch (e) {
      logger.error('schedule', `调度扫描异常：${e instanceof Error ? e.message : String(e)}`);
    }
    const nowMs = Date.now();
    if (nowMs - lastDeletionScanAt >= 24 * 60 * 60 * 1000) {
      lastDeletionScanAt = nowMs;
      try {
        const done = processDueDeletions(repos, deps.dataDir, logger);
        if (done.length > 0) logger.info('account', `注销到期扫描处理 ${done.length} 个账号`);
      } catch (e) {
        logger.error('account', `注销到期扫描异常：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }, scheduleTickMs);
  scheduleTimer.unref?.();
}
