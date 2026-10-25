import type { Repos, SkillRow, SkillSourceImportRow } from '../store/repositories';
import { nowIso, uid } from '../util';
import { appendThreadMessage } from './adminComms';
import { defaultAgentFetcher, type AgentFetcher } from './agentSyncService';
import { notifyOwner } from './notify';
import { parseFrontmatter, BASE_ROLES } from './parseAgencyAgent';
import { copySkillSnapshot } from './skillService';
import { classifyLicenseText, PERMISSIVE_LICENSES } from './github';

/**
 * v1.5.0 K 管理端技能下发·导入段：从 GitHub 仓库导入 skill 定义。
 * 流程：解析仓库地址 → LICENSE 预检（非宽松许可证直接拒绝并留痕）→ 发现 SKILL.md →
 * frontmatter 兼容/必填校验（不合格逐个进 failed 明细）→ 合格者落平台草稿（带来源署名三字段）。
 * skill 定义文件格式定案：仓库内任意深度的 SKILL.md，frontmatter 至少含 name/description，
 * 正文即提示词模板；role 可选（须为基础工种之一，否则回退「文案」）；input_schema 可选 JSON。
 */

export function parseGithubRepoUrl(input: string): { repo: string; branch: string } | null {
  const s = input.trim().replace(/\.git$/, '');
  const m = s.match(/github\.com\/([^/\s]+)\/([^/\s]+)(?:\/tree\/([^/\s]+))?/);
  if (m) return { repo: `${m[1]}/${m[2]}`, branch: m[3] ?? 'main' };
  const bare = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (bare) return { repo: `${bare[1]}/${bare[2]}`, branch: 'main' };
  return null;
}

function slugify(name: string, fallback: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (ascii || fallback.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'imported-skill').slice(0, 60);
}

export interface SkillImportOutcome {
  record: SkillSourceImportRow;
  createdSkillIds: string[];
}

export async function importSkillsFromGithub(
  repos: Repos,
  input: { repoUrl: string; importedBy: string },
  fetcher: AgentFetcher = defaultAgentFetcher,
  bases?: { apiBase: string; rawBase: string },
): Promise<SkillImportOutcome> {
  const apiBase = bases?.apiBase ?? process.env.AGENT_SYNC_GITHUB_API ?? 'https://api.github.com';
  const rawBase = bases?.rawBase ?? process.env.AGENT_SYNC_GITHUB_RAW ?? 'https://raw.githubusercontent.com';
  const ts = nowIso();
  const record: SkillSourceImportRow = {
    id: uid('skimp'),
    repo_url: input.repoUrl,
    repo: '',
    branch: 'main',
    license: '',
    license_ok: 0,
    status: 'failed',
    detail: '',
    imported_by: input.importedBy,
    created_at: ts,
  };
  const finish = (o: Partial<SkillImportOutcome>): SkillImportOutcome => {
    repos.insertSkillSourceImport(record);
    return { record, createdSkillIds: o.createdSkillIds ?? [] };
  };

  const parsed = parseGithubRepoUrl(input.repoUrl);
  if (!parsed) {
    record.detail = '仓库地址无法解析（需要 github.com/owner/repo 或 owner/repo 形式）';
    return finish({});
  }
  record.repo = parsed.repo;
  record.branch = parsed.branch;
  const author = parsed.repo.split('/')[0] ?? '';

  // 1) LICENSE 预检：拉不到原文按识别不出处理（从严拒绝）
  let licenseText = '';
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    try {
      const t = await fetcher(`${rawBase}/${parsed.repo}/${parsed.branch}/${name}`);
      if (t && t.length > 20) {
        licenseText = t;
        break;
      }
    } catch {
      /* 试下一个 */
    }
  }
  const kind = licenseText ? classifyLicenseText(licenseText) : 'other';
  record.license = kind;
  record.license_ok = PERMISSIVE_LICENSES.includes(kind) ? 1 : 0;
  if (!PERMISSIVE_LICENSES.includes(kind)) {
    record.status = 'rejected_license';
    record.detail = licenseText
      ? `来源仓库许可证为 ${kind}，不在宽松名单（${PERMISSIVE_LICENSES.join('/')}），已拒绝导入`
      : '来源仓库未找到可识别的 LICENSE 原文，已拒绝导入（许可证预检不通过）';
    return finish({});
  }

  // 2) 仓库元信息（作者署名兜底）+ 文件树发现 SKILL.md
  let repoAuthor = author;
  try {
    const metaText = await fetcher(`${apiBase}/repos/${parsed.repo}`);
    const meta = JSON.parse(metaText) as { owner?: { login?: string } };
    if (meta.owner?.login) repoAuthor = meta.owner.login;
  } catch {
    /* 用 URL 里的 owner */
  }
  let skillPaths: string[] = [];
  try {
    const treeText = await fetcher(`${apiBase}/repos/${parsed.repo}/git/trees/${parsed.branch}?recursive=1`);
    const tree = JSON.parse(treeText) as { tree?: Array<{ path?: string; type?: string }> };
    skillPaths = (tree.tree ?? [])
      .map((e) => e.path ?? '')
      .filter((p) => /(^|\/)SKILL\.md$/i.test(p))
      .slice(0, 50);
  } catch (e) {
    record.detail = `读取仓库文件树失败：${e instanceof Error ? e.message : String(e)}`;
    return finish({});
  }
  if (skillPaths.length === 0) {
    record.detail = '仓库内未找到 SKILL.md 技能定义文件（约定：任意目录下的 SKILL.md，frontmatter 需含 name/description）';
    return finish({});
  }

  // 3) 逐个校验并落平台草稿
  const createdSkillIds: string[] = [];
  const failures: Array<{ path: string; reason: string }> = [];
  for (const p of skillPaths) {
    try {
      const raw = await fetcher(`${rawBase}/${parsed.repo}/${parsed.branch}/${p}`);
      const { fm, body } = parseFrontmatter(raw);
      const name = (fm.name ?? '').trim();
      const description = (fm.description ?? '').trim();
      if (!name || !description) {
        failures.push({ path: p, reason: `frontmatter 缺 ${!name ? 'name' : 'description'}（必填）` });
        continue;
      }
      if (!body.trim()) {
        failures.push({ path: p, reason: '正文为空（正文即技能提示词模板，必填）' });
        continue;
      }
      let inputSchema = '{}';
      if (fm.input_schema) {
        try {
          JSON.parse(fm.input_schema);
          inputSchema = fm.input_schema;
        } catch {
          failures.push({ path: p, reason: 'input_schema 不是合法 JSON' });
          continue;
        }
      }
      const roleRaw = (fm.role ?? '').trim();
      const role = (BASE_ROLES as readonly string[]).includes(roleRaw) ? roleRaw : '文案';
      const dirName = p.split('/').slice(-2, -1)[0] ?? 'skill';
      let slug = slugify(name, dirName);
      let n = 2;
      const baseSlug = slug;
      while (repos.getSkillBySlugPlatform(slug)) {
        slug = `${baseSlug}-${n++}`;
      }
      const row: SkillRow = {
        id: uid('skill'),
        slug,
        owner_type: 'platform',
        owner_id: null,
        workspace_id: null,
        name,
        description,
        role,
        prompt_template: body.trim(),
        input_schema: inputSchema,
        kb_binding: '{}',
        output_spec: (fm.output_spec ?? '').trim(),
        example_input: '{}',
        example_output: '',
        version: 1,
        changelog: `从 GitHub 导入：${parsed.repo}（${p}）`,
        status: 'draft',
        visibility: 'private',
        source_skill_id: null,
        source_version: null,
        install_count: 0,
        featured: 0,
        featured_at: null,
        listed_at: null,
        contributor_name: null,
        contributor_workspace_name: null,
        verified_notes: '',
        source_repo: parsed.repo,
        source_author: repoAuthor,
        source_license: kind,
        created_by: input.importedBy,
        created_at: ts,
        updated_at: ts,
      };
      repos.insertSkill(row);
      createdSkillIds.push(row.id);
    } catch (e) {
      failures.push({ path: p, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  record.status = createdSkillIds.length > 0 ? 'imported' : 'failed';
  record.detail = [
    `发现 SKILL.md ${skillPaths.length} 个，导入草稿 ${createdSkillIds.length} 个`,
    failures.length ? `不合格 ${failures.length} 个：${failures.map((f) => `${f.path}（${f.reason}）`).join('；')}` : '',
  ]
    .filter(Boolean)
    .join('；');
  return finish({ createdSkillIds });
}

/* ---------- 推送下发（K 路由与 M 运营官共用同一实现，保证口径一致） ---------- */
export interface SkillPushOutcome {
  installed: number;
  upgraded: number;
  skipped: number;
  targets: number;
  /** 实际装/改的副本（回滚技能下发时按此清单卸载） */
  copies: Array<{ workspaceId: string; copyId: string; action: 'installed' | 'upgraded' }>;
}

export function pushSkillToWorkspaces(
  repos: Repos,
  skill: SkillRow,
  workspaceIds: string[],
  pushedBy: string,
  note?: string,
): SkillPushOutcome {
  const out: SkillPushOutcome = { installed: 0, upgraded: 0, skipped: 0, targets: workspaceIds.length, copies: [] };
  for (const wsId of workspaceIds) {
    if (!repos.getWorkspace(wsId)) continue;
    const existing = repos.findInstalledCopy(wsId, skill.id);
    let copyId: string;
    let action: 'installed' | 'upgraded';
    if (existing && existing.source_version === skill.version) {
      out.skipped++;
      continue;
    } else if (existing) {
      repos.updateSkill({
        ...existing,
        name: skill.name,
        description: skill.description,
        role: skill.role,
        prompt_template: skill.prompt_template,
        input_schema: skill.input_schema,
        kb_binding: skill.kb_binding,
        output_spec: skill.output_spec,
        example_input: skill.example_input,
        example_output: skill.example_output,
        source_version: skill.version,
        updated_at: nowIso(),
      });
      copyId = existing.id;
      action = 'upgraded';
      out.upgraded++;
    } else {
      const copy = copySkillSnapshot(repos, skill, wsId, pushedBy);
      copyId = copy.id;
      action = 'installed';
      out.installed++;
    }
    repos.insertSkillPush({
      id: uid('skpush'),
      skill_id: skill.id,
      workspace_id: wsId,
      version: skill.version,
      copy_skill_id: copyId,
      pushed_by: pushedBy,
      created_at: nowIso(),
    });
    out.copies.push({ workspaceId: wsId, copyId, action });
    notifyOwner(
      repos, wsId, 'skill_pushed',
      `平台下发技能：${skill.name}`,
      `平台把技能「${skill.name}」v${skill.version} ${action === 'installed' ? '装入' : '更新到'}了本空间，在技能库里带「平台下发」徽标。`,
      copyId,
    );
    appendThreadMessage(repos, wsId, {
      senderType: 'admin',
      senderUserId: pushedBy,
      body:
        `平台下发了技能「${skill.name}」v${skill.version}` +
        (skill.source_repo ? `（来源 ${skill.source_repo}·${skill.source_author ?? ''}·${skill.source_license ?? ''}）` : '') +
        `，已${action === 'installed' ? '装入' : '更新到'}本空间技能库，发单时可直接套用。` +
        (note ? `\n附言：${note}` : ''),
      kind: 'skill_push',
    });
  }
  return out;
}
