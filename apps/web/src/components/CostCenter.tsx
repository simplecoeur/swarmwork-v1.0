import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { yuan } from '../utils';
import ReportModal, { buildReport } from './ReportModal';
import type { ReportData } from './ReportModal';

export default function CostCenter() {
  const { S, post, refresh, toast, apiName, teamName, memberName } = useApp();
  const [report, setReport] = useState<ReportData | null>(null);
  const [buyApi, setBuyApi] = useState('');
  const [buyAmount, setBuyAmount] = useState('');

  useEffect(() => {
    if (S && S.apis.length && !S.apis.some((a) => a.id === buyApi)) {
      setBuyApi(S.apis[0].id);
    }
  }, [S, buyApi]);

  if (!S) return null;

  const totTok = S.ledger.reduce((s, l) => s + l.totalTokens, 0);
  const totCost = S.ledger.reduce((s, l) => s + l.costYuan, 0);
  const doneN = S.tasks.filter((t) => t.status === '已完成').length;
  const bal = S.apis.reduce((s, a) => s + (a.balanceYuan || 0), 0);

  async function purchase() {
    const amount = parseFloat(buyAmount);
    if (!(amount > 0)) return toast('金额要大于 0');
    try {
      await post('/api/purchase', { apiId: buyApi, amountYuan: amount });
    } catch { return; }
    setBuyAmount('');
    toast('充值成功');
    refresh();
  }

  return (
    <>
      <div className="card">
        <h2>成本总览</h2>
        <div className="kv">
          <div><b>{totTok.toLocaleString()}</b><span>累计 token</span></div>
          <div><b>{yuan(totCost)}</b><span>累计成本</span></div>
          <div><b>{doneN}</b><span>已完成任务</span></div>
          <div><b>{doneN ? Math.round(totTok / doneN).toLocaleString() : '0'}</b><span>平均单耗 token</span></div>
          <div><b>{yuan(bal)}</b><span>各 API 余额合计</span></div>
        </div>
        <p className="hint">口径：每次调用大模型都实时记账（任务 / 执行人所在组 / 所用 API / 阶段），成本 = 总 token ÷ 1,000,000 × 该 API 采购单价，并从该 API 余额中扣除。</p>
        <div style={{ marginTop: 8 }}>
          <button className="btn green" onClick={() => setReport(buildReport(S))}>让总经理汇报</button>
        </div>
      </div>

      <div className="card">
        <h2>按 API 拆账</h2>
        <table>
          <thead>
            <tr><th>API</th><th>调用次数</th><th>token</th><th>成本</th><th>余额</th><th>状态</th></tr>
          </thead>
          <tbody>
            {S.apis.map((a) => {
              const ls = S.ledger.filter((l) => l.apiId === a.id);
              return (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{ls.length}</td>
                  <td>{ls.reduce((s, l) => s + l.totalTokens, 0).toLocaleString()}</td>
                  <td>{yuan(ls.reduce((s, l) => s + l.costYuan, 0))}</td>
                  <td>{yuan(a.balanceYuan)}</td>
                  <td>
                    {!a.hasKey ? (
                      <span className="warn">未填 Key</span>
                    ) : a.overdrawn ? (
                      <span className="warn">已欠费</span>
                    ) : a.balanceYuan <= 0 ? (
                      <span className="warn">余额不足</span>
                    ) : (
                      '正常'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="card">
          <h2>小组排行</h2>
          <table>
            <thead>
              <tr><th>小组</th><th>token</th><th>成本</th><th>已完成</th></tr>
            </thead>
            <tbody>
              {S.teams.map((t) => {
                const ls = S.ledger.filter((l) => l.teamId === t.id);
                return (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{ls.reduce((s, l) => s + l.totalTokens, 0).toLocaleString()}</td>
                    <td>{yuan(ls.reduce((s, l) => s + l.costYuan, 0))}</td>
                    <td>{S.tasks.filter((x) => x.teamId === t.id && x.status === '已完成').length}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2>采购充值</h2>
          <label>充到哪条 API</label>
          <select value={buyApi} onChange={(e) => setBuyApi(e.target.value)}>
            {S.apis.map((a) => (
              <option key={a.id} value={a.id}>{a.name}（余额 {yuan(a.balanceYuan)}）</option>
            ))}
          </select>
          <label>金额（元）</label>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="如：50"
            value={buyAmount}
            onChange={(e) => setBuyAmount(e.target.value)}
          />
          <div style={{ marginTop: 10 }}>
            <button className="btn" onClick={purchase}>采购充值</button>
          </div>
          {S.purchases.length ? (
            <div className="hint" style={{ marginTop: 10 }}>
              采购记录：
              {[...S.purchases]
                .reverse()
                .slice(0, 8)
                .map((p) => `${apiName(p.apiId)} +${yuan(p.amountYuan)}（${String(p.ts).slice(0, 10)}）`)
                .join('；')}
            </div>
          ) : null}
        </div>
      </div>

      <div className="card">
        <h2>任务账本 <span className="tag">每单从接单到交付的全程消耗</span></h2>
        {S.tasks.length ? (
          <table>
            <thead>
              <tr><th>任务</th><th>小组</th><th>负责人</th><th>全程 token</th><th>成本</th><th>状态</th></tr>
            </thead>
            <tbody>
              {[...S.tasks].reverse().map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td>{teamName(t.teamId)}</td>
                  <td>{memberName(t.assigneeId)}</td>
                  <td>{(t.totalTokens || 0).toLocaleString()}</td>
                  <td>{yuan(t.totalCost)}</td>
                  <td>{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint">暂无任务。</p>
        )}
      </div>

      {report && <ReportModal report={report} onClose={() => setReport(null)} />}
    </>
  );
}
