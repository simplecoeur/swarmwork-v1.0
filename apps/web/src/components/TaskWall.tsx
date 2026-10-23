import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchKb } from '../api';
import { yuan } from '../utils';

const chipCls: Record<string, string> = {
  '已完成': 'done',
  '执行中': 'run',
  '待审核': 'rev',
  '被打回': 'rej',
  '待裁决': 'adj',
  '已取消': 'can',
};

export default function TaskWall() {
  const { S, post, refresh, toast, teamName, memberName } = useApp();
  // 注入审计展示：把任务记录的 injectedKbIds 映射成条目标题（ids 变化时才重拉）
  const [kbTitles, setKbTitles] = useState<Record<string, string>>({});
  const injectedSig = S ? S.tasks.map((t) => t.injectedKbIds.join(',')).join('|') : '';
  useEffect(() => {
    if (!injectedSig.replace(/[|,]/g, '')) return;
    fetchKb()
      .then((entries) => setKbTitles(Object.fromEntries(entries.map((e) => [e.id, e.title]))))
      .catch(() => {});
  }, [injectedSig]);

  if (!S) return null;

  async function adjudicate(id: string) {
    try {
      await post('/api/tasks/adjudicate', { taskId: id });
    } catch { return; }
    toast('已裁决通过');
    refresh();
  }

  /* 后悔药（M5）：取消/重试/删除，全部先 confirm 二次确认，合法性由后端状态机兜底 */
  async function cancelTask(id: string, title: string) {
    if (!window.confirm(`取消任务「${title}」？取消后不会再被执行。`)) return;
    try {
      await post(`/api/tasks/${id}/cancel`);
    } catch { return; }
    toast('任务已取消');
    refresh();
  }
  async function retryTask(id: string, title: string) {
    if (!window.confirm(`重试任务「${title}」？将清除停工原因并重新排队。`)) return;
    try {
      await post(`/api/tasks/${id}/retry`);
    } catch { return; }
    toast('已清除停工原因，重新排队');
    refresh();
  }
  async function deleteTask(id: string, title: string) {
    if (!window.confirm(`删除任务「${title}」的记录？账本流水会保留，不影响对账与余额。`)) return;
    try {
      await post(`/api/tasks/${id}/delete`);
    } catch { return; }
    toast('任务记录已删除（账本保留）');
    refresh();
  }

  return (
    <div className="card">
      <h2>任务墙</h2>
      <div>
        {S.tasks.length ? (
          [...S.tasks].reverse().map((t) => (
            <div className="task" key={t.id} id={`task-${t.id}`}>
              <span className="tt">{t.title}</span>
              <span className={`chip ${chipCls[t.status] || ''}`}>{t.status}</span>
              <span className="chip">{t.type}</span>
              <div className="meta">
                {teamName(t.teamId)} · 负责人：{memberName(t.assigneeId)}
                {' · 全程 '}{t.totalTokens || 0} token / {yuan(t.totalCost)}
                {t.rejectCount ? ` · 被打回 ${t.rejectCount} 次` : ''}
                {t.reviewNote ? <><br />审核结论：{t.reviewNote}</> : null}
                {t.injectedKbIds.length ? (
                  <><br />本单注入知识：{t.injectedKbIds.map((id) => kbTitles[id] ?? id).join('、')}</>
                ) : null}
              </div>
              {t.rejectReason ? <div className="reject">打回/裁决原因：{t.rejectReason}</div> : null}
              {t.blockedReason ? <div className="blocked">停工原因：{t.blockedReason}</div> : null}
              {(() => {
                // 后悔药按钮按状态出（M5）：口径与后端 domain 一致，前端只做显隐、后端兜底校验
                const canCancel =
                  t.status === '待领取' ||
                  t.status === '被打回' ||
                  (t.status === '待审核' && !!t.blockedCode);
                const canRetry = !!t.blockedCode && t.status !== '已完成' && t.status !== '已取消';
                const canDelete = t.status === '已完成' || t.status === '已取消';
                if (t.status !== '待裁决' && !canCancel && !canRetry && !canDelete) return null;
                return (
                  <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {t.status === '待裁决' ? (
                      <button className="btn small green" onClick={() => adjudicate(t.id)}>裁决通过</button>
                    ) : null}
                    {canRetry ? (
                      <button className="btn small blue" onClick={() => retryTask(t.id, t.title)}>重试</button>
                    ) : null}
                    {canCancel ? (
                      <button className="btn small gray" onClick={() => cancelTask(t.id, t.title)}>取消任务</button>
                    ) : null}
                    {canDelete ? (
                      <button className="btn small gray" onClick={() => deleteTask(t.id, t.title)}>删除记录</button>
                    ) : null}
                  </div>
                );
              })()}
            </div>
          ))
        ) : (
          <p className="hint">还没有任务，去上面发布第一单真活。</p>
        )}
      </div>
    </div>
  );
}
