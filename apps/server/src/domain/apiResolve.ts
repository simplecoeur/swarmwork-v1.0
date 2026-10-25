import type { ApiRow, Repos } from '../store/repositories';

/**
 * 自备 API 统一解析（v1.4.0 H：成员级绑定）。
 *
 * 优先级（严格）：成员 api_id → 小组 api_id → 空间 defaultApiId 设置。
 * 平台体验 API 不在此链内——仍由调用方在自备解析落空后末位兜底（如引擎 resolveApiRow）。
 *
 * 悬空语义（两级不同，硬性口径）：
 * - 成员级：成员 api_id 指向的行已不存在（API 已删）→ 视为未绑定、继续下行到小组/默认，
 *   不阻塞执行（删 API 时路由层还会主动清理绑定，此处下行是双保险）。
 * - 小组/默认级：保持现行语义一字不改——候选 id 取 `team?.api_id || defaultApiId`，
 *   该 id 查无此行 → 返回 null（不继续下行；例如小组绑了已删 API 时不会再退到空间默认）。
 *
 * 隔离口径：成员/小组/API 单查一律带 workspaceId，成员不存在或跨空间即跳过成员级；
 * ctx.teamId 缺省时用成员自身的 team_id 作小组级上下文。
 */
export interface ApiResolveCtx {
  memberId?: string | null;
  teamId?: string | null;
}

export function resolveOwnApiRow(
  repos: Repos,
  workspaceId: string,
  ctx: ApiResolveCtx,
): ApiRow | null {
  let teamId = ctx.teamId ?? null;

  if (ctx.memberId) {
    const member = repos.getMember(ctx.memberId, workspaceId);
    if (member) {
      if (!teamId) teamId = member.team_id ?? null;
      const memberApiId = member.api_id ?? null;
      if (memberApiId) {
        const row = repos.getApi(memberApiId, workspaceId);
        if (row) return row;
        // 成员级悬空：视为未绑定，继续下行（不返回 null）
      }
    }
    // 成员不存在 / 跨空间：跳过成员级（teamId 仍以入参为准，不采信跨空间成员的 team_id）
  }

  const team = teamId ? repos.getTeam(teamId, workspaceId) : undefined;
  const apiId = team?.api_id || repos.getSetting<string | null>('defaultApiId', null, workspaceId);
  if (!apiId) return null;
  return repos.getApi(apiId, workspaceId) ?? null;
}

/** 同口径回 id：即 resolveOwnApiRow 命中的行 id；无命中（未配置 / 小组或默认级悬空）返回 null。 */
export function resolveOwnApiId(
  repos: Repos,
  workspaceId: string,
  ctx: ApiResolveCtx,
): string | null {
  return resolveOwnApiRow(repos, workspaceId, ctx)?.id ?? null;
}
