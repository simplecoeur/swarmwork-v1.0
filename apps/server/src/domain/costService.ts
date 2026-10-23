import { milliToYuan, TaskStatus, type CostReportDto } from '@swarm/shared';
import type { Repos } from '../store/repositories';

/** 余额推导（ADR-004）：purchases 合计 − ledger 合计，单位厘 */
export function balanceMilli(repos: Repos, apiId: string): number {
  const purchases = repos.purchasesSumByApi(apiId);
  const ledger = repos.ledgerSumByApi(apiId);
  return purchases - ledger.costMilli;
}

/** 总经理汇报聚合（§7/§15）：排行、最贵一单、续航估算、估算占比、裁决统计 */
export function buildReport(repos: Repos): CostReportDto {
  const apis = repos.listApis();
  const teams = repos.listTeams();
  const tasks = repos.listTasks();
  const projects = repos.listProjects();
  const ledger = repos.listLedger();
  const totals = repos.ledgerTotals();

  const doneTasks = tasks.filter((t) => t.status === TaskStatus.DONE);
  const firstTs = ledger.length ? new Date(ledger[0].created_at).getTime() : Date.now();
  const spanDays = Math.max(1, (Date.now() - firstTs) / 86_400_000);

  const byApi = apis.map((a) => {
    const sum = repos.ledgerSumByApi(a.id);
    const bal = balanceMilli(repos, a.id);
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
      const sum = repos.ledgerSumByTeam(t.id);
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
