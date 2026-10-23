import type { BlockedCode, ProjectStatus, TaskStatus } from './stateMachine';
import type { KbScope, LedgerStage, ProviderKind, Role, TaskType } from './constants';

/**
 * 线缆契约类型（设计 §7）。金额在线缆上一律以「元」为单位的 number 出现，
 * 服务端在边界处由厘换算（见 money.ts）；token 为整数。
 */

export interface ApiDto {
  id: string;
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  pricePerM: number;
  balanceYuan: number;
  apiKeyMasked: string;
  hasKey: boolean;
  overdrawn: boolean;
}

export interface TeamDto {
  id: string;
  name: string;
  color: string;
  apiId: string | null;
}

export interface MemberDto {
  id: string;
  teamId: string;
  role: Role;
  name: string;
  prompt: string;
}

export interface ReviewStandardsDto {
  points: string;
  clientNeeds: string;
}

/** 成员新建/编辑入参（M5，POST /api/members/save）：id 缺省 = 新建 */
export interface MemberSaveDto {
  id?: string;
  name: string;
  role: Role;
  teamId: string;
  prompt: string;
}

/** API 测试连接结果（M5，POST /api/apis/test）：不记账、不扣余额，仅连通性探活 */
export interface ApiTestResultDto {
  ok: boolean;
  latencyMs: number;
  message: string;
}

export interface ParamsDto {
  concurrency: number;
  taskBudgetTokens: number;
}

export interface TaskDto {
  id: string;
  projectId: string | null;
  title: string;
  type: TaskType;
  brief: string;
  teamId: string;
  assigneeId: string | null;
  status: TaskStatus;
  result: string;
  reviewNote: string;
  rejectReason: string;
  rejectCount: number;
  blockedReason: string;
  blockedCode: BlockedCode | null;
  /** 老板裁决通过的单独标注（§15.2 统计口径） */
  adjudicated: boolean;
  /** 本单实际注入的知识库条目 ids（注入审计，§10）；多次执行尝试取并集 */
  injectedKbIds: string[];
  /** 发单人（登录用户，M6）；存量/系统任务为 null */
  createdByUserId?: string | null;
  /** 引用的 skill（M7 落地，本轮仅数据位） */
  skillId?: string | null;
  skillVersion?: number | null;
  totalTokens: number;
  totalCost: number;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
}

export interface ProjectDto {
  id: string;
  name: string;
  brief: string;
  teamId: string;
  clientName: string;
  status: ProjectStatus;
  totalTokens: number;
  totalCost: number;
  createdAt: string;
}

export interface LedgerEntryDto {
  ts: string;
  taskId: string;
  teamId: string;
  apiId: string;
  stage: LedgerStage;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costYuan: number;
  estimated: boolean;
}

export interface PurchaseDto {
  ts: string;
  apiId: string;
  amountYuan: number;
  /** purchase 普通采购 / trial_grant 体验额度发放（M6） */
  type?: string;
}

export interface StateDto {
  /** 当前会话空间（M6 多租户） */
  workspace?: { id: string; name: string };
  apis: ApiDto[];
  defaultApiId: string | null;
  teams: TeamDto[];
  members: MemberDto[];
  reviewStandards: ReviewStandardsDto;
  params: ParamsDto;
  tasks: TaskDto[];
  projects: ProjectDto[];
  ledger: LedgerEntryDto[];
  purchases: PurchaseDto[];
}

/** 知识库条目（M3 一期，§10）：scope=company 全公司 / team 某小组 / member 某成员 */
export interface KbEntryDto {
  id: string;
  title: string;
  body: string;
  scope: KbScope;
  /** scope=team 时为小组 id，scope=member 时为成员 id，company 时为 null */
  scopeId: string | null;
  tags: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KbCreateDto {
  title: string;
  body?: string;
  scope: KbScope;
  scopeId?: string | null;
  tags?: string[];
  enabled?: boolean;
}

/** 更新为局部字段（未传的字段保持不变） */
export interface KbUpdateDto {
  title?: string;
  body?: string;
  scope?: KbScope;
  scopeId?: string | null;
  tags?: string[];
  enabled?: boolean;
}

/** 总经理汇报（GET /api/cost/report，§7/§15） */
export interface CostReportDto {
  generatedAt: string;
  totals: {
    totalTokens: number;
    totalCostYuan: number;
    doneTasks: number;
    avgTokensPerDone: number;
    estimatedTokens: number;
    /** 估算 token 占总 token 比例（§15.1 汇报单列） */
    estimatedShare: number;
  };
  byApi: Array<{
    apiId: string;
    name: string;
    calls: number;
    totalTokens: number;
    costYuan: number;
    balanceYuan: number;
    estimatedTokens: number;
    /** 按历史日均消耗估算的续航天数（无消耗记录时为 null） */
    runwayDays: number | null;
  }>;
  byTeam: Array<{ teamId: string; name: string; totalTokens: number; costYuan: number; done: number }>;
  byProject: Array<{
    projectId: string;
    name: string;
    status: ProjectStatus;
    totalTokens: number;
    costYuan: number;
  }>;
  priciestTask: { id: string; title: string; totalTokens: number; costYuan: number } | null;
  /** 裁决统计（§15.2）：单列待裁决与裁决通过数 */
  adjudication: { pending: number; passed: number };
  /** 按发单人（登录用户）维度聚合（M6 §8）；存量无发单人任务归入 userId=null */
  byUser?: Array<{ userId: string | null; totalTokens: number; costYuan: number; tasks: number }>;
}

/* ---------- M6 多用户平台 DTO ---------- */

export interface AuthUserDto {
  id: string;
  email: string;
  displayName: string;
  status: string;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
}

export interface WorkspaceDto {
  id: string;
  name: string;
  ownerUserId: string;
  status: string;
  industryPackId: string | null;
  role: string;
}

export interface RegistryRoleDto {
  roleId: string;
  name: string;
  personaTemplate: string;
  color: string;
  icon: string;
  industry: string | null;
  packId: string | null;
  workspaceId: string | null;
  isSystem: boolean;
}

export interface RegistryTaskTypeDto {
  typeId: string;
  name: string;
  roleId: string;
  industry: string | null;
  packId: string | null;
  workspaceId: string | null;
}

export interface IndustryPackDto {
  id: string;
  industry: string;
  name: string;
  version: string;
  description: string;
  author: string;
  status: string;
  /** 包 manifest（JSON）：company_template/kb_seeds/skill_slugs/role_extensions 等 */
  content: Record<string, unknown>;
}
