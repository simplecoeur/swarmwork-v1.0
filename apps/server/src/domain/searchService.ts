import {
  SEARCH_PER_TYPE_LIMIT,
  SEARCH_TYPES,
  TaskStatus,
  type SearchResponseDto,
  type SearchResultItemDto,
} from '@swarm/shared';
import { parseAssetContent } from './assetService';
import type { Repos } from '../store/repositories';

/**
 * 全局搜索（G-09）：domain 单点实现（searchWorkspace），将来换检索引擎只改这一处。
 * 不建索引表、不引搜索引擎：单空间 solo 规模下，六类实体各跑一条 workspace 过滤后的
 * LIKE 查询足够（skill/资产 section 标题走既有 list + 字面匹配，复用各自可见性定义）。
 *
 * 口径：
 * - q 做 %/_/\ 转义后作字面子串匹配（防通配注入：搜 "%" 只命中真含 % 的行）。
 * - 排序：title 命中优先，其次 updated_at 倒序（tasks/projects 无 updated_at 列，用 created_at）。
 * - 长文本匹配范围：title 全量；brief 前 500 字；result 类只搜 result 前 500 字
 *   （SQL 侧 substr 限定，见 Repos.searchTasks/searchResults/searchProjects）。
 * - 可见性（与隔离同构）：他人 personal KB 不进结果；资产只出名称与 section 标题、
 *   snippet 恒不含正文；skill 出本空间 + 平台库公开项（listLibrarySkills 口径）。
 */

/** LIKE 字面转义：\ 先行，再转义 % 与 _（SQL 侧配 ESCAPE '\' 使用） */
export function escapeLikePattern(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

type Item = SearchResultItemDto;

function snippetOf(text: string, max = 140): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** title 命中优先 + 时间倒序（候选行已带 title 与时间戳） */
function rankAndSlice<T extends { title: string; ts: string }>(
  rows: T[],
  needleLower: string,
  toItem: (r: T) => Item,
): Item[] {
  return rows
    .map((r) => ({ r, titleHit: r.title.toLowerCase().includes(needleLower) ? 0 : 1 }))
    .sort((a, b) => a.titleHit - b.titleHit || (a.r.ts < b.r.ts ? 1 : a.r.ts > b.r.ts ? -1 : 0))
    .slice(0, SEARCH_PER_TYPE_LIMIT)
    .map(({ r }) => toItem(r));
}

export function searchWorkspace(
  repos: Repos,
  workspaceId: string,
  userId: string,
  rawQuery: string,
  typesFilter?: string[],
): SearchResponseDto {
  const q = rawQuery.trim();
  const groups: SearchResponseDto['groups'] = [];
  const empty: SearchResponseDto = { groups: [], results: [] };
  if (!q) return empty;
  const wanted = new Set(
    (typesFilter?.length ? typesFilter : [...SEARCH_TYPES]).filter((t) =>
      (SEARCH_TYPES as readonly string[]).includes(t),
    ),
  );
  const pattern = `%${escapeLikePattern(q)}%`;
  const needle = q.toLowerCase();
  // 候选多取 3 倍，给 title 优先排序留出空间后再切每类上限
  const CANDIDATES = SEARCH_PER_TYPE_LIMIT * 3;

  for (const type of SEARCH_TYPES) {
    if (!wanted.has(type)) continue;
    let items: Item[] = [];
    if (type === 'task') {
      const rows = repos.searchTasks(workspaceId, pattern, CANDIDATES).map((t) => ({
        title: t.title,
        ts: t.created_at,
        row: t,
      }));
      items = rankAndSlice(rows, needle, ({ row }) => ({
        type,
        id: row.id,
        title: row.title,
        snippet: snippetOf(row.brief),
        updatedAt: row.created_at,
      }));
    } else if (type === 'result') {
      const rows = repos.searchResults(workspaceId, pattern, CANDIDATES).map((t) => ({
        title: t.title,
        ts: t.finished_at ?? t.created_at,
        row: t,
      }));
      items = rankAndSlice(rows, needle, ({ row }) => ({
        type,
        id: row.id,
        title: row.title,
        snippet: snippetOf(row.result),
        updatedAt: row.finished_at ?? row.created_at,
      }));
    } else if (type === 'kb') {
      const rows = repos
        .searchKb(workspaceId, pattern, CANDIDATES)
        // 可见性：他人 personal 条目不进结果（与 KB 列表/注入同一口径）
        .filter((k) => !(k.scope === 'personal' && k.owner_user_id && k.owner_user_id !== userId))
        .map((k) => ({ title: k.title, ts: k.updated_at, row: k }));
      items = rankAndSlice(rows, needle, ({ row }) => ({
        type,
        id: row.id,
        title: row.title,
        snippet: snippetOf(row.body),
        updatedAt: row.updated_at,
      }));
    } else if (type === 'asset') {
      // 资产只按名称 + section 标题匹配（正文不参与匹配、更不出 snippet，防内容泄漏）
      const byId = new Map<string, { title: string; ts: string; name: string; sectionTitles: string[] }>();
      for (const a of repos.listAssetsForSearch(workspaceId)) {
        const content = parseAssetContent(a.content);
        const sectionTitles = content.sections.map((s) => s.title || s.key);
        const nameHit = a.name.toLowerCase().includes(needle);
        const titleHits = sectionTitles.filter((t) => t.toLowerCase().includes(needle));
        if (!nameHit && !titleHits.length) continue;
        byId.set(a.id, { title: a.name, ts: a.updated_at, name: a.name, sectionTitles });
      }
      const rows = [...byId.values()];
      items = rankAndSlice(rows, needle, (r) => ({
        type,
        id: [...byId.entries()].find(([, v]) => v === r)?.[0] ?? '',
        title: r.name,
        // snippet 只出 section 标题清单，恒不含任何正文内容
        snippet: r.sectionTitles.length ? `分段：${r.sectionTitles.join('、')}` : '',
        updatedAt: r.ts,
      }));
    } else if (type === 'skill') {
      // 本空间 + 平台库公开项（官方 published / visibility=public 的 published，与 /api/skills 合并口径一致）
      const seen = new Set<string>();
      const all = [...repos.listWorkspaceSkills(workspaceId), ...repos.listLibrarySkills()].filter(
        (s) => (seen.has(s.id) ? false : (seen.add(s.id), true)),
      );
      const rows = all
        .filter(
          (s) =>
            s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle),
        )
        .map((s) => ({ title: s.name, ts: s.updated_at, row: s }));
      items = rankAndSlice(rows, needle, ({ row }) => ({
        type,
        id: row.id,
        title: row.name,
        snippet: snippetOf(row.description),
        updatedAt: row.updated_at,
      }));
    } else if (type === 'talent') {
      // v1.5.0 B：人才库已上架模板（pub 快照）按名/专长匹配
      const rows = repos
        .listPublicAgentTemplates()
        .filter(
          (t) =>
            (t.pub_name ?? '').toLowerCase().includes(needle) ||
            (t.pub_specialty ?? '').toLowerCase().includes(needle),
        )
        .map((t) => ({ title: t.pub_name ?? '', ts: t.updated_at, row: t }));
      items = rankAndSlice(rows, needle, ({ row }) => ({
        type,
        id: row.id,
        title: row.pub_name ?? '',
        snippet: snippetOf(row.pub_specialty ?? ''),
        updatedAt: row.updated_at,
      }));
    } else if (type === 'project') {
      const rows = repos.searchProjects(workspaceId, pattern, CANDIDATES).map((p) => ({
        title: p.name,
        ts: p.created_at,
        row: p,
      }));
      items = rankAndSlice(rows, needle, ({ row }) => ({
        type,
        id: row.id,
        title: row.name,
        snippet: snippetOf(row.brief),
        updatedAt: row.created_at,
      }));
    }
    if (items.length) groups.push({ type, items });
  }
  return { groups, results: groups.flatMap((g) => g.items) };
}

/** result 类定义自检（供单测/注释锚点）：done 且 result 非空，与成果库口径一致 */
export function isResultTask(status: string, result: string): boolean {
  return status === TaskStatus.DONE && !!result;
}
