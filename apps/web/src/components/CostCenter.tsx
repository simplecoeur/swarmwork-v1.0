import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchCostSettings, fetchLedgerView, requestRaw } from '../api';
import { yuan } from '../utils';
import ReportModal, { buildReport } from './ReportModal';
import type { ReportData } from './ReportModal';
import { Badge, Button, Input, Select, Spinner } from './ui';
import type { CostSummary, LedgerViewItem } from '../types';

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
      <CostSummaryCard />
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
          <Button variant="green" onClick={() => setReport(buildReport(S))}>让总经理汇报</Button>
        </div>
      </div>

      <div className="card">
        <h2>按 API 拆账</h2>
        <div className="table-wrap">
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
      </div>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="card">
          <h2>小组排行</h2>
          <div className="table-wrap">
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
        </div>
        <div className="card">
          <h2>采购充值</h2>
          <label>充到哪条 API</label>
          <Select
            value={buyApi}
            onValueChange={setBuyApi}
            options={S.apis.map((a) => ({ value: a.id, label: `${a.name}（余额 ${yuan(a.balanceYuan)}）` }))}
          />
          <label>金额（元）</label>
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder="如：50"
            value={buyAmount}
            onChange={(e) => setBuyAmount(e.target.value)}
          />
          <div style={{ marginTop: 10 }}>
            <Button onClick={purchase}>采购充值</Button>
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
          <div className="table-wrap">
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
          </div>
        ) : (
          <p className="hint">暂无任务。</p>
        )}
      </div>

      <LedgerViewCard />

      {report && <ReportModal report={report} onClose={() => setReport(null)} />}
    </>
  );
}

/**
 * 人话用量摘要卡（G-08）：数据来自 GET /api/cost/settings 的 summary 段（服务端由 purchases/ledger 推导）。
 * 当前余额（自有/体验分开）、约还能跑 N 单、按近 30 天速度约够 M 天 + 低余额阈值设置入口。
 */
function CostSummaryCard() {
  const { S, toast, refresh } = useApp();
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [threshold, setThreshold] = useState('');
  const [effective, setEffective] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchCostSettings();
      setSummary(r.summary);
      setEffective(r.effectiveThresholdYuan);
      setThreshold(r.lowBalanceThresholdYuan === null ? '' : String(r.lowBalanceThresholdYuan));
    } catch {
      /* 拉取失败保持旧值 */
    }
  }, []);

  // 任务/采购变化（state 轮询刷新）时同步摘要
  useEffect(() => {
    load();
  }, [load, S?.tasks.length, S?.purchases.length, S?.ledger.length]);

  async function saveThreshold() {
    const v = threshold.trim();
    const num = v === '' ? null : Number(v);
    if (num !== null && !(num >= 0)) return toast('阈值要 ≥ 0，或留空恢复默认');
    try {
      await requestRaw('PUT', '/api/cost/settings', { lowBalanceThresholdYuan: num });
      toast(num === null ? '已恢复默认预警线（最近一笔采购额的 20%）' : '预警线已保存');
      load();
      refresh();
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (!summary) return null;
  return (
    <div className="card">
      <h2>用量摘要 <span className="tag">人话版：还剩多少、还能跑多久</span></h2>
      <div className="kv">
        <div>
          <b>{yuan(summary.balanceYuan)}</b>
          <span>自有余额（体验额度另有 {yuan(summary.trialBalanceYuan)}）</span>
        </div>
        <div>
          <b>{summary.approxTasksRemaining === null ? '—' : `约 ${summary.approxTasksRemaining} 单`}</b>
          <span>按近 30 天单均成本 {yuan(summary.avgCostPerTaskYuan)} 估算</span>
        </div>
        <div>
          <b>{summary.approxDaysRemaining === null ? '—' : `约 ${summary.approxDaysRemaining} 天`}</b>
          <span>按日均燃烧 {yuan(summary.burnPerDayYuan)}/天估算</span>
        </div>
      </div>
      <div className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
        <div style={{ flex: '0 1 260px' }}>
          <label>低余额预警线（元，余额跌破时站内提醒一次；留空 = 默认最近一笔采购额的 20%）</label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder={effective === null ? '当前未启用预警' : `当前生效 ${effective}`}
          />
        </div>
        <div>
          <Button variant="blue" onClick={saveThreshold}>
            保存预警线
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 工作台账（M8 §5.1）：GET /api/ledger-view 的统一时间线（任务事件 + 操作审计），
 * 最近 50 条展示；按月导出走 /api/ledger-view/export?month=YYYY-MM 直下 CSV。
 */
function LedgerViewCard() {
  const [items, setItems] = useState<LedgerViewItem[]>([]);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await fetchLedgerView());
    } catch {
      /* 拉取失败保持旧列表 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="card">
      <h2>工作台账 <span className="tag">任务事件与操作审计的统一时间线（最近 50 条）</span></h2>
      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
        <div style={{ flex: '0 0 200px' }}>
          <label>导出月份</label>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <div>
          <a className="btn small blue" href={`/api/ledger-view/export?month=${month}`} download>
            导出该月台账 CSV
          </a>{' '}
          <Button size="small" variant="gray" onClick={load}>刷新时间线</Button>
        </div>
      </div>
      {!loaded && <p><Spinner label="加载中…" /></p>}
      {loaded && items.length === 0 && <p className="hint">暂无台账记录。</p>}
      {items.slice(0, 50).map((it, i) => (
        <div className="subtask" key={`${it.ts}-${i}`} style={{ cursor: 'default' }}>
          <span className="meta">{it.ts.slice(0, 16).replace('T', ' ')}</span>{' '}
          <Badge variant={it.kind === 'audit' ? 'rev' : 'run'}>
            {it.kind === 'audit' ? '操作审计' : '任务事件'}
          </Badge>{' '}
          <span>{it.text}</span>
        </div>
      ))}
    </div>
  );
}
