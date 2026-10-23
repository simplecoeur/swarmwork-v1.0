import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchKb } from '../api';
import { Badge, Button, Checkbox, EmptyState, Input, Select, Switch, Textarea, useConfirm } from './ui';
import type { KbEntry } from '../types';
import type { KbScope } from '@swarm/shared';

const SCOPE_LABEL: Record<KbScope, string> = { company: '公司', team: '小组', member: '成员' };
const SCOPE_ORDER: KbScope[] = ['company', 'team', 'member'];

interface FormState {
  title: string;
  body: string;
  scope: KbScope;
  scopeId: string;
  tags: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = { title: '', body: '', scope: 'company', scopeId: '', tags: '', enabled: true };

function toForm(e: KbEntry): FormState {
  return {
    title: e.title,
    body: e.body,
    scope: e.scope,
    scopeId: e.scopeId ?? '',
    tags: e.tags.join(', '),
    enabled: e.enabled,
  };
}

/**
 * 知识库页（M3 一期）：条目按范围分组/筛选、新建/编辑/删除、启用开关、标签编辑。
 * 条目在任务执行时按「公司 > 本组 > 本人 > 他组」优先级 + 关键词命中注入（见后端 §10）。
 */
export default function KnowledgeBase() {
  const { S, post, send, toast, teamName, memberName } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [filter, setFilter] = useState<'all' | KbScope>('all');
  const [editingId, setEditingId] = useState<string | null>(null); // null=未编辑；''=新建
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const load = useCallback(async () => {
    try {
      setEntries(await fetchKb());
    } catch {
      /* 服务重启瞬间忽略，与全局 refresh 一致 */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!S) return null;

  const scopeName = (e: KbEntry): string => {
    if (e.scope === 'company') return '全公司';
    if (e.scope === 'team') return teamName(e.scopeId ?? '');
    return memberName(e.scopeId);
  };

  function startCreate() {
    setForm(EMPTY_FORM);
    setEditingId('');
  }
  function startEdit(e: KbEntry) {
    setForm(toForm(e));
    setEditingId(e.id);
  }

  async function save() {
    const payload = {
      title: form.title.trim(),
      body: form.body,
      scope: form.scope,
      scopeId: form.scope === 'company' ? null : form.scopeId || null,
      tags: form.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      enabled: form.enabled,
    };
    try {
      if (editingId === '') await post('/api/kb', payload);
      else await send('PUT', `/api/kb/${editingId}`, payload);
    } catch { return; }
    toast('知识条目已保存');
    setEditingId(null);
    load();
  }

  async function toggleEnabled(e: KbEntry) {
    try {
      await send('PUT', `/api/kb/${e.id}`, { enabled: !e.enabled });
    } catch { return; }
    toast(e.enabled ? '已停用（停用后不再注入）' : '已启用');
    load();
  }

  function remove(e: KbEntry) {
    ask({
      title: '删除知识条目',
      message: `删除知识条目「${e.title}」？`,
      confirmLabel: '删除',
      onConfirm: async () => {
        try {
          await send('DELETE', `/api/kb/${e.id}`);
        } catch { return; }
        toast('已删除');
        if (editingId === e.id) setEditingId(null);
        load();
      },
    });
  }

  const visible = entries.filter((e) => filter === 'all' || e.scope === filter);

  return (
    <div className="card">
      <h2>知识库 <span className="tag">干活时自动注入参考 · 公司标准全文 + 关键词命中的小组/个人资料</span></h2>

      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
        <div style={{ flex: '0 0 220px' }}>
          <label>按范围筛选</label>
          <Select
            value={filter}
            onValueChange={(v) => setFilter(v as 'all' | KbScope)}
            options={[
              { value: 'all', label: '全部范围' },
              ...SCOPE_ORDER.map((s) => ({ value: s, label: SCOPE_LABEL[s] })),
            ]}
          />
        </div>
        <div>
          <Button onClick={startCreate}>新建条目</Button>{' '}
          <Button variant="gray" onClick={load}>刷新</Button>
        </div>
      </div>

      {editingId !== null && (
        <div className="apicard">
          <label>标题</label>
          <Input value={form.title} onChange={(ev) => setForm({ ...form, title: ev.target.value })} placeholder="如：短剧标题公式" />
          <div className="row">
            <div>
              <label>范围</label>
              <Select
                value={form.scope}
                onValueChange={(v) => setForm({ ...form, scope: v as KbScope, scopeId: '' })}
                options={SCOPE_ORDER.map((s) => ({ value: s, label: SCOPE_LABEL[s] }))}
              />
            </div>
            {form.scope === 'team' && (
              <div>
                <label>所属小组</label>
                <Select
                  value={form.scopeId}
                  onValueChange={(v) => setForm({ ...form, scopeId: v })}
                  placeholder="请选择小组"
                  options={S.teams.map((t) => ({ value: t.id, label: t.name }))}
                />
              </div>
            )}
            {form.scope === 'member' && (
              <div>
                <label>所属成员</label>
                <Select
                  value={form.scopeId}
                  onValueChange={(v) => setForm({ ...form, scopeId: v })}
                  placeholder="请选择成员"
                  options={S.members.map((m) => ({
                    value: m.id,
                    label: `${teamName(m.teamId)} · ${m.name}（${m.role}）`,
                  }))}
                />
              </div>
            )}
          </div>
          <label>标签（逗号分隔，参与关键词检索）</label>
          <Input value={form.tags} onChange={(ev) => setForm({ ...form, tags: ev.target.value })} placeholder="如：短剧, 钩子, 标题" />
          <label>正文</label>
          <Textarea rows={6} value={form.body} onChange={(ev) => setForm({ ...form, body: ev.target.value })} placeholder="这条知识的完整内容，干活时会被拼进成员的指令里" />
          <div style={{ marginTop: 8 }}>
            <Checkbox
              checked={form.enabled}
              onCheckedChange={(on) => setForm({ ...form, enabled: on })}
              label="启用（停用后不再注入）"
            />
          </div>
          <div style={{ marginTop: 8 }}>
            <Button size="small" variant="blue" onClick={save}>保存</Button>{' '}
            <Button size="small" variant="gray" onClick={() => setEditingId(null)}>取消</Button>
          </div>
        </div>
      )}

      {SCOPE_ORDER.map((scope) => {
        const group = visible.filter((e) => e.scope === scope);
        if (!group.length) return null;
        return (
          <div key={scope}>
            <div className="hint" style={{ margin: '10px 0 6px', fontWeight: 600 }}>{SCOPE_LABEL[scope]}级</div>
            {group.map((e) => (
              <div className={`task${e.enabled ? '' : ' kb-off'}`} key={e.id}>
                <span className="tt">{e.title}</span>
                <Badge>{scopeName(e)}</Badge>
                <Badge variant={e.enabled ? 'done' : 'rej'}>{e.enabled ? '启用' : '停用'}</Badge>
                <div className="meta">
                  {e.tags.length ? <>标签：{e.tags.join('、')} · </> : null}
                  更新于 {new Date(e.updatedAt).toLocaleString()}
                </div>
                <pre className="result" style={{ maxHeight: 160 }}>{e.body}</pre>
                <Button size="small" variant="gray" onClick={() => startEdit(e)}>编辑</Button>{' '}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8, verticalAlign: 'middle' }}>
                  <Switch checked={e.enabled} onCheckedChange={() => toggleEnabled(e)} ariaLabel={`启用/停用「${e.title}」`} />
                  <span className="hint">{e.enabled ? '启用中' : '已停用'}</span>
                </span>{' '}
                <Button size="small" variant="gray" onClick={() => remove(e)}>删除</Button>
              </div>
            ))}
          </div>
        );
      })}
      {!visible.length && (
        <EmptyState
          example={<>示例条目：《频道标题公式》公司级 · 标签：标题，钩子 · 正文写清可复用的公式与禁忌</>}
          action={
            <Button size="small" onClick={startCreate}>
              ＋ 新建条目
            </Button>
          }
        >
          暂无知识条目。添加公司标准、小组资料后，成员干活时会自动参考命中的条目；也可以在成果库把已完成成果一键存入。
        </EmptyState>
      )}
      {confirmNode}
    </div>
  );
}
