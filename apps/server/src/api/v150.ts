import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '@swarm/shared';
import { kbCapTokens, kbScopeRank, selectKbForInjection } from '../domain/kbService';
import { estimateTokens } from '../llm/parse';
import type { Logger } from '../logger';
import type { KbRow, Repos } from '../store/repositories';
import type { M7Helpers } from './m7';
import { kbSearchTestSchema } from './schemas';

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
  const { wsAuth, requireAdmin } = helpers;
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
