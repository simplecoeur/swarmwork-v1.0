import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ErrorCode,
  IMPORT_LIMITS,
  KB_SCOPES,
  milliToYuan,
  yuanToMilli,
  type FeedbackDto,
  type KbImportItemResultDto,
} from '@swarm/shared';
import { assetDtoOf, createAsset } from '../domain/assetService';
import {
  buildSummary,
  checkLowBalance,
  effectiveLowBalanceThresholdMilli,
  estimateCost,
} from '../domain/costService';
import { parseAssetSectionsFromFile, parseKbDrafts } from '../domain/importService';
import { createKbEntry } from '../domain/kbService';
import { resolveTypeForSkill } from '../domain/skillService';
import type { Logger } from '../logger';
import type { FeedbackRow, Repos } from '../store/repositories';
import { nowIso } from '../util';
import {
  assetImportConfirmSchema,
  costSettingsSchema,
  feedbackCreateSchema,
  feedbackHandleSchema,
  kbImportConfirmSchema,
} from './schemas';
import type { M7Helpers, RouteCtx } from './m7';

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
  deps: { repos: Repos; logger: Logger },
  helpers: M7Helpers,
): void {
  const { repos, logger } = deps;
  const { auth, wsAuth, requireAdmin, audit } = helpers;
  void auth;

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
}
