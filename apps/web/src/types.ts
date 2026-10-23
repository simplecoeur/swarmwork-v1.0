// 前端类型统一引用 @swarm/shared 契约（设计 §7 契约优先；M2 偏差 #4 留办，M3 落实）。
// 此处只做别名映射，保持各组件既有引用名不变；DTO 的唯一事实来源在 packages/shared。
import type {
  ApiDto,
  AuthUserDto,
  IndustryPackDto,
  KbEntryDto,
  LedgerEntryDto,
  MemberDto,
  ParamsDto,
  ProjectDto,
  PurchaseDto,
  RegistryRoleDto,
  RegistryTaskTypeDto,
  ReviewStandardsDto,
  StateDto,
  TaskDto,
  TeamDto,
  WorkspaceDto,
} from '@swarm/shared';

export type ApiItem = ApiDto;
export type Team = TeamDto;
export type Member = MemberDto;
export type ReviewStandards = ReviewStandardsDto;
export type Params = ParamsDto;
export type Task = TaskDto;
export type Project = ProjectDto;
export type LedgerEntry = LedgerEntryDto;
export type Purchase = PurchaseDto;
export type KbEntry = KbEntryDto;
export type AppState = StateDto;

/* ---------- M6 多用户：直接沿用 shared DTO ---------- */
export type AuthUser = AuthUserDto;
export type Workspace = WorkspaceDto;
export type RegistryRole = RegistryRoleDto;
export type RegistryTaskType = RegistryTaskTypeDto;
export type IndustryPack = IndustryPackDto;

/* ---------- 管理台聚合 DTO（后端 admin 路由现拼，无 shared 对应，本地定义） ---------- */
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
  workspaceCount: number;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminWorkspace {
  id: string;
  name: string;
  ownerUserId: string;
  ownerEmail: string;
  status: string;
  industryPackId: string | null;
  taskCount: number;
  totalCostYuan: number;
  totalTokens: number;
  balanceYuan: number;
  trialGrantedYuan: number;
  trialRemainingYuan: number;
}

export interface TrialApi {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  pricePerM: number;
  apiKeyMasked: string;
  hasKey: boolean;
}

export type Presets = Record<string, { baseUrl: string; model: string }>;

export type TabKey = 'office' | 'cost' | 'settings' | 'kb' | 'admin';
