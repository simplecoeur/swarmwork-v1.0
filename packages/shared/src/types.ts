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

/** v1.4.0 I：像素小人发型枚举（代码绘制分支，见 web PixelOffice） */
export type HairStyle = 'short' | 'long' | 'bald' | 'bun';

/**
 * v1.4.0 I：成员外观定制（全部字段可缺省；整体为 null = 未定制，走自动推导）。
 * skin 须为画布 SKINS 5 档之一；shirt/hairColor 为 #rrggbb；hairStyle 为 HairStyle 枚举。
 */
export interface MemberAppearance {
  skin?: string;
  shirt?: string;
  hairColor?: string;
  hairStyle?: HairStyle;
}

export interface MemberDto {
  id: string;
  teamId: string;
  role: Role;
  name: string;
  prompt: string;
  /** v1.4.0 H：成员级绑定的 API id；null = 跟随小组/空间默认 */
  apiId: string | null;
  /** v1.4.0 I：外观定制；null = 未定制（自动推导） */
  appearance: MemberAppearance | null;
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
  /** v1.4.0 H：成员级 API 绑定；undefined = 不改，null = 清除（跟随小组） */
  apiId?: string | null;
  /** v1.4.0 I：外观定制；undefined = 不改，null = 清除（回自动推导） */
  appearance?: MemberAppearance | null;
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
  /** skill 发单时的参数快照（M7 §5.1：一键再发/改参数再发的数据来源） */
  skillParams?: Record<string, unknown>;
  /** 是否 skill 试运行单（M7 §7.3：照常记账，任务上单列标记） */
  isSkillTest?: boolean;
  /** 本单实际注入的资产引用（M8 §11.4：资产 id@版本号，可追溯到版本） */
  injectedAssets?: string[];
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

/** G-02 能力货架：成员能力卡（数据来自 members 行 + 工种注册表名） */
export interface CapabilityMemberDto {
  memberId: string;
  name: string;
  /** 工种 id（members.role） */
  role: string;
  /** 工种显示名（注册表 roles 的 name，查不到时回退 role id） */
  roleName: string;
  skillTags: string[];
  /** 人设首行（persona 第一行） */
  personaFirstLine: string;
  teamId: string;
  /** v1.4.0 H：成员级绑定的 API id（名册模型徽标用）；null = 跟随小组/默认 */
  apiId: string | null;
}

/**
 * G-02 能力货架：官方 skill 推荐位（平台库 published 前 6，含本空间安装状态）。
 * 衔接口径：无行业包的空间只出已装项（§12.5 不选包开局零行业词不变）。
 */
export interface CapabilitySkillDto {
  skillId: string;
  name: string;
  description: string;
  role: string;
  installed: boolean;
  installedCopyId: string | null;
}

/** G-02：GET /api/state 的 capabilities 摘要段（办公室能力货架数据源，不新建查询通道） */
export interface CapabilitiesDto {
  members: CapabilityMemberDto[];
  recommendedSkills: CapabilitySkillDto[];
}

export interface StateDto {
  /** 当前会话空间（M6 多租户） */
  workspace?: { id: string; name: string };
  /** G-02 能力摘要段（成员能力卡 + 官方 skill 推荐位） */
  capabilities?: CapabilitiesDto;
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
  /** G-08 人话用量摘要（余额/单均成本/约可跑单数/日均燃烧/约可用天数） */
  summary?: CostSummaryDto;
}

/* ---------- M6 多用户平台 DTO ---------- */

export interface AuthUserDto {
  id: string;
  email: string;
  displayName: string;
  status: string;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
  /** G-11：头像地址（无头像为 null，读取端回占位图）；注销冷静期到期时刻（非冷静期为 null） */
  avatarUrl?: string | null;
  deletionAt?: string | null;
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

/* ---------- M7 skill 系统 DTO（方案 §7） ---------- */

export interface SkillInputFieldDto {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number' | 'checkbox';
  required: boolean;
  default?: string | number | boolean;
  options?: string[];
  placeholder?: string;
}

export interface SkillKbBindingDto {
  scopes?: string[];
  tags?: string[];
  entryIds?: string[];
}

export type SkillStatus = 'draft' | 'published' | 'archived';
export type SkillVisibility = 'private' | 'workspace' | 'public' | 'pending_review';

export interface SkillDto {
  id: string;
  slug: string;
  /** user 个人 / workspace 空间 / platform 平台官方 */
  ownerType: string;
  workspaceId: string | null;
  name: string;
  description: string;
  role: string;
  promptTemplate: string;
  inputSchema: SkillInputFieldDto[];
  kbBinding: SkillKbBindingDto;
  outputSpec: string;
  exampleInput: Record<string, unknown>;
  exampleOutput: string;
  version: number;
  changelog: string;
  status: SkillStatus;
  visibility: SkillVisibility;
  sourceSkillId: string | null;
  sourceVersion: number | null;
  installCount: number;
  /** v1.3.0 生态：官方精选标记（仅用户上架 skill 可被管理员晋升）与晋升时间 */
  featured: boolean;
  featuredAt: string | null;
  /** v1.3.0 生态：公开署名来源快照（上架审核通过时落定；源用户/空间注销后仍保留）。
   * 官方自研 skill 为 null（以 ownerType='platform' + 「官方」标区分）。 */
  contributorName: string | null;
  contributorWorkspaceName: string | null;
  /** v1.3.0 生态：上架（审核通过）时间；「最新动态」公示口径 */
  listedAt: string | null;
  /** 快照来源有新版（源 version > 本副本 source_version） */
  hasNewerSource: boolean;
  /** 飞轮沉淀的已验证做法备注（M8 追加，渲染时拼入 brief） */
  verifiedNotes: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** v1.3.0 任务模板（A3）：官方/行业模板 workspaceId 为 null；个人模板仅本空间可见 */
export interface TaskTemplateDto {
  id: string;
  workspaceId: string | null;
  /** official 平台官方 / industry 行业包 / workspace 本空间自建 */
  scope: 'official' | 'industry' | 'workspace';
  industryPackId: string | null;
  name: string;
  /** 建议任务类型（注册表 typeId；套用时若当前空间无此类型则不预填类型） */
  typeId: string;
  /** 说明骨架，可含 {{占位}} */
  briefTemplate: string;
  /** 建议工种（展示提示，不参与派单） */
  suggestedRole: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** v1.3.0 生态公示（B3）：平台库「最新动态」条目 */
export interface SkillActivityItemDto {
  skillId: string;
  name: string;
  kind: 'listed' | 'featured';
  contributorName: string | null;
  contributorWorkspaceName: string | null;
  at: string;
}

/** 只读交付页（§11.2）：管理视图（token 明文仅创建时返回一次）。
 * G-13 起同一 DTO 兼表参观链接：kind='visit' 时 scope='workspace'、taskId/projectId 为 null。 */
export interface DeliveryLinkDto {
  id: string;
  kind: 'delivery' | 'visit';
  scope: 'task' | 'project' | 'workspace';
  taskId: string | null;
  projectId: string | null;
  title: string;
  hasPassword: boolean;
  expiresAt: string | null;
  revoked: boolean;
  viewCount: number;
  createdAt: string;
  /** 仅创建响应里带完整访问路径（含明文 token），之后不再返回 */
  path?: string;
}

/** 渠道推送记录（§11.2/§12.4） */
export interface ChannelPushDto {
  id: number;
  channelType: string;
  taskId: string | null;
  projectId: string | null;
  status: string;
  remoteRef: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}

/* ---------- M8 资产 / 飞轮 / 流水线 / 提醒 DTO ---------- */

export interface AssetSectionDto {
  key: string;
  title: string;
  body: string;
}

export interface AssetContentDto {
  summary?: string;
  sections: AssetSectionDto[];
}

export interface AssetDto {
  id: string;
  typeId: string;
  name: string;
  version: number;
  content: AssetContentDto;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetTypeDto {
  typeId: string;
  name: string;
  structureSchema: Record<string, unknown>;
  industry: string | null;
  packId: string | null;
  workspaceId: string | null;
}

export interface OutcomeMarkDto {
  id: number;
  taskId: string;
  verdict: 'effective' | 'ineffective';
  metrics: Record<string, number>;
  note: string;
  createdBy: string | null;
  createdAt: string;
}

export interface NotificationDto {
  id: number;
  type: string;
  title: string;
  body: string;
  taskId: string | null;
  readAt: string | null;
  createdAt: string;
}

/* ---------- G-06 知识 / 资产文件导入（两段式：先预览后落库） ---------- */

/** KB 导入条目草案（preview 返回、confirm 入参共用）：tags 已解析为数组 */
export interface KbImportDraftDto {
  title: string;
  body: string;
  tags: string[];
}

/** POST /api/kb/import/preview 响应体（只解析、不落库） */
export interface KbImportPreviewDto {
  filename: string;
  drafts: KbImportDraftDto[];
}

/** POST /api/kb/import/confirm 入参：逐条走现有 KB 创建路径，scope/scopeId 口径与手建一致 */
export interface KbImportConfirmDto {
  filename?: string;
  scope: KbScope;
  scopeId?: string | null;
  drafts: KbImportDraftDto[];
}

/** KB 导入 confirm 的逐条结果（失败条目带原因，其余条目照常落库） */
export interface KbImportItemResultDto {
  index: number;
  title: string;
  ok: boolean;
  id?: string;
  error?: string;
}

/** POST /api/assets/import/preview 响应体：name 由文件名去扩展名推导，可在 confirm 时改 */
export interface AssetImportPreviewDto {
  filename: string;
  name: string;
  sections: AssetSectionDto[];
}

/** POST /api/assets/import/confirm 入参：走现有资产创建路径（生成资产 + v1 版本快照） */
export interface AssetImportConfirmDto {
  filename?: string;
  name: string;
  typeId: string;
  summary?: string;
  sections: AssetSectionDto[];
}

/* ---------- G-02 / G-03 用户偏好（user_preferences，GET/PUT /api/preferences） ---------- */

/**
 * G-02 新手引导进度（偏好 key = `onboarding`，值为按空间 id 分键的对象，实现用户 × 空间维度）：
 * step = 当前步（0 认识团队 / 1 试跑一单 / 2 查看成果 / 3 已完成）；skipped = 已跳过（不再展示三步卡）；
 * doneAt = 完成时间（未完成为 null）。帮助页可重置（删该空间键或 step 回 0）重新走引导。
 */
export interface OnboardingDto {
  step: number;
  skipped: boolean;
  doneAt: string | null;
}

/**
 * G-03 通知偏好（偏好 key = `notifyPrefs`）：inapp 为站内逐类型开关（缺省全开）。
 * mail 字段仅预留位（邮件通道暂缓，notifyConfig.mailChannel='reserved-not-implemented'），
 * 本版 UI 不展示邮件开关、分发时 mail channel 未启用即跳过。
 */
export interface NotifyPrefsDto {
  inapp: { [type: string]: boolean };
  mail?: { [type: string]: boolean };
}

/** G-03 通知类型全集（既有 4 类 + v1.2.0 扩展 5 类；新类型的触发点在各自 G 条目内注册） */
export const NOTIFICATION_TYPES = [
  'adjudication',
  'balance',
  'trial_exhausted',
  'reject_max',
  'balance_low',
  'schedule_result',
  'webhook_failed',
  'impersonation',
  'transfer',
] as const;
export type NotificationTypeName = (typeof NOTIFICATION_TYPES)[number];

/* ---------- G-05 帮助与反馈 ---------- */

export type FeedbackCategory = 'bug' | 'suggestion' | 'question' | 'other';
export type FeedbackStatus = 'open' | 'handled';

export interface FeedbackDto {
  id: number;
  userId: string;
  workspaceId: string | null;
  category: FeedbackCategory;
  content: string;
  contact: string | null;
  status: FeedbackStatus;
  adminNote: string | null;
  createdAt: string;
  handledAt: string | null;
}

/* ---------- G-08 用量预估与人话摘要 ---------- */

/** GET /api/cost/estimate：近 30 天 ledger 按任务聚合的同类成本分布（金额双口径：厘 + 元） */
export interface CostEstimateDto {
  avgMilli: number;
  p25Milli: number;
  p75Milli: number;
  avgYuan: number;
  p25Yuan: number;
  p75Yuan: number;
  sampleCount: number;
  /** 退级链：同 skill（样本 ≥5）→ 同 type（样本 ≥5）→ 全空间均值 → 无历史 */
  basis: 'skill' | 'type' | 'workspace' | 'none';
}

/** G-08：GET /api/cost/report 的 summary 段（全部由 purchases/ledger 推导，不新增统计表） */
export interface CostSummaryDto {
  /** 自有余额合计（各空间自有 API 的 Σpurchases − Σledger，厘） */
  balanceMilli: number;
  balanceYuan: number;
  /** 体验额度余额（厘） */
  trialBalanceMilli: number;
  trialBalanceYuan: number;
  /** 近 30 天单均成本（厘/单，无历史为 0） */
  avgCostPerTaskMilli: number;
  avgCostPerTaskYuan: number;
  /** 约可跑单数 = floor((自有余额 + 体验余额) / 单均成本)；无单均成本时为 null */
  approxTasksRemaining: number | null;
  /** 近 30 天日均燃烧（厘/天） */
  burnPerDayMilli: number;
  burnPerDayYuan: number;
  /** 约可用天数 = floor((自有余额 + 体验余额) / 日均燃烧)；无燃烧时为 null */
  approxDaysRemaining: number | null;
}

export interface PipelineTemplateDto {
  id: string;
  name: string;
  industry: string | null;
  description: string;
  commonParams: Array<{ key: string; label: string; required: boolean }>;
  steps: Array<{ skillSlug: string; title: string; available: boolean }>;
}

/* ---------- G-04 任务过程时间线（v1.2.0） ---------- */

/**
 * 任务步骤类型：plan 计划（建单/拆单落位）/ split 拆单 / inject 注入组装 /
 * execute 执行调用 / review 审核调用 / retry 打回重做 / blocked 停工 /
 * recovered 失联回收 / adjudicated 裁决相关。步骤为只读投影 + 旁路记录，不参与状态机。
 */
export type TaskStepKind =
  | 'plan'
  | 'split'
  | 'inject'
  | 'execute'
  | 'review'
  | 'retry'
  | 'blocked'
  | 'recovered'
  | 'adjudicated';

export interface TaskStepDto {
  id: number;
  /** 归属任务 id；拆单步的 taskId 为项目 id（与拆单账本行同口径），子任务上另有 split 副本步 */
  taskId: string;
  /** 同一 taskId 内的步序（1 起） */
  seq: number;
  kind: TaskStepKind;
  actorMemberId: string | null;
  summary: string;
  /** 结构化细节：注入步含 kb/assets 命中名单（名称，用户语言）、审核步含 pass/reason 要点摘要等 */
  detail: Record<string, unknown>;
  /** 调用幂等键（Provider 步 = 网关 idempotencyKey），同 (taskId, callKey) 唯一 */
  callKey: string;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** 本步成本（厘，与 ledger 对应行同源同值；非调用步为 0） */
  costMilli: number;
  costYuan: number;
  createdAt: string;
}

/** task_events 状态流水（时间线的辅助轨） */
export interface TaskTimelineEventDto {
  id: number;
  fromStatus: string | null;
  toStatus: string;
  actorType: string;
  actorId: string | null;
  note: string;
  createdAt: string;
}

/** GET /api/tasks/:id/timeline 响应体（steps 为主、events 为辅，各自按时间升序） */
export interface TaskTimelineDto {
  steps: TaskStepDto[];
  events: TaskTimelineEventDto[];
}

/* ---------- G-07 对外开放 API + Webhook（v1.2.0） ---------- */

/** API Token 列表行（掩码口径：只出 prefix，明文永不回显） */
export interface ApiTokenDto {
  id: string;
  name: string;
  /** 明文 Token 前 8 位（展示/识别用） */
  tokenPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** POST /api/tokens 创建响应：token 明文字段仅此一次出现，之后任何接口都不再返回 */
export interface ApiTokenCreatedDto extends ApiTokenDto {
  token: string;
}

/** POST /api/tokens 入参 */
export interface ApiTokenCreateDto {
  name: string;
  scopes?: string[];
}

/** Webhook 列表行：secret 只回掩码，明文永不出接口 */
export interface WebhookDto {
  id: string;
  url: string;
  secretMasked: string;
  hasSecret: boolean;
  events: string[];
  enabled: boolean;
  createdAt: string;
}

/** POST /api/webhooks 入参（secret 留空 = 服务端生成） */
export interface WebhookCreateDto {
  url: string;
  secret?: string;
  events?: string[];
  enabled?: boolean;
}

/** Webhook 投递记录行 */
export interface WebhookDeliveryDto {
  id: number;
  webhookId: string;
  event: string;
  taskId: string | null;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
}

/** 开放面发单入参（POST /api/open/tasks）：与页面发单同一口径（title/type/brief/references/assetRefs/teamId） */
export interface OpenTaskCreateDto {
  title: string;
  type: string;
  brief?: string;
  references?: string;
  assetRefs?: Array<{ assetId: string; sections?: string[] }>;
  teamId: string;
  projectId?: string | null;
  idempotencyKey?: string;
}

/** 开放面任务视图（GET /api/open/tasks/:id）：状态 + 基本信息 + 用量（金额为元） */
export interface OpenTaskDto {
  id: string;
  title: string;
  type: string;
  status: string;
  teamId: string;
  projectId: string | null;
  skillId: string | null;
  /** 来源标记：api = 经开放 API 发单（页面发单为 web） */
  source: string;
  totalTokens: number;
  totalCostYuan: number;
  createdAt: string;
  finishedAt: string | null;
}

/** 开放面成果视图（GET /api/open/tasks/:id/result）：done 后取成果全文 + 用量 */
export interface OpenTaskResultDto extends OpenTaskDto {
  result: string;
  reviewNote: string;
}

/* ---------- G-09 全局搜索（v1.2.0） ---------- */

export interface SearchResultItemDto {
  type: 'task' | 'result' | 'kb' | 'asset' | 'skill' | 'project';
  id: string;
  title: string;
  /** 摘要片段；资产类恒不含正文（只出名称与 section 标题，见 searchService 可见性口径） */
  snippet: string;
  updatedAt: string;
}

/** GET /api/search 响应：按类分组（每类 ≤10）+ 同内容的平铺列表（分组顺序即 SEARCH_TYPES） */
export interface SearchResponseDto {
  groups: Array<{ type: SearchResultItemDto['type']; items: SearchResultItemDto[] }>;
  results: SearchResultItemDto[];
}

/* ---------- G-14 管理员代入查看（v1.2.0 批次三） ---------- */

/**
 * 管理员代入态（sessions.impersonation JSON 的线缆形，迁移 014）：
 * 平台管理员代入某空间只读查看期间，GET /api/auth/me 顶层带本对象（非代入为 null），
 * 前端据此挂红色横幅；写接口被全局守卫回 403 IMPERSONATION_READ_ONLY（见 §8 隐私口径：
 * 代入强制留痕 audit + 所有者站内通知 impersonation 即时知情）。
 */
export interface ImpersonationDto {
  adminUserId: string;
  adminEmail: string;
  workspaceId: string;
  workspaceName: string;
  ownerUserId: string;
  ownerEmail: string;
  startedAt: string;
}

/** 渠道类型（G-17 起注册表两家：MJ 直推 / 通用 Webhook 生态足点） */
export const CHANNEL_TYPES = ['mj', 'generic_webhook'] as const;
export type ChannelTypeName = (typeof CHANNEL_TYPES)[number];

/**
 * 通用 Webhook 渠道配置（G-17，存 settings.channels.generic_webhook，secret 加密口径同 MJ）：
 * 线缆形只回掩码与绑定状态，明文 secret 永不出接口（与 MJ token 同口径）。
 */
export interface GenericWebhookChannelDto {
  type: 'generic_webhook';
  name: string;
  url: string;
  secretMasked: string;
  hasSecret: boolean;
  events: string[];
  bound: boolean;
  /** 通用 Webhook 不做数据回流：fetchMetrics 恒 unsupported，UI 据此显示「该渠道不支持数据回流」 */
  supportsMetrics: boolean;
}

/* ---------- G-15 空间所有权转让（v1.2.0 批次二接口先行，页面留批次三） ---------- */

/** POST /api/workspaces/:id/transfer 入参：所有者本人操作 + 验密二次确认 */
export interface WorkspaceTransferDto {
  targetUserId: string;
  password: string;
}

/* ---------- G-10 定时任务（v1.2.0 批次二） ---------- */

export type ScheduleKind = 'skill' | 'pipeline' | 'task';
export type ScheduleFreq = 'daily' | 'weekly';
/** 一次计划的执行结果：已发单 / 被守卫拦截（如零余额）/ 发单失败（目标失效等） */
export type ScheduleLastResult = 'dispatched' | 'blocked' | 'failed';

/**
 * 定时计划（schedules）：到点按与手动完全相同的路径发单（skill dispatch / runPipeline / createOneTask）。
 * params 为发单参数快照（skill 参数 / 流水线公共参数；资产引用在 params.assetRefs 内同存）。
 * nextRunAt 为服务端按 timezone 计算的 UTC 时刻；计划仅在平台运行期间生效。
 */
export interface ScheduleDto {
  id: string;
  kind: ScheduleKind;
  skillId: string | null;
  pipelineTemplateId: string | null;
  teamId: string;
  title: string;
  brief: string;
  type: string;
  params: Record<string, unknown>;
  freq: ScheduleFreq;
  /** 0-6（0=周日），仅 weekly 用 */
  weekday: number | null;
  /** 当地时间 HH:MM */
  timeLocal: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastTaskId: string | null;
  lastResult: ScheduleLastResult | null;
  createdAt: string;
  updatedAt: string;
}

/* ---------- G-11 账号设置（v1.2.0 批次二；邮箱验证小块暂缓） ---------- */

/** GET /api/account 资料聚合：基本资料 + 名下空间清单 + 邮箱验证状态位（暂缓口径） */
export interface AccountDto {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  isPlatformAdmin: boolean;
  /** 邮箱验证：随 G-01 邮件通道暂缓，本版恒 false 且只展示占位文案，不做假状态/假按钮 */
  emailVerified: boolean;
  emailVerificationNote: string;
  deletionAt: string | null;
  workspaces: Array<{ id: string; name: string; role: string }>;
}

/** GET /api/auth/sessions 的活跃会话行：id 为会话行 id 的掩码前缀（吊销接口以此定位本人会话） */
export interface AuthSessionDto {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string;
  userAgent: string;
  isCurrent: boolean;
}

/** POST /api/schedules 入参（assetRefs 与手动发单同口径，服务端并入 params 快照） */
export interface ScheduleCreateDto {
  kind: ScheduleKind;
  skillId?: string | null;
  pipelineTemplateId?: string | null;
  teamId: string;
  title?: string;
  brief?: string;
  type?: string;
  params?: Record<string, unknown>;
  assetRefs?: Array<{ assetId: string; sections?: string[] }>;
  freq: ScheduleFreq;
  weekday?: number | null;
  timeLocal: string;
  timezone?: string;
  enabled?: boolean;
}
