import { z } from 'zod';
import { KB_SCOPES, PROVIDERS } from '@swarm/shared';

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
