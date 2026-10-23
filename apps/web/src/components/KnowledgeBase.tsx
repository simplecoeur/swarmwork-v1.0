import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchKb } from '../api';
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

  async function remove(e: KbEntry) {
    if (!window.confirm(`删除知识条目「${e.title}」？`)) return;
    try {
      await send('DELETE', `/api/kb/${e.id}`);
    } catch { return; }
    toast('已删除');
    if (editingId === e.id) setEditingId(null);
    load();
  }

  const visible = entries.filter((e) => filter === 'all' || e.scope === filter);

  return (
    <div className="card">
      <h2>知识库 <span className="tag">干活时自动注入参考 · 公司标准全文 + 关键词命中的小组/个人资料</span></h2>

      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
        <div style={{ flex: '0 0 220px' }}>
          <label>按范围筛选</label>
          <select value={filter} onChange={(ev) => setFilter(ev.target.value as 'all' | KbScope)}>
            <option value="all">全部范围</option>
            {SCOPE_ORDER.map((s) => (
              <option key={s} value={s}>{SCOPE_LABEL[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <button className="btn" onClick={startCreate}>新建条目</button>{' '}
          <button className="btn gray" onClick={load}>刷新</button>
        </div>
      </div>

      {editingId !== null && (
        <div className="apicard">
          <label>标题</label>
          <input value={form.title} onChange={(ev) => setForm({ ...form, title: ev.target.value })} placeholder="如：短剧标题公式" />
          <div className="row">
            <div>
              <label>范围</label>
              <select
                value={form.scope}
                onChange={(ev) => setForm({ ...form, scope: ev.target.value as KbScope, scopeId: '' })}
              >
                {SCOPE_ORDER.map((s) => (
                  <option key={s} value={s}>{SCOPE_LABEL[s]}</option>
                ))}
              </select>
            </div>
            {form.scope === 'team' && (
              <div>
                <label>所属小组</label>
                <select value={form.scopeId} onChange={(ev) => setForm({ ...form, scopeId: ev.target.value })}>
                  <option value="">请选择小组</option>
                  {S.teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}
            {form.scope === 'member' && (
              <div>
                <label>所属成员</label>
                <select value={form.scopeId} onChange={(ev) => setForm({ ...form, scopeId: ev.target.value })}>
                  <option value="">请选择成员</option>
                  {S.members.map((m) => (
                    <option key={m.id} value={m.id}>{teamName(m.teamId)} · {m.name}（{m.role}）</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <label>标签（逗号分隔，参与关键词检索）</label>
          <input value={form.tags} onChange={(ev) => setForm({ ...form, tags: ev.target.value })} placeholder="如：短剧, 钩子, 标题" />
          <label>正文</label>
          <textarea rows={6} value={form.body} onChange={(ev) => setForm({ ...form, body: ev.target.value })} placeholder="这条知识的完整内容，干活时会被拼进成员的指令里" />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              className="chk"
              checked={form.enabled}
              onChange={(ev) => setForm({ ...form, enabled: ev.target.checked })}
            />
            启用（停用后不再注入）
          </label>
          <div style={{ marginTop: 8 }}>
            <button className="btn small blue" onClick={save}>保存</button>{' '}
            <button className="btn small gray" onClick={() => setEditingId(null)}>取消</button>
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
                <span className="chip">{scopeName(e)}</span>
                <span className={`chip ${e.enabled ? 'done' : 'rej'}`}>{e.enabled ? '启用' : '停用'}</span>
                <div className="meta">
                  {e.tags.length ? <>标签：{e.tags.join('、')} · </> : null}
                  更新于 {new Date(e.updatedAt).toLocaleString()}
                </div>
                <pre className="result" style={{ maxHeight: 160 }}>{e.body}</pre>
                <button className="btn small gray" onClick={() => startEdit(e)}>编辑</button>{' '}
                <button className="btn small gray" onClick={() => toggleEnabled(e)}>{e.enabled ? '停用' : '启用'}</button>{' '}
                <button className="btn small gray" onClick={() => remove(e)}>删除</button>
              </div>
            ))}
          </div>
        );
      })}
      {!visible.length && <p className="hint">暂无知识条目。点「新建条目」添加公司标准、小组资料，或在成果列表把已完成成果一键存入。</p>}
    </div>
  );
}
