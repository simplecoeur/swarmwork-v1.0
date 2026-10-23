import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchRegistry, fetchSkills } from '../api';
import AssetRefPicker from './AssetRefPicker';
import type { AssetRef, RegistryRole, SkillInputField, SkillListItem } from '../types';

const STATUS_LABEL: Record<string, string> = { draft: '草稿', published: '已发布', archived: '已归档' };
const VIS_LABEL: Record<string, string> = {
  private: '私有',
  workspace: '本空间可见',
  public: '已上架平台库',
  pending_review: '上架待审核',
};
const FIELD_TYPES: Array<SkillInputField['type']> = ['text', 'textarea', 'select', 'number', 'checkbox'];
const KB_SCOPES = ['personal', 'team', 'company', 'platform'];
const KB_SCOPE_LABEL: Record<string, string> = {
  personal: '个人',
  team: '小组',
  company: '公司',
  platform: '平台',
};

type ParamValue = string | number | boolean;

/* ---------------- 参数表编辑行 ---------------- */
interface ParamRow {
  key: string;
  label: string;
  type: SkillInputField['type'];
  required: boolean;
  defaultText: string;
  optionsText: string;
  placeholder: string;
}

const EMPTY_ROW: ParamRow = {
  key: '',
  label: '',
  type: 'text',
  required: false,
  defaultText: '',
  optionsText: '',
  placeholder: '',
};

function rowFromField(f: SkillInputField): ParamRow {
  return {
    key: f.key,
    label: f.label,
    type: f.type,
    required: !!f.required,
    defaultText: f.default === undefined ? '' : String(f.default),
    optionsText: (f.options ?? []).join(', '),
    placeholder: f.placeholder ?? '',
  };
}

function fieldFromRow(r: ParamRow): SkillInputField {
  const f: SkillInputField = {
    key: r.key.trim(),
    label: r.label.trim() || r.key.trim(),
    type: r.type,
    required: r.required,
  };
  if (r.placeholder.trim()) f.placeholder = r.placeholder.trim();
  if (r.type === 'select') {
    f.options = r.optionsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  }
  if (r.defaultText !== '') {
    if (r.type === 'number') f.default = Number(r.defaultText) || 0;
    else if (r.type === 'checkbox') f.default = r.defaultText === 'true' || r.defaultText === '是';
    else f.default = r.defaultText;
  }
  return f;
}

/* ---------------- 技能编辑表单状态 ---------------- */
interface SkillForm {
  name: string;
  description: string;
  role: string;
  promptTemplate: string;
  rows: ParamRow[];
  kbScopes: string[];
  kbTags: string;
  outputSpec: string;
  exampleInputText: string;
  exampleOutput: string;
  changelog: string;
  visibility: 'private' | 'workspace';
}

const EMPTY_FORM: SkillForm = {
  name: '',
  description: '',
  role: '',
  promptTemplate: '',
  rows: [],
  kbScopes: [],
  kbTags: '',
  outputSpec: '',
  exampleInputText: '',
  exampleOutput: '',
  changelog: '',
  visibility: 'private',
};

function formFromSkill(s: SkillListItem): SkillForm {
  return {
    name: s.name,
    description: s.description,
    role: s.role,
    promptTemplate: s.promptTemplate,
    rows: (s.inputSchema ?? []).map(rowFromField),
    kbScopes: s.kbBinding?.scopes ?? [],
    kbTags: (s.kbBinding?.tags ?? []).join(', '),
    outputSpec: s.outputSpec,
    exampleInputText: s.exampleInput ? JSON.stringify(s.exampleInput, null, 2) : '',
    exampleOutput: s.exampleOutput,
    changelog: '',
    visibility: s.visibility === 'workspace' ? 'workspace' : 'private',
  };
}

function defaultParams(s: SkillListItem): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const f of s.inputSchema ?? []) {
    if (f.default !== undefined) out[f.key] = f.default as ParamValue;
    else out[f.key] = f.type === 'checkbox' ? false : '';
  }
  return out;
}

/**
 * 技能页（M7）：本空间 skill 管理 + 平台库安装/升级 + 按 inputSchema 自动表单发单/试运行。
 * 列表走 GET /api/skills（本空间 + 平台库合并返回，前端按 workspaceId 分段）。
 */
export default function Skills() {
  const { S, post, send, toast, refresh, setTab, currentWorkspace, user } = useApp();
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [roles, setRoles] = useState<RegistryRole[]>([]);
  const [loaded, setLoaded] = useState(false);
  // 编辑器：editing=null 且 editorOpen=false 时关闭；editing 为空表示新建
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SkillListItem | null>(null);
  const [form, setForm] = useState<SkillForm>(EMPTY_FORM);
  // 发单 / 试运行弹窗
  const [dispatchSkill, setDispatchSkill] = useState<SkillListItem | null>(null);
  const [dispatchMode, setDispatchMode] = useState<'dispatch' | 'test'>('dispatch');
  const [params, setParams] = useState<Record<string, ParamValue>>({});
  const [teamId, setTeamId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [assetRefs, setAssetRefs] = useState<AssetRef[]>([]);

  const load = useCallback(async () => {
    try {
      setSkills(await fetchSkills());
    } catch {
      /* 拉取失败保持空列表，下方有空态提示 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    fetchRegistry().then((r) => setRoles(r.roles)).catch(() => setRoles([]));
  }, [load]);

  useEffect(() => {
    if (S && S.teams.length && !S.teams.some((t) => t.id === teamId)) {
      setTeamId(S.teams[0].id);
    }
  }, [S, teamId]);

  if (!S) return null;

  const wsId = currentWorkspace?.id ?? S.workspace?.id ?? '';
  const ownAll = skills.filter((s) => s.workspaceId === wsId);
  // 三段：本空间自建 / 已安装副本（sourceSkillId 非空）/ 平台库
  const own = ownAll.filter((s) => !s.sourceSkillId);
  const copies = ownAll.filter((s) => !!s.sourceSkillId);
  const library = skills.filter((s) => s.workspaceId !== wsId);

  /* ---------- 列表操作 ---------- */
  async function act(id: string, action: 'publish' | 'archive' | 'submit-review', okMsg: string) {
    try {
      await post(`/api/skills/${id}/${action}`);
    } catch { return; }
    toast(okMsg);
    load();
  }

  async function install(s: SkillListItem, upgrade: boolean) {
    let res: Record<string, unknown>;
    try {
      res = await post(`/api/skills/${s.id}/install`, upgrade ? { upgrade: true } : {});
    } catch { return; }
    if (res.alreadyInstalled) toast('已经安装过了，用的是本空间副本');
    else if (res.upgraded || upgrade) toast(`「${s.name}」已升级到 v${s.version}`);
    else toast(`「${s.name}」已安装到本空间`);
    load();
  }

  /* ---------- 编辑器 ---------- */
  function startCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  }
  function startEdit(s: SkillListItem) {
    setEditing(s);
    setForm(formFromSkill(s));
    setEditorOpen(true);
  }

  async function saveSkill(publishAfter: boolean) {
    if (!form.name.trim()) return toast('先填技能名称');
    if (!form.role.trim()) return toast('先填适用工种');
    const rows = form.rows.filter((r) => r.key.trim() || r.label.trim());
    if (rows.some((r) => !r.key.trim())) return toast('参数表的 key 不能为空');
    let exampleInput: Record<string, unknown> = {};
    if (form.exampleInputText.trim()) {
      try {
        exampleInput = JSON.parse(form.exampleInputText) as Record<string, unknown>;
      } catch {
        return toast('示例参数不是合法 JSON');
      }
    }
    if (editing && !form.changelog.trim()) {
      return toast('修改已有 skill 必须填写本次变更说明（changelog）');
    }
    const skill = {
      name: form.name.trim(),
      description: form.description,
      role: form.role.trim(),
      promptTemplate: form.promptTemplate,
      inputSchema: rows.map(fieldFromRow),
      kbBinding: {
        scopes: form.kbScopes,
        tags: form.kbTags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      },
      outputSpec: form.outputSpec,
      exampleInput,
      exampleOutput: form.exampleOutput,
      changelog: form.changelog.trim(),
      visibility: form.visibility,
    };
    let id = editing?.id;
    let status = editing?.status;
    try {
      if (editing) {
        await send('PUT', `/api/skills/${editing.id}`, { skill });
      } else {
        const res = await post('/api/skills', { skill });
        id = String(res.id);
        status = 'draft';
      }
      if (publishAfter && id && status !== 'published') {
        await post(`/api/skills/${id}/publish`);
      }
    } catch { return; } // 后端原文（含 changelog 校验）已由 post/send toast
    toast(publishAfter ? '已保存并发布' : '草稿已保存');
    setEditorOpen(false);
    setEditing(null);
    load();
  }

  /* ---------- 发单 / 试运行 ---------- */
  function openDispatch(s: SkillListItem, mode: 'dispatch' | 'test') {
    // 平台库已安装的 skill 用本空间副本发单（副本才归本空间调度）
    const effective =
      mode === 'dispatch' && s.installedCopyId
        ? skills.find((x) => x.id === s.installedCopyId) ?? s
        : s;
    setDispatchSkill(effective);
    setDispatchMode(mode);
    const base = defaultParams(effective);
    if (mode === 'test') {
      for (const [k, v] of Object.entries(effective.exampleInput ?? {})) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') base[k] = v;
      }
    }
    setParams(base);
    setProjectId('');
    setAssetRefs([]);
  }

  async function submitDispatch() {
    if (!dispatchSkill) return;
    if (!teamId) return toast('先选小组');
    const clean: Record<string, unknown> = {};
    for (const f of dispatchSkill.inputSchema ?? []) {
      const v = params[f.key];
      if (f.required && (v === '' || v === undefined)) return toast(`参数「${f.label}」必填`);
      if (v !== '' && v !== undefined) clean[f.key] = f.type === 'number' ? Number(v) : v;
    }
    try {
      if (dispatchMode === 'test') {
        await post(`/api/skills/${dispatchSkill.id}/test-run`, { params: clean, teamId });
        toast('试运行已发单（照常记账），去任务墙看产出');
      } else {
        await post(`/api/skills/${dispatchSkill.id}/dispatch`, {
          params: clean,
          teamId,
          projectId: projectId || undefined,
          assetRefs: assetRefs.length ? assetRefs : undefined,
        });
        toast('已发单，进任务墙了');
      }
    } catch { return; }
    setDispatchSkill(null);
    refresh();
    setTab('office');
  }

  const canEdit = (s: SkillListItem) =>
    s.ownerType !== 'platform' || !!user?.isPlatformAdmin;

  function skillCard(s: SkillListItem, mine: boolean) {
    const installed = !!s.installedCopyId;
    const source = s.sourceSkillId ? skills.find((x) => x.id === s.sourceSkillId) : undefined;
    return (
      <div className="task" key={s.id}>
        <span className="tt">{s.name}</span>
        <span className="chip">{s.role}</span>
        <span className="chip">v{s.version}</span>
        <span className={`chip ${s.status === 'published' ? 'done' : s.status === 'archived' ? 'can' : 'adj'}`}>
          {STATUS_LABEL[s.status] ?? s.status}
        </span>
        <span className="chip">{VIS_LABEL[s.visibility] ?? s.visibility}</span>
        <span className="chip">安装 {s.installCount}</span>
        {s.sourceSkillId && <span className="chip">安装副本</span>}
        {mine && s.hasNewerSource && <span className="chip rej">来源有新版</span>}
        <div className="meta">
          {s.description || '（无说明）'}
          <br />
          slug：{s.slug} · 更新于 {s.updatedAt.slice(0, 16).replace('T', ' ')}
          {s.verifiedNotes ? (
            <>
              <br />
              已验证做法：{s.verifiedNotes}
            </>
          ) : null}
        </div>
        <div style={{ marginTop: 6 }}>
          {mine ? (
            <>
              {canEdit(s) && (
                <button className="btn small gray" onClick={() => startEdit(s)}>编辑</button>
              )}{' '}
              {s.status === 'draft' && (
                <button className="btn small green" onClick={() => act(s.id, 'publish', '已发布')}>发布</button>
              )}{' '}
              {s.status !== 'archived' && (
                <button className="btn small gray" onClick={() => act(s.id, 'archive', '已归档')}>归档</button>
              )}{' '}
              {s.sourceSkillId && s.hasNewerSource && source && (
                <button className="btn small green" onClick={() => install(source, true)}>升级到新版</button>
              )}{' '}
              {s.status === 'published' && s.visibility !== 'public' && s.visibility !== 'pending_review' && (
                <button className="btn small blue" onClick={() => act(s.id, 'submit-review', '已提交上架审核，等平台管理员通过')}>
                  提交上架
                </button>
              )}{' '}
              <button className="btn small gray" onClick={() => openDispatch(s, 'test')}>试运行</button>{' '}
              <button className="btn small" onClick={() => openDispatch(s, 'dispatch')}>发单</button>
            </>
          ) : (
            <>
              {!installed && (
                <button className="btn small blue" onClick={() => install(s, false)}>安装</button>
              )}{' '}
              {installed && s.hasNewerSource && (
                <button className="btn small green" onClick={() => install(s, true)}>有新版 · 升级</button>
              )}{' '}
              {installed && (
                <button className="btn small" onClick={() => openDispatch(s, 'dispatch')}>发单</button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>
          本空间技能{' '}
          <span className="tag">自己建的（含草稿）与安装的副本；内容变更要写 changelog 才会升版本</span>
        </h2>
        <div style={{ marginBottom: 10 }}>
          <button className="btn" onClick={startCreate}>＋ 新建技能</button>{' '}
          <button className="btn gray" onClick={load}>刷新</button>
        </div>
        {!loaded && <p className="hint">加载中…</p>}
        {loaded && own.length === 0 && (
          <p className="hint">本空间还没有自建技能。点「新建技能」写一个，或到下方平台库安装官方技能。</p>
        )}
        {own.map((s) => skillCard(s, true))}
      </div>

      <div className="card">
        <h2>已安装副本 <span className="tag">从平台库安装来的快照副本，归本空间调度；来源出新版时可一键升级</span></h2>
        {loaded && copies.length === 0 && <p className="hint">还没有安装任何平台库技能。</p>}
        {copies.map((s) => skillCard(s, true))}
      </div>

      <div className="card">
        <h2>平台库 <span className="tag">官方技能 + 已上架公开技能；安装后在本空间生成副本，来源出新版可一键升级</span></h2>
        {loaded && library.length === 0 && <p className="hint">平台库暂无可安装的技能。</p>}
        {library.map((s) => skillCard(s, false))}
      </div>

      {/* ---------- 新建 / 编辑 ---------- */}
      {editorOpen && (
        <div className="modal show">
          <div className="box" style={{ maxWidth: 780 }}>
            <h2 style={{ marginTop: 0 }}>{editing ? `编辑技能 · ${editing.name}` : '新建技能'}</h2>
            <div className="row">
              <div>
                <label>名称</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：爆款标题生成" />
              </div>
              <div>
                <label>适用工种（可从注册表选，也可直接输入）</label>
                <input
                  list="skill-role-list"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  placeholder="如：文案"
                />
                <datalist id="skill-role-list">
                  {roles.map((r) => (
                    <option key={r.roleId} value={r.name} />
                  ))}
                </datalist>
              </div>
              <div>
                <label>可见性</label>
                <select
                  value={form.visibility}
                  onChange={(e) => setForm({ ...form, visibility: e.target.value as SkillForm['visibility'] })}
                >
                  <option value="private">私有（仅自己）</option>
                  <option value="workspace">本空间可见</option>
                </select>
              </div>
            </div>
            <label>说明</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="这个技能干什么、适合什么场景" />
            <label>提示词模板（用 {'{{参数key}}'} 占位，发单时按参数表替换）</label>
            <textarea
              rows={6}
              value={form.promptTemplate}
              onChange={(e) => setForm({ ...form, promptTemplate: e.target.value })}
              placeholder={'如：为短剧《{{title}}》写 {{count}} 个爆款标题，风格：{{style}}'}
            />

            <label>参数表（发单表单按此自动生成）</label>
            {form.rows.map((r, i) => (
              <div className="row" key={i} style={{ alignItems: 'flex-end', marginBottom: 4 }}>
                <div>
                  <input placeholder="key（如 title）" value={r.key} onChange={(e) => {
                    const rows = [...form.rows];
                    rows[i] = { ...r, key: e.target.value };
                    setForm({ ...form, rows });
                  }} />
                </div>
                <div>
                  <input placeholder="显示名" value={r.label} onChange={(e) => {
                    const rows = [...form.rows];
                    rows[i] = { ...r, label: e.target.value };
                    setForm({ ...form, rows });
                  }} />
                </div>
                <div>
                  <select value={r.type} onChange={(e) => {
                    const rows = [...form.rows];
                    rows[i] = { ...r, type: e.target.value as SkillInputField['type'] };
                    setForm({ ...form, rows });
                  }}>
                    {FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <input placeholder="默认值" value={r.defaultText} onChange={(e) => {
                    const rows = [...form.rows];
                    rows[i] = { ...r, defaultText: e.target.value };
                    setForm({ ...form, rows });
                  }} />
                </div>
                <div>
                  <input placeholder="选项（仅 select，逗号分隔）" value={r.optionsText} onChange={(e) => {
                    const rows = [...form.rows];
                    rows[i] = { ...r, optionsText: e.target.value };
                    setForm({ ...form, rows });
                  }} />
                </div>
                <div style={{ flex: '0 0 92px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, margin: 0 }}>
                    <input
                      type="checkbox"
                      className="chk"
                      checked={r.required}
                      onChange={(e) => {
                        const rows = [...form.rows];
                        rows[i] = { ...r, required: e.target.checked };
                        setForm({ ...form, rows });
                      }}
                    />
                    必填
                  </label>
                </div>
                <div style={{ flex: '0 0 64px' }}>
                  <button
                    className="btn small gray"
                    onClick={() => setForm({ ...form, rows: form.rows.filter((_, x) => x !== i) })}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
            <button className="btn small gray" onClick={() => setForm({ ...form, rows: [...form.rows, { ...EMPTY_ROW }] })}>
              ＋ 加一行参数
            </button>

            <label>知识库绑定 · 范围（多选）</label>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {KB_SCOPES.map((sc) => (
                <label key={sc} style={{ display: 'flex', alignItems: 'center', gap: 4, margin: 0 }}>
                  <input
                    type="checkbox"
                    className="chk"
                    checked={form.kbScopes.includes(sc)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        kbScopes: e.target.checked
                          ? [...form.kbScopes, sc]
                          : form.kbScopes.filter((x) => x !== sc),
                      })
                    }
                  />
                  {KB_SCOPE_LABEL[sc]}（{sc}）
                </label>
              ))}
            </div>
            <label>知识库绑定 · 标签（逗号分隔，按标签命中注入）</label>
            <input value={form.kbTags} onChange={(e) => setForm({ ...form, kbTags: e.target.value })} placeholder="如：短剧, 钩子" />
            <label>输出规格</label>
            <textarea rows={2} value={form.outputSpec} onChange={(e) => setForm({ ...form, outputSpec: e.target.value })} placeholder="产出长什么样：结构、条数、格式要求……" />
            <div className="row">
              <div>
                <label>示例参数（JSON，试运行时直接用它发单）</label>
                <textarea rows={3} value={form.exampleInputText} onChange={(e) => setForm({ ...form, exampleInputText: e.target.value })} placeholder='{"title":"龙王归来"}' />
              </div>
              <div>
                <label>示例产出</label>
                <textarea rows={3} value={form.exampleOutput} onChange={(e) => setForm({ ...form, exampleOutput: e.target.value })} placeholder="一份理想产出的样子" />
              </div>
            </div>
            <label>{editing ? '本次变更说明 changelog（必填，后端会据此升版本）' : '变更说明 changelog（可空，默认「初始版本」）'}</label>
            <input value={form.changelog} onChange={(e) => setForm({ ...form, changelog: e.target.value })} placeholder="如：标题公式加入反问式钩子" />
            <div style={{ marginTop: 12 }}>
              <button className="btn blue" onClick={() => saveSkill(false)}>
                {editing ? '保存' : '保存草稿'}
              </button>{' '}
              <button className="btn" onClick={() => saveSkill(true)}>保存并发布</button>{' '}
              <button className="btn gray" onClick={() => { setEditorOpen(false); setEditing(null); }}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- 发单 / 试运行 ---------- */}
      {dispatchSkill && (
        <div className="modal show">
          <div className="box" style={{ maxWidth: 640 }}>
            <h2 style={{ marginTop: 0 }}>
              {dispatchMode === 'test' ? '试运行' : '发单'} · {dispatchSkill.name}
              <span className="tag" style={{ marginLeft: 8 }}>v{dispatchSkill.version}</span>
            </h2>
            {(dispatchSkill.inputSchema ?? []).map((f) => (
              <div key={f.key}>
                <label>
                  {f.label}
                  {f.required ? ' *' : ''}
                </label>
                {f.type === 'textarea' ? (
                  <textarea
                    rows={3}
                    placeholder={f.placeholder}
                    value={String(params[f.key] ?? '')}
                    onChange={(e) => setParams({ ...params, [f.key]: e.target.value })}
                  />
                ) : f.type === 'select' ? (
                  <select
                    value={String(params[f.key] ?? '')}
                    onChange={(e) => setParams({ ...params, [f.key]: e.target.value })}
                  >
                    <option value="">请选择</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : f.type === 'checkbox' ? (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                    <input
                      type="checkbox"
                      className="chk"
                      checked={!!params[f.key]}
                      onChange={(e) => setParams({ ...params, [f.key]: e.target.checked })}
                    />
                    是
                  </label>
                ) : (
                  <input
                    type={f.type === 'number' ? 'number' : 'text'}
                    placeholder={f.placeholder}
                    value={String(params[f.key] ?? '')}
                    onChange={(e) => setParams({ ...params, [f.key]: e.target.value })}
                  />
                )}
              </div>
            ))}
            <div className="row">
              <div>
                <label>交给哪个小组</label>
                <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                  {S.teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              {dispatchMode === 'dispatch' && (
                <div>
                  <label>挂到项目（可选）</label>
                  <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    <option value="">不挂项目</option>
                    {S.projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {dispatchMode === 'dispatch' && (
              <>
                <label>资产引用（可选，发单时按当前版本落快照注入）</label>
                <AssetRefPicker value={assetRefs} onChange={setAssetRefs} />
              </>
            )}
            <div style={{ marginTop: 12 }}>
              <button className="btn" onClick={submitDispatch}>
                {dispatchMode === 'test' ? '开始试运行' : '发单'}
              </button>{' '}
              <button className="btn gray" onClick={() => setDispatchSkill(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
