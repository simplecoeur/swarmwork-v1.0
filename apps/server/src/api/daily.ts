import type { FastifyInstance } from 'fastify';
import { SCHEDULE_SCAN_MS } from '@swarm/shared';
import { runAgentMonthlyTick } from '../domain/agentSyncPipeline';
import { doCheckin, getCheckinStatus, runDailyTick } from '../domain/dailyService';
import {
  getDailySettings,
  mailStatusOf,
  saveDailySettings,
  type DailySettings,
} from '../domain/dailySettings';
import { workspaceTimezone, zonedDateStr } from '../domain/scheduleService';
import type { Logger } from '../logger';
import type { Repos } from '../store/repositories';
import type { M7Helpers } from './m7';
import { dailySettingsPutSchema } from './schemas';

/**
 * v1.3.0 G 路由组：每日设置 / 签到 / 晨报读取 + 每日调度 tick。
 * tick 与 G-10 定时任务共用同一启动路径口径（进程内 30s interval，SCHEDULE_SCAN_MS；
 * 测试可用 SWARM_SCHEDULE_TICK_MS 覆盖）；tick 本体是 domain/dailyService.runDailyTick，interval 只是壳。
 */
export function registerDailyRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; logger: Logger; dataDir: string },
  helpers: M7Helpers,
): void {
  const { repos, logger } = deps;
  const { wsAuth, audit } = helpers;

  app.get('/api/daily-settings', async (req) => {
    const ctx = wsAuth(req);
    return {
      ok: true,
      settings: {
        ...getDailySettings(repos, ctx.workspaceId),
        mailStatus: mailStatusOf(repos, ctx.workspaceId),
      },
    };
  });

  app.put('/api/daily-settings', async (req) => {
    const ctx = wsAuth(req);
    const body = dailySettingsPutSchema.parse(req.body ?? {});
    const patch: Partial<DailySettings> = { ...body };
    const next = saveDailySettings(repos, ctx.workspaceId, patch);
    audit(req, ctx, 'update_daily_settings', 'settings', 'dailySettings');
    return { ok: true, settings: { ...next, mailStatus: mailStatusOf(repos, ctx.workspaceId) } };
  });

  app.get('/api/checkin', async (req) => {
    const ctx = wsAuth(req);
    const s = getCheckinStatus(repos, ctx.user.id, ctx.workspaceId);
    return {
      ok: true,
      checkedToday: s.checkedToday,
      streak: s.streak,
      monthDays: s.monthDays,
      lastCheckinDate: s.lastCheckinDate,
    };
  });

  app.post('/api/checkin', async (req) => {
    const ctx = wsAuth(req);
    const { status, created } = doCheckin(repos, ctx.user.id, ctx.workspaceId);
    if (created) audit(req, ctx, 'daily_checkin', 'checkin', status.today, status.today);
    return {
      ok: true,
      created,
      checkedToday: status.checkedToday,
      streak: status.streak,
      monthDays: status.monthDays,
      lastCheckinDate: status.lastCheckinDate,
    };
  });

  app.get('/api/briefings/today', async (req) => {
    const ctx = wsAuth(req);
    const tz = workspaceTimezone(repos, ctx.workspaceId);
    const today = zonedDateStr(new Date(), tz);
    const row = repos.getBriefing(ctx.workspaceId, today);
    return {
      ok: true,
      briefing: row
        ? { id: row.id, date: row.date, contentMd: row.content_md, createdAt: row.created_at }
        : null,
    };
  });

  app.get('/api/briefings', async (req) => {
    const ctx = wsAuth(req);
    return {
      ok: true,
      briefings: repos
        .listBriefings(ctx.workspaceId, 7)
        .map((b) => ({ id: b.id, date: b.date, contentMd: b.content_md, createdAt: b.created_at })),
    };
  });

  /* ---- 每日调度 tick（与 v120 的 G-10 调度器同为进程内 30s 扫描，启动位置同在路由注册尾部） ---- */
  const tickMs = Number(process.env.SWARM_SCHEDULE_TICK_MS || SCHEDULE_SCAN_MS) || SCHEDULE_SCAN_MS;
  const timer = setInterval(() => {
    runDailyTick(repos, new Date()).catch((e) => {
      logger.error('daily', `每日调度扫描异常：${e instanceof Error ? e.message : String(e)}`);
    });
    // v1.5.0 C：智能体月度自动同步同 tick 顺带检查（每月 1 日平台时区触发、当月只跑一次，内部防重）
    runAgentMonthlyTick(repos, new Date()).catch((e) => {
      logger.error('agent-sync', `月度自动同步扫描异常：${e instanceof Error ? e.message : String(e)}`);
    });
  }, tickMs);
  timer.unref?.();
}
