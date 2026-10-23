import { z } from 'zod';
import { PROVIDERS, TASK_TYPES } from '@swarm/shared';

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

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1, '标题必填'),
  type: z.enum(TASK_TYPES).default('文案'),
  brief: z.string().default(''),
  teamId: z.string().min(1),
  projectId: z.string().nullable().optional(),
  idempotencyKey: z.string().min(1).optional(),
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
  scope: z.enum(['company', 'team']).default('company'),
  teamId: z.string().nullable().optional(),
  ownerMemberId: z.string().nullable().optional(),
  kind: z.enum(['提示词', '资料', '成果', '标准']).default('资料'),
  title: z.string().trim().min(1, '标题必填'),
  content: z.string().default(''),
  tags: z.array(z.string()).default([]),
});
