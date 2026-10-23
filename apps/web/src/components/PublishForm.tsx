import { useEffect, useState } from 'react';
import { useApp } from '../context';

export default function PublishForm() {
  const { S, post, refresh, toast } = useApp();
  const [title, setTitle] = useState('');
  const [type, setType] = useState('文案');
  const [teamId, setTeamId] = useState('');
  const [brief, setBrief] = useState('');

  // 与原生版一致：小组下拉跟随最新数据，尽量保留当前选择
  useEffect(() => {
    if (S && S.teams.length && !S.teams.some((t) => t.id === teamId)) {
      setTeamId(S.teams[0].id);
    }
  }, [S, teamId]);

  if (!S) return null;

  async function createTask() {
    if (!title.trim()) return toast('先填标题');
    try {
      await post('/api/tasks', { title: title.trim(), type, brief, teamId });
    } catch { return; }
    setTitle('');
    setBrief('');
    toast('已发布，进队列了');
    refresh();
  }

  return (
    <div className="card" style={{ flex: 1.2 }}>
      <h2>发布真任务</h2>
      <label>标题</label>
      <input
        placeholder="如：给 MJ Drama 首支视频写英文标题"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="row">
        <div>
          <label>类型</label>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option>文案</option>
            <option>调研</option>
            <option>代码</option>
          </select>
        </div>
        <div>
          <label>交给哪个小组</label>
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            {S.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      </div>
      <label>说明（越具体产出越好）</label>
      <textarea
        rows={4}
        placeholder="题材、受众、长度、风格、必须包含的内容……"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
      />
      <div style={{ marginTop: 10 }}>
        <button className="btn" onClick={createTask}>发布任务</button>
      </div>
      <p className="hint">任务会进入队列自动开工（前提：该小组的 API 已填 Key 且余额充足，否则会停在待分配并写明原因）。</p>
    </div>
  );
}
