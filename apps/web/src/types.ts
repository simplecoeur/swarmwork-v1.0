// 前端类型统一引用 @swarm/shared 契约（设计 §7 契约优先；M2 偏差 #4 留办，M3 落实）。
// 此处只做别名映射，保持各组件既有引用名不变；DTO 的唯一事实来源在 packages/shared。
import type {
  ApiDto,
  ApiTokenCreatedDto,
  ApiTokenDto,
  AssetContentDto,
  AssetDto,
  AssetImportConfirmDto,
  AssetImportPreviewDto,
  AssetSectionDto,
  AssetTypeDto,
  AuthUserDto,
  CapabilitiesDto,
  ChannelPushDto,
  CostEstimateDto,
  CostSummaryDto,
  DeliveryLinkDto,
  FeedbackDto,
  IndustryPackDto,
  KbEntryDto,
  KbImportConfirmDto,
  KbImportDraftDto,
  KbImportPreviewDto,
  LedgerEntryDto,
  MemberDto,
  NotificationDto,
  NotifyPrefsDto,
  OnboardingDto,
  OutcomeMarkDto,
  ParamsDto,
  PipelineTemplateDto,
  ProjectDto,
  PurchaseDto,
  RegistryRoleDto,
  RegistryTaskTypeDto,
  ReviewStandardsDto,
  SearchResponseDto,
  SearchResultItemDto,
  SkillDto,
  SkillInputFieldDto,
  SkillKbBindingDto,
  StateDto,
  TaskDto,
  TaskStepDto,
  TaskTimelineDto,
  TeamDto,
  WebhookDeliveryDto,
  WebhookDto,
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

export type TabKey = 'office' | 'cost' | 'settings' | 'kb' | 'admin' | 'skills' | 'assets' | 'help' | 'search';

/* ---------- G-06 文件导入 ---------- */
export type KbImportDraft = KbImportDraftDto;
export type KbImportPreview = KbImportPreviewDto;
export type KbImportConfirm = KbImportConfirmDto;
export type AssetImportPreview = AssetImportPreviewDto;
export type AssetImportConfirm = AssetImportConfirmDto;

/* ---------- G-07/G-09（v1.2.0 批次二） ---------- */
export type ApiToken = ApiTokenDto;
export type ApiTokenCreated = ApiTokenCreatedDto;
export type WebhookItem = WebhookDto;
export type WebhookDelivery = WebhookDeliveryDto;
export type SearchItem = SearchResultItemDto;
export type SearchResponse = SearchResponseDto;

/* ---------- G-02/G-03/G-05/G-08（v1.2.0 批次一） ---------- */
export type Capabilities = CapabilitiesDto;
export type Onboarding = OnboardingDto;
export type NotifyPrefs = NotifyPrefsDto;
export type FeedbackItem = FeedbackDto;
export type CostEstimate = CostEstimateDto;
export type CostSummary = CostSummaryDto;

/* ---------- M7/M8：直接沿用 shared DTO ---------- */
export type Skill = SkillDto;
export type SkillInputField = SkillInputFieldDto;
export type SkillKbBinding = SkillKbBindingDto;
/** GET /api/skills 的行：shared DTO + 服务端拼的已安装副本 id */
export type SkillListItem = SkillDto & { installedCopyId: string | null };
export type Delivery = DeliveryLinkDto;
export type ChannelPush = ChannelPushDto;
export type Asset = AssetDto;
export type AssetType = AssetTypeDto;
export type AssetContent = AssetContentDto;
export type AssetSection = AssetSectionDto;
export type OutcomeMark = OutcomeMarkDto;
export type AppNotification = NotificationDto;
export type PipelineTemplate = PipelineTemplateDto;
/** G-04 任务过程时间线 */
export type TaskStep = TaskStepDto;
export type TaskTimelineData = TaskTimelineDto;

/** 资产引用（发单 / skill 发单共用，M8 §11.4） */
export interface AssetRef {
  assetId: string;
  sections?: string[];
}

/** GET /api/results 的行（后端 results 路由现拼） */
export interface ResultItem {
  taskId: string;
  title: string;
  type: string;
  projectId: string | null;
  skillId: string | null;
  skillVersion: number | null;
  result: string;
  totalTokens: number;
  totalCostYuan: number;
  finishedAt: string | null;
  mark: OutcomeMark | null;
}

/** GET /api/channels 的行 */
export interface ChannelInfo {
  type: string;
  name: string;
  baseUrl: string;
  account: string;
  hasToken: boolean;
  bound: boolean;
}

/** GET /api/ledger-view 的时间线行 */
export interface LedgerViewItem {
  ts: string;
  kind: 'task_event' | 'audit';
  taskId: string | null;
  text: string;
  actorType: string;
}
