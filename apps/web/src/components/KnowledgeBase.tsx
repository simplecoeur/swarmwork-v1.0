import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { confirmKbImport, fetchKb, previewKbImport, searchKbTest, type KbSearchTestHit } from '../api';
import { Badge, Button, Checkbox, Dialog, EmptyState, Input, Select, Switch, Textarea, useConfirm } from './ui';
import type { KbEntry, KbImportDraft } from '../types';
import type { KbScope } from '@swarm/shared';

/* v1.5.0 B 术语归一：四档 平台/公司/小组/成员（与注入优先级同序）；
 * 后端 personal 条目在用户侧呈现为「成员」档（scopeKey 折算）。 */
const SCOPE_LABEL: Record<string, string> = { platform: '平台', company: '公司', team: '小组', member: '成员' };
const SCOPE_ORDER: string[] = ['platform', 'company', 'team', 'member'];
/** 表单可选范围（平台级仅管理员在管理台维护，普通面板不给入口） */
const FORM_SCOPES: KbScope[] = ['company', 'team', 'member'];
const scopeKey = (e: KbEntry): string => (e.scope === 'personal' ? 'member' : e.scope);

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
  const { S, post, send, toast, teamName, memberName, user, setTab } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [filter, setFilter] = useState<'all' | string>('all');
  const [editingId, setEditingId] = useState<string | null>(null); // null=未编辑；''=新建
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  /* G-06 文件导入（两段式 Dialog：选范围+文件 → 预览勾选/改 title → 确认落库） */
  const [importOpen, setImportOpen] = useState(false);
  const [impScope, setImpScope] = useState<KbScope>('company');
  const [impScopeId, setImpScopeId] = useState('');
  const [impFile, setImpFile] = useState<File | null>(null);
  const [impFilename, setImpFilename] = useState('');
  const [impDrafts, setImpDrafts] = useState<Array<KbImportDraft & { include: boolean }>>([]);
  const [impBusy, setImpBusy] = useState(false);
  /* v1.5.0 E 搜索测试：按当前注入策略回放一句话会命中哪些条目 */
  const [testQuery, setTestQuery] = useState('');
  const [testTeamId, setTestTeamId] = useState('');
  const [testHits, setTestHits] = useState<KbSearchTestHit[] | null>(null);
  const [testMeta, setTestMeta] = useState<{ capTokens: number; totalTokens: number } | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  async function runSearchTest() {
    const q = testQuery.trim();
    if (!q) return toast('先输入一句任务描述');
    setTestBusy(true);
    try {
      const r = await searchKbTest(q, { teamId: testTeamId || undefined });
      setTestHits(r.hits);
      setTestMeta({ capTokens: r.capTokens, totalTokens: r.totalTokens });
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setTestBusy(false);
    }
  }

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
    if (e.scope === 'platform') return '平台公共';
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

  async function runKbPreview() {
    if (!impFile) return toast('先选择文件');
    if (impScope !== 'company' && !impScopeId) return toast('先选择范围归属');
    setImpBusy(true);
    try {
      const pv = await previewKbImport(impFile, impScope, impScope === 'company' ? null : impScopeId || null);
      setImpFilename(pv.filename);
      setImpDrafts(pv.drafts.map((d) => ({ ...d, include: true })));
      if (!pv.drafts.length) toast('没有解析出条目');
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setImpBusy(false);
    }
  }

  async function runKbConfirm() {
    const picked = impDrafts.filter((d) => d.include);
    if (!picked.length) return toast('至少勾选一条');
    setImpBusy(true);
    try {
      const res = await confirmKbImport({
        filename: impFilename,
        scope: impScope,
        scopeId: impScope === 'company' ? null : impScopeId || null,
        drafts: picked.map((d) => ({ title: d.title, body: d.body, tags: d.tags })),
      });
      toast(`导入完成：成功 ${res.created} 条${res.failed ? `，失败 ${res.failed} 条` : ''}`);
      setImportOpen(false);
      setImpDrafts([]);
      setImpFile(null);
      load();
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setImpBusy(false);
    }
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

  const visible = entries.filter((e) => filter === 'all' || scopeKey(e) === filter);

  return (
    <div className="card">
      <h2>知识库 <span className="tag">干活时自动注入参考 · 平台公共 + 公司标准全文 + 关键词命中的小组/成员资料</span></h2>

      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
        <div style={{ flex: '0 0 220px' }}>
          <label>按范围筛选</label>
          <Select
            value={filter}
            onValueChange={(v) => setFilter(v as 'all' | string)}
            options={[
              { value: 'all', label: '全部范围' },
              ...SCOPE_ORDER.map((s) => ({ value: s, label: SCOPE_LABEL[s] })),
            ]}
          />
        </div>
        <div>
          <Button onClick={startCreate}>新建条目</Button>{' '}
          <Button variant="gray" onClick={() => setImportOpen(true)}>文件导入</Button>{' '}
          <Button variant="gray" onClick={load}>刷新</Button>
          {user?.isPlatformAdmin && (
            <>
              {' '}
              <Button variant="gray" onClick={() => setTab('admin')}>去管理台维护平台知识</Button>
            </>
          )}
        </div>
      </div>

      <div className="apicard" style={{ marginBottom: 10 }}>
        <div className="hint" style={{ fontWeight: 600, marginBottom: 6 }}>
          搜索测试 <span style={{ fontWeight: 400 }}>输入一句任务描述，预览按当前注入策略实际会命中的条目与顺序（发单前先验知识会不会被用上）</span>
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 320px' }}>
            <label>任务描述</label>
            <Input
              value={testQuery}
              onChange={(ev) => setTestQuery(ev.target.value)}
              placeholder="如：给新剧写一版招商标题"
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') void runSearchTest();
              }}
            />
          </div>
          <div style={{ flex: '0 0 200px' }}>
            <label>以哪个小组视角</label>
            <Select
              value={testTeamId}
              onValueChange={setTestTeamId}
              placeholder="（第一个小组）"
              options={S.teams.map((t) => ({ value: t.id, label: t.name }))}
            />
          </div>
          <div>
            <Button variant="blue" onClick={runSearchTest} disabled={testBusy}>
              {testBusy ? '测试中…' : '测试命中'}
            </Button>
          </div>
        </div>
        {testHits !== null && (
          <div style={{ marginTop: 8 }}>
            {testHits.length === 0 && <div className="hint">没有命中任何条目：换个说法，或检查条目是否启用、标签是否覆盖关键词。</div>}
            {testHits.map((h, i) => (
              <div key={h.id} className="meta" style={{ margin: '4px 0' }}>
                {i + 1}. <b>{h.title}</b> <Badge>{h.rankLabel}</Badge> 约 {h.tokens} token
              </div>
            ))}
            {testMeta && (
              <div className="hint" style={{ marginTop: 4 }}>
                合计约 {testMeta.totalTokens} token（无预算时注入上限 {testMeta.capTokens} token，超限的条目会被跳过）
              </div>
            )}
          </div>
        )}
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
                options={FORM_SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s] }))}
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
        const group = visible.filter((e) => scopeKey(e) === scope);
        if (!group.length) return null;
        const isPlatform = scope === 'platform';
        return (
          <div key={scope}>
            <div className="hint" style={{ margin: '10px 0 6px', fontWeight: 600 }}>{SCOPE_LABEL[scope]}级</div>
            {group.map((e) => (
              <div className={`task${e.enabled ? '' : ' kb-off'}`} key={e.id}>
                <span className="tt">{e.title}</span>
                <Badge>{scopeName(e)}</Badge>
                {isPlatform && <Badge variant="adj">平台公共 · 只读</Badge>}
                <Badge variant={e.enabled ? 'done' : 'rej'}>{e.enabled ? '启用' : '停用'}</Badge>
                <div className="meta">
                  {e.tags.length ? <>标签：{e.tags.join('、')} · </> : null}
                  更新于 {new Date(e.updatedAt).toLocaleString()}
                </div>
                <pre className="result" style={{ maxHeight: 160 }}>{e.body}</pre>
                {!isPlatform && (
                  <>
                    <Button size="small" variant="gray" onClick={() => startEdit(e)}>编辑</Button>{' '}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8, verticalAlign: 'middle' }}>
                      <Switch checked={e.enabled} onCheckedChange={() => toggleEnabled(e)} ariaLabel={`启用/停用「${e.title}」`} />
                      <span className="hint">{e.enabled ? '启用中' : '已停用'}</span>
                    </span>{' '}
                    <Button size="small" variant="gray" onClick={() => remove(e)}>删除</Button>
                  </>
                )}
                {isPlatform && (
                  <div className="hint">平台公共知识由平台管理员在管理台统一维护，所有空间干活时按最高优先级参考。</div>
                )}
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

      {importOpen && (
        <Dialog open onClose={() => setImportOpen(false)} title="文件导入知识库" wide={720}>
          <p className="hint">
            支持 .md / .txt / .csv / .docx，单文件 ≤5MB、单次 ≤500 条。md 按标题切分、txt 按空行分段、
            csv 需 title,body,tags 表头、docx 自动提纯文本。先预览，确认后才落库。
          </p>
          <div className="row">
            <div>
              <label>范围</label>
              <Select
                value={impScope}
                onValueChange={(v) => { setImpScope(v as KbScope); setImpScopeId(''); }}
                options={FORM_SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s] }))}
              />
            </div>
            {impScope === 'team' && (
              <div>
                <label>所属小组</label>
                <Select
                  value={impScopeId}
                  onValueChange={setImpScopeId}
                  placeholder="请选择小组"
                  options={S.teams.map((t) => ({ value: t.id, label: t.name }))}
                />
              </div>
            )}
            {impScope === 'member' && (
              <div>
                <label>所属成员</label>
                <Select
                  value={impScopeId}
                  onValueChange={setImpScopeId}
                  placeholder="请选择成员"
                  options={S.members.map((m) => ({
                    value: m.id,
                    label: `${teamName(m.teamId)} · ${m.name}（${m.role}）`,
                  }))}
                />
              </div>
            )}
          </div>
          <label>选择文件</label>
          <Input
            type="file"
            accept=".md,.markdown,.txt,.csv,.docx"
            onChange={(e) => { setImpFile(e.target.files?.[0] ?? null); setImpDrafts([]); }}
          />
          <div style={{ marginTop: 10 }}>
            <Button size="small" variant="blue" onClick={runKbPreview} disabled={impBusy || !impFile}>
              {impBusy ? '解析中…' : '解析预览'}
            </Button>
          </div>
          {impDrafts.length > 0 && (
            <>
              <div className="hint" style={{ margin: '10px 0 6px', fontWeight: 600 }}>
                预览共 {impDrafts.length} 条，已勾选 {impDrafts.filter((d) => d.include).length} 条（可逐条改标题）
              </div>
              {impDrafts.map((d, i) => (
                <div className="apicard" key={i}>
                  <Checkbox
                    checked={d.include}
                    onCheckedChange={(on) => {
                      const next = [...impDrafts];
                      next[i] = { ...d, include: on };
                      setImpDrafts(next);
                    }}
                    label={`第 ${i + 1} 条`}
                  />
                  <Input
                    value={d.title}
                    onChange={(e) => {
                      const next = [...impDrafts];
                      next[i] = { ...d, title: e.target.value };
                      setImpDrafts(next);
                    }}
                    placeholder="条目标题"
                  />
                  <div className="meta">
                    {d.tags.length ? <>标签：{d.tags.join('、')} · </> : null}
                    {d.body.slice(0, 140)}
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 10 }}>
                <Button onClick={runKbConfirm} disabled={impBusy}>确认导入</Button>{' '}
                <Button variant="gray" onClick={() => setImportOpen(false)}>取消</Button>
              </div>
            </>
          )}
        </Dialog>
      )}
      {confirmNode}
    </div>
  );
}
