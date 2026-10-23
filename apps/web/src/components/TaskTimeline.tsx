import { useEffect, useRef, useState } from 'react';
import { fetchTaskTimeline } from '../api';
import { useApp } from '../context';
import type { TaskStep, TaskTimelineData } from '../types';
import { yuan } from '../utils';
import { Badge, EmptyState, Spinner } from './ui';

/**
 * 任务过程时间线（G-04）：纵向步骤流（task_steps 为主轨）+ 状态流水（task_events 为辅轨）合并按时间呈现。
 * 执行中（live）随 2s 轮询增量刷新；已完成任务打开即为完整回放——同一组件、同一接口、同一数据，无单独回放模式。
 * 呈现只用组件层（Badge/EmptyState/Spinner）与既有设计 token，不引入原生弹窗/下拉。
 */
const KIND_META: Record<TaskStep['kind'], { icon: string; label: string }> = {
  plan: { icon: '📋', label: '计划' },
  split: { icon: '🧩', label: '拆单' },
  inject: { icon: '📥', label: '注入' },
  execute: { icon: '▶️', label: '执行' },
  review: { icon: '🔍', label: '审核' },
  retry: { icon: '↩️', label: '重做' },
  blocked: { icon: '⛔', label: '停工' },
  recovered: { icon: '♻️', label: '回收' },
  adjudicated: { icon: '⚖️', label: '裁决' },
};

function humanDuration(ms: number | null): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function asStringArray(v: unknown): Array<{ title?: string; name?: string; ref?: string }> {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is { title?: string; name?: string; ref?: string } => !!x && typeof x === 'object');
}

function StepDetail({ step }: { step: TaskStep }) {
  const { setTab } = useApp();
  const d = step.detail ?? {};
  if (step.kind === 'inject') {
    const kb = asStringArray(d.kb);
    const assets = asStringArray(d.assets);
    if (!kb.length && !assets.length) return null;
    return (
      <div className="tl-detail">
        {kb.length ? (
          <div>
            命中知识：
            {kb.map((k, i) => (
              <button key={i} type="button" className="tl-link" onClick={() => setTab('kb')}>
                《{k.title ?? ''}》
              </button>
            ))}
          </div>
        ) : null}
        {assets.length ? (
          <div>
            命中资产：
            {assets.map((a, i) => (
              <button key={i} type="button" className="tl-link" onClick={() => setTab('assets')}>
                《{a.name ?? a.ref ?? ''}》
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (step.kind === 'review' && typeof d.pass === 'boolean') {
    return (
      <div className="tl-detail">
        <Badge variant={d.pass ? 'done' : 'rej'}>{d.pass ? '要点核对：通过' : '要点核对：不通过'}</Badge>
        {typeof d.reason === 'string' && d.reason ? <div>要点摘要：{d.reason}</div> : null}
      </div>
    );
  }
  if (step.kind === 'split' && Array.isArray(d.subtasks)) {
    const subs = d.subtasks as Array<{ index?: number; title?: string; type?: string }>;
    if (!subs.length) return null;
    return (
      <div className="tl-detail">
        {subs.map((s, i) => (
          <div key={i}>
            {s.index ?? i + 1}. 《{s.title ?? ''}》{s.type ? `（${s.type}）` : ''}
          </div>
        ))}
      </div>
    );
  }
  if (step.kind === 'retry' && typeof d.rejectReason === 'string' && d.rejectReason) {
    return <div className="tl-detail">打回理由：{d.rejectReason}</div>;
  }
  if (step.kind === 'blocked' && typeof d.reason === 'string' && d.reason) {
    return <div className="tl-detail">停工原因：{d.reason}</div>;
  }
  return null;
}

export default function TaskTimeline({ taskId, live }: { taskId: string; live?: boolean }) {
  const { memberName } = useApp();
  const [data, setData] = useState<TaskTimelineData | null>(null);
  const [failed, setFailed] = useState(false);
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetchTaskTimeline(taskId)
        .then((d) => {
          if (!stop) {
            setData(d);
            setFailed(false);
          }
        })
        .catch(() => {
          if (!stop) setFailed(true);
        });
    load();
    const timer = window.setInterval(() => {
      if (liveRef.current) load();
    }, 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [taskId]);

  if (!data) {
    return failed ? (
      <p className="hint">过程时间线加载失败，稍后自动重试。</p>
    ) : (
      <Spinner label="加载过程时间线…" />
    );
  }
  if (!data.steps.length && !data.events.length) {
    return <EmptyState>暂无过程记录（本任务创建于时间线功能上线前）。</EmptyState>;
  }

  // 合并双轨：按时间升序；同一时刻步骤优先于状态流水，轨内按 id 保持插入顺序
  type Row =
    | { key: string; ts: string; ord: number; step: TaskStep }
    | { key: string; ts: string; ord: number; event: TaskTimelineData['events'][number] };
  const rows: Row[] = [
    ...data.steps.map((s) => ({ key: `s${s.id}`, ts: s.createdAt, ord: 0, step: s }) as Row),
    ...data.events.map((e) => ({ key: `e${e.id}`, ts: e.createdAt, ord: 1, event: e }) as Row),
  ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.ord - b.ord));

  return (
    <div className="timeline">
      {rows.map((r) => {
        if ('step' in r) {
          const s = r.step;
          const meta = KIND_META[s.kind] ?? { icon: '•', label: s.kind };
          const dur = humanDuration(s.durationMs);
          const tokens =
            s.promptTokens != null || s.completionTokens != null
              ? `${(s.promptTokens ?? 0) + (s.completionTokens ?? 0)} token`
              : null;
          return (
            <div className="tl-row" key={r.key}>
              <span className="tl-icon" aria-hidden="true">{meta.icon}</span>
              <div className="tl-body">
                <div className="tl-head">
                  <Badge>{meta.label}</Badge>
                  <span className="tl-summary">{s.summary}</span>
                </div>
                <div className="tl-meta">
                  {s.createdAt.slice(5, 19).replace('T', ' ')}
                  {s.actorMemberId ? ` · ${memberName(s.actorMemberId)}` : ''}
                  {dur ? ` · 耗时 ${dur}` : ''}
                  {tokens ? ` · 用量 ${tokens}` : ''}
                  {s.costMilli ? ` · 成本 ${yuan(s.costYuan)}` : ''}
                </div>
                <StepDetail step={s} />
              </div>
            </div>
          );
        }
        const e = r.event;
        return (
          <div className="tl-row tl-row--event" key={r.key}>
            <span className="tl-icon" aria-hidden="true">·</span>
            <div className="tl-body">
              <div className="tl-meta">
                {e.createdAt.slice(5, 19).replace('T', ' ')}
                {` · 状态 ${e.fromStatus ?? '（新建）'} → ${e.toStatus}`}
                {e.note ? `（${e.note}）` : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
