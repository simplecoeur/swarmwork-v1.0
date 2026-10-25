import { useApp } from '../context';
import { yuan } from '../utils';
import { Button, Dialog } from './ui';

export interface ReportData {
  doneCount: number;
  activeCount: number;
  adjudicationCount: number;
  totTok: number;
  totCost: number;
  priciestTitle: string;
  priciestCost: number;
  priciestTokens: number;
  byTeam: { name: string; cost: number }[];
  apiLines: { name: string; balance: number; suffix: string }[];
  daysTxt: string;
}

/** 与原生版 openReport() 的口径逐项一致（在点击按钮时按当前账本快照计算） */
export function buildReport(S: NonNullable<ReturnType<typeof useApp>['S']>): ReportData {
  const totTok = S.ledger.reduce((s, l) => s + l.totalTokens, 0);
  const totCost = S.ledger.reduce((s, l) => s + l.costYuan, 0);
  const done = S.tasks.filter((t) => t.status === '已完成');
  const priciest = [...S.tasks].sort((a, b) => (b.totalCost || 0) - (a.totalCost || 0))[0];
  const byTeam = S.teams
    .map((t) => {
      const ls = S.ledger.filter((l) => l.teamId === t.id);
      return {
        name: t.name,
        tok: ls.reduce((s, l) => s + l.totalTokens, 0),
        cost: ls.reduce((s, l) => s + l.costYuan, 0),
      };
    })
    .sort((a, b) => b.cost - a.cost);
  let daysTxt = '暂无消耗记录，无法估算';
  if (S.ledger.length) {
    const first = new Date(S.ledger[0].ts).getTime();
    const spanDays = Math.max(1, (Date.now() - first) / 86400000);
    const daily = totCost / spanDays;
    const bal = S.apis.reduce((s, a) => s + (a.balanceYuan || 0), 0);
    daysTxt =
      daily > 0
        ? '按近 ' + spanDays.toFixed(1) + ' 天平均每天烧 ' + yuan(daily) + ' 估算，当前总余额 ' + yuan(bal) +
          ' 约可撑 ' + (bal / daily).toFixed(1) + ' 天（估算）'
        : '日均消耗为 0';
  }
  return {
    doneCount: done.length,
    activeCount: S.tasks.filter((t) => ['待领取', '执行中', '待审核', '被打回'].includes(t.status)).length,
    adjudicationCount: S.tasks.filter((t) => t.status === '待裁决').length,
    totTok,
    totCost,
    priciestTitle: priciest && priciest.totalCost > 0 ? priciest.title : '',
    priciestCost: priciest ? priciest.totalCost || 0 : 0,
    priciestTokens: priciest ? priciest.totalTokens || 0 : 0,
    byTeam: byTeam.map((t) => ({ name: t.name, cost: t.cost })),
    apiLines: S.apis.map((a) => ({
      name: a.name,
      balance: a.balanceYuan,
      suffix: a.overdrawn ? '（已欠费，请交费）' : a.balanceYuan <= 0 ? '（余额不足，请交费）' : '',
    })),
    daysTxt,
  };
}

export default function ReportModal({ report, onClose }: { report: ReportData; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="总经理汇报">
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          <p>老板，本期汇报如下：</p>
          <p>
            · 已完成任务 <b>{report.doneCount}</b> 单，进行中/排队 {report.activeCount} 单，待您裁决 {report.adjudicationCount} 单。<br />
            · 总消耗 <b>{report.totTok.toLocaleString()}</b> token，总成本 <b>{yuan(report.totCost)}</b>。<br />
            {report.priciestTitle ? (
              <>· 最贵的一单：「{report.priciestTitle}」，花了 {yuan(report.priciestCost)}（{report.priciestTokens.toLocaleString()} token）。<br /></>
            ) : null}
            · 各组消耗排行：{report.byTeam.map((t, i) => `${i + 1}. ${t.name} ${yuan(t.cost)}`).join('；')}<br />
            · 各 API：{report.apiLines.map((a) => `${a.name} 余额 ${yuan(a.balance)}${a.suffix}`).join('；')}<br />
            · 余额续航：{report.daysTxt}
          </p>
          <p className="hint">说明：以上为系统按账本实时汇总；续航天数为估算，实际取决于后续任务量。</p>
        </div>
        <div style={{ textAlign: 'right', marginTop: 12 }}>
          <Button variant="gray" onClick={onClose}>关闭</Button>
        </div>
    </Dialog>
  );
}
