import * as fs from 'fs';
import * as path from 'path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AVATAR_LIMITS, ErrorCode } from '@swarm/shared';
import { AVATAR_EXT_TO_MIME, AVATAR_MIME_TO_EXT } from '../domain/accountService';
import {
  DEFAULT_OFFICE_STYLE,
  normalizeOfficeStyle,
  styleImageFileIds,
  type OfficeStyleConfig,
} from '../domain/officeStyle';
import type { Logger } from '../logger';
import type { Repos, StyleTemplateRow } from '../store/repositories';
import { nowIso, uid } from '../util';
import type { M7Helpers } from './m7';
import {
  officeStyleSchema,
  styleTemplateCreateSchema,
  styleTemplateRejectSchema,
} from './schemas';

function fail(code: string, message: string, status = 400): never {
  throw Object.assign(new Error(message), { code, statusCode: status });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

export interface StyleTemplateDto {
  id: string;
  name: string;
  /** platform 官方 / workspace 空间模板（前端三级口径的 scope 投影） */
  scope: 'platform' | 'workspace';
  ownerType: string;
  workspaceId: string | null;
  visibility: string;
  config: OfficeStyleConfig;
  /** config 的同义别名（前端 OfficeStyleTemplate.style 字段口径） */
  style: OfficeStyleConfig;
  applyCount: number;
  contributorName: string | null;
  contributorWorkspaceName: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function styleTemplateDto(r: StyleTemplateRow): StyleTemplateDto {
  const config = normalizeOfficeStyle(safeParse(r.config));
  return {
    id: r.id,
    name: r.name,
    scope: r.owner_type === 'platform' ? 'platform' : 'workspace',
    ownerType: r.owner_type,
    workspaceId: r.workspace_id,
    visibility: r.visibility,
    config,
    style: config,
    applyCount: r.apply_count,
    contributorName: r.contributor_name,
    contributorWorkspaceName: r.contributor_workspace_name,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ---------- 风格图片文件登记（落盘 DATA_DIR/style-images/ + index.json 登记归属空间） ---------- */
interface StyleImageRecord {
  workspaceId: string;
  fileName: string;
  mime: string;
}

function styleImagesDir(dataDir: string): string {
  return path.join(dataDir, 'style-images');
}
function styleImageIndexPath(dataDir: string): string {
  return path.join(styleImagesDir(dataDir), 'index.json');
}
function readStyleImageIndex(dataDir: string): Record<string, StyleImageRecord> {
  try {
    const v = JSON.parse(fs.readFileSync(styleImageIndexPath(dataDir), 'utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, StyleImageRecord>) : {};
  } catch {
    return {};
  }
}
function writeStyleImageIndex(dataDir: string, idx: Record<string, StyleImageRecord>): void {
  fs.mkdirSync(styleImagesDir(dataDir), { recursive: true });
  fs.writeFileSync(styleImageIndexPath(dataDir), JSON.stringify(idx, null, 2));
}


/**
 * v1.3.0 F 办公室风格路由组：GET/PUT /api/office-style、POST/GET /api/style-images、
 * style-templates 全组（建/列表/提交审核/管理员审/套用），另注册
 * GET /api/office-style/templates 别名回合并列表，对齐前端调用口径。
 * 当前风格存 settings(key='officeStyle')；模板存 style_templates（迁移 016）。
 */
export function registerV130StyleRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; logger: Logger; dataDir: string },
  helpers: M7Helpers,
): void {
  const { repos, dataDir } = deps;
  const { wsAuth, requireAdmin, audit } = helpers;

  app.get('/api/office-style', async (req) => {
    const ctx = wsAuth(req);
    const raw = repos.getSetting<unknown>('officeStyle', null, ctx.workspaceId);
    const style = raw === null ? DEFAULT_OFFICE_STYLE : normalizeOfficeStyle(raw);
    return { ok: true, style };
  });

  app.put('/api/office-style', async (req) => {
    const ctx = wsAuth(req);
    const parsed = officeStyleSchema.parse(req.body ?? {});
    const raw = (parsed as { style?: OfficeStyleConfig }).style ?? parsed;
    const style = normalizeOfficeStyle(raw);
    repos.setSetting('officeStyle', style, ctx.workspaceId);
    audit(req, ctx, 'update_office_style', 'settings', 'officeStyle');
    return { ok: true, style };
  });

  /** 风格图片上传：与头像同一套口径（@fastify/multipart 单文件、MIME 白名单、≤ AVATAR_LIMITS 上限） */
  app.post('/api/style-images', async (req) => {
    const ctx = wsAuth(req);
    const data = await req.file();
    if (!data) fail(ErrorCode.VALIDATION, '请选择要上传的图片', 400);
    const ext = AVATAR_MIME_TO_EXT[data!.mimetype];
    if (!ext) {
      fail(
        ErrorCode.VALIDATION,
        `只支持图片（PNG/JPEG/WebP/GIF），当前类型：${data!.mimetype || '未知'}`,
        400,
      );
    }
    const buffer = await data!.toBuffer();
    if (buffer.length === 0) fail(ErrorCode.VALIDATION, '图片文件为空', 400);
    if (buffer.length > AVATAR_LIMITS.MAX_BYTES) {
      fail(ErrorCode.VALIDATION, '图片不能超过 2MB', 400);
    }
    const fileId = uid('styleimg');
    const fileName = `${fileId}.${ext}`;
    fs.mkdirSync(styleImagesDir(dataDir), { recursive: true });
    fs.writeFileSync(path.join(styleImagesDir(dataDir), fileName), buffer);
    const idx = readStyleImageIndex(dataDir);
    idx[fileId] = { workspaceId: ctx.workspaceId, fileName, mime: data!.mimetype };
    writeStyleImageIndex(dataDir, idx);
    audit(req, ctx, 'upload_style_image', 'style_image', fileId, fileName);
    return { ok: true, fileId, url: `/api/style-images/${fileId}` };
  });

  /**
   * 风格图片读取（登录态）。可见性规则：
   * - 文件属当前空间 → 可读；
   * - 文件被某个 visibility='public' 的 style_template 的 config 引用（poster/sign）→ 可读
   *   （含官方 platform 模板——其 visibility 恒 public）；
   * - 其余一律 404。注意：未过审（pending_review）/私有模板引用的图片不公示，
   *   模板 config 可以原样进 library 列表，但图片本体仍按本规则把关。
   */
  app.get('/api/style-images/:fileId', async (req, reply: FastifyReply) => {
    const ctx = wsAuth(req);
    const { fileId } = req.params as { fileId: string };
    const rec = readStyleImageIndex(dataDir)[fileId];
    if (!rec) {
      reply.status(404);
      return { ok: false, error: { code: ErrorCode.NOT_FOUND, message: '图片不存在' } };
    }
    let visible = rec!.workspaceId === ctx.workspaceId;
    if (!visible) {
      for (const t of repos.listPublicStyleTemplates()) {
        if (t.visibility !== 'public' && t.owner_type !== 'platform') continue;
        if (styleImageFileIds(normalizeOfficeStyle(safeParse(t.config))).includes(fileId)) {
          visible = true;
          break;
        }
      }
    }
    const full = path.join(styleImagesDir(dataDir), path.basename(rec!.fileName));
    if (!visible || !fs.existsSync(full)) {
      reply.status(404);
      return { ok: false, error: { code: ErrorCode.NOT_FOUND, message: '图片不存在' } };
    }
    const ext = rec!.fileName.split('.').pop() ?? 'png';
    reply.header('cache-control', 'no-cache');
    reply.type(AVATAR_EXT_TO_MIME[ext] ?? rec!.mime ?? 'application/octet-stream');
    return reply.send(fs.readFileSync(full));
  });

  /* ----- 风格模板 ----- */
  const getOwnStyleTemplateOr404 = (ctx: { workspaceId: string }, id: string): StyleTemplateRow => {
    const row = repos.getStyleTemplate(id);
    if (!row || row.workspace_id !== ctx.workspaceId) {
      fail(ErrorCode.NOT_FOUND, '风格模板不存在', 404);
    }
    return row!;
  };

  app.post('/api/style-templates', async (req) => {
    const ctx = wsAuth(req);
    const body = styleTemplateCreateSchema.parse(req.body ?? {});
    const config = normalizeOfficeStyle(body.config);
    const ws = repos.getWorkspace(ctx.workspaceId);
    const ts = nowIso();
    const row: StyleTemplateRow = {
      id: uid('styletpl'),
      workspace_id: ctx.workspaceId,
      owner_type: 'workspace',
      name: body.name,
      config: JSON.stringify(config),
      visibility: 'private',
      apply_count: 0,
      // 署名快照当场落定（进平台库公示口径，与 skill approve 快照一致）
      contributor_name: ctx.user.display_name,
      contributor_workspace_name: ws?.name ?? '',
      created_by: ctx.user.id,
      created_at: ts,
      updated_at: ts,
    };
    repos.insertStyleTemplate(row);
    audit(req, ctx, 'create_style_template', 'style_template', row.id, row.name);
    return { ok: true, id: row.id, template: styleTemplateDto(row) };
  });

  app.get('/api/style-templates', async (req) => {
    const ctx = wsAuth(req);
    const mine = repos.listStyleTemplatesByWorkspace(ctx.workspaceId);
    const mineIds = new Set(mine.map((t) => t.id));
    const library = repos.listPublicStyleTemplates().filter((t) => !mineIds.has(t.id));
    return { ok: true, mine: mine.map(styleTemplateDto), library: library.map(styleTemplateDto) };
  });

  /** 前端既有调用口径别名：合并列表（mine + library）单数组返回 */
  app.get('/api/office-style/templates', async (req) => {
    const ctx = wsAuth(req);
    const mine = repos.listStyleTemplatesByWorkspace(ctx.workspaceId);
    const mineIds = new Set(mine.map((t) => t.id));
    const library = repos.listPublicStyleTemplates().filter((t) => !mineIds.has(t.id));
    return { ok: true, templates: [...mine, ...library].map(styleTemplateDto) };
  });

  app.post('/api/style-templates/:id/submit-review', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const row = getOwnStyleTemplateOr404(ctx, id);
    if (row.visibility === 'public') fail(ErrorCode.VALIDATION, '该模板已在平台库公开');
    if (row.visibility !== 'pending_review') {
      repos.updateStyleTemplate({ ...row, visibility: 'pending_review', updated_at: nowIso() });
      audit(req, ctx, 'submit_style_template_review', 'style_template', id, row.name);
    }
    return { ok: true };
  });

  app.post('/api/admin/style-templates/:id/approve', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const row = repos.getStyleTemplate(id);
    if (!row) fail(ErrorCode.NOT_FOUND, '风格模板不存在', 404);
    if (row!.visibility !== 'pending_review') fail(ErrorCode.VALIDATION, '该模板不在待审核状态');
    repos.updateStyleTemplate({ ...row!, visibility: 'public', updated_at: nowIso() });
    audit(req, ctx, 'admin_approve_style_template', 'style_template', id, row!.name);
    return { ok: true };
  });

  app.post('/api/admin/style-templates/:id/reject', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = styleTemplateRejectSchema.parse(req.body ?? {});
    const row = repos.getStyleTemplate(id);
    if (!row) fail(ErrorCode.NOT_FOUND, '风格模板不存在', 404);
    if (row!.visibility !== 'pending_review') fail(ErrorCode.VALIDATION, '该模板不在待审核状态');
    repos.updateStyleTemplate({ ...row!, visibility: 'workspace', updated_at: nowIso() });
    audit(req, ctx, 'admin_reject_style_template', 'style_template', id, body.reason);
    return { ok: true };
  });

  app.post('/api/style-templates/:id/apply', async (req) => {
    const ctx = wsAuth(req);
    const { id } = req.params as { id: string };
    const row = repos.getStyleTemplate(id);
    // 可见才可套用：本空间的 / platform 官方 / 已过审 public；其余 404 不泄漏存在性
    const visible =
      !!row &&
      (row.workspace_id === ctx.workspaceId || row.owner_type === 'platform' || row.visibility === 'public');
    if (!visible) fail(ErrorCode.NOT_FOUND, '风格模板不存在', 404);
    const config = normalizeOfficeStyle(safeParse(row!.config));
    repos.setSetting('officeStyle', config, ctx.workspaceId);
    repos.bumpStyleTemplateApplyCount(id);
    audit(req, ctx, 'apply_style_template', 'style_template', id, row!.name);
    return { ok: true, style: config };
  });
}
