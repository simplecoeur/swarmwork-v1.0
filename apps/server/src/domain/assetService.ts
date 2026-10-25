import { nowIso, uid } from '../util';
import type { AssetRow, Repos } from '../store/repositories';
import { DomainError } from './taskService';

/**
 * 资产库域服务（方案 §11.4）：资产 = 整份结构化资料，content JSON 约定为
 * { summary?: string, sections: [{ key, title, body }] }（剧本按集分段，key 如 ep1/ep2）。
 * 任务引用在发单时落快照（task_asset_refs 记当时版本号）；引擎按快照版本取内容注入，
 * 资产后续升版不影响历史任务的注入记录与复现。
 */
export interface AssetSection {
  key: string;
  title: string;
  body: string;
}
export interface AssetContent {
  summary?: string;
  sections: AssetSection[];
}

export function parseAssetContent(json: string): AssetContent {
  try {
    const v = JSON.parse(json || '{}') as Partial<AssetContent>;
    const sections = Array.isArray(v.sections)
      ? v.sections.filter(
          (s): s is AssetSection =>
            !!s && typeof s === 'object' && typeof (s as AssetSection).key === 'string',
        )
      : [];
    return { summary: typeof v.summary === 'string' ? v.summary : undefined, sections };
  } catch {
    return { sections: [] };
  }
}

export interface AssetRefInput {
  assetId: string;
  /** 引用的分段 key 列表；缺省/空 = 整份引用 */
  sections?: string[];
}

/** 发单时落资产引用快照：校验资产归属本空间，记当前版本号 */
export function attachAssetRefs(
  repos: Repos,
  taskId: string,
  workspaceId: string,
  refs: AssetRefInput[] | undefined,
): void {
  if (!refs?.length) return;
  for (const ref of refs) {
    const asset = repos.getAsset(ref.assetId, workspaceId);
    if (!asset) throw new DomainError('NOT_FOUND', `资产「${ref.assetId}」不存在`);
    repos.insertTaskAssetRef({
      task_id: taskId,
      workspace_id: workspaceId,
      asset_id: asset.id,
      asset_version: asset.version,
      sections: JSON.stringify(ref.sections ?? []),
      created_at: nowIso(),
    });
  }
}

/** 引擎注入用：按任务的引用快照（版本锁定）组装资产分段文本 */
export function resolveAssetSections(
  repos: Repos,
  taskId: string,
): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  for (const ref of repos.listTaskAssetRefs(taskId)) {
    const contentJson = repos.getAssetVersion(ref.asset_id, ref.asset_version);
    if (!contentJson) continue;
    const asset = repos.getAsset(ref.asset_id);
    const content = parseAssetContent(contentJson);
    let wanted: string[] = [];
    try {
      wanted = JSON.parse(ref.sections || '[]') as string[];
    } catch {
      wanted = [];
    }
    const sections = wanted.length
      ? content.sections.filter((s) => wanted.includes(s.key))
      : content.sections;
    if (!sections.length) continue;
    const name = asset?.name ?? ref.asset_id;
    const text =
      `## 资产《${name}》（v${ref.asset_version}）` +
      sections.map((s) => `\n### ${s.title || s.key}\n${s.body}`).join('\n');
    out.push({ id: `${ref.asset_id}@${ref.asset_version}`, text });
  }
  return out;
}

/**
 * 资产创建的统一落库口径（手建 POST /api/assets 与 G-06 文件导入 confirm 共用）：
 * version=1 起版，repos.insertAsset 内部同步写 v1 版本快照，历史任务可按版追溯。
 */
export function createAsset(
  repos: Repos,
  input: { workspaceId: string; typeId: string; name: string; content: AssetContent; createdBy: string },
): AssetRow {
  const ts = nowIso();
  const row: AssetRow = {
    id: uid('asset'),
    workspace_id: input.workspaceId,
    type_id: input.typeId,
    name: input.name,
    version: 1,
    content: JSON.stringify(input.content),
    created_by: input.createdBy,
    created_at: ts,
    updated_at: ts,
  };
  repos.insertAsset(row);
  return row;
}

export function assetDtoOf(row: AssetRow): {
  id: string;
  typeId: string;
  name: string;
  version: number;
  content: AssetContent;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    typeId: row.type_id,
    name: row.name,
    version: row.version,
    content: parseAssetContent(row.content),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
