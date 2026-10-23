import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ErrorCode,
  milliToYuan,
  PROVIDER_PRESETS,
  TaskStatus,
  TYPE_ROLE,
  yuanToMilli,
  type ApiDto,
  type AuthUserDto,
  type IndustryPackDto,
  type KbEntryDto,
  type LedgerEntryDto,
  type MemberDto,
  type ProjectDto,
  type PurchaseDto,
  type RegistryRoleDto,
  type RegistryTaskTypeDto,
  type StateDto,
  type TaskDto,
  type WorkspaceDto,
} from '@swarm/shared';
import * as fs from 'fs';
import {
  clearCookieHeader,
  generateTempPassword,
  hashPassword,
  hashSessionToken,
  LOGIN_LOCK_MS,
  LOGIN_MAX_FAILURES,
  newSessionToken,
  parseCookieHeader,
  REGISTRATION_RISK,
  SESSION_COOKIE,
  SESSION_RENEW_BELOW_MS,
  SESSION_TTL_MS,
  sessionCookieHeader,
  verifyPassword,
} from '../auth/auth';
import { balanceMilli, buildReport, trialBalanceMilli } from '../domain/costService';
import { createProject } from '../domain/projectService';
import { cancelTask, deleteTask, refreshProjectStatus, retryTask, transitionTask } from '../domain/taskService';
import { createProvider, LlmGateway } from '../llm/gateway';
import type { Logger } from '../logger';
import { decryptKey, encryptKey, maskKey } from '../store/crypto';
import { provisionWorkspace } from '../store/bootstrap';
import { parseManifest, registerPackExtensions } from '../store/industry';
import { makeMemberRows, ROLE_PERSONAS } from '../store/seed';
import {
  PLATFORM_WORKSPACE_ID,
  type ApiRow,
  type IndustryPackRow,
  type KbRow,
  type MemberRow,
  type Repos,
  type SessionRow,
  type TaskRow,
  type UserRow,
  type WorkspaceRow,
} from '../store/repositories';
import { nowIso, uid } from '../util';
import { registerM7Routes } from './m7';
import {
  adjudicateSchema,
  apiDeleteSchema,
  apiSaveSchema,
  apiTestSchema,
  changePasswordSchema,
  defaultApiSchema,
  industryPackSaveSchema,
  kbCreateSchema,
  kbUpdateSchema,
  loginSchema,
  memberDeleteSchema,
  memberPromptSchema,
  memberSaveSchema,
  paramsSchema,
  preferencesPutSchema,
  projectCreateSchema,
  purchaseSchema,
  registerSchema,
  registryRoleSchema,
  registryTaskTypeSchema,
  reviewStandardsSchema,
  switchWorkspaceSchema,
  taskBatchSchema,
  taskCreateSchema,
  teamDeleteSchema,
  teamSaveSchema,
  trialApiSaveSchema,
  trialGrantSchema,
  workspaceCreateSchema,
} from './schemas';

/** API 测试连接的探活超时（M5）：比正式调用的 120s 短，快速回失败原因 */
const API_TEST_TIMEOUT_MS = 15_000;

/** 体验额度专用停工文案（§8.1，与 engine 口径一致） */
export const TRIAL_EXHAUSTED_REASON = '体验额度已用完，请到设置后台填自己的 API Key';

/** 体验额度单笔上限（元，§8.1：小额、¥10 量级；一次性发放、不可续发叠加） */
export const TRIAL_GRANT_MAX_YUAN = 10;

export interface ApiDeps {
  repos: Repos;
  gateway: LlmGateway;
  logger: Logger;
  /** SQLite 数据库文件路径（GET /api/backup 打包下载用） */
  dbPath: string;
}

function fail(code: string, message: string, status = 400): never {
  throw Object.assign(new Error(message), { code, statusCode: status });
}

interface AuthCtx {
  user: UserRow;
  session: SessionRow;
  workspaceId: string | null;
}

type AuthedRequest = FastifyRequest & { authCtx?: AuthCtx };

/* ---------- DTO 映射（边界格式化：厘 → 元，Key 只出掩码） ---------- */
function apiDto(repos: Repos, row: ApiRow, workspaceId: string): ApiDto {
  const bal = balanceMilli(repos, row.id, workspaceId);
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

function userDto(u: UserRow): AuthUserDto {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    status: u.status,
    isPlatformAdmin: u.is_platform_admin === 1,
    mustChangePassword: u.must_change_password === 1,
  };
}

function parseIdList(json: string): string[] {
  try {
    const v = JSON.parse(json || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function kbDto(k: KbRow): KbEntryDto {
  return {
    id: k.id,
    title: k.title,
    body: k.body,
    scope: k.scope as KbEntryDto['scope'],
    scopeId: k.scope_id,
    tags: parseIdList(k.tags),
    enabled: k.enabled === 1,
    createdAt: k.created_at,
    updatedAt: k.updated_at,
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
    injectedKbIds: parseIdList(row.injected_kb_ids),
    createdByUserId: row.created_by_user_id ?? null,
    skillId: row.skill_id ?? null,
    skillVersion: row.skill_version ?? null,
    skillParams: (() => {
      try {
        const v = JSON.parse(row.skill_params || '{}') as unknown;
        return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    })(),
    isSkillTest: row.is_skill_test === 1,
    totalTokens: row.total_tokens,
    totalCost: milliToYuan(row.total_cost_milli),
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
  };
}

function buildState(repos: Repos, workspaceId: string): StateDto {
  const ws = repos.getWorkspace(workspaceId);
  const tasks = repos.listTasks(workspaceId);
  const projects: ProjectDto[] = repos.listProjects(workspaceId).map((p) => {
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
  const ledger: LedgerEntryDto[] = repos.listLedger(workspaceId).map((l) => ({
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
  const purchases: PurchaseDto[] = repos.listPurchases(workspaceId).map((p) => ({
    ts: p.created_at,
    apiId: p.api_id,
    amountYuan: milliToYuan(p.amount_milli),
    type: p.type ?? 'purchase',
  }));
  return {
    workspace: ws ? { id: ws.id, name: ws.name } : undefined,
    apis: repos.listApis(workspaceId).map((a) => apiDto(repos, a, workspaceId)),
    defaultApiId: repos.getSetting<string | null>('defaultApiId', null, workspaceId),
    teams: repos
      .listTeams(workspaceId)
      .map((t) => ({ id: t.id, name: t.name, color: t.color, apiId: t.api_id })),
    members: repos.listMembers(workspaceId).map((m) => ({
      id: m.id,
      teamId: m.team_id,
      role: m.role as MemberDto['role'],
      name: m.name,
      prompt: m.prompt,
    })),
    reviewStandards: repos.getSetting('reviewStandards', { points: '', clientNeeds: '' }, workspaceId),
    params: repos.getSetting('params', { concurrency: 4, taskBudgetTokens: 0 }, workspaceId),
    tasks: tasks.map(taskDto),
    projects,
    ledger,
    purchases,
  };
}

export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { repos, gateway, logger } = deps;

  /* ================= 会话解析（M6 §3.1：当前空间只取自 session，忽略前端传入的 workspace_id） ================= */
  const resolveAuth = (req: FastifyRequest): AuthCtx => {
    const cookies = parseCookieHeader(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token) fail(ErrorCode.UNAUTHORIZED, '未登录或会话已失效', 401);
    const session = repos.getSession(hashSessionToken(token!));
    if (!session) fail(ErrorCode.UNAUTHORIZED, '未登录或会话已失效', 401);
    const nowMs = Date.now();
    if (new Date(session!.expires_at).getTime() <= nowMs) {
      repos.deleteSession(session!.id);
      fail(ErrorCode.UNAUTHORIZED, '会话已过期，请重新登录', 401);
    }
    const user = repos.getUser(session!.user_id);
    if (!user || user!.status === 'disabled') {
      repos.deleteSessionsByUser(session!.user_id);
      fail(ErrorCode.UNAUTHORIZED, '账号不可用，请重新登录', 401);
    }
    // 滑动续期：剩余不足一半时延长 7 天
    let sess = session!;
    if (new Date(sess.expires_at).getTime() - nowMs < SESSION_RENEW_BELOW_MS) {
      sess = { ...sess, expires_at: new Date(nowMs + SESSION_TTL_MS).toISOString(), last_seen_at: nowIso() };
      repos.updateSession(sess);
    }
    // 当前空间必须仍是本人 active membership；失效则回落到第一个空间
    let workspaceId = sess.current_workspace_id;
    if (workspaceId) {
      const m = repos.getMembership(user!.id, workspaceId);
      if (!m || m.status !== 'active') workspaceId = null;
    }
    if (!workspaceId) {
      const first = repos.listMembershipsByUser(user!.id)[0];
      workspaceId = first ? first.workspace_id : null;
      if (workspaceId && workspaceId !== sess.current_workspace_id) {
        sess = { ...sess, current_workspace_id: workspaceId };
        repos.updateSession(sess);
      }
    }
    return { user: user!, session: sess, workspaceId };
  };

  const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/api/auth/register']);
  const MUST_CHANGE_EXEMPT = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/change-password']);
  app.addHook('onRequest', async (req) => {
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith('/api/') || PUBLIC_PATHS.has(url)) return;
    const ctx = resolveAuth(req);
    (req as AuthedRequest).authCtx = ctx;
    if (ctx.user.must_change_password === 1 && !MUST_CHANGE_EXEMPT.has(url)) {
      fail(ErrorCode.FORBIDDEN, '请先修改初始密码后再继续使用', 403);
    }
  });

  const auth = (req: FastifyRequest): AuthCtx => {
    const ctx = (req as AuthedRequest).authCtx;
    if (!ctx) fail(ErrorCode.UNAUTHORIZED, '未登录或会话已失效', 401);
    return ctx!;
  };
  /** 业务接口的空间上下文：无空间一律拒绝（pending 用户没有空间与会话） */
  const wsAuth = (req: FastifyRequest): AuthCtx & { workspaceId: string } => {
    const ctx = auth(req);
    if (!ctx.workspaceId) fail(ErrorCode.FORBIDDEN, '当前账号尚未加入任何空间', 403);
    return ctx as AuthCtx & { workspaceId: string };
  };
  const requireAdmin = (req: FastifyRequest): AuthCtx => {
    const ctx = auth(req);
    if (ctx.user.is_platform_admin !== 1) fail(ErrorCode.FORBIDDEN, '仅平台管理员可操作', 403);
    return ctx;
  };
  const audit = (
    req: FastifyRequest,
    ctx: AuthCtx,
    action: string,
    targetType = '',
    targetId = '',
    detail = '',
  ): void => {
    repos.insertAudit({
      workspace_id: ctx.workspaceId,
      user_id: ctx.user.id,
      action,
      target_type: targetType,
      target_id: targetId,
      detail,
      ip: req.ip ?? '',
    });
  };

  const createSessionFor = (
    user: UserRow,
    workspaceId: string | null,
    req: FastifyRequest,
  ): string => {
    const token = newSessionToken();
    const ts = nowIso();
    repos.insertSession({
      id: hashSessionToken(token),
      user_id: user.id,
      current_workspace_id: workspaceId,
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      created_ip: req.ip ?? '',
      user_agent: String(req.headers['user-agent'] ?? ''),
      created_at: ts,
      last_seen_at: ts,
    });
    return token;
  };

  const workspaceDto = (u: UserRow, w: WorkspaceRow): WorkspaceDto => ({
    id: w.id,
    name: w.name,
    ownerUserId: w.owner_user_id,
    status: w.status,
    industryPackId: w.industry_pack_id,
    role: repos.getMembership(u.id, w.id)?.role ?? 'member',
  });

  /* ================= 健康检查 / 账号接口 ================= */
  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/auth/register', async (req, reply) => {
    const body = registerSchema.parse(req.body ?? {});
    if (repos.getUserByEmail(body.email)) {
      fail(ErrorCode.VALIDATION, '该邮箱已注册', 409);
    }
    // 注册风控（常量规则见 auth.ts REGISTRATION_RISK）：同 IP 短时多次注册或全局审核开关 → pending
    const since = new Date(Date.now() - REGISTRATION_RISK.WINDOW_MS).toISOString();
    const recentFromIp = req.ip ? repos.countRecentRegistrationsByIp(req.ip, since) : 0;
    const requireApproval =
      process.env.SWARM_REGISTRATION_REQUIRE_APPROVAL === '1' ||
      repos.getSetting<boolean>('requireApproval', false, PLATFORM_WORKSPACE_ID);
    const pending = requireApproval || recentFromIp >= REGISTRATION_RISK.MAX_PER_IP;
    const user: UserRow = {
      id: uid('user'),
      email: body.email,
      password_hash: await hashPassword(body.password),
      display_name: body.displayName,
      status: pending ? 'pending' : 'active',
      is_platform_admin: 0,
      must_change_password: 0,
      failed_attempts: 0,
      locked_until: null,
      registration_ip: req.ip ?? '',
      last_login_at: null,
      created_at: nowIso(),
    };
    repos.insertUser(user);
    repos.insertLoginLog({
      user_id: user.id,
      email: user.email,
      success: 0,
      ip: req.ip ?? '',
      reason: pending ? '注册待审核' : '注册成功',
    });
    if (pending) {
      // 暂存开通意向，管理员通过时按此建空间
      if (body.industryPackId) repos.setPreference(user.id, 'pendingPackId', body.industryPackId);
      if (body.workspaceName) repos.setPreference(user.id, 'pendingWorkspaceName', body.workspaceName);
      return { ok: true, pending: true, user: userDto(user) };
    }
    const ws = provisionWorkspace(
      repos,
      user.id,
      body.workspaceName || `${body.displayName} 的空间`,
      body.industryPackId ?? null,
    );
    const token = createSessionFor(user, ws.id, req);
    reply.header('set-cookie', sessionCookieHeader(token));
    logger.info('auth', '注册成功（即时开通）', { taskId: undefined });
    return { ok: true, pending: false, user: userDto(user), workspace: workspaceDto(user, ws) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body ?? {});
    const ip = req.ip ?? '';
    const user = repos.getUserByEmail(body.email);
    if (!user) {
      repos.insertLoginLog({ user_id: null, email: body.email, success: 0, ip, reason: '用户不存在' });
      fail(ErrorCode.UNAUTHORIZED, '邮箱或密码不正确', 401);
    }
    const u = user!;
    if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      repos.insertLoginLog({ user_id: u.id, email: u.email, success: 0, ip, reason: '账号锁定中' });
      fail(ErrorCode.ACCOUNT_LOCKED, '登录失败次数过多，账号已锁定 15 分钟', 403);
    }
    const okPw = await verifyPassword(u.password_hash, body.password);
    if (!okPw) {
      const attempts = u.failed_attempts + 1;
      const locked = attempts >= LOGIN_MAX_FAILURES;
      repos.updateUser({
        ...u,
        failed_attempts: locked ? 0 : attempts,
        locked_until: locked ? new Date(Date.now() + LOGIN_LOCK_MS).toISOString() : u.locked_until,
      });
      repos.insertLoginLog({
        user_id: u.id,
        email: u.email,
        success: 0,
        ip,
        reason: locked ? '密码错误达上限，锁定 15 分钟' : '密码错误',
      });
      if (locked) fail(ErrorCode.ACCOUNT_LOCKED, '登录失败次数过多，账号已锁定 15 分钟', 403);
      fail(ErrorCode.UNAUTHORIZED, '邮箱或密码不正确', 401);
    }
    if (u.status === 'pending') {
      repos.insertLoginLog({ user_id: u.id, email: u.email, success: 0, ip, reason: '账号待审核' });
      fail(ErrorCode.FORBIDDEN, '账号待管理员审核开通', 403);
    }
    if (u.status === 'disabled') {
      repos.insertLoginLog({ user_id: u.id, email: u.email, success: 0, ip, reason: '账号已停用' });
      fail(ErrorCode.FORBIDDEN, '账号已停用', 403);
    }
    repos.updateUser({ ...u, failed_attempts: 0, locked_until: null, last_login_at: nowIso() });
    repos.insertLoginLog({ user_id: u.id, email: u.email, success: 1, ip, reason: '' });
    const first = repos.listMembershipsByUser(u.id)[0];
    const token = createSessionFor(u, first ? first.workspace_id : null, req);
    reply.header('set-cookie', sessionCookieHeader(token));
    repos.insertAudit({
      workspace_id: first ? first.workspace_id : null,
      user_id: u.id,
      action: 'login',
      target_type: 'user',
      target_id: u.id,
      ip,
    });
    return { ok: true, user: userDto({ ...u, last_login_at: nowIso() }) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const ctx = auth(req);
    repos.deleteSession(ctx.session.id);
    reply.header('set-cookie', clearCookieHeader());
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const ctx = auth(req);
    const workspaces = repos
      .listMembershipsByUser(ctx.user.id)
      .map((m) => repos.getWorkspace(m.workspace_id))
      .filter((w): w is WorkspaceRow => !!w)
      .map((w) => workspaceDto(ctx.user, w));
    const current = ctx.workspaceId ? repos.getWorkspace(ctx.workspaceId) : undefined;
    return {
      ok: true,
      user: userDto(ctx.user),
      workspace: current ? workspaceDto(ctx.user, current) : null,
      workspaces,
    };
  });

  app.post('/api/auth/change-password', async (req) => {
    const ctx = auth(req);
    const body = changePasswordSchema.parse(req.body ?? {});
    const okPw = await verifyPassword(ctx.user.password_hash, body.currentPassword);
    if (!okPw) fail(ErrorCode.VALIDATION, '当前密码不正确');
    repos.updateUser({
      ...ctx.user,
      password_hash: await hashPassword(body.newPassword),
      must_change_password: 0,
    });
    // 改密后吊销其他会话，保留当前会话
    repos.deleteSessionsByUser(ctx.user.id, ctx.session.id);
    audit(req, ctx, 'change_password', 'user', ctx.user.id);
    return { ok: true };
  });

  app.post('/api/auth/switch-workspace', async (req) => {
    const ctx = auth(req);
    const { workspaceId } = switchWorkspaceSchema.parse(req.body ?? {});
    const m = repos.getMembership(ctx.user.id, workspaceId);
    if (!m || m.status !== 'active') {
      fail(ErrorCode.FORBIDDEN, '你不是该空间的成员', 403);
    }
    const ws = repos.getWorkspace(workspaceId);
    if (!ws || ws.status !== 'active') fail(ErrorCode.NOT_FOUND, '空间不存在或已停用', 404);
    repos.updateSession({ ...ctx.session, current_workspace_id: workspaceId, last_seen_at: nowIso() });
    return { ok: true, workspace: workspaceDto(ctx.user, ws!) };
  });

  /* ================= 空间 / 行业包 / 注册表 / 个人偏好 ================= */
  app.get('/api/workspaces', async (req) => {
    const ctx = auth(req);
    const workspaces = repos
      .listMembershipsByUser(ctx.user.id)
      .map((m) => repos.getWorkspace(m.workspace_id))
      .filter((w): w is WorkspaceRow => !!w)
      .map((w) => workspaceDto(ctx.user, w));
    return { ok: true, workspaces };
  });

  app.post('/api/workspaces', async (req) => {
    const ctx = auth(req);
    const body = workspaceCreateSchema.parse(req.body ?? {});
    let ws: WorkspaceRow;
    try {
      ws = provisionWorkspace(repos, ctx.user.id, body.name, body.industryPackId ?? null);
    } catch (e) {
      fail(ErrorCode.VALIDATION, e instanceof Error ? e.message : String(e));
    }
    // 建空间后自动切换到新空间
    repos.updateSession({ ...ctx.session, current_workspace_id: ws!.id, last_seen_at: nowIso() });
    audit(req, { ...ctx, workspaceId: ws!.id }, 'create_workspace', 'workspace', ws!.id, body.name);
    return { ok: true, workspace: workspaceDto(ctx.user, ws!) };
  });

  const packDto = (p: IndustryPackRow): IndustryPackDto => {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(p.content) as Record<string, unknown>;
    } catch {
      content = {};
    }
    return {
      id: p.id,
      industry: p.industry,
      name: p.name,
      version: p.version,
      description: p.description,
      author: p.author,
      status: p.status,
      content,
    };
  };
  app.get('/api/industry-packs', async (req) => {
    auth(req);
    return { ok: true, packs: repos.listIndustryPacks(true).map(packDto) };
  });

  app.get('/api/registry', async (req) => {
    const ctx = wsAuth(req);
    const ws = repos.getWorkspace(ctx.workspaceId);
    const packId = ws?.industry_pack_id ?? null;
    const roles: RegistryRoleDto[] = repos.listRolesVisible(ctx.workspaceId, packId).map((r) => ({
      roleId: r.role_id,
      name: r.name,
      personaTemplate: r.persona_template,
      color: r.color,
      icon: r.icon,
      industry: r.industry,
      packId: r.pack_id,
      workspaceId: r.workspace_id,
      isSystem: r.is_system === 1,
    }));
    const taskTypes: RegistryTaskTypeDto[] = repos
      .listTaskTypesVisible(ctx.workspaceId, packId)
      .map((t) => ({
        typeId: t.type_id,
        name: t.name,
        roleId: t.role_id,
        industry: t.industry,
        packId: t.pack_id,
        workspaceId: t.workspace_id,
      }));
    return { ok: true, roles, taskTypes };
  });

  app.post('/api/registry/roles', async (req) => {
    const ctx = wsAuth(req);
    const { role: b } = registryRoleSchema.parse(req.body ?? {});
    const ws = repos.getWorkspace(ctx.workspaceId);
    const packId = ws?.industry_pack_id ?? null;
    const roleId = b.roleId ?? b.name;
    if (repos.listRolesVisible(ctx.workspaceId, packId).some((r) => r.role_id === roleId)) {
      fail(ErrorCode.VALIDATION, `工种「${roleId}」已存在`);
    }
    repos.insertRole({
      id: uid('role'),
      role_id: roleId,
      name: b.name,
      persona_template: b.personaTemplate || `你是一名${b.name}。`,
      color: b.color,
      icon: b.icon,
      industry: null,
      pack_id: null,
      workspace_id: ctx.workspaceId,
      is_system: 0,
      created_at: nowIso(),
    });
    audit(req, ctx, 'create_role', 'role', roleId);
    return { ok: true, roleId };
  });

  app.post('/api/registry/task-types', async (req) => {
    const ctx = wsAuth(req);
    const { taskType: b } = registryTaskTypeSchema.parse(req.body ?? {});
    const ws = repos.getWorkspace(ctx.workspaceId);
    const packId = ws?.industry_pack_id ?? null;
    const typeId = b.typeId ?? b.name;
    if (!repos.listRolesVisible(ctx.workspaceId, packId).some((r) => r.role_id === b.roleId)) {
      fail(ErrorCode.VALIDATION, `工种「${b.roleId}」未注册`);
    }
    if (repos.listTaskTypesVisible(ctx.workspaceId, packId).some((t) => t.type_id === typeId)) {
      fail(ErrorCode.VALIDATION, `任务类型「${typeId}」已存在`);
    }
    repos.insertTaskType({
      id: uid('tt'),
      type_id: typeId,
      name: b.name,
      role_id: b.roleId,
      industry: null,
      pack_id: null,
      workspace_id: ctx.workspaceId,
      created_at: nowIso(),
    });
    audit(req, ctx, 'create_task_type', 'task_type', typeId);
    return { ok: true, typeId };
  });

  app.get('/api/preferences', async (req) => {
    const ctx = auth(req);
    return { ok: true, preferences: repos.getPreferences(ctx.user.id) };
  });
  app.put('/api/preferences', async (req) => {
    const ctx = auth(req);
    const body = preferencesPutSchema.parse(req.body ?? {});
    if (body.values) {
      for (const [k, v] of Object.entries(body.values)) repos.setPreference(ctx.user.id, k, v);
    } else if (body.key) {
      repos.setPreference(ctx.user.id, body.key, body.value ?? null);
    } else {
      fail(ErrorCode.VALIDATION, '需要提供 key/value 或 values');
    }
    return { ok: true, preferences: repos.getPreferences(ctx.user.id) };
  });

  /* ================= 业务接口（全部按 session 空间隔离） ================= */
  app.get('/api/state', async (req) => {
    const ctx = wsAuth(req);
    return buildState(repos, ctx.workspaceId);
  });
  app.get('/api/presets', async (req) => {
    auth(req);
    return PROVIDER_PRESETS;
  });
  app.get('/api/cost/report', async (req) => {
    const ctx = wsAuth(req);
    return { ok: true, report: buildReport(repos, ctx.workspaceId) };
  });

  /* ----- 知识库（M3 + M6 三层：platform/company/team/personal） ----- */
  const normalizeKbScope = (
    ctx: AuthCtx & { workspaceId: string },
    scope: string,
    scopeId: string | null | undefined,
  ): string | null => {
    if (scope === 'company' || scope === 'platform') return null;
    if (scope === 'personal') return null; // 个人条目以 owner_user_id 归属，scope_id 不用
    if (!scopeId) fail(ErrorCode.VALIDATION, `scope=${scope} 时必须指定 scopeId`);
    if (scope === 'team' && !repos.getTeam(scopeId!, ctx.workspaceId)) {
      fail(ErrorCode.VALIDATION, 'scopeId 指向的小组不存在');
    }
    if (scope === 'member' && !repos.getMember(scopeId!, ctx.workspaceId)) {
      fail(ErrorCode.VALIDATION, 'scopeId 指向的成员不存在');
    }
    return scopeId!;
  };
  /** 个人条目对他人不可见（回 404 不暴露存在性） */
  const kbVisibleTo = (ctx: AuthCtx, k: KbRow): boolean => {
    if (k.scope === 'personal' && k.owner_user_id && k.owner_user_id !== ctx.user.id) return false;
    return true;
  };

  app.get('/api/kb', async (req) => {
    const ctx = wsAuth(req);
    const entries = repos.listKb(ctx.workspaceId).filter((k) => kbVisibleTo(ctx, k));
    return { ok: true, entries: entries.map(kbDto) };
  });
  app.post('/api/kb', async (req) => {
    const ctx = wsAuth(req);
    const body = kbCreateSchema.parse(req.body ?? {});
    if (body.scope === 'platform' && ctx.user.is_platform_admin !== 1) {
      fail(ErrorCode.FORBIDDEN, '平台公共知识仅平台管理员可维护', 403);
    }
    const scope = body.scope === 'member' ? 'personal' : body.scope;
    const scopeId = normalizeKbScope(ctx, scope, body.scopeId ?? null);
    const ts = nowIso();
    const row: KbRow = {
      id: uid('kb'),
      title: body.title,
      body: body.body,
      scope,
      scope_id: scopeId,
      tags: JSON.stringify(body.tags),
      enabled: body.enabled ? 1 : 0,
      created_at: ts,
      updated_at: ts,
      workspace_id: scope === 'platform' ? null : ctx.workspaceId,
      owner_user_id: scope === 'personal' ? ctx.user.id : null,
    };
    repos.insertKb(row);
    return { ok: true, id: row.id, entry: kbDto(row) };
  });
  app.put('/api/kb/:id', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const cur = repos.getKb(id, ctx.workspaceId);
    if (!cur || !kbVisibleTo(ctx, cur!)) fail(ErrorCode.NOT_FOUND, '知识条目不存在', 404);
    if (cur!.scope === 'platform' && ctx.user.is_platform_admin !== 1) {
      fail(ErrorCode.FORBIDDEN, '平台公共知识仅平台管理员可维护', 403);
    }
    const body = kbUpdateSchema.parse(req.body ?? {});
    const scope = body.scope ?? cur!.scope;
    const scopeId = normalizeKbScope(ctx, scope, body.scopeId !== undefined ? body.scopeId : cur!.scope_id);
    const next: KbRow = {
      ...cur!,
      title: body.title ?? cur!.title,
      body: body.body ?? cur!.body,
      scope,
      scope_id: scopeId,
      tags: body.tags !== undefined ? JSON.stringify(body.tags) : cur!.tags,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : cur!.enabled,
      updated_at: nowIso(),
      workspace_id: scope === 'platform' ? null : (cur!.workspace_id ?? ctx.workspaceId),
      owner_user_id:
        scope === 'personal' ? (cur!.owner_user_id ?? ctx.user.id) : cur!.owner_user_id ?? null,
    };
    repos.updateKb(next);
    return { ok: true, entry: kbDto(next) };
  });
  app.delete('/api/kb/:id', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const cur = repos.getKb(id, ctx.workspaceId);
    if (!cur || !kbVisibleTo(ctx, cur!)) fail(ErrorCode.NOT_FOUND, '知识条目不存在', 404);
    if (cur!.scope === 'platform' && ctx.user.is_platform_admin !== 1) {
      fail(ErrorCode.FORBIDDEN, '平台公共知识仅平台管理员可维护', 403);
    }
    repos.deleteKb(id);
    return { ok: true };
  });
  /** 成果回流：已完成任务的成果一键存入知识库（标题=任务标题、scope 默认任务所属组、正文=成果全文） */
  app.post('/api/kb/from-task/:taskId', async (req) => {
    const ctx = wsAuth(req);
    const { taskId } = req.params as { taskId: string };
    const task = repos.getTask(taskId, ctx.workspaceId);
    if (!task) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
    if (task!.status !== TaskStatus.DONE) fail(ErrorCode.VALIDATION, '任务尚未完成，成果不可回流');
    if (!task!.result) fail(ErrorCode.VALIDATION, '任务成果为空，无法回流');
    const ts = nowIso();
    const row: KbRow = {
      id: uid('kb'),
      title: task!.title,
      body: task!.result,
      scope: 'team',
      scope_id: task!.team_id,
      tags: '[]',
      enabled: 1,
      created_at: ts,
      updated_at: ts,
      workspace_id: ctx.workspaceId,
      owner_user_id: null,
    };
    repos.insertKb(row);
    logger.info('api', '成果回流知识库', { taskId, kbId: row.id });
    return { ok: true, id: row.id, entry: kbDto(row) };
  });

  /* ----- API 管理 ----- */
  const saveApi = async (req: FastifyRequest, bodyRaw: unknown) => {
    const ctx = wsAuth(req);
    const { api: b } = apiSaveSchema.parse(bodyRaw ?? {});
    let row: ApiRow | undefined = b.id ? repos.getApi(b.id, ctx.workspaceId) : undefined;
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
        workspace_id: ctx.workspaceId,
        is_trial: 0,
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
    if (!repos.getSetting<string | null>('defaultApiId', null, ctx.workspaceId)) {
      repos.setSetting('defaultApiId', row.id, ctx.workspaceId);
    }
    audit(req, ctx, 'save_api', 'api', row.id, row.name);
    return { ok: true, id: row.id };
  };
  app.post('/api/apis/save', async (req) => saveApi(req, req.body));
  app.post('/api/settings/apis', async (req) => saveApi(req, req.body));
  app.post('/api/apis/delete', async (req) => {
    const ctx = wsAuth(req);
    const { id } = apiDeleteSchema.parse(req.body ?? {});
    if (!repos.getApi(id, ctx.workspaceId)) fail(ErrorCode.NOT_FOUND, 'API 不存在', 404);
    repos.deleteApi(id);
    if (repos.getSetting<string | null>('defaultApiId', null, ctx.workspaceId) === id) {
      repos.setSetting('defaultApiId', repos.listApis(ctx.workspaceId)[0]?.id ?? null, ctx.workspaceId);
    }
    audit(req, ctx, 'delete_api', 'api', id);
    return { ok: true };
  });

  /**
   * 测试连接（M5）：直连 Provider 发一次最小 chat（max_tokens=1、15s 超时），
   * 不走网关——不记账、不扣余额、不触发熔断；成败都以 test 结果体返回（失败含厂商原文摘要）。
   */
  app.post('/api/apis/test', async (req) => {
    const ctx = wsAuth(req);
    const body = apiTestSchema.parse(req.body ?? {});
    const stored = body.id ? repos.getApi(body.id, ctx.workspaceId) : undefined;
    if (body.id && !stored) fail(ErrorCode.NOT_FOUND, 'API 不存在', 404);
    if (!body.api && !stored) fail(ErrorCode.VALIDATION, '需要提供已存 API 的 id 或一条完整配置');
    const storedKey = stored ? decryptKey(stored.api_key_enc) : '';
    let apiKey = storedKey;
    if (body.api?.apiKey && body.api.apiKey !== maskKey(storedKey)) apiKey = body.api.apiKey;
    const provider = body.api?.provider ?? stored!.provider;
    const baseUrl = body.api?.baseUrl ?? stored!.base_url;
    const model = body.api?.model ?? stored!.model;
    const done = (ok: boolean, latencyMs: number, message: string) => ({
      ok: true,
      test: { ok, latencyMs, message },
    });
    if (!apiKey) return done(false, 0, '未填写 API Key（先填 Key 再测连接）');
    if (!baseUrl) return done(false, 0, '未填写 Base URL');
    if (!model) return done(false, 0, '未填写模型名');
    const probeRow: ApiRow = {
      id: stored?.id ?? 'api_test_probe',
      name: stored?.name ?? 'test',
      provider,
      base_url: baseUrl,
      api_key_enc: encryptKey(apiKey),
      model,
      price_per_m_milli: 0,
      created_at: stored?.created_at ?? nowIso(),
      workspace_id: ctx.workspaceId,
    };
    const t0 = Date.now();
    try {
      await createProvider(probeRow).chat({
        model,
        system: '',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        maxTokens: 1,
        timeoutMs: API_TEST_TIMEOUT_MS,
      });
      const latencyMs = Date.now() - t0;
      logger.info('api', `API 测试连接成功 ${provider}/${model} ${latencyMs}ms`, { apiId: probeRow.id });
      return done(true, latencyMs, `连接成功，模型「${model}」已响应`);
    } catch (e) {
      const latencyMs = Date.now() - t0;
      const message = e instanceof Error ? e.message : String(e);
      logger.warn('api', `API 测试连接失败：${message}`, { apiId: probeRow.id });
      return done(false, latencyMs, message);
    }
  });
  app.post('/api/settings/default-api', async (req) => {
    const ctx = wsAuth(req);
    const { apiId } = defaultApiSchema.parse(req.body ?? {});
    repos.setSetting('defaultApiId', apiId, ctx.workspaceId);
    return { ok: true };
  });

  /* ----- 设置 ----- */
  app.post('/api/settings/review', async (req) => {
    const ctx = wsAuth(req);
    const body = reviewStandardsSchema.parse(req.body ?? {});
    repos.setSetting('reviewStandards', body, ctx.workspaceId);
    audit(req, ctx, 'update_review_standards', 'settings', 'reviewStandards');
    return { ok: true };
  });
  app.post('/api/settings/params', async (req) => {
    const ctx = wsAuth(req);
    const body = paramsSchema.parse(req.body ?? {});
    repos.setSetting('params', body, ctx.workspaceId);
    return { ok: true };
  });

  /* ----- 组织 ----- */
  app.post('/api/teams/save', async (req) => {
    const ctx = wsAuth(req);
    const { team: b } = teamSaveSchema.parse(req.body ?? {});
    const row = b.id ? repos.getTeam(b.id, ctx.workspaceId) : undefined;
    if (!row) {
      const id = uid('team');
      repos.insertTeam({
        id,
        name: b.name,
        color: b.color,
        api_id: b.apiId ?? null,
        created_at: nowIso(),
        deleted_at: null,
        workspace_id: ctx.workspaceId,
      });
      const isFirst = repos.listTeams(ctx.workspaceId).length === 1;
      for (const m of makeMemberRows(id, b.name, isFirst, ctx.workspaceId)) {
        repos.insertMember({ ...m, id: uid('member') });
      }
      return { ok: true, id };
    }
    row.name = b.name;
    row.color = b.color;
    row.api_id = b.apiId ?? null;
    repos.updateTeam(row);
    return { ok: true, id: row.id };
  });
  app.post('/api/teams/delete', async (req) => {
    const ctx = wsAuth(req);
    const { id } = teamDeleteSchema.parse(req.body ?? {});
    if (!repos.getTeam(id, ctx.workspaceId)) fail(ErrorCode.NOT_FOUND, '小组不存在', 404);
    repos.softDeleteTeam(id);
    return { ok: true };
  });
  app.post('/api/members/prompt', async (req) => {
    const ctx = wsAuth(req);
    const body = memberPromptSchema.parse(req.body ?? {});
    const member = repos.getMember(body.memberId, ctx.workspaceId);
    if (!member) fail(ErrorCode.NOT_FOUND, '成员不存在', 404);
    repos.updateMemberPrompt(body.memberId, body.name ?? member!.name, body.prompt);
    return { ok: true };
  });

  /* ----- 成员管理（M5）：新建/编辑/换组 + 删除守卫 ----- */
  app.post('/api/members/save', async (req) => {
    const ctx = wsAuth(req);
    const { member: b } = memberSaveSchema.parse(req.body ?? {});
    const team = repos.getTeam(b.teamId, ctx.workspaceId);
    if (!team) fail(ErrorCode.VALIDATION, '所属小组不存在');
    const wsRow = repos.getWorkspace(ctx.workspaceId);
    const roleRow = repos
      .listRolesVisible(ctx.workspaceId, wsRow?.industry_pack_id ?? null)
      .find((r) => r.role_id === b.role);
    const rolePersona = roleRow?.persona_template ?? ROLE_PERSONAS.find((r) => r.role === b.role)?.persona ?? '';
    const cur = b.id ? repos.getMember(b.id, ctx.workspaceId) : undefined;
    if (b.id && !cur) fail(ErrorCode.NOT_FOUND, '成员不存在', 404);
    if (!cur) {
      const row: MemberRow = {
        id: uid('member'),
        team_id: b.teamId,
        name: b.name,
        role: b.role,
        persona: rolePersona,
        prompt: b.prompt,
        skill_tags: '[]',
        color: '',
        workspace_id: ctx.workspaceId,
      };
      repos.insertMember(row);
      logger.info('api', '新建成员', { memberId: row.id });
      audit(req, ctx, 'create_member', 'member', row.id, row.name);
      return { ok: true, id: row.id };
    }
    const next: MemberRow = {
      ...cur!,
      team_id: b.teamId,
      name: b.name,
      role: b.role,
      // 工种变更时人设跟随新工种默认（人设无独立编辑入口，始终与工种口径一致）
      persona: b.role !== cur!.role ? rolePersona : cur!.persona,
      prompt: b.prompt,
    };
    repos.updateMember(next);
    audit(req, ctx, 'update_member', 'member', next.id, next.name);
    return { ok: true, id: next.id };
  });
  app.post('/api/members/delete', async (req) => {
    const ctx = wsAuth(req);
    const { id } = memberDeleteSchema.parse(req.body ?? {});
    const member = repos.getMember(id, ctx.workspaceId);
    if (!member) fail(ErrorCode.NOT_FOUND, '成员不存在', 404);
    const active = repos.countActiveTasksByMember(id, ctx.workspaceId);
    if (active > 0) {
      fail(
        ErrorCode.MEMBER_HAS_ACTIVE_TASKS,
        `成员「${member!.name}」名下还有 ${active} 个未完成任务，先取消或等它们完成再删除`,
      );
    }
    repos.deleteMember(id);
    logger.info('api', '删除成员', { memberId: id });
    audit(req, ctx, 'delete_member', 'member', id, member!.name);
    return { ok: true };
  });

  /* ----- 任务 ----- */
  /** 参考资料拼装（P1）：非空 references 以【参考资料】段追加到 brief 末尾 */
  const withReferences = (brief: string, references?: string): string =>
    references && references.trim()
      ? `${brief}${brief ? '\n\n' : ''}【参考资料】\n${references.trim()}`
      : brief;

  const createOneTask = (
    ctx: AuthCtx & { workspaceId: string },
    body: {
      title: string;
      type: string;
      brief: string;
      references?: string;
      teamId: string;
      projectId?: string | null;
      idempotencyKey?: string;
      skillId?: string | null;
      skillVersion?: number | null;
    },
  ): { id: string; duplicated?: boolean } => {
    const team = repos.getTeam(body.teamId, ctx.workspaceId) ?? repos.listTeams(ctx.workspaceId)[0];
    if (!team) fail(ErrorCode.VALIDATION, '还没有小组');
    const wsRow = repos.getWorkspace(ctx.workspaceId);
    const packId = wsRow?.industry_pack_id ?? null;
    if (!repos.listTaskTypesVisible(ctx.workspaceId, packId).some((t) => t.type_id === body.type)) {
      fail(ErrorCode.VALIDATION, `任务类型「${body.type}」未在注册表中登记`);
    }
    if (body.idempotencyKey) {
      const dup = repos
        .listTasks(ctx.workspaceId)
        .find((t) => t.idempotency_key === body.idempotencyKey);
      if (dup) return { id: dup.id, duplicated: true };
    }
    const role =
      repos.resolveRoleForType(body.type, ctx.workspaceId, packId) ?? TYPE_ROLE[body.type] ?? '文案';
    const worker = repos.teamMember(team.id, role, ctx.workspaceId);
    const id = uid('task');
    const row: TaskRow = {
      id,
      project_id: body.projectId ?? null,
      team_id: team.id,
      assignee_id: worker?.id ?? null,
      title: body.title,
      type: body.type,
      brief: withReferences(body.brief, body.references),
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
      injected_kb_ids: '[]',
      created_at: nowIso(),
      claimed_at: null,
      finished_at: null,
      workspace_id: ctx.workspaceId,
      created_by_user_id: ctx.user.id,
      skill_id: body.skillId ?? null,
      skill_version: body.skillVersion ?? null,
    };
    repos.insertTask(row);
    repos.insertTaskEvent({
      task_id: id,
      workspace_id: ctx.workspaceId,
      actor_type: 'user',
      actor_id: ctx.user.id,
      from_status: null,
      to_status: TaskStatus.PENDING,
      note: '发单',
    });
    return { id };
  };

  app.post('/api/tasks', async (req) => {
    const ctx = wsAuth(req);
    const body = taskCreateSchema.parse(req.body ?? {});
    const r = createOneTask(ctx, body);
    return { ok: true, id: r.id, ...(r.duplicated ? { duplicated: true } : {}) };
  });

  /** 批量发单（P1：一行一单；前端按行拆标题，共用类型/小组/说明后缀/参考资料） */
  app.post('/api/tasks/batch', async (req) => {
    const ctx = wsAuth(req);
    const body = taskBatchSchema.parse(req.body ?? {});
    const ids: string[] = [];
    for (const item of body.items) {
      const brief = [item.brief ?? '', body.briefSuffix].filter((s) => s && s.trim()).join('\n');
      const r = createOneTask(ctx, {
        title: item.title,
        type: body.type,
        brief,
        references: body.references,
        teamId: body.teamId,
        projectId: body.projectId ?? null,
      });
      ids.push(r.id);
    }
    audit(req, ctx, 'batch_tasks', 'task', '', `批量发单 ${ids.length} 单`);
    return { ok: true, ids, count: ids.length };
  });

  /** 任务详情（回传注入审计等全量字段，§10） */
  app.get('/api/tasks/:id', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const task = repos.getTask(id, ctx.workspaceId);
    if (!task) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
    return { ok: true, task: taskDto(task!) };
  });

  const adjudicate = async (req: FastifyRequest, taskId: string) => {
    const ctx = wsAuth(req);
    const task = repos.getTask(taskId, ctx.workspaceId);
    if (!task) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
    if (task!.status !== TaskStatus.ADJUDICATION) fail(ErrorCode.VALIDATION, '该任务不在待裁决状态');
    // 裁决通过不受预算闸门拦截（§15.2）：transitionTask 的 DONE 迁移不设守卫
    transitionTask(
      repos,
      task!,
      TaskStatus.DONE,
      {
        adjudicated: 1,
        finished_at: nowIso(),
        review_note: (task!.review_note || '') + '（老板裁决：通过）',
        blocked_code: null,
        blocked_reason: '',
        heartbeat_at: null,
      },
      undefined,
      { type: 'user', id: ctx.user.id, note: '老板裁决通过' },
    );
    refreshProjectStatus(repos, task!.project_id);
    logger.info('api', '老板裁决通过', { taskId });
    audit(req, ctx, 'adjudicate', 'task', taskId);
    return { ok: true };
  };
  app.post('/api/tasks/adjudicate', async (req) => {
    const { taskId } = adjudicateSchema.parse(req.body ?? {});
    return adjudicate(req, taskId);
  });
  app.post('/api/tasks/:id/adjudicate', async (req) => {
    const { id } = req.params as { id: string };
    return adjudicate(req, id);
  });

  /* ----- 任务后悔药（M5）：取消 / 重试 / 删除，合法性在 domain 层校验 ----- */
  const getTaskOr404 = (ctx: AuthCtx & { workspaceId: string }, id: string): TaskRow => {
    const task = repos.getTask(id, ctx.workspaceId);
    if (!task) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
    return task!;
  };
  app.post('/api/tasks/:id/cancel', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const next = cancelTask(repos, getTaskOr404(ctx, id), { type: 'user', id: ctx.user.id, note: '老板取消' });
    logger.info('api', '取消任务', { taskId: id });
    return { ok: true, task: taskDto(next) };
  });
  app.post('/api/tasks/:id/retry', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const next = retryTask(repos, getTaskOr404(ctx, id));
    logger.info('api', '手动重试停工任务（已清停工原因）', { taskId: id });
    return { ok: true, task: taskDto(next) };
  });
  app.post('/api/tasks/:id/delete', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    deleteTask(repos, getTaskOr404(ctx, id), { type: 'user', id: ctx.user.id });
    logger.info('api', '删除任务记录（账本保留）', { taskId: id });
    return { ok: true };
  });

  /* ----- 数据备份（M6 口径：整库文件含全部空间，仅平台管理员可用且审计留痕） ----- */
  app.get('/api/backup', async (req, reply) => {
    const ctx = requireAdmin(req);
    audit(req, ctx, 'backup_download', 'database', '', '整库备份（含全部空间）');
    // 先把 WAL 合并回主文件并截断，保证下载到的单文件自洽一致
    repos.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const buf = fs.readFileSync(deps.dbPath);
    const stamp = nowIso().slice(0, 10);
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="swarm-backup-${stamp}.db"`);
    reply.header('x-backup-scope', 'full-database-all-workspaces');
    return reply.send(buf);
  });

  /* ----- 项目（方案下发） ----- */
  app.post('/api/projects', async (req) => {
    const ctx = wsAuth(req);
    const body = projectCreateSchema.parse(req.body ?? {});
    if (!repos.getTeam(body.teamId, ctx.workspaceId)) {
      fail(ErrorCode.VALIDATION, '小组不存在');
    }
    const { projectId, taskIds } = await createProject(repos, gateway, logger, {
      ...body,
      workspaceId: ctx.workspaceId,
      createdByUserId: ctx.user.id,
    });
    return { ok: true, id: projectId, taskIds };
  });

  /* ----- 采购充值 ----- */
  const purchase = async (req: FastifyRequest, apiId: string, amountYuan: number) => {
    const ctx = wsAuth(req);
    const api = repos.getApi(apiId, ctx.workspaceId);
    if (!api) fail(ErrorCode.NOT_FOUND, 'API 不存在', 404);
    repos.insertPurchase(apiId, yuanToMilli(amountYuan), ctx.workspaceId, 'purchase');
    audit(req, ctx, 'purchase', 'api', apiId, `充值 ${amountYuan} 元`);
    return { ok: true, balanceYuan: milliToYuan(balanceMilli(repos, apiId, ctx.workspaceId)) };
  };
  app.post('/api/purchase', async (req) => {
    const body = purchaseSchema.parse(req.body ?? {});
    return purchase(req, body.apiId, body.amountYuan);
  });
  app.post('/api/settings/apis/:id/purchase', async (req) => {
    const { id } = req.params as { id: string };
    const body = purchaseSchema.omit({ apiId: true }).parse(req.body ?? {});
    return purchase(req, id, body.amountYuan);
  });

  /* ================= 管理台（仅平台管理员） ================= */
  app.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    const users = repos.listUsers().map((u) => ({
      ...userDto(u),
      email: u.email,
      workspaceCount: repos.listMembershipsByUser(u.id).length,
      lastLoginAt: u.last_login_at,
      createdAt: u.created_at,
    }));
    return { ok: true, users };
  });
  app.post('/api/admin/users/:id/approve', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const u = repos.getUser(id);
    if (!u) fail(ErrorCode.NOT_FOUND, '用户不存在', 404);
    repos.updateUser({ ...u!, status: 'active' });
    if (repos.listMembershipsByUser(id).length === 0) {
      const packId = repos.getPreference<string | null>(id, 'pendingPackId', null);
      const wsName = repos.getPreference<string>(id, 'pendingWorkspaceName', `${u!.display_name} 的空间`);
      provisionWorkspace(repos, id, wsName, packId);
    }
    audit(req, ctx, 'admin_approve_user', 'user', id);
    return { ok: true };
  });
  app.post('/api/admin/users/:id/disable', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const u = repos.getUser(id);
    if (!u) fail(ErrorCode.NOT_FOUND, '用户不存在', 404);
    repos.updateUser({ ...u!, status: 'disabled' });
    repos.deleteSessionsByUser(id); // 停用即时吊销全部会话
    audit(req, ctx, 'admin_disable_user', 'user', id);
    return { ok: true };
  });
  app.post('/api/admin/users/:id/reset-password', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const u = repos.getUser(id);
    if (!u) fail(ErrorCode.NOT_FOUND, '用户不存在', 404);
    const temp = generateTempPassword();
    repos.updateUser({ ...u!, password_hash: await hashPassword(temp), must_change_password: 1 });
    repos.deleteSessionsByUser(id);
    audit(req, ctx, 'admin_reset_password', 'user', id);
    // 临时密码仅此一次返回，不落日志/审计明细
    return { ok: true, temporaryPassword: temp };
  });
  app.get('/api/admin/workspaces', async (req) => {
    requireAdmin(req);
    const trial = repos.getTrialApi();
    const workspaces = repos.listWorkspaces().map((w) => {
      const totals = repos.ledgerTotals(w.id);
      const ownBalance = repos
        .listApis(w.id)
        .reduce((s, a) => s + balanceMilli(repos, a.id, w.id), 0);
      return {
        id: w.id,
        name: w.name,
        ownerUserId: w.owner_user_id,
        ownerEmail: repos.getUser(w.owner_user_id)?.email ?? '',
        status: w.status,
        industryPackId: w.industry_pack_id,
        taskCount: repos.listTasks(w.id).length,
        totalCostYuan: milliToYuan(totals.costMilli),
        totalTokens: totals.totalTokens,
        balanceYuan: milliToYuan(ownBalance),
        trialGrantedYuan: trial ? milliToYuan(repos.trialGrantedSum(trial.id, w.id)) : 0,
        trialRemainingYuan: trial ? milliToYuan(trialBalanceMilli(repos, w.id)) : 0,
      };
    });
    return { ok: true, workspaces };
  });
  app.post('/api/admin/trial-grants', async (req) => {
    const ctx = requireAdmin(req);
    const body = trialGrantSchema.parse(req.body ?? {});
    const ws = repos.getWorkspace(body.workspaceId);
    if (!ws) fail(ErrorCode.NOT_FOUND, '空间不存在', 404);
    const trial = repos.getTrialApi();
    if (!trial) {
      fail(ErrorCode.VALIDATION, '平台体验 API 未配置（先经 POST /api/admin/trial-api 配置体验 API）');
    }
    // §8.1 口径：小额（单笔 ≤ ¥10）、一次性、不可续发叠加
    if (body.amountYuan > TRIAL_GRANT_MAX_YUAN) {
      fail(ErrorCode.VALIDATION, `体验额度单笔上限 ¥${TRIAL_GRANT_MAX_YUAN}（小额冷启动口径，§8.1）`);
    }
    if (repos.trialGrantedSum(trial!.id, body.workspaceId) > 0) {
      fail(
        ErrorCode.VALIDATION,
        '该空间已发放过体验额度：体验额度一次性发放、不可续发叠加（§8.1）；继续使用请空间自备 API Key',
      );
    }
    repos.insertPurchase(trial!.id, yuanToMilli(body.amountYuan), body.workspaceId, 'trial_grant');
    audit(req, ctx, 'trial_grant', 'workspace', body.workspaceId, `发放体验额度 ${body.amountYuan} 元`);
    return {
      ok: true,
      trialRemainingYuan: milliToYuan(trialBalanceMilli(repos, body.workspaceId)),
    };
  });
  app.get('/api/admin/trial-api', async (req) => {
    requireAdmin(req);
    const trial = repos.getTrialApi();
    if (!trial) return { ok: true, api: null };
    const key = decryptKey(trial.api_key_enc);
    return {
      ok: true,
      api: {
        id: trial.id,
        name: trial.name,
        provider: trial.provider,
        baseUrl: trial.base_url,
        model: trial.model,
        pricePerM: milliToYuan(trial.price_per_m_milli),
        apiKeyMasked: maskKey(key),
        hasKey: !!key,
      },
    };
  });
  /** 平台体验 API 维护口径：平台级行（workspace_id=NULL、is_trial=1），管理员经此口配置 Key */
  app.post('/api/admin/trial-api', async (req) => {
    const ctx = requireAdmin(req);
    const { api: b } = trialApiSaveSchema.parse(req.body ?? {});
    let row = repos.getTrialApi();
    if (!row) {
      row = {
        id: uid('api'),
        name: b.name,
        provider: b.provider,
        base_url: b.baseUrl,
        api_key_enc: '',
        model: b.model,
        price_per_m_milli: yuanToMilli(b.pricePerM),
        created_at: nowIso(),
        workspace_id: null,
        is_trial: 1,
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
    audit(req, ctx, 'save_trial_api', 'api', row.id, row.name);
    return { ok: true, id: row.id };
  });
  app.get('/api/admin/industry-packs', async (req) => {
    requireAdmin(req);
    return { ok: true, packs: repos.listIndustryPacks(false).map(packDto) };
  });
  app.post('/api/admin/industry-packs', async (req) => {
    const ctx = requireAdmin(req);
    const { pack: b } = industryPackSaveSchema.parse(req.body ?? {});
    const ts = nowIso();
    const existing = b.id ? repos.getIndustryPack(b.id) : repos.getIndustryPack(b.industry);
    if (existing) {
      const next: IndustryPackRow = {
        ...existing,
        industry: b.industry,
        name: b.name,
        version: b.version,
        description: b.description,
        author: b.author,
        status: b.status,
        content: JSON.stringify(b.content),
        updated_at: ts,
      };
      repos.updateIndustryPack(next);
      registerPackExtensions(repos, next);
      audit(req, ctx, 'update_industry_pack', 'industry_pack', next.id);
      return { ok: true, id: next.id };
    }
    const row: IndustryPackRow = {
      id: b.id ?? uid('pack'),
      industry: b.industry,
      name: b.name,
      version: b.version,
      description: b.description,
      author: b.author,
      status: b.status,
      content: JSON.stringify(b.content),
      created_at: ts,
      updated_at: ts,
    };
    // manifest 结构校验：content 至少含 teams 数组（可为空）
    void parseManifest(row);
    repos.insertIndustryPack(row);
    registerPackExtensions(repos, row);
    audit(req, ctx, 'create_industry_pack', 'industry_pack', row.id);
    return { ok: true, id: row.id };
  });

  /* ================= M7 路由组（skill 系统 / 交付闭环 / 渠道适配器） ================= */
  registerM7Routes(app, { repos, logger }, { auth, wsAuth, requireAdmin, audit });
}
