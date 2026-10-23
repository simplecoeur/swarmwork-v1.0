// 与 server.js 的 /api/state 返回结构一一对应
export interface ApiItem {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  pricePerM: number;
  balanceYuan: number;
  apiKeyMasked: string;
  hasKey: boolean;
  overdrawn: boolean;
}

export interface Team {
  id: string;
  name: string;
  color: string;
  apiId: string | null;
}

export interface Member {
  id: string;
  teamId: string;
  role: string;
  name: string;
  prompt: string;
}

export interface ReviewStandards {
  points: string;
  clientNeeds: string;
}

export interface Params {
  concurrency: number;
  taskBudgetTokens: number;
}

export interface Task {
  id: string;
  title: string;
  type: string;
  brief: string;
  teamId: string;
  assigneeId: string | null;
  status: string; // 待领取 / 执行中 / 待审核 / 被打回 / 待裁决 / 已完成
  result: string;
  reviewNote: string;
  rejectReason: string;
  rejectCount: number;
  blockedReason: string;
  totalTokens: number;
  totalCost: number;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
}

export interface LedgerEntry {
  ts: string;
  taskId: string;
  teamId: string;
  apiId: string;
  stage: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costYuan: number;
}

export interface Purchase {
  ts: string;
  apiId: string;
  amountYuan: number;
}

export interface AppState {
  apis: ApiItem[];
  defaultApiId: string | null;
  teams: Team[];
  members: Member[];
  reviewStandards: ReviewStandards;
  params: Params;
  tasks: Task[];
  ledger: LedgerEntry[];
  purchases: Purchase[];
}

export type Presets = Record<string, { baseUrl: string; model: string }>;

export type TabKey = 'office' | 'cost' | 'settings';
