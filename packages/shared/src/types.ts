import type { BlockedCode, ProjectStatus, TaskStatus } from './stateMachine';
import type { LedgerStage, ProviderKind, Role, TaskType } from './constants';

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
}

export interface StateDto {
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

export interface KbEntryDto {
  id: string;
  scope: 'company' | 'team';
  teamId: string | null;
  ownerMemberId: string | null;
  kind: '提示词' | '资料' | '成果' | '标准';
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
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
}
