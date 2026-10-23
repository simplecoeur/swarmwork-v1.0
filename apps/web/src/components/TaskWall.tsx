import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchKb } from '../api';
import { yuan } from '../utils';
import TaskTimeline from './TaskTimeline';
import { Badge, Button, EmptyState, useConfirm, type BadgeVariant } from './ui';

const chipCls: Record<string, BadgeVariant> = {
  '已完成': 'done',
  '执行中': 'run',
  '待审核': 'rev',
  '被打回': 'rej',
  '待裁决': 'adj',
  '已取消': 'can',
};

export default function TaskWall() {
  const { S, post, refresh, toast, teamName, memberName } = useApp();
  const { ask, confirmNode } = useConfirm();
  // G-04：过程时间线展开态（按任务 id）；执行中随组件内 2s 轮询增量刷新，已完成打开即回放
  const [openTl, setOpenTl] = useState<Record<string, boolean>>({});
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

  /* 后悔药（M5）：取消/重试/删除，全部先走自有确认弹窗二次确认，合法性由后端状态机兜底 */
  function cancelTask(id: string, title: string) {
    ask({
      title: '取消任务',
      message: `取消任务「${title}」？取消后不会再被执行。`,
      confirmLabel: '取消任务',
      onConfirm: async () => {
        try {
          await post(`/api/tasks/${id}/cancel`);
        } catch { return; }
        toast('任务已取消');
        refresh();
      },
    });
  }
  function retryTask(id: string, title: string) {
    ask({
      title: '重试任务',
      message: `重试任务「${title}」？将清除停工原因并重新排队。`,
      confirmLabel: '重试',
      onConfirm: async () => {
        try {
          await post(`/api/tasks/${id}/retry`);
        } catch { return; }
        toast('已清除停工原因，重新排队');
        refresh();
      },
    });
  }
  function deleteTask(id: string, title: string) {
    ask({
      title: '删除任务记录',
      message: `删除任务「${title}」的记录？账本流水会保留，不影响对账与余额。`,
      confirmLabel: '删除记录',
      onConfirm: async () => {
        try {
          await post(`/api/tasks/${id}/delete`);
        } catch { return; }
        toast('任务记录已删除（账本保留）');
        refresh();
      },
    });
  }

  return (
    <div className="card">
      <h2>任务墙</h2>
      <div>
        {S.tasks.length ? (
          [...S.tasks].reverse().map((t) => (
            <div className="task" key={t.id} id={`task-${t.id}`}>
              <span className="tt">{t.title}</span>
              <Badge variant={chipCls[t.status] ?? 'default'}>{t.status}</Badge>
              <Badge>{t.type}</Badge>
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
              <div style={{ marginTop: 6 }}>
                <Button
                  size="small"
                  variant="gray"
                  onClick={() => setOpenTl((m) => ({ ...m, [t.id]: !m[t.id] }))}
                >
                  {openTl[t.id] ? '收起过程时间线' : '过程时间线'}
                </Button>
              </div>
              {openTl[t.id] ? (
                <TaskTimeline taskId={t.id} live={t.status !== '已完成' && t.status !== '已取消'} />
              ) : null}
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
                      <Button size="small" variant="green" onClick={() => adjudicate(t.id)}>裁决通过</Button>
                    ) : null}
                    {canRetry ? (
                      <Button size="small" variant="blue" onClick={() => retryTask(t.id, t.title)}>重试</Button>
                    ) : null}
                    {canCancel ? (
                      <Button size="small" variant="gray" onClick={() => cancelTask(t.id, t.title)}>取消任务</Button>
                    ) : null}
                    {canDelete ? (
                      <Button size="small" variant="gray" onClick={() => deleteTask(t.id, t.title)}>删除记录</Button>
                    ) : null}
                  </div>
                );
              })()}
            </div>
          ))
        ) : (
          <EmptyState
            example={<>示例：《新剧第 1 集》英文标题 · 文案 · 已完成 · 全程 12,300 token / ¥0.025</>}
            action={
              <Button
                size="small"
                onClick={() =>
                  document.getElementById('publish-anchor')?.scrollIntoView({ behavior: 'smooth' })
                }
              >
                去发布第一单
              </Button>
            }
          >
            还没有任务。发布一单真活，团队就会自动领取、执行、审核并交付到这里。
          </EmptyState>
        )}
      </div>
      {confirmNode}
    </div>
  );
}
