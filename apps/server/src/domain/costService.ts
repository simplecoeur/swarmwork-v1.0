import { milliToYuan, TaskStatus, type CostReportDto } from '@swarm/shared';
import { DEFAULT_WORKSPACE_ID, type Repos } from '../store/repositories';

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
