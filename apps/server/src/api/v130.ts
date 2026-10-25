import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ErrorCode,
  type SkillActivityItemDto,
  type TaskTemplateDto,
} from '@swarm/shared';
import { notifyUser } from '../domain/notify';
import type { Logger } from '../logger';
import type { Repos, TemplateRow } from '../store/repositories';
import { nowIso, uid } from '../util';
import { contributorOf, skillDto } from './m7';
import type { M7Helpers } from './m7';
import { skillFeatureSchema, templateCreateSchema } from './schemas';
import { styleTemplateDto } from './v130style';

function fail(code: string, message: string, status = 400): never {
  throw Object.assign(new Error(message), { code, statusCode: status });
}

/* ---------- DTO ---------- */
function templateDto(r: TemplateRow): TaskTemplateDto {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    scope: r.scope as TaskTemplateDto['scope'],
    industryPackId: r.industry_pack_id,
    name: r.name,
    typeId: r.type_id,
    briefTemplate: r.brief_template,
    suggestedRole: r.suggested_role,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * v1.3.0 路由组：
 * - A3 任务模板：GET/POST /api/templates、POST /api/templates/from-task/:taskId、DELETE /api/templates/:id
 *   （另注册 /api/task-templates* 别名，与前端 api.ts 的既有调用口径对齐，处理函数同一套）。
 * - B 精选与公示：POST /api/admin/skills/:id/feature、GET /api/skills/activity。
 */
export function registerV130Routes(
  app: FastifyInstance,
  deps: { repos: Repos; logger: Logger; dataDir: string },
  helpers: M7Helpers,
): void {
  const { repos, logger } = deps;
  const { wsAuth, requireAdmin, audit } = helpers;

  /* ================= A3 任务模板 ================= */
  const listTemplates = async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const packId = repos.getWorkspace(ctx.workspaceId)?.industry_pack_id ?? null;
    return { ok: true, templates: repos.listVisibleTemplates(ctx.workspaceId, packId).map(templateDto) };
  };
  app.get('/api/templates', listTemplates);
  app.get('/api/task-templates', listTemplates);

  const createTemplate = async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const body = templateCreateSchema.parse(req.body ?? {});
    const ts = nowIso();
    const row: TemplateRow = {
      id: uid('tpl'),
      workspace_id: ctx.workspaceId,
      scope: 'workspace',
      industry_pack_id: null,
      name: body.name,
      type_id: body.typeId,
      brief_template: body.briefTemplate,
      suggested_role: body.suggestedRole,
      created_by: ctx.user.id,
      created_at: ts,
      updated_at: ts,
    };
    repos.insertTemplate(row);
    audit(req, ctx, 'create_task_template', 'task_template', row.id, row.name);
    return { ok: true, id: row.id, template: templateDto(row) };
  };
  app.post('/api/templates', createTemplate);
  app.post('/api/task-templates', createTemplate);

  const createTemplateFromTask = (taskId: string, req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const task = repos.getTask(taskId, ctx.workspaceId);
    if (!task) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
    const ts = nowIso();
    const row: TemplateRow = {
      id: uid('tpl'),
      workspace_id: ctx.workspaceId,
      scope: 'workspace',
      industry_pack_id: null,
      name: task!.title,
      type_id: task!.type,
      brief_template: task!.brief,
      suggested_role: '',
      created_by: ctx.user.id,
      created_at: ts,
      updated_at: ts,
    };
    repos.insertTemplate(row);
    audit(req, ctx, 'create_task_template_from_task', 'task_template', row.id, `源任务 ${task!.id}`);
    return { ok: true, id: row.id, template: templateDto(row) };
  };
  app.post('/api/templates/from-task/:taskId', async (req) => {
    const { taskId } = req.params as { taskId: string };
    return createTemplateFromTask(taskId, req);
  });
  app.post('/api/task-templates/from-task', async (req) => {
    const body = (req.body ?? {}) as { taskId?: string };
    if (!body.taskId) fail(ErrorCode.VALIDATION, '需要提供 taskId');
    return createTemplateFromTask(body.taskId!, req);
  });

  const deleteTemplate = async (req: FastifyRequest) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const row = repos.getTemplate(id);
    // 仅本空间自建模板可删：官方/行业/他人空间模板一律 404（不泄漏存在性）
    if (!row || row.scope !== 'workspace' || row.workspace_id !== ctx.workspaceId) {
      fail(ErrorCode.NOT_FOUND, '模板不存在', 404);
    }
    repos.deleteTemplate(id);
    audit(req, ctx, 'delete_task_template', 'task_template', id, row!.name);
    return { ok: true };
  };
  app.delete('/api/templates/:id', deleteTemplate);
  app.delete('/api/task-templates/:id', deleteTemplate);

  /* ================= B 精选与公示 ================= */
  app.post('/api/admin/skills/:id/feature', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = skillFeatureSchema.parse(req.body ?? {});
    const cur = repos.getSkill(id);
    if (!cur) fail(ErrorCode.NOT_FOUND, 'skill 不存在', 404);
    if (cur!.owner_type !== 'workspace' || cur!.visibility !== 'public') {
      fail(ErrorCode.VALIDATION, '仅已上架的用户 skill 可设精选');
    }
    const was = cur!.featured === 1;
    if (was === body.featured) {
      // 幂等：状态无变化直接返回，不重复写库/通知
      return { ok: true, skill: skillDto(repos, cur!) };
    }
    const next = {
      ...cur!,
      featured: body.featured ? 1 : 0,
      featured_at: body.featured ? nowIso() : null,
      updated_at: nowIso(),
    };
    repos.updateSkill(next);
    audit(
      req,
      ctx,
      body.featured ? 'admin_feature_skill' : 'admin_unfeature_skill',
      'skill',
      id,
      cur!.name,
    );
    if (cur!.created_by && cur!.workspace_id) {
      notifyUser(
        repos,
        cur!.created_by,
        cur!.workspace_id,
        body.featured ? 'skill_featured' : 'skill_unfeatured',
        body.featured ? '你的 skill 被选为官方精选' : '你的 skill 已取消官方精选',
        body.featured
          ? `skill「${cur!.name}」已被平台选为官方精选，将在平台库精选位展示。`
          : `skill「${cur!.name}」已被取消官方精选标记。`,
      );
    }
    logger.info('skill', `管理员${body.featured ? '精选' : '取消精选'} skill ${id}（${cur!.name}）`);
    return { ok: true, skill: skillDto(repos, next) };
  });

  /* ================= F 补点：管理员风格模板待审列表（DTO 与一期 library 同口径） ================= */
  app.get('/api/admin/style-templates/pending', async (req) => {
    requireAdmin(req);
    const templates = repos.listPendingStyleTemplates().map(styleTemplateDto);
    return { ok: true, templates };
  });

  app.get('/api/skills/activity', async (req) => {
    wsAuth(req);
    const items: SkillActivityItemDto[] = [];
    for (const s of repos.listLibrarySkills()) {
      if (s.owner_type !== 'workspace' || s.visibility !== 'public') continue;
      const c = contributorOf(repos, s);
      items.push({
        skillId: s.id,
        name: s.name,
        kind: 'listed',
        contributorName: c.name,
        contributorWorkspaceName: c.workspaceName,
        at: s.listed_at ?? s.updated_at,
      });
      if (s.featured_at) {
        items.push({
          skillId: s.id,
          name: s.name,
          kind: 'featured',
          contributorName: c.name,
          contributorWorkspaceName: c.workspaceName,
          at: s.featured_at,
        });
      }
    }
    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const top = items.slice(0, 10);
    // activity 为前端 api.ts 的既有读取字段名，与 items 同内容双发
    return { ok: true, items: top, activity: top };
  });

}
