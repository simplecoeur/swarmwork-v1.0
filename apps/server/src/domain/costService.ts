import {
  milliToYuan,
  TaskStatus,
  type CostEstimateDto,
  type CostReportDto,
  type CostSummaryDto,
} from '@swarm/shared';
import { DEFAULT_WORKSPACE_ID, type Repos } from '../store/repositories';
import { notifyOwner } from './notify';
import type { Logger } from '../logger';

/** 余额推导（ADR-004）：某空间内 purchases 合计 − ledger 合计，单位厘（M6 起按空间隔离） */
export function balanceMilli(
  repos: Repos,
  apiId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): number {
  const purchases = repos.purchasesSumByApi(apiId, workspaceId);
  const ledger = repos.ledgerSumByApi(apiId, workspaceId);
  return purchases - ledger.costMilli;
}

/** 体验额度余额（§8.1）：该空间在平台体验 API 上的 Σtrial_grant − Σledger */
export function trialBalanceMilli(repos: Repos, workspaceId: string): number {
  const trial = repos.getTrialApi();
  if (!trial) return 0;
  const granted = repos.trialGrantedSum(trial.id, workspaceId);
  const used = repos.ledgerSumByApi(trial.id, workspaceId);
  return granted - used.costMilli;
}

/* ================= G-08 用量预估 + 余额预警 + 人话摘要 ================= */

const THIRTY_DAYS_MS = 30 * 86_400_000;

/** 自有余额合计（厘）：空间内各 apis 行的 Σpurchases − Σledger（与 balanceMilli 同口径汇总，不含体验额度） */
export function ownBalanceMilli(repos: Repos, workspaceId: string): number {
  return repos.listApis(workspaceId).reduce((s, a) => s + balanceMilli(repos, a.id, workspaceId), 0);
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function estimateFromCosts(costs: number[], basis: CostEstimateDto['basis']): CostEstimateDto {
  const sorted = [...costs].sort((a, b) => a - b);
  const avg = costs.length ? Math.round(costs.reduce((s, c) => s + c, 0) / costs.length) : 0;
  const p25 = percentile(sorted, 25);
  const p75 = percentile(sorted, 75);
  return {
    avgMilli: avg,
    p25Milli: p25,
    p75Milli: p75,
    avgYuan: milliToYuan(avg),
    p25Yuan: milliToYuan(p25),
    p75Yuan: milliToYuan(p75),
    sampleCount: costs.length,
    basis,
  };
}

/**
 * 用量预估（G-08）：近 30 天 ledger 按任务聚合，退级链 skill → type → workspace → none。
 * 同 skill / 同 type 样本 <5 即退级；全空间均值不限样本数；皆无历史 → basis='none'。
 */
export function estimateCost(
  repos: Repos,
  workspaceId: string,
  opts: { type?: string; skillId?: string } = {},
): CostEstimateDto {
  const since = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  const rows = repos.ledgerTaskCosts(workspaceId, since);
  if (opts.skillId) {
    const costs = rows.filter((r) => r.skillId === opts.skillId).map((r) => r.costMilli);
    if (costs.length >= 5) return estimateFromCosts(costs, 'skill');
  }
  if (opts.type) {
    const costs = rows.filter((r) => r.type === opts.type).map((r) => r.costMilli);
    if (costs.length >= 5) return estimateFromCosts(costs, 'type');
  }
  if (rows.length) return estimateFromCosts(rows.map((r) => r.costMilli), 'workspace');
  return estimateFromCosts([], 'none');
}

/** 人话用量摘要（G-08）：全部由 purchases/ledger 推导（§5 口径），不新增统计表 */
export function buildSummary(repos: Repos, workspaceId: string): CostSummaryDto {
  const own = ownBalanceMilli(repos, workspaceId);
  const trial = trialBalanceMilli(repos, workspaceId);
  const spendable = own + trial;
  const since = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  const rows = repos.ledgerTaskCosts(workspaceId, since);
  const total30 = rows.reduce((s, r) => s + r.costMilli, 0);
  const avgPerTask = rows.length ? Math.round(total30 / rows.length) : 0;
  const burnPerDay = Math.round(total30 / 30);
  return {
    balanceMilli: own,
    balanceYuan: milliToYuan(own),
    trialBalanceMilli: trial,
    trialBalanceYuan: milliToYuan(trial),
    avgCostPerTaskMilli: avgPerTask,
    avgCostPerTaskYuan: milliToYuan(avgPerTask),
    approxTasksRemaining: avgPerTask > 0 ? Math.floor(spendable / avgPerTask) : null,
    burnPerDayMilli: burnPerDay,
    burnPerDayYuan: milliToYuan(burnPerDay),
    approxDaysRemaining: burnPerDay > 0 ? Math.floor(spendable / burnPerDay) : null,
  };
}

/**
 * 生效中的低余额阈值（厘）：用户显式设置（settings.lowBalanceThresholdMilli）优先；
 * 未设置时默认 = 最近一笔采购额的 20%，无采购史时 = 体验额度发放额的 20%，皆无 → null（不启用）。
 */
export function effectiveLowBalanceThresholdMilli(repos: Repos, workspaceId: string): number | null {
  const explicit = repos.getSetting<number | null>('lowBalanceThresholdMilli', null, workspaceId);
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const latest = repos.latestPurchaseMilli(workspaceId);
  if (latest && latest > 0) return Math.round(latest * 0.2);
  const trial = repos.getTrialApi();
  if (trial) {
    const granted = repos.trialGrantedSum(trial.id, workspaceId);
    if (granted > 0) return Math.round(granted * 0.2);
  }
  return null;
}

/**
 * 低余额预警检查（G-08，旁路）：余额由阈值上穿到阈值下 → 恰好发一条 balance_low 并置标记防重复；
 * 余额回到阈值上 → 清标记（下次跌破再发）。自有余额与体验余额各一套标记，体验文案分型沿用 trial 口径。
 * 挂在回账后与采购后调用；失败一律吞掉记日志，绝不拖慢/阻断主路径（口径同 G-04 旁路）。
 */
export function checkLowBalance(repos: Repos, workspaceId: string, logger?: Logger): void {
  try {
    const threshold = effectiveLowBalanceThresholdMilli(repos, workspaceId);
    if (threshold !== null) {
      const bal = ownBalanceMilli(repos, workspaceId);
      const alerted = repos.getSetting<boolean>('lowBalanceAlerted', false, workspaceId);
      if (bal < threshold && !alerted) {
        notifyOwner(
          repos,
          workspaceId,
          'balance_low',
          '余额预警',
          `自有余额已降到 ${milliToYuan(bal)} 元，低于预警线 ${milliToYuan(threshold)} 元，请到成本中心采购充值`,
          null,
        );
        repos.setSetting('lowBalanceAlerted', true, workspaceId);
      } else if (bal >= threshold && alerted) {
        repos.setSetting('lowBalanceAlerted', false, workspaceId);
      }
    }
    // 体验额度：阈值 = 发放额的 20%（固定比例，与默认口径一致）
    const trial = repos.getTrialApi();
    if (trial) {
      const granted = repos.trialGrantedSum(trial.id, workspaceId);
      if (granted > 0) {
        const tThreshold = Math.round(granted * 0.2);
        const tBal = trialBalanceMilli(repos, workspaceId);
        const tAlerted = repos.getSetting<boolean>('trialLowBalanceAlerted', false, workspaceId);
        if (tBal < tThreshold && !tAlerted) {
          notifyOwner(
            repos,
            workspaceId,
            'balance_low',
            '体验额度余额预警',
            `体验额度余额已降到 ${milliToYuan(tBal)} 元，低于预警线 ${milliToYuan(tThreshold)} 元（发放额的 20%），请到设置后台填自己的 API Key`,
            null,
          );
          repos.setSetting('trialLowBalanceAlerted', true, workspaceId);
        } else if (tBal >= tThreshold && tAlerted) {
          repos.setSetting('trialLowBalanceAlerted', false, workspaceId);
        }
      }
    }
  } catch (e) {
    logger?.warn('cost', `低余额预警检查失败（已忽略）：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 总经理汇报聚合（§7/§15 + M6 按当前空间）：排行、最贵一单、续航估算、估算占比、裁决统计、按发单人维度 */
export function buildReport(
  repos: Repos,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): CostReportDto {
  const apis = repos.listApis(workspaceId);
  const teams = repos.listTeams(workspaceId);
  const tasks = repos.listTasks(workspaceId);
  const projects = repos.listProjects(workspaceId);
  const ledger = repos.listLedger(workspaceId);
  const totals = repos.ledgerTotals(workspaceId);

  const doneTasks = tasks.filter((t) => t.status === TaskStatus.DONE);
  const firstTs = ledger.length ? new Date(ledger[0].created_at).getTime() : Date.now();
  const spanDays = Math.max(1, (Date.now() - firstTs) / 86_400_000);

  const byApi = apis.map((a) => {
    const sum = repos.ledgerSumByApi(a.id, workspaceId);
    const bal = balanceMilli(repos, a.id, workspaceId);
    const dailyCostMilli = totals.costMilli > 0 ? sum.costMilli / spanDays : 0;
    return {
      apiId: a.id,
      name: a.name,
      calls: sum.calls,
      totalTokens: sum.totalTokens,
      costYuan: milliToYuan(sum.costMilli),
      balanceYuan: milliToYuan(bal),
      estimatedTokens: sum.estimatedTokens,
      runwayDays:
        dailyCostMilli > 0 ? Math.max(0, Math.round((bal / dailyCostMilli) * 10) / 10) : null,
    };
  });

  const byTeam = teams
    .map((t) => {
      const sum = repos.ledgerSumByTeam(t.id, workspaceId);
      return {
        teamId: t.id,
        name: t.name,
        totalTokens: sum.totalTokens,
        costYuan: milliToYuan(sum.costMilli),
        done: tasks.filter((x) => x.team_id === t.id && x.status === TaskStatus.DONE).length,
      };
    })
    .sort((a, b) => b.costYuan - a.costYuan);

  const byProject = projects.map((p) => {
    const children = tasks.filter((t) => t.project_id === p.id);
    const tok = children.reduce((s, t) => s + repos.ledgerSumByTask(t.id).totalTokens, 0);
    const cost = children.reduce((s, t) => s + repos.ledgerSumByTask(t.id).costMilli, 0);
    return {
      projectId: p.id,
      name: p.name,
      status: p.status,
      totalTokens: tok,
      costYuan: milliToYuan(cost),
    };
  });

  const byUserMap = new Map<string | null, { totalTokens: number; costMilli: number; tasks: number }>();
  for (const t of tasks) {
    const key = t.created_by_user_id ?? null;
    const agg = byUserMap.get(key) ?? { totalTokens: 0, costMilli: 0, tasks: 0 };
    const sum = repos.ledgerSumByTask(t.id);
    agg.totalTokens += sum.totalTokens;
    agg.costMilli += sum.costMilli;
    agg.tasks += 1;
    byUserMap.set(key, agg);
  }
  const byUser = [...byUserMap.entries()].map(([userId, agg]) => ({
    userId,
    totalTokens: agg.totalTokens,
    costYuan: milliToYuan(agg.costMilli),
    tasks: agg.tasks,
  }));

  const priciest = [...tasks].sort((a, b) => b.total_cost_milli - a.total_cost_milli)[0];

  return {
    generatedAt: new Date().toISOString(),
    summary: buildSummary(repos, workspaceId),
    totals: {
      totalTokens: totals.totalTokens,
      totalCostYuan: milliToYuan(totals.costMilli),
      doneTasks: doneTasks.length,
      avgTokensPerDone: doneTasks.length ? Math.round(totals.totalTokens / doneTasks.length) : 0,
      estimatedTokens: totals.estimatedTokens,
      estimatedShare: totals.totalTokens
        ? Math.round((totals.estimatedTokens / totals.totalTokens) * 10_000) / 10_000
        : 0,
    },
    byApi,
    byTeam,
    byProject,
    byUser,
    priciestTask:
      priciest && priciest.total_cost_milli > 0
        ? {
            id: priciest.id,
            title: priciest.title,
            totalTokens: priciest.total_tokens,
            costYuan: milliToYuan(priciest.total_cost_milli),
          }
        : null,
    adjudication: {
      pending: tasks.filter((t) => t.status === TaskStatus.ADJUDICATION).length,
      passed: tasks.filter((t) => t.adjudicated === 1).length,
    },
  };
}
