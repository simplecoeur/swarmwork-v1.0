import { useApp } from '../context';
import { yuan } from '../utils';

const chipCls: Record<string, string> = {
  '已完成': 'done',
  '执行中': 'run',
  '待审核': 'rev',
  '被打回': 'rej',
  '待裁决': 'adj',
};

export default function TaskWall() {
  const { S, post, refresh, toast, teamName, memberName } = useApp();
  if (!S) return null;

  async function adjudicate(id: string) {
    try {
      await post('/api/tasks/adjudicate', { taskId: id });
    } catch { return; }
    toast('已裁决通过');
    refresh();
  }

  return (
    <div className="card">
      <h2>任务墙</h2>
      <div>
        {S.tasks.length ? (
          [...S.tasks].reverse().map((t) => (
            <div className="task" key={t.id}>
              <span className="tt">{t.title}</span>
              <span className={`chip ${chipCls[t.status] || ''}`}>{t.status}</span>
              <span className="chip">{t.type}</span>
              <div className="meta">
                {teamName(t.teamId)} · 负责人：{memberName(t.assigneeId)}
                {' · 全程 '}{t.totalTokens || 0} token / {yuan(t.totalCost)}
                {t.rejectCount ? ` · 被打回 ${t.rejectCount} 次` : ''}
                {t.reviewNote ? <><br />审核结论：{t.reviewNote}</> : null}
              </div>
              {t.rejectReason ? <div className="reject">打回/裁决原因：{t.rejectReason}</div> : null}
              {t.blockedReason ? <div className="blocked">停工原因：{t.blockedReason}</div> : null}
              {t.status === '待裁决' ? (
                <div style={{ marginTop: 6 }}>
                  <button className="btn small green" onClick={() => adjudicate(t.id)}>裁决通过</button>
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <p className="hint">还没有任务，去上面发布第一单真活。</p>
        )}
      </div>
    </div>
  );
}
