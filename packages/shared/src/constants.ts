/** 集中常量（设计 §8、§9、§15.1/§15.2 拍板口径，禁止散落魔法数） */
export const TEMPERATURES = {
  /** 工人执行产出 */
  EXECUTION: 0.7,
  /** 审核判定（要稳定一致） */
  REVIEW: 0.1,
  /** 组长拆单 */
  SPLIT: 0.3,
} as const;

/** LLM 调用护栏（§8/§15.1） */
export const LLM_GUARD = {
  TIMEOUT_MS: 120_000,
  MAX_RETRIES: 2,
  RETRY_BASE_MS: 1_000,
  CIRCUIT_FAILURE_THRESHOLD: 3,
  CIRCUIT_OPEN_MS: 5 * 60_000,
} as const;

/** 引擎节奏（§9/§15.2） */
export const ENGINE = {
  TICK_MS: 1_000,
  HEARTBEAT_MS: 30_000,
  STALE_MS: 10 * 60_000,
} as const;

/**
 * 工种与任务类型（M6 起已退役为「注册表种子默认值」）：
 * 运行时工种/任务类型以服务端 roles/task_types 注册表为准（平台通用 + 行业包 + 空间自定义），
 * 本常量仅作注册表种子与前端占位使用，不再是封闭枚举。Role/TaskType 因此放宽为 string。
 */
export const ROLES = ['组长', '研究员', '文案', '程序员', '审核'] as const;
export type Role = string;

export const TASK_TYPES = ['文案', '调研', '代码'] as const;
export type TaskType = string;

export const TYPE_ROLE: Readonly<Record<string, string>> = {
  文案: '文案',
  调研: '研究员',
  代码: '程序员',
};

export const PROVIDERS = ['deepseek', 'openai', 'anthropic', 'tongyi', 'zhipu', 'custom'] as const;
export type ProviderKind = (typeof PROVIDERS)[number];

export const PROVIDER_PRESETS: Readonly<
  Record<ProviderKind, { baseUrl: string; model: string }>
> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  tongyi: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  custom: { baseUrl: '', model: '' },
};

/** 账本阶段 */
export const LEDGER_STAGES = ['执行', '审核', '重做'] as const;
export type LedgerStage = (typeof LEDGER_STAGES)[number];

/**
 * 知识库条目范围（M6 扩展）：company 空间级 / team 小组级 / personal 个人级（owner_user_id）/
 * platform 平台公共（workspace_id 为 NULL）。'member' 为 M3 旧值，迁移后折算为 personal，保留在枚举中兼容旧数据。
 */
export const KB_SCOPES = ['company', 'team', 'member', 'personal', 'platform'] as const;
export type KbScope = string;

/** 文件导入上限（G-06）：单文件字节数 / KB 单次条数 / 资产单次分段数；超限回 VALIDATION 且零落库 */
export const IMPORT_LIMITS = {
  MAX_FILE_BYTES: 5 * 1024 * 1024,
  MAX_KB_DRAFTS: 500,
  MAX_ASSET_SECTIONS: 200,
} as const;

/** 全量导出上限（G-16）：组装后 zip 超过此字节数回 VALIDATION，提示走管理员整库备份 */
export const EXPORT_LIMITS = {
  MAX_ZIP_BYTES: 50 * 1024 * 1024,
} as const;

/** 交付/参观链接种类（G-13）：delivery 交付页 | visit 办公室参观页（同一张 delivery_links 表） */
export const DELIVERY_LINK_KINDS = ['delivery', 'visit'] as const;
export type DeliveryLinkKind = (typeof DELIVERY_LINK_KINDS)[number];

/** 开放 API Token 权限位（G-07）：dispatch 发单 / read 查状态与成果 */
export const API_TOKEN_SCOPES = ['dispatch', 'read'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** Webhook 订阅事件（G-07）：任务终态外推（done/转裁决/终局失败）+ test 试投递事件 */
export const WEBHOOK_EVENTS = ['task.done', 'task.adjudication', 'task.failed', 'test'] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/** Webhook 投递重试口径（G-07）：总尝试 3 次，退避 1m/5m/15m（第 3 次失败即终败，后两档供后续扩展） */
export const WEBHOOK_DELIVERY = {
  MAX_ATTEMPTS: 3,
  RETRY_DELAYS_MS: [60_000, 300_000, 900_000],
  TIMEOUT_MS: 10_000,
} as const;

/** 头像（G-11）：单文件大小上限（服务端校验口径，客户端上传前另裁方缩到 256px） */
export const AVATAR_LIMITS = {
  MAX_BYTES: 2 * 1024 * 1024,
  CLIENT_SIZE_PX: 256,
} as const;
/** 注销冷静期（G-11）：申请后 7 天到期自动匿名化，冷静期内可撤销 */
export const ACCOUNT_DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** 定时任务调度（G-10）：进程内扫描间隔（与引擎 1s tick 分开，避免高频查表） */
export const SCHEDULE_SCAN_MS = 30_000;
/** 星期标签（下标 = weekday，0=周日，与 JS Date.getDay / Intl 口径一致） */
export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 全局搜索实体类型（G-09）：result = done 且 result 非空的 tasks 子集 */
export const SEARCH_TYPES = ['task', 'result', 'kb', 'asset', 'skill', 'talent', 'project'] as const;
export type SearchEntityType = (typeof SEARCH_TYPES)[number];

/** 搜索长文本匹配口径（G-09）：brief 前段与 result 仅匹配前 500 字，防长文本全表扫描失控 */
export const SEARCH_TEXT_LIMIT = 500;
/** 搜索每类结果上限（G-09） */
export const SEARCH_PER_TYPE_LIMIT = 10;

/** 知识库注入护栏（§10 + §15.1 上下文裁剪口径） */
export const KB_INJECTION = {
  /** 有单任务预算时：注入总量上限 = 剩余预算 × 此比例 */
  BUDGET_SHARE: 0.3,
  /** 无预算上限时的固定注入上限（token） */
  NO_BUDGET_CAP_TOKENS: 8_000,
} as const;
