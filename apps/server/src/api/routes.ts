import type { FastifyInstance } from 'fastify';
import {
  ErrorCode,
  milliToYuan,
  PROVIDER_PRESETS,
  TaskStatus,
  TYPE_ROLE,
  yuanToMilli,
  type ApiDto,
  type KbEntryDto,
  type LedgerEntryDto,
  type MemberDto,
  type ProjectDto,
  type PurchaseDto,
  type StateDto,
  type TaskDto,
} from '@swarm/shared';
import { balanceMilli, buildReport } from '../domain/costService';
import { createProject } from '../domain/projectService';
import { refreshProjectStatus, transitionTask } from '../domain/taskService';
import type { LlmGateway } from '../llm/gateway';
import type { Logger } from '../logger';
import { decryptKey, encryptKey, maskKey } from '../store/crypto';
import { makeMemberRows } from '../store/seed';
import type { ApiRow, Repos, TaskRow } from '../store/repositories';
import { nowIso, uid } from '../util';
import {
  adjudicateSchema,
  apiDeleteSchema,
  apiSaveSchema,
  defaultApiSchema,
  kbCreateSchema,
  memberPromptSchema,
  paramsSchema,
  projectCreateSchema,
  purchaseSchema,
  reviewStandardsSchema,
  taskCreateSchema,
  teamDeleteSchema,
  teamSaveSchema,
} from './schemas';

export interface ApiDeps {
  repos: Repos;
  gateway: LlmGateway;
  logger: Logger;
}

function fail(code: string, message: string, status = 400): never {
  throw Object.assign(new Error(message), { code, statusCode: status });
}

/* ---------- DTO 映射（边界格式化：厘 → 元，Key 只出掩码） ---------- */
function apiDto(repos: Repos, row: ApiRow): ApiDto {
  const bal = balanceMilli(repos, row.id);
  const key = decryptKey(row.api_key_enc);
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as ApiDto['provider'],
    baseUrl: row.base_url,
    model: row.model,
    pricePerM: milliToYuan(row.price_per_m_milli),
    balanceYuan: milliToYuan(bal),
    apiKeyMasked: maskKey(key),
    hasKey: !!key,
    overdrawn: bal < 0,
  };
}

function taskDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    type: row.type as TaskDto['type'],
    brief: row.brief,
    teamId: row.team_id,
    assigneeId: row.assignee_id,
    status: row.status,
    result: row.result,
    reviewNote: row.review_note,
    rejectReason: row.reject_reason,
    rejectCount: row.reject_count,
    blockedReason: row.blocked_reason,
    blockedCode: row.blocked_code,
    adjudicated: row.adjudicated === 1,
    totalTokens: row.total_tokens,
    totalCost: milliToYuan(row.total_cost_milli),
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
  };
}

function buildState(repos: Repos): StateDto {
  const tasks = repos.listTasks();
  const projects: ProjectDto[] = repos.listProjects().map((p) => {
    const children = tasks.filter((t) => t.project_id === p.id);
    const childCost = children.reduce((s, t) => s + repos.ledgerSumByTask(t.id).costMilli, 0);
    const childTok = children.reduce((s, t) => s + repos.ledgerSumByTask(t.id).totalTokens, 0);
    const split = repos.ledgerSumByTask(p.id); // 拆单调用记在项目 id 上
    return {
      id: p.id,
      name: p.name,
      brief: p.brief,
      teamId: p.team_id,
      clientName: p.client_name,
      status: p.status,
      totalTokens: childTok + split.totalTokens,
      totalCost: milliToYuan(childCost + split.costMilli),
      createdAt: p.created_at,
    };
  });
  const ledger: LedgerEntryDto[] = repos.listLedger().map((l) => ({
    ts: l.created_at,
    taskId: l.task_id,
    teamId: l.team_id,
    apiId: l.api_id,
    stage: l.stage as LedgerEntryDto['stage'],
    promptTokens: l.prompt_tokens,
    completionTokens: l.completion_tokens,
    totalTokens: l.total_tokens,
    costYuan: milliToYuan(l.cost_milli),
    estimated: l.estimated === 1,
  }));
  const purchases: PurchaseDto[] = repos.listPurchases().map((p) => ({
    ts: p.created_at,
    apiId: p.api_id,
    amountYuan: milliToYuan(p.amount_milli),
  }));
  return {
    apis: repos.listApis().map((a) => apiDto(repos, a)),
    defaultApiId: repos.getSetting<string | null>('defaultApiId', null),
    teams: repos.listTeams().map((t) => ({ id: t.id, name: t.name, color: t.color, apiId: t.api_id })),
    members: repos.listMembers().map((m) => ({
      id: m.id,
      teamId: m.team_id,
      role: m.role as MemberDto['role'],
      name: m.name,
      prompt: m.prompt,
    })),
    reviewStandards: repos.getSetting('reviewStandards', { points: '', clientNeeds: '' }),
    params: repos.getSetting('params', { concurrency: 4, taskBudgetTokens: 0 }),
    tasks: tasks.map(taskDto),
    projects,
    ledger,
    purchases,
  };
}

export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { repos, gateway, logger } = deps;

  app.get('/api/state', async () => buildState(repos));
  app.get('/api/presets', async () => PROVIDER_PRESETS);
  app.get('/api/cost/report', async () => ({ ok: true, report: buildReport(repos) }));

  /* ----- 知识库（§7 最小契约；注入与回流在 M3 增量实现） ----- */
  app.get('/api/kb', async () => ({
    ok: true,
    entries: repos.listKb().map(
      (k): KbEntryDto => ({
        id: k.id,
        scope: k.scope as KbEntryDto['scope'],
        teamId: k.team_id,
        ownerMemberId: k.owner_member_id,
        kind: k.kind as KbEntryDto['kind'],
        title: k.title,
        content: k.content,
        tags: JSON.parse(k.tags || '[]') as string[],
        createdAt: k.created_at,
      }),
    ),
  }));
  app.post('/api/kb', async (req) => {
    const body = kbCreateSchema.parse(req.body ?? {});
    const id = uid('kb');
    repos.insertKb({
      id,
      scope: body.scope,
      team_id: body.teamId ?? null,
      owner_member_id: body.ownerMemberId ?? null,
      kind: body.kind,
      title: body.title,
      content: body.content,
      tags: JSON.stringify(body.tags),
      created_at: nowIso(),
    });
    return { ok: true, id };
  });

  /* ----- API 管理 ----- */
  const saveApi = async (bodyRaw: unknown) => {
    const { api: b } = apiSaveSchema.parse(bodyRaw ?? {});
    let row: ApiRow | undefined = b.id ? repos.getApi(b.id) : undefined;
    if (!row) {
      row = {
        id: uid('api'),
        name: '',
        provider: 'custom',
        base_url: '',
        api_key_enc: '',
        model: '',
        price_per_m_milli: 0,
        created_at: nowIso(),
      };
      repos.insertApi(row);
    }
    const currentKey = decryptKey(row.api_key_enc);
    row.name = b.name;
    row.provider = b.provider;
    row.base_url = b.baseUrl;
    row.model = b.model;
    row.price_per_m_milli = yuanToMilli(b.pricePerM);
    if (b.clearKey) row.api_key_enc = encryptKey('');
    else if (typeof b.apiKey === 'string' && b.apiKey !== '' && b.apiKey !== maskKey(currentKey)) {
      row.api_key_enc = encryptKey(b.apiKey);
    }
    repos.updateApi(row);
    if (!repos.getSetting<string | null>('defaultApiId', null)) repos.setSetting('defaultApiId', row.id);
    return { ok: true, id: row.id };
  };
  app.post('/api/apis/save', async (req) => saveApi(req.body));
  app.post('/api/settings/apis', async (req) => saveApi(req.body));
  app.post('/api/apis/delete', async (req) => {
    const { id } = apiDeleteSchema.parse(req.body ?? {});
    repos.deleteApi(id);
    if (repos.getSetting<string | null>('defaultApiId', null) === id) {
      repos.setSetting('defaultApiId', repos.listApis()[0]?.id ?? null);
    }
    return { ok: true };
  });
  app.post('/api/settings/default-api', async (req) => {
    const { apiId } = defaultApiSchema.parse(req.body ?? {});
    repos.setSetting('defaultApiId', apiId);
    return { ok: true };
  });

  /* ----- 设置 ----- */
  app.post('/api/settings/review', async (req) => {
    const body = reviewStandardsSchema.parse(req.body ?? {});
    repos.setSetting('reviewStandards', body);
    return { ok: true };
  });
  app.post('/api/settings/params', async (req) => {
    const body = paramsSchema.parse(req.body ?? {});
    repos.setSetting('params', body);
    return { ok: true };
  });

  /* ----- 组织 ----- */
  app.post('/api/teams/save', async (req) => {
    const { team: b } = teamSaveSchema.parse(req.body ?? {});
    const row = b.id ? repos.getTeam(b.id) : undefined;
    if (!row) {
      const id = uid('team');
      repos.insertTeam({ id, name: b.name, color: b.color, api_id: b.apiId ?? null, created_at: nowIso(), deleted_at: null });
      const isFirst = repos.listTeams().length === 1;
      for (const m of makeMemberRows(id, b.name, isFirst)) repos.insertMember(m);
      return { ok: true, id };
    }
    row.name = b.name;
    row.color = b.color;
    row.api_id = b.apiId ?? null;
    repos.updateTeam(row);
    return { ok: true, id: row.id };
  });
  app.post('/api/teams/delete', async (req) => {
    const { id } = teamDeleteSchema.parse(req.body ?? {});
    repos.softDeleteTeam(id);
    return { ok: true };
  });
  app.post('/api/members/prompt', async (req) => {
    const body = memberPromptSchema.parse(req.body ?? {});
    const member = repos.getMember(body.memberId);
    if (!member) fail(ErrorCode.NOT_FOUND, '成员不存在', 404);
    repos.updateMemberPrompt(body.memberId, body.name ?? member!.name, body.prompt);
    return { ok: true };
  });

  /* ----- 任务 ----- */
  app.post('/api/tasks', async (req) => {
    const body = taskCreateSchema.parse(req.body ?? {});
    const team = repos.getTeam(body.teamId) ?? repos.listTeams()[0];
    if (!team) fail(ErrorCode.VALIDATION, '还没有小组');
    if (body.idempotencyKey) {
      const dup = repos.listTasks().find((t) => t.idempotency_key === body.idempotencyKey);
      if (dup) return { ok: true, id: dup.id, duplicated: true };
    }
    const worker = repos.teamMember(team.id, TYPE_ROLE[body.type]);
    const id = uid('task');
    const row: TaskRow = {
      id,
      project_id: body.projectId ?? null,
      team_id: team.id,
      assignee_id: worker?.id ?? null,
      title: body.title,
      type: body.type,
      brief: body.brief,
      status: TaskStatus.PENDING,
      result: '',
      review_note: '',
      reject_reason: '',
      reject_count: 0,
      blocked_reason: '',
      blocked_code: null,
      adjudicated: 0,
      idempotency_key: body.idempotencyKey ?? null,
      total_tokens: 0,
      total_cost_milli: 0,
      heartbeat_at: null,
      created_at: nowIso(),
      claimed_at: null,
      finished_at: null,
    };
    repos.insertTask(row);
    return { ok: true, id };
  });

  const adjudicate = async (taskId: string) => {
    const task = repos.getTask(taskId);
    if (!task) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
    if (task!.status !== TaskStatus.ADJUDICATION) fail(ErrorCode.VALIDATION, '该任务不在待裁决状态');
    // 裁决通过不受预算闸门拦截（§15.2）：transitionTask 的 DONE 迁移不设守卫
    transitionTask(repos, task!, TaskStatus.DONE, {
      adjudicated: 1,
      finished_at: nowIso(),
      review_note: (task!.review_note || '') + '（老板裁决：通过）',
      blocked_code: null,
      blocked_reason: '',
      heartbeat_at: null,
    });
    refreshProjectStatus(repos, task!.project_id);
    logger.info('api', '老板裁决通过', { taskId });
    return { ok: true };
  };
  app.post('/api/tasks/adjudicate', async (req) => {
    const { taskId } = adjudicateSchema.parse(req.body ?? {});
    return adjudicate(taskId);
  });
  app.post('/api/tasks/:id/adjudicate', async (req) => {
    const { id } = req.params as { id: string };
    return adjudicate(id);
  });

  /* ----- 项目（方案下发） ----- */
  app.post('/api/projects', async (req) => {
    const body = projectCreateSchema.parse(req.body ?? {});
    const { projectId, taskIds } = await createProject(repos, gateway, logger, body);
    return { ok: true, id: projectId, taskIds };
  });

  /* ----- 采购充值 ----- */
  const purchase = async (apiId: string, amountYuan: number) => {
    const api = repos.getApi(apiId);
    if (!api) fail(ErrorCode.NOT_FOUND, 'API 不存在', 404);
    repos.insertPurchase(apiId, yuanToMilli(amountYuan));
    return { ok: true, balanceYuan: milliToYuan(balanceMilli(repos, apiId)) };
  };
  app.post('/api/purchase', async (req) => {
    const body = purchaseSchema.parse(req.body ?? {});
    return purchase(body.apiId, body.amountYuan);
  });
  app.post('/api/settings/apis/:id/purchase', async (req) => {
    const { id } = req.params as { id: string };
    const body = purchaseSchema.omit({ apiId: true }).parse(req.body ?? {});
    return purchase(id, body.amountYuan);
  });
}
