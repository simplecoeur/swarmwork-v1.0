import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchDeliveries, fetchResults } from '../api';
import { yuan } from '../utils';
import { Badge, Button, Checkbox, Dialog, EmptyState, Input, useConfirm } from './ui';
import ResultView from './ResultView';
import type { Delivery, ResultItem } from '../types';

/** 标记成果渠道表现的弹窗状态：指标三件套（播放 / 点击率 / 完播率）+ 备注 */
interface OutcomeState {
  taskId: string;
  title: string;
  verdict: 'effective' | 'ineffective';
  views: string;
  ctr: string;
  completion: string;
  note: string;
}

/** 生成交付页的弹窗状态：生成后回填完整链接展示 */
interface DeliveryState {
  taskId: string;
  title: string;
  password: string;
  days: string;
  link: string;
}

/**
 * 成果库（M8 飞轮）：数据统一走 GET /api/results（支持关键词搜索与只看已验证有效）。
 * 每份成果：导出 md/csv、生成只读交付页、推送 MJ、标记有效/无效（填渠道指标）、
 * 有效成果沉淀到知识库 / skill、一键再发。底部管理已有交付页（浏览数/口令/过期/撤销）。
 */
export default function Results() {
  const { S, post, toast } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [q, setQ] = useState('');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [outcome, setOutcome] = useState<OutcomeState | null>(null);
  const [delivery, setDelivery] = useState<DeliveryState | null>(null);

  const loadResults = useCallback(async () => {
    try {
      setResults(await fetchResults(q, verifiedOnly));
    } catch {
      /* 拉取失败保持旧列表 */
    } finally {
      setLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 搜索词只在点搜索/回车时生效，不随输入实时查
  }, [verifiedOnly]);

  const loadDeliveries = useCallback(async () => {
    try {
      setDeliveries(await fetchDeliveries());
    } catch {
      /* 保持旧列表 */
    }
  }, []);

  useEffect(() => {
    loadResults();
    loadDeliveries();
  }, [loadResults, loadDeliveries]);

  if (!S) return null;

  function copyText(text: string) {
    navigator.clipboard.writeText(text).then(() => toast('已复制'));
  }

  async function pushMj(r: ResultItem) {
    let res: Record<string, unknown>;
    try {
      res = await post('/api/channels/push', { channelType: 'mj', taskId: r.taskId });
    } catch { return; }
    const push = res.push as { status?: string; message?: string } | undefined;
    toast(`推送 MJ：${push?.status ?? ''}${push?.message ? ` · ${push.message}` : ''}`);
  }

  /** G-17 通用 Webhook 推送（payload 含成果全文 + 交付页链接 + 用量摘要，HMAC 签名） */
  async function pushWebhook(r: ResultItem) {
    let res: Record<string, unknown>;
    try {
      res = await post('/api/channels/push', { channelType: 'generic_webhook', taskId: r.taskId });
    } catch { return; }
    const push = res.push as { status?: string; message?: string } | undefined;
    toast(`推送 Webhook：${push?.status ?? ''}${push?.message ? ` · ${push.message}` : ''}`);
  }

  async function submitOutcome() {
    if (!outcome) return;
    const metrics: Record<string, number> = {};
    const views = parseFloat(outcome.views);
    const ctr = parseFloat(outcome.ctr);
    const completion = parseFloat(outcome.completion);
    if (!Number.isNaN(views)) metrics.views = views;
    if (!Number.isNaN(ctr)) metrics.ctr = ctr;
    if (!Number.isNaN(completion)) metrics.completion = completion;
    try {
      await post(`/api/tasks/${outcome.taskId}/outcome`, {
        verdict: outcome.verdict,
        metrics,
        note: outcome.note,
      });
    } catch { return; }
    toast(outcome.verdict === 'effective' ? '已标记为有效（可沉淀）' : '已标记为无效');
    setOutcome(null);
    loadResults();
  }

  async function sediment(taskId: string, target: 'kb' | 'skill') {
    try {
      await post(`/api/tasks/${taskId}/sediment`, { target });
    } catch { return; }
    toast(target === 'kb' ? '已沉淀到知识库（带「已验证」标签）' : '已沉淀到 skill 的已验证做法备注');
  }

  async function redispatch(r: ResultItem) {
    try {
      await post(`/api/tasks/${r.taskId}/redispatch`, {});
    } catch { return; }
    toast(r.skillId ? '已按原参数再发一单，进任务墙了' : '已按原标题/说明再发一单，进任务墙了');
  }

  async function submitDelivery() {
    if (!delivery) return;
    let res: Record<string, unknown>;
    try {
      res = await post('/api/deliveries', {
        scope: 'task',
        taskId: delivery.taskId,
        password: delivery.password || undefined,
        expiresInDays: delivery.days ? Number(delivery.days) : undefined,
      });
    } catch { return; }
    const d = res.delivery as Delivery | undefined;
    if (d?.path) {
      setDelivery({ ...delivery, link: window.location.origin + d.path });
      toast('交付页已生成，链接只完整显示这一次，请及时复制');
      loadDeliveries();
    }
  }

  function revokeDelivery(d: Delivery) {
    ask({
      title: '撤销交付页',
      message: `撤销交付页「${d.title}」？撤销后链接立即失效。`,
      confirmLabel: '撤销',
      onConfirm: async () => {
        try {
          await post(`/api/deliveries/${d.id}/revoke`);
        } catch { return; }
        toast('交付页已撤销');
        loadDeliveries();
      },
    });
  }

  const expired = (d: Delivery) => !!d.expiresAt && new Date(d.expiresAt).getTime() < Date.now();

  return (
    <>
      <div className="card">
        <h2>成果库 <span className="tag">真实产出 · 渠道表现标记 → 有效成果沉淀成规律（飞轮）</span></h2>
        <div className="row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
          <div>
            <label>搜索（标题 / 正文关键词）</label>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') loadResults();
              }}
              placeholder="如：标题、钩子……"
            />
          </div>
          <div style={{ flex: '0 0 120px' }}>
            <Button variant="blue" onClick={loadResults}>搜索</Button>
          </div>
          <div style={{ flex: '0 0 190px' }}>
            <Checkbox
              checked={verifiedOnly}
              onCheckedChange={setVerifiedOnly}
              label="只看已验证有效"
            />
          </div>
        </div>

        {!loaded && <p className="hint">加载中…</p>}
        {loaded && results.length === 0 && (
          <EmptyState
            example={<>示例成果：《新剧第 1 集》英文标题 ×10 · 已交付 · 可导出/生成交付页/标记有效后沉淀</>}
            action={
              <Button
                size="small"
                onClick={() =>
                  document.getElementById('publish-anchor')?.scrollIntoView({ behavior: 'smooth' })
                }
              >
                去发一单出成果
              </Button>
            }
          >
            暂无符合条件的成果。任务完成后，成果会自动汇到这里，可导出、生成交付页、标记渠道表现并沉淀回知识库。
          </EmptyState>
        )}
        {results.map((r) => {
          const effective = r.mark?.verdict === 'effective';
          return (
            <div className="task" key={r.taskId}>
              <span className="tt">{r.title}</span>
              <Badge variant="done">已交付</Badge>
              <Badge>{r.type}</Badge>
              {r.skillId && <Badge>skill v{r.skillVersion ?? '?'}</Badge>}
              {r.mark && (
                <Badge variant={effective ? 'done' : 'rej'}>
                  {effective ? '✓ 已验证有效' : '已验证无效'}
                </Badge>
              )}
              <div className="meta">
                {(r.totalTokens || 0).toLocaleString()} token / {yuan(r.totalCostYuan)}
                {r.finishedAt ? ` · 完成于 ${r.finishedAt.slice(0, 16).replace('T', ' ')}` : ''}
                {r.mark && Object.keys(r.mark.metrics ?? {}).length > 0 ? (
                  <>
                    <br />
                    渠道指标：
                    {Object.entries(r.mark.metrics)
                      .map(([k, v]) => `${k}=${v}`)
                      .join('，')}
                    {r.mark.note ? ` · ${r.mark.note}` : ''}
                  </>
                ) : null}
              </div>
              <ResultView result={r.result || ''} taskId={r.taskId} />
              <Button size="small" variant="gray" onClick={() => copyText(r.result || '')}>复制</Button>{' '}
              <a className="btn small gray" href={`/api/tasks/${r.taskId}/export?format=md`} download>
                导出 .md
              </a>{' '}
              <a className="btn small gray" href={`/api/tasks/${r.taskId}/export?format=csv`} download>
                导出 .csv
              </a>{' '}
              <Button
                size="small"
                variant="blue"
                onClick={() =>
                  setDelivery({ taskId: r.taskId, title: r.title, password: '', days: '7', link: '' })
                }
              >
                生成交付页
              </Button>{' '}
              <Button size="small" variant="blue" onClick={() => pushMj(r)}>推送 MJ</Button>{' '}
              <Button size="small" variant="blue" onClick={() => pushWebhook(r)}>推送 Webhook</Button>{' '}
              <Button
                size="small"
                variant="green"
                onClick={() =>
                  setOutcome({ taskId: r.taskId, title: r.title, verdict: 'effective', views: '', ctr: '', completion: '', note: '' })
                }
              >
                标记有效
              </Button>{' '}
              <Button
                size="small"
                variant="gray"
                onClick={() =>
                  setOutcome({ taskId: r.taskId, title: r.title, verdict: 'ineffective', views: '', ctr: '', completion: '', note: '' })
                }
              >
                标记无效
              </Button>{' '}
              <Button size="small" variant="gray" disabled={!effective} onClick={() => sediment(r.taskId, 'kb')}>
                沉淀到知识库
              </Button>{' '}
              <Button
                size="small"
                variant="gray"
                disabled={!effective || !r.skillId}
                onClick={() => sediment(r.taskId, 'skill')}
              >
                沉淀到 skill
              </Button>{' '}
              <Button size="small" onClick={() => redispatch(r)}>一键再发</Button>
              {!effective && (
                <div className="hint" style={{ marginTop: 4 }}>
                  沉淀需先把成果标记为「有效」{r.skillId ? '' : '；沉淀到 skill 仅限 skill 产出的成果'}。
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ---------- 交付页管理 ---------- */}
      <div className="card">
        <h2>交付页 <span className="tag">只读外链（可设口令/有效期）；链接明文只在生成时显示一次，这里只管状态</span></h2>
        {deliveries.length === 0 && <p className="hint">暂无交付页。在上方成果上点「生成交付页」创建。</p>}
        {deliveries.map((d) => (
          <div className="task" key={d.id}>
            <span className="tt">{d.title}</span>
            <Badge>{d.scope === 'task' ? '单任务' : '项目'}</Badge>
            {d.hasPassword && <Badge variant="adj">带口令</Badge>}
            {d.revoked ? (
              <Badge variant="rej">已撤销</Badge>
            ) : expired(d) ? (
              <Badge variant="rej">已过期</Badge>
            ) : (
              <Badge variant="done">有效</Badge>
            )}
            <div className="meta">
              浏览 {d.viewCount} 次 · 创建于 {d.createdAt.slice(0, 16).replace('T', ' ')}
              {d.expiresAt ? ` · 过期时间 ${d.expiresAt.slice(0, 16).replace('T', ' ')}` : ' · 不过期'}
            </div>
            {!d.revoked && (
              <div style={{ marginTop: 6 }}>
                <Button size="small" variant="gray" onClick={() => revokeDelivery(d)}>撤销</Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ---------- 标记有效/无效 ---------- */}
      {outcome && (
        <Dialog
          open
          onClose={() => setOutcome(null)}
          title={<>标记{outcome.verdict === 'effective' ? '有效' : '无效'} · {outcome.title}</>}
        >
            <p className="hint">填这份成果在渠道上的真实表现（都可留空，只记结论也行）；只有「有效」成果能沉淀进知识库 / skill。</p>
            <div className="row">
              <div>
                <label>播放量（views）</label>
                <Input type="number" min="0" value={outcome.views} onChange={(e) => setOutcome({ ...outcome, views: e.target.value })} placeholder="如：125000" />
              </div>
              <div>
                <label>点击率 ctr（%）</label>
                <Input type="number" min="0" step="0.01" value={outcome.ctr} onChange={(e) => setOutcome({ ...outcome, ctr: e.target.value })} placeholder="如：4.2" />
              </div>
              <div>
                <label>完播率（%）</label>
                <Input type="number" min="0" step="0.01" value={outcome.completion} onChange={(e) => setOutcome({ ...outcome, completion: e.target.value })} placeholder="如：38" />
              </div>
            </div>
            <label>备注</label>
            <Input value={outcome.note} onChange={(e) => setOutcome({ ...outcome, note: e.target.value })} placeholder="如：封面钩子有效，评论区都在问后续" />
            <div style={{ marginTop: 12 }}>
              <Button onClick={submitOutcome}>保存标记</Button>{' '}
              <Button variant="gray" onClick={() => setOutcome(null)}>取消</Button>
            </div>
        </Dialog>
      )}

      {/* ---------- 生成交付页 ---------- */}
      {delivery && (
        <Dialog open onClose={() => setDelivery(null)} title={<>生成交付页 · {delivery.title}</>}>
            {delivery.link ? (
              <>
                <p className="hint">交付页已生成（只读外链）。完整链接只显示这一次，请立即复制保存：</p>
                <pre className="result" style={{ wordBreak: 'break-all' }}>{delivery.link}</pre>
                <div style={{ marginTop: 12 }}>
                  <Button onClick={() => copyText(delivery.link)}>复制链接</Button>{' '}
                  <Button variant="gray" onClick={() => setDelivery(null)}>关闭</Button>
                </div>
              </>
            ) : (
              <>
                <div className="row">
                  <div>
                    <label>访问口令（可空）</label>
                    <Input value={delivery.password} onChange={(e) => setDelivery({ ...delivery, password: e.target.value })} placeholder="留空 = 无口令" />
                  </div>
                  <div>
                    <label>有效天数（可空 = 不过期）</label>
                    <Input type="number" min="1" value={delivery.days} onChange={(e) => setDelivery({ ...delivery, days: e.target.value })} placeholder="如：7" />
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <Button onClick={submitDelivery}>生成</Button>{' '}
                  <Button variant="gray" onClick={() => setDelivery(null)}>取消</Button>
                </div>
              </>
            )}
        </Dialog>
      )}
      {confirmNode}
    </>
  );
}
