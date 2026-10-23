import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ErrorCode, milliToYuan, yuanToMilli, type FeedbackDto } from '@swarm/shared';
import {
  buildSummary,
  checkLowBalance,
  effectiveLowBalanceThresholdMilli,
  estimateCost,
} from '../domain/costService';
import { resolveTypeForSkill } from '../domain/skillService';
import type { Logger } from '../logger';
import type { FeedbackRow, Repos } from '../store/repositories';
import { nowIso } from '../util';
import { costSettingsSchema, feedbackCreateSchema, feedbackHandleSchema } from './schemas';
import type { M7Helpers } from './m7';

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

/**
 * v1.2.0 批次一路由组：
 * - G-05 反馈：POST /api/feedback（登录用户、频率限制）、GET /api/admin/feedback（仅管理员）、
 *   POST /api/admin/feedback/:id/handle（置 handled + 备注，落 audit）。只落库，不做工单流转。
 * - G-08 预估与阈值：GET /api/cost/estimate（退级链）、GET/PUT /api/cost/settings（低余额阈值）。
 *   report 的 summary 段在 costService.buildReport 内拼装（见 routes 的 /api/cost/report）。
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
}
