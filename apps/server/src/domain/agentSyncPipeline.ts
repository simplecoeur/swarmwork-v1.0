import { PLATFORM_WORKSPACE_ID, type AgentSyncRunRow, type Repos } from '../store/repositories';
import { nowIso, uid } from '../util';
import {
  defaultAgentFetcher,
  getAgentSyncSources,
  saveAgentSyncSources,
  syncAgentSource,
  type AgentFetcher,
  type AgentSyncResult,
  type AgentSyncSource,
} from './agentSyncService';
import { classifyLicenseText, githubApiBase, githubRawBase, normalizeLicenseKind } from './github';
import { notifyUser } from './notify';
import { zonedDateStr } from './scheduleService';
import { ADMIN_USER_ID } from '../store/bootstrap';

/**
 * v1.5.0 C 同步流水线一期：在 v1.4 手动同步之上加四段——
 * 许可证漂移检查（源改许可证整源暂停+告警）→ 抓取（锚定源 commit）→ 写 run 记录 → 热度榜月度快照重算。
 * 月度自动调度复用 schedules 的时区工具（平台级固定 Asia/Shanghai，与晨报默认时区一致），
 * 由 daily.ts 的 30s tick 顺带调用 runAgentMonthlyTick（每月 1 日触发、当月只跑一次，settings 标记防重）。
 */

export const AGENT_SYNC_AUTO_STATE_KEY = 'agentSyncAutoState';
export const AGENT_SOURCE_META_KEY = 'agentSourceMeta';
export const AGENT_SYNC_PLATFORM_TZ = 'Asia/Shanghai';

export interface AgentSourceMeta {
  stars: number;
  pushedAt: string;
  headSha: string;
  fetchedAt: string;
}

export function getAgentSourceMeta(repos: Repos): Record<string, AgentSourceMeta> {
  return repos.getSetting<Record<string, AgentSourceMeta>>(AGENT_SOURCE_META_KEY, {}, PLATFORM_WORKSPACE_ID);
}

async function fetchRepoMeta(
  fetcher: AgentFetcher,
  source: AgentSyncSource,
): Promise<AgentSourceMeta | null> {
  try {
    const repoText = await fetcher(`${githubApiBase()}/repos/${source.repo}`);
    const repoJson = JSON.parse(repoText) as { stargazers_count?: number; pushed_at?: string };
    let headSha = '';
    try {
      const commitText = await fetcher(`${githubApiBase()}/repos/${source.repo}/commits/${source.branch}`);
      headSha = (JSON.parse(commitText) as { sha?: string }).sha ?? '';
    } catch {
      /* sha 拉取失败不阻断同步，run 里留空 */
    }
    return {
      stars: typeof repoJson.stargazers_count === 'number' ? repoJson.stargazers_count : 0,
      pushedAt: repoJson.pushed_at ?? '',
      headSha,
      fetchedAt: nowIso(),
    };
  } catch {
    return null;
  }
}

/** 抓源仓库 LICENSE 原文并归类；任何失败回 null（不据此暂停，避免网络抖动误伤） */
async function fetchRepoLicenseKind(fetcher: AgentFetcher, source: AgentSyncSource): Promise<string | null> {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) {
    try {
      const text = await fetcher(`${githubRawBase()}/${source.repo}/${source.branch}/${name}`);
      if (text && text.length > 20) return classifyLicenseText(text);
    } catch {
      /* 试下一个文件名 */
    }
  }
  return null;
}

export interface AgentSyncPipelineOutcome {
  run: AgentSyncRunRow;
  result: AgentSyncResult | null;
  paused: boolean;
}

/** 跑一个源的完整流水线（手动/自动共用）；整源失败时落 failed run 后原样抛错（路由层保持 502 口径） */
export async function runAgentSyncPipeline(
  repos: Repos,
  source: AgentSyncSource,
  trigger: 'manual' | 'auto',
  fetcher: AgentFetcher = defaultAgentFetcher,
): Promise<AgentSyncPipelineOutcome> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const base: AgentSyncRunRow = {
    id: uid('syncrun'),
    source_id: source.id,
    source_repo: source.repo,
    trigger_type: trigger,
    status: 'success',
    source_commit: '',
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    failed_details: '[]',
    error: '',
    duration_ms: 0,
    created_at: startedAt,
    finished_at: '',
  };
  const finish = (row: AgentSyncRunRow): AgentSyncRunRow => {
    row.duration_ms = Date.now() - startedMs;
    row.finished_at = nowIso();
    repos.insertAgentSyncRun(row);
    return row;
  };

  // 1) 许可证漂移：源仓库实际许可证与白名单登记不一致 → 整源暂停 + run 留痕 + 通知管理员
  const actualKind = await fetchRepoLicenseKind(fetcher, source);
  const expectedKind = normalizeLicenseKind(source.license);
  if (actualKind && expectedKind && actualKind !== expectedKind) {
    const reason = `许可证漂移：白名单登记 ${source.license}，仓库现为 ${actualKind}，已整源暂停`;
    const sources = getAgentSyncSources(repos).map((s) =>
      s.id === source.id ? { ...s, paused: true, pauseReason: reason } : s,
    );
    saveAgentSyncSources(repos, sources);
    const run = finish({ ...base, status: 'paused_license_drift', error: reason });
    notifyAdminSyncAlert(repos, '智能体同步源已暂停', reason);
    return { run, result: null, paused: true };
  }

  // 2) 仓库元信息（stars/最近推送/HEAD commit），失败不阻断
  const meta = await fetchRepoMeta(fetcher, source);
  if (meta) {
    const all = getAgentSourceMeta(repos);
    all[source.repo] = meta;
    repos.setSetting(AGENT_SOURCE_META_KEY, all, PLATFORM_WORKSPACE_ID);
    base.source_commit = meta.headSha;
  }

  // 3) 同步本体（只写 draft，语义见 agentSyncService）
  let result: AgentSyncResult;
  try {
    result = await syncAgentSource(repos, source, fetcher);
  } catch (e) {
    finish({ ...base, status: 'failed', error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  const run = finish({
    ...base,
    status: 'success',
    fetched: result.fetched,
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
    failed: result.failed,
    failed_details: JSON.stringify(result.failedDetails),
  });

  // 4) 热度榜快照（当月）重算
  computeHeatSnapshots(repos, new Date());
  return { run, result, paused: false };
}

function notifyAdminSyncAlert(repos: Repos, title: string, body: string): void {
  const admin = repos.getUser(ADMIN_USER_ID);
  if (!admin) return;
  const ws = repos.listWorkspaces().find((w) => w.owner_user_id === ADMIN_USER_ID);
  notifyUser(repos, ADMIN_USER_ID, ws?.id ?? PLATFORM_WORKSPACE_ID, 'agent_sync_alert', title, body);
}

/**
 * 热度榜（方案 §5.2 定案）：榜单分 = 0.5×源仓 stars 对数分 + 0.3×新鲜度分 + 0.2×站内有效招募对数分。
 * - stars 对数分：log10(stars+1)/6（100 万 stars 封顶 1）
 * - 新鲜度分：源仓近 90 天有推送 0.5 + 模板近 90 天有内容更新 0.5
 *   （内容更新时间以 pub_at/created_at 近似——模板行无独立内容时间戳，属既定近似口径）
 * - 有效招募：招募事件满 7 天且成员仍在、同空间去重（repos.countEffectiveRecruits），对数分 log10(n+1)/2（100 封顶）
 * 只给已上架模板打分；按月落快照，同步后与每月 1 日重算。
 */
export function computeHeatSnapshots(repos: Repos, now: Date): void {
  const month = nowIso().slice(0, 7);
  const meta = getAgentSourceMeta(repos);
  const cutoff7d = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const fresh90 = now.getTime() - 90 * 24 * 3600 * 1000;
  for (const t of repos.listPublicAgentTemplates()) {
    const m = meta[t.source_repo];
    const stars = m?.stars ?? 0;
    const starsScore = Math.min(1, Math.log10(stars + 1) / 6);
    const repoFresh = m?.pushedAt && Date.parse(m.pushedAt) >= fresh90 ? 0.5 : 0;
    const tplTs = Date.parse(t.pub_at ?? t.created_at);
    const tplFresh = Number.isFinite(tplTs) && tplTs >= fresh90 ? 0.5 : 0;
    const eff = repos.countEffectiveRecruits(t.id, cutoff7d);
    const recruitScore = Math.min(1, Math.log10(eff + 1) / 2);
    const score = 0.5 * starsScore + 0.3 * (repoFresh + tplFresh) + 0.2 * recruitScore;
    repos.upsertAgentHeatSnapshot({
      id: uid('heat'),
      month,
      template_id: t.id,
      score: Math.round(score * 10000) / 10000,
      source_stars: stars,
      effective_recruits: eff,
      created_at: nowIso(),
    });
  }
}

/** 月度自动同步 tick：每月 1 日（平台时区）触发一次；settings 标记当月已跑防重，逐源跑流水线，失败不互相阻断 */
export async function runAgentMonthlyTick(
  repos: Repos,
  now: Date,
  fetcher: AgentFetcher = defaultAgentFetcher,
): Promise<{ ran: boolean; sources: number }> {
  const dateStr = zonedDateStr(now, AGENT_SYNC_PLATFORM_TZ); // YYYY-MM-DD（平台时区）
  if (!dateStr.endsWith('-01')) return { ran: false, sources: 0 };
  const month = dateStr.slice(0, 7);
  const state = repos.getSetting<{ lastRunMonth?: string }>(
    AGENT_SYNC_AUTO_STATE_KEY,
    {},
    PLATFORM_WORKSPACE_ID,
  );
  if (state.lastRunMonth === month) return { ran: false, sources: 0 };
  // 先落标记再执行：进程中途崩溃也不会同月重复整轮（run 记录可查、管理员可手动补跑）
  repos.setSetting(AGENT_SYNC_AUTO_STATE_KEY, { ...state, lastRunMonth: month, startedAt: nowIso() }, PLATFORM_WORKSPACE_ID);
  const sources = getAgentSyncSources(repos).filter((s) => !s.paused);
  let failures = 0;
  for (const source of sources) {
    try {
      await runAgentSyncPipeline(repos, source, 'auto', fetcher);
    } catch {
      failures++;
    }
  }
  if (failures > 0) {
    notifyAdminSyncAlert(repos, '月度自动同步有失败', `${month} 月度同步 ${failures} 个源失败，请到管理台同步流水线看板查看原文。`);
  }
  return { ran: true, sources: sources.length };
}
