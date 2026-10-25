import type { FastifyInstance } from 'fastify';
import { testApiConnection } from '../domain/apiTest';
import { saveDailySettings, type DailySettings } from '../domain/dailySettings';
import type { Logger } from '../logger';
import type { Repos } from '../store/repositories';
import { nowIso, uid } from '../util';
import type { M7Helpers } from './m7';
import { apiTestConnectionSchema, questionnairePutSchema } from './schemas';

/**
 * v1.3.0 C2 路由组：裸配置测试连接 + 问卷存档读写。
 * 存档铁律：answers 里不存 apiKey 明文（api 段只有脱敏形）；PUT 存档绝不碰 apis 表、绝不触发团队重组。
 */

export interface QuestionnaireInput {
  api?: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
  } | null;
  industry?: string;
  job?: string;
  uses?: string[];
  problems?: string;
  checkinReminderEnabled?: boolean;
  checkinReminderTime?: string;
  briefingEnabled?: boolean;
  briefingTime?: string;
  supervisionItems?: string;
}

/** 问卷 → 存档 answers（api 段脱敏：只留 provider/baseUrl/model/apiId/keyMasked） */
export function maskedQuestionnaireAnswers(
  q: QuestionnaireInput,
  apiId: string | null,
): Record<string, unknown> {
  return {
    api: q.api
      ? {
          provider: q.api.provider,
          baseUrl: q.api.baseUrl,
          model: q.api.model,
          apiId,
          keyMasked: '••••',
        }
      : null,
    industry: q.industry ?? '',
    job: q.job ?? '',
    uses: q.uses ?? [],
    problems: q.problems ?? '',
    checkinReminderEnabled: q.checkinReminderEnabled,
    checkinReminderTime: q.checkinReminderTime,
    briefingEnabled: q.briefingEnabled,
    briefingTime: q.briefingTime,
    supervisionItems: q.supervisionItems ?? '',
  };
}

/** 问卷中的提醒字段 → dailySettings 合并补丁（与 G 共用同一 setting 键） */
export function reminderPatchFromQuestionnaire(q: QuestionnaireInput): Partial<DailySettings> {
  const patch: Partial<DailySettings> = {};
  if (typeof q.checkinReminderEnabled === 'boolean') patch.checkinReminderEnabled = q.checkinReminderEnabled;
  if (typeof q.checkinReminderTime === 'string') patch.checkinReminderTime = q.checkinReminderTime;
  if (typeof q.briefingEnabled === 'boolean') patch.briefingEnabled = q.briefingEnabled;
  if (typeof q.briefingTime === 'string') patch.briefingTime = q.briefingTime;
  if (typeof q.supervisionItems === 'string') patch.supervisionItems = q.supervisionItems;
  return patch;
}

export function storeQuestionnaire(
  repos: Repos,
  userId: string,
  workspaceId: string,
  answers: Record<string, unknown>,
): void {
  const cur = repos.getQuestionnaire(workspaceId);
  const ts = nowIso();
  repos.upsertQuestionnaire({
    id: cur?.id ?? uid('quest'),
    user_id: userId,
    workspace_id: workspaceId,
    answers: JSON.stringify(answers),
    created_at: cur?.created_at ?? ts,
    updated_at: ts,
  });
}

function parseAnswers(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function registerQuestionnaireRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; logger: Logger; dataDir: string },
  helpers: M7Helpers,
): void {
  const { repos, logger } = deps;
  const { auth, wsAuth, audit } = helpers;

  /** 裸配置测试连接：仅登录态（建空间问卷第 1 步用，尚无空间上下文）；与 /api/apis/test 共用同一实现 */
  app.post('/api/apis/test-connection', async (req) => {
    auth(req);
    const body = apiTestConnectionSchema.parse(req.body ?? {});
    const test = await testApiConnection({
      provider: body.provider,
      baseUrl: body.baseUrl,
      model: body.model,
      apiKey: body.apiKey ?? '',
    });
    if (test.ok) {
      logger.info('api', `API 裸配置测试连接成功 ${body.provider}/${body.model} ${test.latencyMs}ms`);
      return { ok: true, test };
    }
    // 失败：沿既有错误形状（{ok:true, test:{ok:false,...}} 与 /api/apis/test 一致，含厂商原文）
    logger.warn('api', `API 裸配置测试连接失败：${test.message}`);
    return { ok: true, test };
  });

  app.get('/api/questionnaire', async (req) => {
    const ctx = wsAuth(req);
    const row = repos.getQuestionnaire(ctx.workspaceId);
    return { ok: true, questionnaire: row ? parseAnswers(row.answers) : null };
  });

  app.put('/api/questionnaire', async (req) => {
    const ctx = wsAuth(req);
    // zod 剥离未声明键：payload 里即使带 api/apiKey 也在此丢弃，绝不碰 apis 表
    const body = questionnairePutSchema.parse(req.body ?? {});
    const row = repos.getQuestionnaire(ctx.workspaceId);
    const cur = row ? parseAnswers(row.answers) : {};
    const next: Record<string, unknown> = { ...cur };
    for (const k of ['industry', 'job', 'uses', 'problems', 'supervisionItems'] as const) {
      if (body[k] !== undefined) next[k] = body[k];
    }
    for (const k of ['checkinReminderEnabled', 'checkinReminderTime', 'briefingEnabled', 'briefingTime'] as const) {
      if (body[k] !== undefined) next[k] = body[k];
    }
    storeQuestionnaire(repos, ctx.user.id, ctx.workspaceId, next);
    // 提醒字段同步写 dailySettings（与 G 共用同一键）
    const patch = reminderPatchFromQuestionnaire(body as QuestionnaireInput);
    if (Object.keys(patch).length) saveDailySettings(repos, ctx.workspaceId, patch);
    audit(req, ctx, 'update_questionnaire', 'questionnaire', ctx.workspaceId);
    return { ok: true, questionnaire: next };
  });
}
