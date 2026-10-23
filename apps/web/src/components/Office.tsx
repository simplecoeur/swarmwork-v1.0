import { useEffect, useState } from 'react';
import { useApp } from '../context';
import type { AppState, Member } from '../types';

function memberStatus(S: AppState, m: Member): [string, string] {
  const t1 = S.tasks.find((t) => t.assigneeId === m.id && t.status === '执行中');
  if (t1) return ['执行中', 'st-run'];
  const t2 = S.tasks.find((t) => t.teamId === m.teamId && t.status === '待审核' && m.role === '审核');
  if (t2) return ['审核中', 'st-rev'];
  return ['待命', 'st-idle'];
}

function MemberChip({ m, color, onEdit }: { m: Member; color: string; onEdit: (id: string) => void }) {
  const { S } = useApp();
  if (!S) return null;
  const [st, cls] = memberStatus(S, m);
  return (
    <div className="member" onClick={() => onEdit(m.id)} title="点击编辑专属提示词">
      <div className="avatar" style={{ background: color }}>{m.name.slice(-2)}</div>
      <div className="mname">{m.name}</div>
      <div className="mrole">{m.role}</div>
      <div className="mrole"><span className={`dot ${cls}`}></span>{st}</div>
    </div>
  );
}

function MemberEditor({ memberId, onClose }: { memberId: string; onClose: () => void }) {
  const { S, post, refresh, toast } = useApp();
  const m = S?.members.find((x) => x.id === memberId);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');

  // 打开编辑器时把该成员的现有名字/提示词灌进表单（与原生版点击时渲染表单一致）
  useEffect(() => {
    if (m) {
      setName(m.name);
      setPrompt(m.prompt || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  if (!S || !m) return null;

  async function save() {
    try {
      await post('/api/members/prompt', { memberId, name, prompt });
    } catch { return; }
    onClose();
    toast('成员已更新');
    refresh();
  }

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h2>成员档案：{m.name}（{m.role}）</h2>
      <label>名字</label>
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <label>专属提示词（只对这个成员生效，会拼进他的干活指令）</label>
      <textarea
        rows={3}
        placeholder="如：文风幽默搞笑，标题爱用反问句……"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div style={{ marginTop: 8 }}>
        <button className="btn small blue" onClick={save}>保存</button>{' '}
        <button className="btn small gray" onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}

export default function Office() {
  const { S, apiName } = useApp();
  const [editingId, setEditingId] = useState<string | null>(null);
  if (!S) return null;
  return (
    <div className="card">
      <h2>办公室 <span className="tag">小人状态由真实任务驱动 · 点任意成员可改他的专属提示词</span></h2>
      <div>
        {S.teams.map((team) => {
          const ms = S.members.filter((m) => m.teamId === team.id);
          const reviewers = ms.filter((m) => m.role === '审核');
          const others = ms.filter((m) => m.role !== '审核');
          const apiTxt = team.apiId ? apiName(team.apiId) : '跟随默认（' + apiName(S.defaultApiId) + '）';
          return (
            <div className="teamzone" key={team.id}>
              <div className="tname">
                <span style={{ color: team.color }}>■</span> {team.name}{' '}
                <span style={{ fontWeight: 400, color: '#9aa0ae', fontSize: 12 }}>使用 API：{apiTxt}</span>
              </div>
              <div className="members">
                {others.map((m) => <MemberChip key={m.id} m={m} color={team.color} onEdit={setEditingId} />)}
              </div>
              <div className="hint" style={{ margin: '8px 0 4px' }}>审核桌（审核员常驻，成果送到这里审）：</div>
              <div className="members">
                {reviewers.map((m) => <MemberChip key={m.id} m={m} color={team.color} onEdit={setEditingId} />)}
              </div>
            </div>
          );
        })}
      </div>
      {editingId && <MemberEditor memberId={editingId} onClose={() => setEditingId(null)} />}
    </div>
  );
}
