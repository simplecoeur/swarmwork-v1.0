import { z } from 'zod';
import { API_TOKEN_SCOPES, IMPORT_LIMITS, KB_SCOPES, PROVIDERS } from '@swarm/shared';

/** 入参 zod 校验（设计 §7：校验失败不进 domain） */
export const apiSaveSchema = z.object({
  api: z.object({
    id: z.string().optional(),
    name: z.string().trim().min(1, '名称必填'),
    provider: z.enum(PROVIDERS).default('custom'),
    baseUrl: z.string().default(''),
    model: z.string().default(''),
    pricePerM: z.number().min(0).default(0),
    apiKey: z.string().optional(),
    clearKey: z.boolean().optional(),
  }),
});

export const apiDeleteSchema = z.object({ id: z.string().min(1) });

export const defaultApiSchema = z.object({ apiId: z.string().nullable() });

export const reviewStandardsSchema = z.object({
  points: z.string().default(''),
  clientNeeds: z.string().default(''),
});

export const paramsSchema = z.object({
  concurrency: z.number().int().min(1),
  taskBudgetTokens: z.number().int().min(0),
});

export const teamSaveSchema = z.object({
  team: z.object({
    id: z.string().optional(),
    name: z.string().trim().min(1, '组名必填'),
    color: z.string().default('#5b8def'),
    apiId: z.string().nullable().optional(),
  }),
});

export const teamDeleteSchema = z.object({ id: z.string().min(1) });

export const memberPromptSchema = z.object({
  memberId: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  prompt: z.string().default(''),
});

/** 成员新建/编辑（M5）：与 apis/teams 的 save 风格一致，外层包 member 对象。role 为注册表 role_id（M6 起放宽为任意字符串，存在性在路由层查注册表） */
export const memberSaveSchema = z.object({
  member: z.object({
    id: z.string().optional(),
    name: z.string().trim().min(1, '名字必填'),
    role: z.string().trim().min(1, '工种必填'),
    teamId: z.string().min(1, '必须指定所属小组'),
    prompt: z.string().default(''),
  }),
});

export const memberDeleteSchema = z.object({ id: z.string().min(1) });

/** API 测试连接（M5）：给已存 id（用库里配置与 Key）或一条完整配置（表单未保存值，apiKey 留空且有 id 时回退已存 Key） */
export const apiTestSchema = z.object({
  id: z.string().min(1).optional(),
  api: z
    .object({
      provider: z.enum(PROVIDERS).default('custom'),
      baseUrl: z.string().default(''),
      model: z.string().default(''),
      apiKey: z.string().optional(),
    })
    .optional(),
});

/** 资产引用（M8 §11.4，发单/skill 发单共用） */
export const assetRefSchema = z.object({
  assetId: z.string().min(1),
  sections: z.array(z.string()).optional(),
});

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1, '标题必填'),
  /** 任务类型为注册表 type_id（M6 起放宽为任意字符串，存在性在路由层查注册表） */
  type: z.string().trim().min(1).default('文案'),
  brief: z.string().default(''),
  /** 参考资料文本（链接/附件说明，P1）：非空时以【参考资料】段拼入 brief */
  references: z.string().optional(),
  /** 资产引用（M8 §11.4）：发单时按资产当前版本落快照 */
  assetRefs: z.array(assetRefSchema).optional(),
  teamId: z.string().min(1),
  projectId: z.string().nullable().optional(),
  idempotencyKey: z.string().min(1).optional(),
  skillId: z.string().nullable().optional(),
  skillVersion: z.number().int().nullable().optional(),
});

/** 批量发单（P1：一行一单）：items 为标题行数组，共用 type/team/brief 后缀与参考资料 */
export const taskBatchSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1, '标题必填'),
        brief: z.string().optional(),
      }),
    )
    .min(1, '至少一行标题')
    .max(100, '单次批量最多 100 单'),
  type: z.string().trim().min(1).default('文案'),
  briefSuffix: z.string().default(''),
  references: z.string().optional(),
  /** 资产引用（M8 §11.4）：批量各单共用同一组引用，逐单发单时按当前版本落快照 */
  assetRefs: z.array(assetRefSchema).optional(),
  teamId: z.string().min(1),
  projectId: z.string().nullable().optional(),
});

export const adjudicateSchema = z.object({ taskId: z.string().min(1) });

export const purchaseSchema = z.object({
  apiId: z.string().min(1),
  amountYuan: z.number().positive('金额必须大于 0'),
});

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1, '项目名必填'),
  brief: z.string().default(''),
  teamId: z.string().min(1),
  clientName: z.string().default(''),
});

export const kbCreateSchema = z.object({
  title: z.string().trim().min(1, '标题必填'),
  body: z.string().default(''),
  scope: z.enum(KB_SCOPES).default('company'),
  scopeId: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

/** 局部更新：未传字段保持不变（scope 与 scopeId 的一致性在路由层按合并后取值校验） */
export const kbUpdateSchema = z.object({
  title: z.string().trim().min(1, '标题必填').optional(),
  body: z.string().optional(),
  scope: z.enum(KB_SCOPES).optional(),
  scopeId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

/* ---------- M6 账号/空间/注册表/管理台 ---------- */

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('邮箱格式不正确'),
  password: z.string().min(8, '密码至少 8 位'),
  displayName: z.string().trim().min(1, '显示名必填'),
  industryPackId: z.string().nullable().optional(),
  workspaceName: z.string().trim().min(1).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('邮箱格式不正确'),
  password: z.string().min(1, '密码必填'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '当前密码必填'),
  newPassword: z.string().min(8, '新密码至少 8 位'),
});

export const switchWorkspaceSchema = z.object({
  workspaceId: z.string().min(1),
});

export const workspaceCreateSchema = z.object({
  name: z.string().trim().min(1, '空间名必填'),
  industryPackId: z.string().nullable().optional(),
});

export const registryRoleSchema = z.object({
  role: z.object({
    name: z.string().trim().min(1, '工种名必填'),
    roleId: z.string().trim().min(1).optional(),
    personaTemplate: z.string().default(''),
    color: z.string().default(''),
    icon: z.string().default(''),
  }),
});

export const registryTaskTypeSchema = z.object({
  taskType: z.object({
    name: z.string().trim().min(1, '类型名必填'),
    typeId: z.string().trim().min(1).optional(),
    roleId: z.string().trim().min(1, '必须指定派给哪个工种'),
  }),
});

export const preferencesPutSchema = z.object({
  key: z.string().min(1).optional(),
  value: z.unknown().optional(),
  values: z.record(z.string(), z.unknown()).optional(),
});

export const trialGrantSchema = z.object({
  workspaceId: z.string().min(1),
  amountYuan: z.number().positive('金额必须大于 0'),
});

export const industryPackSaveSchema = z.object({
  pack: z.object({
    id: z.string().optional(),
    industry: z.string().trim().min(1, '行业代码必填'),
    name: z.string().trim().min(1, '包名必填'),
    version: z.string().default('1.0.0'),
    description: z.string().default(''),
    author: z.string().default('platform'),
    status: z.enum(['draft', 'published', 'offline']).default('published'),
    content: z.record(z.string(), z.unknown()).default({}),
  }),
});

export const trialApiSaveSchema = z.object({
  api: z.object({
    name: z.string().trim().min(1, '名称必填'),
    provider: z.enum(PROVIDERS).default('custom'),
    baseUrl: z.string().default(''),
    model: z.string().default(''),
    pricePerM: z.number().min(0).default(0),
    apiKey: z.string().optional(),
    clearKey: z.boolean().optional(),
  }),
});

/* ---------- M7 skill / 交付 / 渠道 ---------- */

export const skillInputFieldSchema = z.object({
  key: z.string().trim().min(1, '参数 key 必填'),
  label: z.string().default(''),
  type: z.enum(['text', 'textarea', 'select', 'number', 'checkbox']).default('text'),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
});

export const skillSaveSchema = z.object({
  skill: z.object({
    id: z.string().optional(),
    slug: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1, '名称必填'),
    description: z.string().default(''),
    role: z.string().trim().min(1, '适用工种必填'),
    promptTemplate: z.string().default(''),
    inputSchema: z.array(skillInputFieldSchema).default([]),
    kbBinding: z
      .object({
        scopes: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        entryIds: z.array(z.string()).optional(),
      })
      .default({}),
    outputSpec: z.string().default(''),
    exampleInput: z.record(z.string(), z.unknown()).default({}),
    exampleOutput: z.string().default(''),
    changelog: z.string().default(''),
    visibility: z.enum(['private', 'workspace']).optional(),
  }),
});

export const skillDispatchSchema = z.object({
  params: z.record(z.string(), z.unknown()).default({}),
  teamId: z.string().min(1, '必须指定小组'),
  projectId: z.string().nullable().optional(),
  title: z.string().trim().min(1).optional(),
  /** 资产引用（M8 §11.4） */
  assetRefs: z.array(assetRefSchema).optional(),
});

export const skillTestRunSchema = z.object({
  params: z.record(z.string(), z.unknown()).optional(),
  teamId: z.string().min(1, '必须指定小组'),
});

export const skillInstallSchema = z.object({
  upgrade: z.boolean().default(false),
});

export const deliveryCreateSchema = z.object({
  scope: z.enum(['task', 'project']),
  taskId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  title: z.string().trim().min(1).optional(),
  password: z.string().min(4, '口令至少 4 位').optional(),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
});

/** 参观链接创建（G-13）：有效期/口令口径与交付页 deliveryCreateSchema 同组字段 */
export const visitLinkCreateSchema = z.object({
  password: z.string().min(4, '口令至少 4 位').optional(),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
});

export const channelBindSchema = z.object({
  channelType: z.string().trim().min(1).default('mj'),
  baseUrl: z.string().trim().min(1, '渠道地址必填'),
  token: z.string().optional(),
  clearToken: z.boolean().optional(),
  account: z.string().optional(),
});

export const channelPushSchema = z.object({
  channelType: z.string().trim().min(1).default('mj'),
  taskId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
});

/* ---------- M8 资产 / 飞轮 / 流水线 / 提醒 ---------- */

export const assetSaveSchema = z.object({
  asset: z.object({
    id: z.string().optional(),
    typeId: z.string().trim().min(1, '资产类型必填'),
    name: z.string().trim().min(1, '资产名必填'),
    content: z
      .object({
        summary: z.string().optional(),
        sections: z
          .array(
            z.object({
              key: z.string().trim().min(1),
              title: z.string().default(''),
              body: z.string().default(''),
            }),
          )
          .default([]),
      })
      .default({ sections: [] }),
  }),
});

export const assetTypeSaveSchema = z.object({
  assetType: z.object({
    typeId: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1, '类型名必填'),
    structureSchema: z.record(z.string(), z.unknown()).default({}),
  }),
});

export const outcomeSchema = z.object({
  verdict: z.enum(['effective', 'ineffective']),
  metrics: z.record(z.string(), z.number()).default({}),
  note: z.string().default(''),
});

export const sedimentSchema = z.object({
  target: z.enum(['kb', 'skill']),
  note: z.string().default(''),
});

export const redispatchSchema = z.object({
  teamId: z.string().min(1).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  title: z.string().trim().min(1).optional(),
});

export const pipelineRunSchema = z.object({
  templateId: z.string().min(1),
  teamId: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const notifyConfigSchema = z.object({
  emailEnabled: z.boolean().default(false),
  email: z.string().default(''),
});

/* ---------- G-05 反馈 / G-08 成本设置（v1.2.0） ---------- */

export const feedbackCreateSchema = z.object({
  category: z.enum(['bug', 'suggestion', 'question', 'other']).default('other'),
  content: z.string().trim().min(1, '反馈内容必填').max(2000, '反馈内容最长 2000 字'),
  contact: z.string().trim().max(200).optional(),
});

export const feedbackHandleSchema = z.object({
  adminNote: z.string().trim().max(1000).optional(),
});

/** 低余额阈值设置：以元提交（null = 清除显式设置，回落默认口径：最近一笔采购额/体验发放额的 20%） */
export const costSettingsSchema = z.object({
  lowBalanceThresholdYuan: z.number().min(0).nullable(),
});

/* ---------- G-06 文件导入 confirm（preview 走 multipart，不经 zod） ---------- */

/**
 * KB 导入 confirm：drafts 上限 500 在此整体校验（超限 VALIDATION 且零落库）；
 * 单条 title/body 不在此设 min —— 逐条走创建路径校验、逐条回成败（见 v120 路由）。
 */
export const kbImportConfirmSchema = z.object({
  filename: z.string().max(300).optional(),
  scope: z.enum(KB_SCOPES).default('company'),
  scopeId: z.string().nullable().optional(),
  drafts: z
    .array(
      z.object({
        title: z.string().default(''),
        body: z.string().default(''),
        tags: z.array(z.string()).default([]),
      }),
    )
    .min(1, '没有可导入的条目草案')
    .max(IMPORT_LIMITS.MAX_KB_DRAFTS, 'KB 单次导入最多 500 条，请拆分文件分批导入'),
});

/* ---------- G-07 开放 API / Webhook（v1.2.0 批次二） ---------- */

export const apiTokenCreateSchema = z.object({
  name: z.string().trim().min(1, 'Token 名称必填').max(100),
  scopes: z
    .array(z.enum(API_TOKEN_SCOPES))
    .min(1, '至少选择一个权限')
    .default(['dispatch', 'read']),
});

/** Webhook 可订阅事件：三类终态事件（test 为系统试投递事件，不开放订阅） */
const subscribableEventSchema = z.enum(['task.done', 'task.adjudication', 'task.failed']);

export const webhookCreateSchema = z.object({
  url: z.string().trim().min(1, 'Webhook URL 必填').max(2000),
  secret: z.string().trim().max(500).optional(),
  events: z
    .array(subscribableEventSchema)
    .min(1, '至少订阅一个事件')
    .default(['task.done']),
  enabled: z.boolean().default(true),
});

/** Webhook 更新（启停/改址/改订阅）：未传字段保持不变 */
export const webhookUpdateSchema = z.object({
  url: z.string().trim().min(1, 'Webhook URL 必填').max(2000).optional(),
  secret: z.string().trim().max(500).optional(),
  clearSecret: z.boolean().optional(),
  events: z.array(subscribableEventSchema).min(1, '至少订阅一个事件').optional(),
  enabled: z.boolean().optional(),
});

/** 开放面发单（POST /api/open/tasks）：与页面发单 taskCreateSchema 同口径，另加可选 skillId 透传 */
export const openTaskCreateSchema = taskCreateSchema.extend({
  skillParams: z.record(z.string(), z.unknown()).optional(),
});

/* ---------- G-15 空间所有权转让（v1.2.0 批次二接口先行） ---------- */

export const workspaceTransferSchema = z.object({
  targetUserId: z.string().min(1, '必须指定接收人'),
  password: z.string().min(1, '密码必填（转让须验密确认）'),
});

/* ---------- G-10 定时任务（v1.2.0 批次二） ---------- */

const scheduleTimeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/, '时间须为 HH:MM 格式');

export const scheduleCreateSchema = z.object({
  kind: z.enum(['skill', 'pipeline', 'task']),
  skillId: z.string().min(1).nullable().optional(),
  pipelineTemplateId: z.string().min(1).nullable().optional(),
  teamId: z.string().min(1, '必须指定小组'),
  title: z.string().trim().max(200).default(''),
  brief: z.string().default(''),
  type: z.string().trim().min(1).default('文案'),
  params: z.record(z.string(), z.unknown()).default({}),
  assetRefs: z.array(assetRefSchema).optional(),
  freq: z.enum(['daily', 'weekly']),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  timeLocal: scheduleTimeSchema,
  timezone: z.string().trim().min(1).default('Asia/Shanghai'),
  enabled: z.boolean().default(true),
});

/** 计划更新：未传字段保持不变；改目标/参数时路由层按合并后取值重新走建单校验 */
export const scheduleUpdateSchema = z.object({
  kind: z.enum(['skill', 'pipeline', 'task']).optional(),
  skillId: z.string().min(1).nullable().optional(),
  pipelineTemplateId: z.string().min(1).nullable().optional(),
  teamId: z.string().min(1).optional(),
  title: z.string().trim().max(200).optional(),
  brief: z.string().optional(),
  type: z.string().trim().min(1).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  assetRefs: z.array(assetRefSchema).optional(),
  freq: z.enum(['daily', 'weekly']).optional(),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  timeLocal: scheduleTimeSchema.optional(),
  timezone: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
});

/* ---------- G-11 账号设置（v1.2.0 批次二） ---------- */

export const accountProfileSchema = z.object({
  displayName: z.string().trim().min(1, '显示名必填').max(50),
});

export const deleteRequestSchema = z.object({
  password: z.string().min(1, '密码必填（注销须验密确认）'),
});

/* ---------- G-09 全局搜索（v1.2.0 批次二）：q 必填，types 为逗号分隔过滤（路由层解析） ---------- */

/** 资产导入 confirm：sections 上限 200 整体校验（超限 VALIDATION 且零落库）；资产为单行创建，字段在此收紧 */
export const assetImportConfirmSchema = z.object({
  filename: z.string().max(300).optional(),
  name: z.string().trim().min(1, '资产名必填'),
  typeId: z.string().trim().min(1, '资产类型必填'),
  summary: z.string().default(''),
  sections: z
    .array(
      z.object({
        key: z.string().trim().min(1, '分段 key 必填'),
        title: z.string().default(''),
        body: z.string().default(''),
      }),
    )
    .min(1, '没有可导入的分段草案')
    .max(IMPORT_LIMITS.MAX_ASSET_SECTIONS, '资产单次导入最多 200 个分段，请拆分文件分批导入'),
});
