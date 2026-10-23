import type { Repos } from '../store/repositories';
import { DRAMA_PERSONA_SUFFIX, parseManifest } from '../store/industry';
import { makeMemberRows, ROLE_PERSONAS } from '../store/seed';
import { nowIso, uid } from '../util';

/**
 * 团队锻造（v1.3.0 C2）：按问卷答案规则生成默认团队（不依赖 LLM）。
 * - 行业层：短剧包直接以 industry.ts 的 SHORT_DRAMA_MANIFEST 三组为底（读 manifest 实际结构复用，不另抄）；
 *   非短剧包行业层为空。
 * - 职能层：uses 映射到职能组，缺哪补哪、与行业层同职能不重复建组。
 *   每组构成 = 组长 1 + 主力工种 1–2 + 审核 1，role 必须取注册表真实存在的 role id
 *   （组长/审核为注册表系统保留位 role_leader/role_reviewer 对应的 role_id）。
 * - uses 为空且无行业层 → 通用组（与默认种子 seedGenericWorkspace 同构成）。
 * 落库走 repos.insertTeam/insertMember（与种子同一路径）。先拼完整计划再落库，拼装失败不留半成品。
 */
export interface ForgeAnswers {
  industry?: string;
  job?: string;
  uses?: string[];
  problems?: string;
}

export interface ForgeSummary {
  teams: number;
  members: number;
  teamNames: string[];
}

interface PlannedMember {
  role: string;
  name: string;
  persona: string;
}
interface PlannedTeam {
  name: string;
  color: string;
  members: PlannedMember[];
}

/** uses → 职能组定义（主力工种取注册表 role id） */
const FUNCTION_GROUPS: Record<
  string,
  { name: string; dramaName?: string; color: string; mains: string[]; focus: string }
> = {
  内容生产: {
    name: '内容创作组',
    color: '#e8a13a',
    mains: ['文案', '研究员'],
    focus: '内容生产：选题、文案与成稿交付',
  },
  日常办公: {
    name: '办公助理组',
    color: '#5b8def',
    mains: ['文案', '程序员'],
    focus: '日常办公：文档、表格、纪要与流程协助',
  },
  学习研究: {
    name: '学习研究组',
    color: '#3a6fd8',
    mains: ['研究员', '文案'],
    focus: '学习研究：资料检索、要点提炼与研究报告',
  },
  运营推广: {
    name: '运营推广组',
    dramaName: '短剧运营组',
    color: '#d86fb0',
    mains: ['文案', '研究员'],
    focus: '运营推广：渠道文案、活动策划与数据复盘',
  },
};

/** 短剧包三组已覆盖的职能（同职能不重复建组） */
const DRAMA_COVERED_USES: Record<string, string> = {
  内容生产: '短剧文案组',
  学习研究: '选题调研组',
};

const ROLE_BASE = new Map(ROLE_PERSONAS.map((r) => [r.role, r]));

export function forgeTeams(
  repos: Repos,
  workspaceId: string,
  packId: string | null,
  answers: ForgeAnswers,
): ForgeSummary {
  const pack = packId ? repos.getIndustryPack(packId) : undefined;
  const isDrama = !!pack && pack.industry === 'short_drama';
  const job = (answers.job ?? '').trim();
  const jobSentence = job
    ? `老板的岗位是「${job}」，产出要贴合其工作场景与用词习惯。`
    : '产出要贴合老板的实际工作场景。';
  const industrySentence = isDrama ? DRAMA_PERSONA_SUFFIX : '';

  const plan: PlannedTeam[] = [];
  const nameUseCount = new Map<string, number>();
  const pickName = (role: string, teamName: string): string => {
    const base = ROLE_BASE.get(role)?.name ?? role;
    const n = (nameUseCount.get(role) ?? 0) + 1;
    nameUseCount.set(role, n);
    // 命名习惯与 seed.makeMemberRows 一致：首用裸名、复用加组名前缀
    return n === 1 ? base : `${teamName}${base}`;
  };
  const personaFor = (role: string, focus: string): string => {
    const base = ROLE_BASE.get(role)?.persona ?? `你是一名${role}。`;
    return [base, focus ? `本组职责：${focus}。` : '', industrySentence, jobSentence]
      .filter(Boolean)
      .join('');
  };

  /* ---- 行业层（短剧包：manifest 三组为底） ---- */
  if (isDrama && pack) {
    const manifest = parseManifest(pack);
    for (const t of manifest.teams) {
      plan.push({
        name: t.name,
        color: t.color || '#5b8def',
        members: t.members.map((m) => ({
          role: m.role,
          name: m.name,
          persona: job ? `${m.persona}${jobSentence}` : m.persona,
        })),
      });
      for (const m of t.members) {
        // manifest 成员名已占用对应 role 的裸名位，后续职能组同 role 走组名前缀命名
        const base = ROLE_BASE.get(m.role)?.name;
        if (base && m.name === base) nameUseCount.set(m.role, 1);
      }
    }
  }

  /* ---- 职能层（uses 映射，缺哪补哪） ---- */
  const uses = Array.isArray(answers.uses) ? answers.uses : [];
  for (const use of uses) {
    const def = FUNCTION_GROUPS[use];
    if (!def) continue;
    if (isDrama && DRAMA_COVERED_USES[use]) continue; // 行业层已覆盖同职能
    const teamName = isDrama && def.dramaName ? def.dramaName : def.name;
    if (plan.some((t) => t.name === teamName)) continue;
    const members: PlannedMember[] = [
      { role: '组长', name: pickName('组长', teamName), persona: personaFor('组长', def.focus) },
      ...def.mains.map((role) => ({
        role,
        name: pickName(role, teamName),
        persona: personaFor(role, def.focus),
      })),
      { role: '审核', name: pickName('审核', teamName), persona: personaFor('审核', def.focus) },
    ];
    plan.push({ name: teamName, color: def.color, members });
  }

  /* ---- role 合法性校验（注册表真实值，缺失即抛错走降级） ---- */
  const visibleRoles = new Set(
    repos.listRolesVisible(workspaceId, packId).map((r) => r.role_id),
  );
  for (const t of plan) {
    for (const m of t.members) {
      if (!visibleRoles.has(m.role)) {
        throw new Error(`工种「${m.role}」未在注册表中登记，无法锻造团队`);
      }
      if (!m.persona.trim()) throw new Error(`成员「${m.name}」人设为空`);
    }
  }

  /* ---- 落库（与种子同一路径） ---- */
  let memberCount = 0;
  if (!plan.length) {
    // 兜底：通用组，与默认种子同构成（makeMemberRows 五工种）
    const teamId = uid('team');
    repos.insertTeam({
      id: teamId,
      name: '通用小组',
      color: '#5b8def',
      api_id: null,
      created_at: nowIso(),
      deleted_at: null,
      workspace_id: workspaceId,
    });
    const rows = makeMemberRows(teamId, '通用小组', true, workspaceId);
    for (const m of rows) {
      repos.insertMember({ ...m, id: uid('member') });
      memberCount += 1;
    }
    return { teams: 1, members: memberCount, teamNames: ['通用小组'] };
  }

  for (const t of plan) {
    const teamId = uid('team');
    repos.insertTeam({
      id: teamId,
      name: t.name,
      color: t.color,
      api_id: null,
      created_at: nowIso(),
      deleted_at: null,
      workspace_id: workspaceId,
    });
    for (const m of t.members) {
      repos.insertMember({
        id: uid('member'),
        team_id: teamId,
        name: m.name,
        role: m.role,
        persona: m.persona,
        prompt: '',
        skill_tags: '[]',
        color: '',
        workspace_id: workspaceId,
      });
      memberCount += 1;
    }
  }
  return { teams: plan.length, members: memberCount, teamNames: plan.map((t) => t.name) };
}
