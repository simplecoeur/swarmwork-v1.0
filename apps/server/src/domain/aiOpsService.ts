import type { AiOpsRunRow, KbRow, Repos, SkillRow, UserRow } from '../store/repositories';
import { nowIso, uid } from '../util';
import { appendThreadMessage, notifyAnnouncement } from './adminComms';
import { getAgentSyncSources } from './agentSyncService';
import { runAgentSyncPipeline } from './agentSyncPipeline';
import { pushSkillToWorkspaces } from './skillImportService';

/**
 * v1.5.0 M AI 平台运营官（一期）。
 * 身份：平台级内部服务账号 user_ai_operator（不可登录），运营动作以它为执行主体落库
 * （公告 created_by、线程消息 sender 即它）；入口端点只对平台管理员会话开放（requireAdmin），
 * 普通用户/空间所有者调用一律 403。
 * 链路：指令 → LLM 解析为结构化计划（本文件只做严格校验，非法计划不执行）→ 逐步执行 →
 * 每步写 audit（detail 关联 run id + 原始指令）→ run 落执行报告；破坏性步骤需管理员在计划预览后确认。
 * 回滚（按 audit/run）：公告撤下、平台知识改动还原（含删除恢复）、技能下发撤销（副本归档卸载）。
 * 一期边界：只调度已有管理动作；不做代码级发版/热改（见设计文档 §22）。
 */
export const AI_OPERATOR_USER_ID = 'user_ai_operator';

export function ensureAiOperatorUser(repos: Repos): void {
  if (repos.getUser(AI_OPERATOR_USER_ID)) return;
  const ts = nowIso();
  const row: UserRow = {
    id: AI_OPERATOR_USER_ID,
    email: 'ai-operator@swarm.local',
    display_name: 'AI 运营官',
    password_hash: '!service-account-no-login',
    status: 'active',
    is_platform_admin: 0,
    must_change_password: 0,
    created_at: ts,
    failed_attempts: 0,
    locked_until: null,
    registration_ip: '',
    last_login_at: null,
  };
  repos.insertUser(row);
}

/* ---------------- 计划结构 ---------------- */
export interface AiOpsStep {
  op: string;
  params: Record<string, unknown>;
  destructive: boolean;
  status: 'pending' | 'done' | 'failed' | 'skipped' | 'rolled_back';
  summary?: string;
  error?: string;
  rollback?: Record<string, unknown> | null;
}
export interface AiOpsPlan {
  steps: AiOpsStep[];
}

export type AuditFn = (action: string, targetType: string, targetId: string, detail: string) => void;

interface OpDef {
  desc: string;
  paramsHint: string;
  destructive?: boolean;
  run: (repos: Repos, params: Record<string, unknown>) => Promise<{ summary: string; rollback?: Record<string, unknown> | null }>;
}

/* ---------------- 参数小工具 ---------------- */
function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === 'string' ? v.trim() : '';
}
function needStr(params: Record<string, unknown>, key: string, label: string): string {
  const v = str(params, key);
  if (!v) throw new Error(`参数 ${label} 必填`);
  return v;
}
function resolveWorkspace(repos: Repos, ref: string) {
  const byId = repos.getWorkspace(ref);
  if (byId) return byId;
  const byName = repos.listWorkspaces().filter((w) => w.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`空间名「${ref}」不唯一，请用空间 id`);
  throw new Error(`空间不存在：${ref}`);
}
function resolveUser(repos: Repos, ref: string) {
  const byId = repos.getUser(ref);
  if (byId) return byId;
  const byEmail = repos.getUserByEmail(ref);
  if (byEmail) return byEmail;
  throw new Error(`用户不存在：${ref}`);
}
function resolvePlatformKb(repos: Repos, ref: string): KbRow {
  const byId = repos.listPlatformKb().find((k) => k.id === ref);
  if (byId) return byId;
  const byTitle = repos.listPlatformKb().filter((k) => k.title === ref);
  if (byTitle.length === 1) return byTitle[0]!;
  throw new Error(`平台知识不存在或标题不唯一：${ref}`);
}
function resolvePlatformSkill(repos: Repos, ref: string): SkillRow {
  const byId = repos.getSkill(ref);
  if (byId && byId.owner_type === 'platform') return byId;
  const byName = repos.listPlatformSkills().filter((s) => s.name === ref);
  if (byName.length === 1) return byName[0]!;
  throw new Error(`平台技能不存在或名称不唯一：${ref}`);
}

/* ---------------- op 注册表 ---------------- */
export const AI_OPS: Record<string, OpDef> = {
  get_pending_summary: {
    desc: '查询各审核队列的待审积压计数与清单摘要（只读）',
    paramsHint: '{}',
    run: async (repos) => {
      const skills = repos.listPendingReviewSkills();
      const styles = repos.listPendingStyleTemplates();
      const agents = repos
        .listAgentTemplates()
        .filter((t) => t.status === 'pending_review' || t.has_pending_update === 1);
      const summary =
        `待审积压：skill 上架 ${skills.length} 条、风格模板 ${styles.length} 条、智能体模板 ${agents.length} 条。` +
        (skills.length ? ` skill：${skills.slice(0, 10).map((s) => `「${s.name}」(${s.id})`).join('、')}。` : '') +
        (styles.length ? ` 风格：${styles.slice(0, 10).map((s) => `「${s.name}」(${s.id})`).join('、')}。` : '') +
        (agents.length ? ` 智能体：${agents.slice(0, 10).map((t) => `「${t.draft_name}」(${t.id})`).join('、')}。` : '');
      return { summary };
    },
  },
  list_workspaces: {
    desc: '列出平台空间清单（只读）',
    paramsHint: '{}',
    run: async (repos) => {
      const list = repos.listWorkspaces().slice(0, 50);
      return {
        summary: `共 ${repos.listWorkspaces().length} 个空间：` +
          list.map((w) => `「${w.name}」(${w.id}，状态 ${w.status})`).join('、'),
      };
    },
  },
  publish_announcement: {
    desc: '发布平台公告（可回滚：撤下）',
    paramsHint: '{"title":"标题","body":"正文","workspaces":"all 或空间名/id 数组（缺省 all）"}',
    run: async (repos, params) => {
      const title = needStr(params, 'title', 'title');
      const body = needStr(params, 'body', 'body');
      const wsParam = params.workspaces;
      const scope = Array.isArray(wsParam) ? 'selected' : 'all';
      const workspaceIds = Array.isArray(wsParam)
        ? wsParam.map((r) => resolveWorkspace(repos, String(r)).id)
        : [];
      const ts = nowIso();
      const row = {
        id: uid('ann'),
        title,
        body,
        scope,
        workspace_ids: JSON.stringify(workspaceIds),
        status: 'published',
        created_by: AI_OPERATOR_USER_ID,
        published_at: ts,
        created_at: ts,
        updated_at: ts,
      };
      repos.insertAnnouncement(row);
      const reached = notifyAnnouncement(repos, row);
      return {
        summary: `公告「${title}」已发布，触达 ${reached} 个空间`,
        rollback: { type: 'withdraw_announcement', announcementId: row.id },
      };
    },
  },
  withdraw_announcement: {
    desc: '撤下公告',
    paramsHint: '{"announcement":"公告 id 或标题"}',
    run: async (repos, params) => {
      const ref = needStr(params, 'announcement', 'announcement');
      const all = repos.listAnnouncements();
      const target = all.find((a) => a.id === ref) ?? all.find((a) => a.title === ref);
      if (!target) throw new Error(`公告不存在：${ref}`);
      repos.updateAnnouncement({ ...target, status: 'withdrawn', updated_at: nowIso() });
      return { summary: `公告「${target.title}」已撤下` };
    },
  },
  create_platform_kb: {
    desc: '新建平台公共知识条目（可回滚：删除）',
    paramsHint: '{"title":"标题","body":"正文","tags":["标签"]}',
    run: async (repos, params) => {
      const title = needStr(params, 'title', 'title');
      const body = needStr(params, 'body', 'body');
      const tags = Array.isArray(params.tags) ? params.tags.filter((t): t is string => typeof t === 'string') : [];
      const ts = nowIso();
      const row: KbRow = {
        id: uid('kb'),
        title,
        body,
        scope: 'platform',
        scope_id: null,
        tags: JSON.stringify(tags),
        enabled: 1,
        created_at: ts,
        updated_at: ts,
        workspace_id: null,
        owner_user_id: null,
      };
      repos.insertKb(row);
      return { summary: `平台知识「${title}」已创建`, rollback: { type: 'delete_kb', id: row.id } };
    },
  },
  update_platform_kb: {
    desc: '修改平台知识条目（可回滚：还原改前全文）',
    paramsHint: '{"kb":"条目 id 或标题","title?":"新标题","body?":"新正文","enabled?":true}',
    run: async (repos, params) => {
      const cur = resolvePlatformKb(repos, needStr(params, 'kb', 'kb'));
      const before = { ...cur };
      const next: KbRow = {
        ...cur,
        title: str(params, 'title') || cur.title,
        body: str(params, 'body') || cur.body,
        enabled: typeof params.enabled === 'boolean' ? (params.enabled ? 1 : 0) : cur.enabled,
        updated_at: nowIso(),
      };
      repos.updateKb(next);
      return { summary: `平台知识「${next.title}」已更新`, rollback: { type: 'restore_kb', row: before } };
    },
  },
  delete_platform_kb: {
    desc: '删除平台知识条目（破坏性；可回滚：按原样恢复）',
    paramsHint: '{"kb":"条目 id 或标题"}',
    destructive: true,
    run: async (repos, params) => {
      const cur = resolvePlatformKb(repos, needStr(params, 'kb', 'kb'));
      repos.deleteKb(cur.id);
      return { summary: `平台知识「${cur.title}」已删除`, rollback: { type: 'restore_kb', row: { ...cur } } };
    },
  },
  push_skill: {
    desc: '把已上架平台技能推送下发到空间（同版幂等；可回滚：撤销下发）',
    paramsHint: '{"skill":"技能名或 id","workspaces":"all 或空间名/id 数组","note?":"附言"}',
    run: async (repos, params) => {
      const skill = resolvePlatformSkill(repos, needStr(params, 'skill', 'skill'));
      if (skill.status !== 'published') throw new Error(`技能「${skill.name}」未上架，不能推送`);
      const wsParam = params.workspaces;
      const targets = Array.isArray(wsParam)
        ? wsParam.map((r) => resolveWorkspace(repos, String(r)).id)
        : repos.listWorkspaces().map((w) => w.id);
      const out = pushSkillToWorkspaces(repos, skill, targets, AI_OPERATOR_USER_ID, str(params, 'note') || undefined);
      return {
        summary: `技能「${skill.name}」v${skill.version} 推送完成：新装 ${out.installed}、升级 ${out.upgraded}、跳过 ${out.skipped}`,
        rollback: {
          type: 'unpush_skill',
          skillId: skill.id,
          version: skill.version,
          copies: out.copies,
        },
      };
    },
  },
  send_space_message: {
    desc: '给指定空间所有者发平台消息（进该空间消息线程）',
    paramsHint: '{"workspace":"空间名或 id","body":"正文"}',
    run: async (repos, params) => {
      const ws = resolveWorkspace(repos, needStr(params, 'workspace', 'workspace'));
      const body = needStr(params, 'body', 'body');
      appendThreadMessage(repos, ws.id, {
        senderType: 'admin',
        senderUserId: AI_OPERATOR_USER_ID,
        body,
        kind: 'chat',
        notify: true,
      });
      return { summary: `已给空间「${ws.name}」所有者发消息` };
    },
  },
  sync_agent_source: {
    desc: '立即同步一个智能体来源（只写草稿进审核中心，不自动上架）',
    paramsHint: '{"source":"源 id 或仓库 owner/repo"}',
    run: async (repos, params) => {
      const ref = needStr(params, 'source', 'source');
      const source = getAgentSyncSources(repos).find((s) => s.id === ref || s.repo === ref);
      if (!source) throw new Error(`同步源不存在：${ref}`);
      if (source.paused) throw new Error(`源 ${source.repo} 已暂停（${source.pauseReason ?? '许可证漂移'}）`);
      const outcome = await runAgentSyncPipeline(repos, source, 'manual');
      if (outcome.paused || !outcome.result) {
        throw new Error(outcome.run.error || '同步被暂停');
      }
      const r = outcome.result;
      return {
        summary: `源 ${source.repo} 同步完成：拉取 ${r.fetched}、新增 ${r.created}、更新 ${r.updated}、未变 ${r.unchanged}、失败 ${r.failed}（锚定 commit ${outcome.run.source_commit.slice(0, 7) || '—'}）`,
      };
    },
  },
  approve_agent_template: {
    desc: '通过智能体模板上架/更新',
    paramsHint: '{"template":"模板 id"}',
    run: async (repos, params) => {
      const id = needStr(params, 'template', 'template');
      const t = repos.getAgentTemplate(id);
      if (!t) throw new Error(`模板不存在：${id}`);
      if (t.status !== 'pending_review' && t.has_pending_update !== 1) {
        throw new Error(`模板「${t.draft_name}」不在待审状态`);
      }
      repos.updateAgentTemplate({
        ...t,
        pub_name: t.draft_name,
        pub_specialty: t.draft_specialty,
        pub_persona: t.draft_persona,
        pub_role: t.draft_role,
        status: 'public',
        has_pending_update: 0,
        reject_reason: '',
        updated_at: nowIso(),
        pub_at: nowIso(),
      });
      return { summary: `智能体「${t.draft_name}」已上架人才库` };
    },
  },
  reject_agent_template: {
    desc: '驳回智能体模板（原因必填；已上架的更新被驳则草稿回滚为上架版）',
    paramsHint: '{"template":"模板 id","reason":"驳回原因"}',
    run: async (repos, params) => {
      const id = needStr(params, 'template', 'template');
      const reason = needStr(params, 'reason', 'reason');
      const t = repos.getAgentTemplate(id);
      if (!t) throw new Error(`模板不存在：${id}`);
      if (t.status === 'public') {
        repos.updateAgentTemplate({
          ...t,
          draft_name: t.pub_name ?? t.draft_name,
          draft_specialty: t.pub_specialty ?? t.draft_specialty,
          draft_persona: t.pub_persona ?? t.draft_persona,
          draft_role: t.pub_role ?? t.draft_role,
          has_pending_update: 0,
          reject_reason: reason,
          updated_at: nowIso(),
        });
      } else {
        repos.updateAgentTemplate({ ...t, status: 'rejected', reject_reason: reason, updated_at: nowIso() });
      }
      return { summary: `智能体「${t.draft_name}」已驳回：${reason}` };
    },
  },
  approve_skill: {
    desc: '通过 skill 上架审核（落署名快照）',
    paramsHint: '{"skill":"skill id"}',
    run: async (repos, params) => {
      const id = needStr(params, 'skill', 'skill');
      const cur = repos.getSkill(id);
      if (!cur) throw new Error(`skill 不存在：${id}`);
      if (cur.visibility !== 'pending_review') throw new Error(`skill「${cur.name}」不在待审核状态`);
      // 署名快照口径与管理台 approve 一致：取贡献者当前显示名/空间名，取不到写空串
      const contributor = cur.created_by ? repos.getUser(cur.created_by) : undefined;
      const ws = cur.workspace_id ? repos.getWorkspace(cur.workspace_id) : undefined;
      repos.updateSkill({
        ...cur,
        visibility: 'public',
        status: 'published',
        listed_at: nowIso(),
        contributor_name: contributor?.display_name ?? '',
        contributor_workspace_name: ws?.name ?? '',
        updated_at: nowIso(),
      });
      return { summary: `skill「${cur.name}」已上架平台库` };
    },
  },
  reject_skill: {
    desc: '驳回 skill 上架审核（原因必填）',
    paramsHint: '{"skill":"skill id","reason":"驳回原因"}',
    run: async (repos, params) => {
      const id = needStr(params, 'skill', 'skill');
      const reason = needStr(params, 'reason', 'reason');
      const cur = repos.getSkill(id);
      if (!cur) throw new Error(`skill 不存在：${id}`);
      if (cur.visibility !== 'pending_review') throw new Error(`skill「${cur.name}」不在待审核状态`);
      repos.updateSkill({ ...cur, visibility: 'workspace', updated_at: nowIso() });
      return { summary: `skill「${cur.name}」已驳回：${reason}` };
    },
  },
  approve_style_template: {
    desc: '通过风格模板上架审核',
    paramsHint: '{"template":"风格模板 id"}',
    run: async (repos, params) => {
      const id = needStr(params, 'template', 'template');
      const row = repos.getStyleTemplate(id);
      if (!row) throw new Error(`风格模板不存在：${id}`);
      if (row.visibility !== 'pending_review') throw new Error(`风格模板「${row.name}」不在待审核状态`);
      repos.updateStyleTemplate({ ...row, visibility: 'public', updated_at: nowIso() });
      return { summary: `风格模板「${row.name}」已上架` };
    },
  },
  reject_style_template: {
    desc: '驳回风格模板（原因必填）',
    paramsHint: '{"template":"风格模板 id","reason":"驳回原因"}',
    run: async (repos, params) => {
      const id = needStr(params, 'template', 'template');
      const reason = needStr(params, 'reason', 'reason');
      const row = repos.getStyleTemplate(id);
      if (!row) throw new Error(`风格模板不存在：${id}`);
      if (row.visibility !== 'pending_review') throw new Error(`风格模板「${row.name}」不在待审核状态`);
      repos.updateStyleTemplate({ ...row, visibility: 'workspace', updated_at: nowIso() });
      return { summary: `风格模板「${row.name}」已驳回：${reason}` };
    },
  },
  disable_user: {
    desc: '停用用户账号并吊销其会话（破坏性）',
    paramsHint: '{"user":"用户 id 或邮箱"}',
    destructive: true,
    run: async (repos, params) => {
      const u = resolveUser(repos, needStr(params, 'user', 'user'));
      repos.updateUser({ ...u, status: 'disabled' });
      repos.deleteSessionsByUser(u.id);
      return { summary: `用户 ${u.email} 已停用` };
    },
  },
  enable_user: {
    desc: '恢复用户账号',
    paramsHint: '{"user":"用户 id 或邮箱"}',
    run: async (repos, params) => {
      const u = resolveUser(repos, needStr(params, 'user', 'user'));
      repos.updateUser({ ...u, status: 'active' });
      return { summary: `用户 ${u.email} 已恢复` };
    },
  },
  disable_workspace: {
    desc: '停用（封停）空间（破坏性）',
    paramsHint: '{"workspace":"空间名或 id"}',
    destructive: true,
    run: async (repos, params) => {
      const ws = resolveWorkspace(repos, needStr(params, 'workspace', 'workspace'));
      repos.updateWorkspace({ ...ws, status: 'disabled' });
      return { summary: `空间「${ws.name}」已停用` };
    },
  },
  enable_workspace: {
    desc: '恢复空间',
    paramsHint: '{"workspace":"空间名或 id"}',
    run: async (repos, params) => {
      const ws = resolveWorkspace(repos, needStr(params, 'workspace', 'workspace'));
      repos.updateWorkspace({ ...ws, status: 'active' });
      return { summary: `空间「${ws.name}」已恢复` };
    },
  },
};

export function aiOpsCatalogText(): string {
  return Object.entries(AI_OPS)
    .map(([name, def]) => `- ${name}：${def.desc}；参数 ${def.paramsHint}${def.destructive ? '（破坏性）' : ''}`)
    .join('\n');
}

/* ---------------- 计划解析与校验（纯函数，非法即抛，绝不执行） ---------------- */
export function parseAiOpsPlan(llmText: string): AiOpsPlan {
  const start = llmText.indexOf('{');
  const end = llmText.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON 计划');
  let parsed: unknown;
  try {
    parsed = JSON.parse(llmText.slice(start, end + 1));
  } catch {
    throw new Error('模型返回的计划不是合法 JSON');
  }
  const stepsRaw = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new Error('计划 steps 为空或不是数组');
  }
  if (stepsRaw.length > 20) throw new Error('计划步骤超过上限 20');
  const steps: AiOpsStep[] = stepsRaw.map((raw, i) => {
    const item = raw as { op?: unknown; params?: unknown };
    if (typeof item.op !== 'string' || !AI_OPS[item.op]) {
      throw new Error(`第 ${i + 1} 步 op 非法或不在运营动作目录内：${String(item.op)}`);
    }
    if (item.params !== undefined && (typeof item.params !== 'object' || item.params === null || Array.isArray(item.params))) {
      throw new Error(`第 ${i + 1} 步 params 必须是对象`);
    }
    const def = AI_OPS[item.op]!;
    return {
      op: item.op,
      params: (item.params as Record<string, unknown> | undefined) ?? {},
      destructive: !!def.destructive,
      status: 'pending' as const,
    };
  });
  return { steps };
}

/* ---------------- 执行与回滚 ---------------- */
export function createAiOpsRun(repos: Repos, instruction: string, plan: AiOpsPlan, createdBy: string): AiOpsRunRow {
  const row: AiOpsRunRow = {
    id: uid('aiops'),
    instruction,
    plan: JSON.stringify(plan),
    status: 'planned',
    created_by: createdBy,
    created_at: nowIso(),
    finished_at: '',
    report: '',
  };
  repos.insertAiOpsRun(row);
  return row;
}

export function parseRunPlan(run: AiOpsRunRow): AiOpsPlan {
  try {
    const v = JSON.parse(run.plan) as AiOpsPlan;
    return { steps: Array.isArray(v.steps) ? v.steps : [] };
  } catch {
    return { steps: [] };
  }
}

export async function executeAiOpsRun(
  repos: Repos,
  runId: string,
  auditFn: AuditFn,
  opts?: { confirmDestructive?: boolean },
): Promise<AiOpsRunRow> {
  const run = repos.getAiOpsRun(runId);
  if (!run) throw new Error('运营 run 不存在');
  const plan = parseRunPlan(run!);
  const destructiveSteps = plan.steps.filter((s) => s.destructive && s.status === 'pending');
  if (destructiveSteps.length > 0 && !opts?.confirmDestructive) {
    const next = { ...run!, status: 'awaiting_confirm' };
    repos.updateAiOpsRun(next);
    return next;
  }
  run!.status = 'running';
  repos.updateAiOpsRun(run!);
  let done = 0;
  let failed = 0;
  for (const step of plan.steps) {
    if (step.status !== 'pending') continue;
    try {
      const def = AI_OPS[step.op];
      if (!def) throw new Error(`未知 op：${step.op}`);
      const out = await def.run(repos, step.params);
      step.status = 'done';
      step.summary = out.summary;
      step.rollback = out.rollback ?? null;
      done++;
      auditFn(`ai_ops_${step.op}`, 'ai_ops_run', run!.id, `run=${run!.id}｜指令：${run!.instruction}｜${out.summary}`);
    } catch (e) {
      step.status = 'failed';
      step.error = e instanceof Error ? e.message : String(e);
      failed++;
      auditFn(`ai_ops_${step.op}_failed`, 'ai_ops_run', run!.id, `run=${run!.id}｜指令：${run!.instruction}｜失败：${step.error}`);
    }
  }
  run!.plan = JSON.stringify(plan);
  run!.status = failed === 0 ? 'done' : done === 0 ? 'failed' : 'partial';
  run!.finished_at = nowIso();
  run!.report = JSON.stringify({
    total: plan.steps.length,
    done,
    failed,
    finishedAt: run!.finished_at,
  });
  repos.updateAiOpsRun(run!);
  return run!;
}

/** 按步回滚（三类：公告撤下 / 平台知识还原 / 技能下发撤销）；返回受影响清单摘要 */
export async function rollbackAiOpsStep(
  repos: Repos,
  runId: string,
  stepIndex: number,
  auditFn: AuditFn,
): Promise<{ summary: string; affected: string[] }> {
  const run = repos.getAiOpsRun(runId);
  if (!run) throw new Error('运营 run 不存在');
  const plan = parseRunPlan(run!);
  const step = plan.steps[stepIndex];
  if (!step) throw new Error('步骤不存在');
  if (step.status !== 'done' || !step.rollback) throw new Error('该步骤无可回滚记录');
  const rb = step.rollback;
  const affected: string[] = [];
  let summary = '';
  if (rb.type === 'withdraw_announcement') {
    const a = repos.getAnnouncement(String(rb.announcementId));
    if (a) {
      repos.updateAnnouncement({ ...a, status: 'withdrawn', updated_at: nowIso() });
      affected.push(`公告「${a.title}」`);
    }
    summary = '公告已撤下';
  } else if (rb.type === 'delete_kb') {
    repos.deleteKb(String(rb.id));
    affected.push(`平台知识 ${String(rb.id)}`);
    summary = '平台知识已删除（撤销新建）';
  } else if (rb.type === 'restore_kb') {
    const row = rb.row as KbRow;
    if (repos.listPlatformKb().some((k) => k.id === row.id)) {
      repos.updateKb({ ...row, updated_at: nowIso() });
    } else {
      repos.insertKb(row);
    }
    affected.push(`平台知识「${row.title}」`);
    summary = '平台知识已还原为改动前版本';
  } else if (rb.type === 'unpush_skill') {
    const copies = (rb.copies as Array<{ workspaceId: string; copyId: string; action: string }>) ?? [];
    for (const c of copies) {
      const copy = repos.getSkill(c.copyId);
      if (copy) {
        // 平台无物理删除技能的既有口径：归档即卸载（用户端不再可用/可见于装配）
        repos.updateSkill({ ...copy, status: 'archived', updated_at: nowIso() });
        const ws = repos.getWorkspace(c.workspaceId);
        affected.push(`${ws?.name ?? c.workspaceId}：${copy.name}`);
      }
    }
    repos.deleteSkillPushes(String(rb.skillId), Number(rb.version));
    summary = `技能下发已撤销，${affected.length} 个空间的副本已卸载（归档）`;
  } else {
    throw new Error(`不支持的回滚类型：${String(rb.type)}`);
  }
  step.status = 'rolled_back';
  run!.plan = JSON.stringify(plan);
  repos.updateAiOpsRun(run!);
  auditFn('ai_ops_rollback', 'ai_ops_run', run!.id, `run=${run!.id}｜指令：${run!.instruction}｜第 ${stepIndex + 1} 步（${step.op}）回滚：${summary}`);
  return { summary, affected };
}
