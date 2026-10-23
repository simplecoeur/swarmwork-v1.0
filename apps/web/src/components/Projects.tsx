import { useState } from 'react';
import { useApp } from '../context';
import { yuan } from '../utils';

const projChipCls: Record<string, string> = {
  '已交付': 'done',
  '待裁决': 'adj',
  '进行中': 'run',
};

const taskChipCls: Record<string, string> = {
  '已完成': 'done',
  '执行中': 'run',
  '待审核': 'rev',
  '被打回': 'rej',
  '待裁决': 'adj',
  '已取消': 'can',
};

/** 点子任务行 → 滚动到任务墙对应卡片并闪烁定位 */
function jumpToTask(taskId: string) {
  const el = document.getElementById(`task-${taskId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  window.setTimeout(() => el.classList.remove('flash'), 1600);
}

/**
 * 项目视图（M5）：方案下发的项目制容器。
 * 进度 = 子任务完成数/总数；总账取服务端聚合（子任务账本 + 拆单调用那笔，见 state.projects）；
 * 状态聚合与 §15.2 一致（任一子任务待裁决→待裁决，全部完成→已交付），由服务端维护、前端只展示。
 */
export default function Projects() {
  const { S, teamName } = useApp();
  const [openId, setOpenId] = useState<string | null>(null);
  if (!S || !S.projects.length) return null;

  return (
    <div className="card">
      <h2>项目 <span className="tag">方案下发 · 组长拆单 · 进度与总账按子任务聚合</span></h2>
      <div>
        {[...S.projects].reverse().map((p) => {
          const children = S.tasks.filter((t) => t.projectId === p.id);
          const done = children.filter((t) => t.status === '已完成').length;
          const cancelled = children.filter((t) => t.status === '已取消').length;
          const pct = children.length ? Math.round((done / children.length) * 100) : 0;
          const open = openId === p.id;
          return (
            <div className="task" key={p.id}>
              <span className="tt">{p.name}</span>
              <span className={`chip ${projChipCls[p.status] || ''}`}>{p.status}</span>
              <div className="meta">
                {teamName(p.teamId)}
                {p.clientName ? ` · 甲方：${p.clientName}` : ''}
                {` · 子任务进度 ${done}/${children.length} 完成`}
                {cancelled ? `（含 ${cancelled} 个已取消）` : ''}
                {` · 项目总账 ${p.totalTokens || 0} token / ${yuan(p.totalCost)}（含拆单调用）`}
                {p.brief ? <><br />方案说明：{p.brief}</> : null}
              </div>
              <div className="pbar"><div style={{ width: `${pct}%` }} /></div>
              <div style={{ marginTop: 6 }}>
                <button className="btn small gray" onClick={() => setOpenId(open ? null : p.id)}>
                  {open ? '收起子任务' : `展开子任务（${children.length}）`}
                </button>
              </div>
              {open && (
                <div style={{ marginTop: 4 }}>
                  {children.length ? (
                    children.map((t) => (
                      <div
                        className="subtask"
                        key={t.id}
                        onClick={() => jumpToTask(t.id)}
                        title="点击定位到任务墙卡片"
                      >
                        <span style={{ fontWeight: 700 }}>{t.title}</span>
                        <span className={`chip ${taskChipCls[t.status] || ''}`}>{t.status}</span>
                        <span className="chip">{t.type}</span>
                        <span className="meta">{` · ${t.totalTokens || 0} token / ${yuan(t.totalCost)}`}</span>
                      </div>
                    ))
                  ) : (
                    <p className="hint">暂无子任务。</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
