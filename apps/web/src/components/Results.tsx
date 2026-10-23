import { useApp } from '../context';
import { yuan } from '../utils';

export default function Results() {
  const { S, post, toast, teamName, memberName } = useApp();
  if (!S) return null;
  const done = S.tasks.filter((t) => t.status === '已完成');

  async function saveToKb(id: string) {
    try {
      await post(`/api/kb/from-task/${id}`);
    } catch { return; }
    toast('已存入知识库（归属本任务小组，可在「知识库」页查看）');
  }

  function copyResult(id: string) {
    const t = S!.tasks.find((x) => x.id === id);
    if (!t) return;
    navigator.clipboard.writeText(t.result || '').then(() => toast('已复制'));
  }
  function downloadResult(id: string) {
    const t = S!.tasks.find((x) => x.id === id);
    if (!t) return;
    const blob = new Blob(['# ' + t.title + '\n\n' + (t.result || '')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = t.title.replace(/[\\/:*?"<>|]/g, '_') + '.md';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="card">
      <h2>成果列表 <span className="tag">真实产出，非模拟</span></h2>
      <div>
        {done.length ? (
          [...done].reverse().map((t) => (
            <div className="task" key={t.id}>
              <span className="tt">{t.title}</span>
              <span className="chip done">已交付</span>
              <div className="meta">
                {teamName(t.teamId)} · {memberName(t.assigneeId)} · {t.totalTokens || 0} token / {yuan(t.totalCost)}
              </div>
              <pre className="result">{t.result}</pre>
              <button className="btn small gray" onClick={() => copyResult(t.id)}>复制</button>{' '}
              <button className="btn small gray" onClick={() => downloadResult(t.id)}>下载 .md</button>{' '}
              <button className="btn small gray" onClick={() => saveToKb(t.id)}>存入知识库</button>
            </div>
          ))
        ) : (
          <p className="hint">暂无已交付成果。</p>
        )}
      </div>
    </div>
  );
}
