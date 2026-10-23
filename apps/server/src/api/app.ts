import Fastify, { type FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import * as fs from 'fs';
import { ErrorCode } from '@swarm/shared';
import { ZodError } from 'zod';
import { DomainError } from '../domain/taskService';
import type { Logger } from '../logger';
import { registerRoutes, type ApiDeps } from './routes';

/** Fastify 应用工厂：路由 + 静态托管 + 统一错误结构（设计 §7） */
export async function buildApp(deps: ApiDeps, staticDir: string, logger: Logger): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        ok: false,
        error: { code: ErrorCode.VALIDATION, message: err.issues.map((i) => i.message).join('；') || '入参校验失败' },
      });
    }
    if (err instanceof DomainError) {
      return reply.status(400).send({ ok: false, error: { code: err.code, message: err.message } });
    }
    const e = err as Error & { code?: string; statusCode?: number };
    if (typeof e.code === 'string' && typeof e.statusCode === 'number') {
      return reply.status(e.statusCode).send({ ok: false, error: { code: e.code, message: e.message } });
    }
    logger.error('api', `未处理异常：${e.message}`);
    return reply.status(500).send({ ok: false, error: { code: ErrorCode.INTERNAL, message: e.message } });
  });

  // 文件上传（G-06 导入）：插件上限放宽到 16MB 以便路由层对 5MB 业务上限回统一的 VALIDATION
  // 并说明（见 domain/importService 与 IMPORT_LIMITS）；单请求只收 1 个文件。
  await app.register(fastifyMultipart, {
    limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 16 },
  });

  registerRoutes(app, deps);

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ ok: false, error: { code: ErrorCode.NOT_FOUND, message: '未知接口' } });
    }
    return reply.status(404).send('Not Found');
  });

  if (fs.existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir, prefix: '/' });
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/html');
      return '<!doctype html><html><head><meta charset="utf-8"><title>干活蜂群</title></head><body>前端尚未构建（npm run build -w @swarm/web）</body></html>';
    });
  }
  return app;
}
