import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchMyThread, type ThreadMessageItem } from '../api';
import { Badge, Button, EmptyState, Select, Spinner, Textarea } from './ui';

/**
 * v1.5.0 L 平台消息（用户端）：与平台管理员的双向文本线程（收件人恒为空间所有者本人）。
 * 打开即标记已读；可给消息挂本空间小组作为上下文标签。不是实时 IM，刷新拉取。
 */
export default function MessagesPanel() {
  const { S, post, toast } = useApp();
  const [messages, setMessages] = useState<ThreadMessageItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetchMyThread();
      setMessages(r.messages);
      // 打开即已读（服务端按 owner 侧计数）
      post('/api/messages/thread/read').catch(() => {});
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoaded(true);
    }
  }, [post, toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function sendMsg() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      await post('/api/messages/thread/messages', { body, ...(teamId ? { teamId } : {}) });
      setDraft('');
      await load();
    } catch {
      /* post 已 toast */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        这里是与平台管理员的沟通线程：技能下发说明、审核补充、运营通知都会落到这里，你可以直接回复。
      </p>
      {!loaded && (
        <p>
          <Spinner label="加载中…" />
        </p>
      )}
      {loaded && messages.length === 0 && <EmptyState>暂无消息，平台管理员联系你时会显示在这里。</EmptyState>}
      <div>
        {messages.map((m) => (
          <div className="task" key={m.id} style={m.senderType === 'owner' ? { marginLeft: 32 } : { marginRight: 32 }}>
            <span className="tt" style={{ fontSize: 13 }}>
              {m.senderType === 'owner' ? '我' : m.senderUserId === 'user_ai_operator' ? 'AI 运营官' : '平台管理员'}
            </span>{' '}
            <Badge>{new Date(m.createdAt).toLocaleString()}</Badge>
            {m.kind === 'skill_push' && <Badge variant="adj">技能下发</Badge>}
            {m.kind === 'review_note' && <Badge variant="rev">审核说明</Badge>}
            {m.teamName && <Badge>关于小组：{m.teamName}</Badge>}
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{m.body}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Textarea
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="回复平台管理员…"
          aria-label="回复内容"
        />
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 6 }}>
          <div style={{ flex: '0 0 220px' }}>
            <label>关联小组（可选）</label>
            <Select
              value={teamId}
              onValueChange={setTeamId}
              placeholder="不关联"
              emptyLabel="不关联"
              options={(S?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))}
            />
          </div>
          <div>
            <Button variant="blue" disabled={busy || !draft.trim()} onClick={sendMsg}>
              {busy ? '发送中…' : '发送'}
            </Button>{' '}
            <Button variant="gray" onClick={load}>刷新</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
