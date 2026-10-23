import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { requestRaw } from '../api';
import { yuan } from '../utils';
import { Badge, Button, Dialog, Field, Input, Select, Spinner, useConfirm } from './ui';
import type { AdminUser, AdminWorkspace, FeedbackItem, IndustryPack, SkillListItem, TrialApi } from '../types';

const PROVIDERS = ['deepseek', 'openai', 'anthropic', 'custom'];

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ');
}

const STATUS_LABEL: Record<string, string> = {
  active: '已开通',
  pending: '待审核',
  disabled: '已停用',
};

/**
 * 平台管理台（M6，仅 isPlatformAdmin 可见）：
 * 用户审核/停用/重置密码、体验 API 配置、体验额度发放（单笔 ≤¥10、每空间一次性）、
 * 空间聚合表、行业包只读列表。后端错误 message 直接 toast（post 包装已处理）。
 */
export default function Admin() {
  const { post, toast, refreshAuth, refresh, setTab } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [packs, setPacks] = useState<IndustryPack[]>([]);
  const [trialApi, setTrialApi] = useState<TrialApi | null>(null);
  const [trialLoaded, setTrialLoaded] = useState(false);
  const [resetResult, setResetResult] = useState<{ email: string; temp: string } | null>(null);

  const get = useCallback(
    async (path: string) => {
      try {
        return await requestRaw('GET', path);
      } catch (e) {
        toast('出错：' + (e instanceof Error ? e.message : String(e)));
        throw e;
      }
    },
    [toast],
  );

  const loadUsers = useCallback(async () => {
    try {
      const j = await get('/api/admin/users');
      setUsers((j.users as AdminUser[]) ?? []);
    } catch { /* get 已 toast */ }
  }, [get]);

  const loadWorkspaces = useCallback(async () => {
    try {
      const j = await get('/api/admin/workspaces');
      setWorkspaces((j.workspaces as AdminWorkspace[]) ?? []);
    } catch { /* get 已 toast */ }
  }, [get]);

  const loadTrial = useCallback(async () => {
    try {
      const j = await get('/api/admin/trial-api');
      setTrialApi((j.api as TrialApi | null) ?? null);
    } catch { /* get 已 toast */ } finally {
      setTrialLoaded(true);
    }
  }, [get]);

  const loadPacks = useCallback(async () => {
    try {
      const j = await get('/api/admin/industry-packs');
      setPacks((j.packs as IndustryPack[]) ?? []);
    } catch { /* get 已 toast */ }
  }, [get]);

  useEffect(() => {
    loadUsers();
    loadWorkspaces();
    loadTrial();
    loadPacks();
  }, [loadUsers, loadWorkspaces, loadTrial, loadPacks]);

  async function approveUser(u: AdminUser) {
    try {
      await post(`/api/admin/users/${u.id}/approve`);
    } catch { return; }
    toast(`已开通 ${u.email}`);
    loadUsers();
    loadWorkspaces();
  }
  function disableUser(u: AdminUser) {
    ask({
      title: '停用用户',
      message: `停用 ${u.email}？其全部会话会立即失效。`,
      confirmLabel: '停用',
      onConfirm: async () => {
        try {
          await post(`/api/admin/users/${u.id}/disable`);
        } catch { return; }
        toast(`已停用 ${u.email}`);
        loadUsers();
      },
    });
  }
  function resetPassword(u: AdminUser) {
    ask({
      title: '重置密码',
      message: `给 ${u.email} 重置密码？旧密码立即失效、其会话被吊销，下次登录须改密。`,
      confirmLabel: '重置密码',
      onConfirm: async () => {
        let res: Record<string, unknown>;
        try {
          res = await post(`/api/admin/users/${u.id}/reset-password`);
        } catch { return; }
        // 临时密码只此一次返回：弹窗一次性展示，管理员自行转交用户
        setResetResult({ email: u.email, temp: String(res.temporaryPassword ?? '') });
        loadUsers();
      },
    });
  }

  /* G-14 代入查看（只读）：进入后全站红色横幅提示，写操作被服务端守卫拦截 */
  async function impersonateWorkspace(w: AdminWorkspace) {
    try {
      await post(`/api/admin/impersonate/${w.id}`);
    } catch { return; }
    toast(`已代入查看空间「${w.name}」（只读）`);
    await refreshAuth();
    await refresh();
    setTab('office');
  }

  return (
    <>
      {/* ---------- 用户管理 ---------- */}
      <div className="card">
        <h2>用户管理 <span className="tag">待审核的通过后自动按其注册意向建空间</span></h2>
        <div className="table-wrap">
          <table>
          <thead>
            <tr>
              <th>邮箱</th><th>显示名</th><th>状态</th><th>空间数</th>
              <th>注册时间</th><th>最近登录</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.email}
                  {u.isPlatformAdmin && <Badge variant="rev">管理员</Badge>}
                  {u.mustChangePassword && <Badge variant="adj">待改密</Badge>}
                </td>
                <td>
                  <img className="avatar-img" src={u.avatarUrl ?? `/api/users/${u.id}/avatar`} alt="" />{' '}
                  {u.displayName}
                </td>
                <td>{STATUS_LABEL[u.status] ?? u.status}</td>
                <td>{u.workspaceCount}</td>
                <td>{fmtTime(u.createdAt)}</td>
                <td>{fmtTime(u.lastLoginAt)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {u.status === 'pending' && (
                    <Button size="small" variant="green" onClick={() => approveUser(u)}>通过</Button>
                  )}{' '}
                  {u.status === 'disabled' && (
                    <Button size="small" variant="green" onClick={() => approveUser(u)}>启用</Button>
                  )}{' '}
                  {u.status === 'active' && (
                    <Button size="small" variant="gray" onClick={() => disableUser(u)}>停用</Button>
                  )}{' '}
                  <Button size="small" variant="gray" onClick={() => resetPassword(u)}>重置密码</Button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={7} className="hint">暂无用户（或加载失败）。</td></tr>
            )}
          </tbody>
          </table>
        </div>
      </div>

      {/* ---------- 体验额度 ---------- */}
      <div className="card">
        <h2>体验额度 <span className="tag">先配平台体验 API，再给空间发放：单笔 ≤ ¥10、每空间一次性、不可续发</span></h2>
        {trialLoaded && (
          <TrialApiForm
            key={trialApi ? trialApi.id : 'none'}
            initial={trialApi}
            onSaved={loadTrial}
          />
        )}
        <GrantForm workspaces={workspaces} onGranted={loadWorkspaces} />
      </div>

      {/* ---------- 空间聚合 ---------- */}
      <div className="card">
        <h2>空间总览</h2>
        <div className="table-wrap">
          <table>
          <thead>
            <tr>
              <th>空间</th><th>所有者</th><th>任务数</th><th>总消费</th>
              <th>自有余额</th><th>体验额度（已发 / 剩余）</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td>
                <td>{w.ownerEmail}</td>
                <td>{w.taskCount}</td>
                <td>{yuan(w.totalCostYuan)}</td>
                <td>{yuan(w.balanceYuan)}</td>
                <td>{yuan(w.trialGrantedYuan)} / {yuan(w.trialRemainingYuan)}</td>
                <td>{STATUS_LABEL[w.status] ?? w.status}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <Button size="small" variant="gray" onClick={() => impersonateWorkspace(w)}>代入查看</Button>
                </td>
              </tr>
            ))}
            {workspaces.length === 0 && (
              <tr><td colSpan={8} className="hint">暂无空间（或加载失败）。</td></tr>
            )}
          </tbody>
          </table>
        </div>
      </div>

      {/* ---------- skill 上架审核（M7） ---------- */}
      <SkillReviewCard />

      {/* ---------- 用户反馈（G-05） ---------- */}
      <FeedbackCard />

      {/* ---------- 行业包（只读） ---------- */}
      <div className="card">
        <h2>行业包 <span className="tag">只读列表；包的编辑走服务端种子/接口，本台不做编辑</span></h2>
        {packs.length === 0 && <p className="hint">暂无行业包。</p>}
        {packs.map((p) => (
          <div className="task" key={p.id}>
            <span className="tt">{p.name}</span>
            <Badge>{p.industry}</Badge>
            <Badge>v{p.version}</Badge>
            <Badge>{p.status}</Badge>
            <div className="meta">{p.description}（作者：{p.author}）</div>
          </div>
        ))}
      </div>

      {/* ---------- 重置密码结果（一次性展示） ---------- */}
      {resetResult && (
        <Dialog open onClose={() => setResetResult(null)} title="临时密码（只显示这一次）">
            <p className="hint">
              账号 <b>{resetResult.email}</b> 的临时密码如下，请立即转交给用户本人；
              关闭后无法再查看，用户用它登录后会被要求改密。
            </p>
            <pre className="result" style={{ fontSize: 18, textAlign: 'center' }}>{resetResult.temp}</pre>
            <div style={{ marginTop: 12 }}>
              <Button onClick={() => setResetResult(null)}>已转交，关闭</Button>
            </div>
        </Dialog>
      )}
      {confirmNode}
    </>
  );
}

/* ---------------- 用户反馈（G-05）：只落库 + 置已处理，不做工单流转 ---------------- */

const FEEDBACK_CATEGORY_LABEL: Record<string, string> = {
  bug: '问题',
  suggestion: '建议',
  question: '疑问',
  other: '其他',
};

function FeedbackCard() {
  const { post, toast } = useApp();
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const qs = statusFilter ? `?status=${statusFilter}` : '';
      const j = await requestRaw('GET', `/api/admin/feedback${qs}`);
      setItems((j.feedback as FeedbackItem[]) ?? []);
      setTotal(Number(j.total ?? 0));
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoaded(true);
    }
  }, [statusFilter, toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function handle(f: FeedbackItem) {
    try {
      await post(`/api/admin/feedback/${f.id}/handle`, { adminNote: notes[f.id] ?? '' });
      toast('已置为已处理');
      load();
    } catch {
      /* post 已 toast */
    }
  }

  return (
    <div className="card">
      <h2>用户反馈 <span className="tag">用户在帮助页/顶栏提交的反馈（共 {total} 条）；处理后置已处理并留备注</span></h2>
      <div style={{ marginBottom: 8 }}>
        <Select
          value={statusFilter}
          onValueChange={setStatusFilter}
          emptyLabel="全部状态"
          options={[
            { value: 'open', label: '待处理' },
            { value: 'handled', label: '已处理' },
          ]}
        />{' '}
        <Button size="small" variant="gray" onClick={load}>刷新</Button>
      </div>
      {loaded && items.length === 0 && <p className="hint">暂无符合条件的反馈。</p>}
      {items.map((f) => (
        <div className="task" key={f.id}>
          <span className="tt">#{f.id}</span>
          <Badge>{FEEDBACK_CATEGORY_LABEL[f.category] ?? f.category}</Badge>
          <Badge variant={f.status === 'handled' ? 'done' : 'adj'}>
            {f.status === 'handled' ? '已处理' : '待处理'}
          </Badge>
          <div className="meta">
            {fmtTime(f.createdAt)} · 用户 {f.userId}
            {f.contact ? ` · 联系方式：${f.contact}` : ''}
            {f.handledAt ? ` · 处理于 ${fmtTime(f.handledAt)}` : ''}
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.7, overflowWrap: 'anywhere' }}>{f.content}</div>
          {f.adminNote ? <div className="hint">处理备注：{f.adminNote}</div> : null}
          {f.status === 'open' && (
            <div className="row" style={{ alignItems: 'flex-end', marginTop: 6 }}>
              <div>
                <Input
                  value={notes[f.id] ?? ''}
                  onChange={(e) => setNotes((m) => ({ ...m, [f.id]: e.target.value }))}
                  placeholder="处理备注（可选）"
                />
              </div>
              <div style={{ flex: '0 0 110px' }}>
                <Button size="small" variant="green" onClick={() => handle(f)}>
                  置已处理
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------- skill 上架审核（M7） ---------------- */
function SkillReviewCard() {
  const { post, toast } = useApp();
  const [pending, setPending] = useState<SkillListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [rejecting, setRejecting] = useState<SkillListItem | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      const j = await requestRaw('GET', '/api/admin/skills/pending');
      setPending((j.skills as SkillListItem[]) ?? []);
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoaded(true);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(s: SkillListItem) {
    try {
      await post(`/api/admin/skills/${s.id}/approve`);
    } catch { return; }
    toast(`已通过「${s.name}」，已上架平台库`);
    load();
  }

  async function reject() {
    if (!rejecting) return;
    const s = rejecting;
    try {
      await post(`/api/admin/skills/${s.id}/reject`, { reason });
    } catch { return; }
    toast(`已驳回「${s.name}」，退回提交方空间可见状态`);
    setRejecting(null);
    setReason('');
    load();
  }

  return (
    <div className="card">
      <h2>Skill 上架审核 <span className="tag">用户提交上架的技能在此过审：通过 → 进平台库公开；驳回 → 退回本空间可见</span></h2>
      {!loaded && <p><Spinner label="加载中…" /></p>}
      {loaded && pending.length === 0 && <p className="hint">暂无待审核的 skill。</p>}
      {pending.map((s) => (
        <div className="task" key={s.id}>
          <span className="tt">{s.name}</span>
          <Badge>{s.role}</Badge>
          <Badge>v{s.version}</Badge>
          <Badge variant="adj">待审核</Badge>
          <div className="meta">
            {s.description || '（无说明）'}
            <br />
            slug：{s.slug} · 参数 {(s.inputSchema ?? []).length} 个 · 提交于 {s.updatedAt.slice(0, 16).replace('T', ' ')}
            {s.changelog ? <><br />变更说明：{s.changelog}</> : null}
          </div>
          <pre className="result" style={{ maxHeight: 160 }}>{s.promptTemplate}</pre>
          <Button size="small" variant="green" onClick={() => approve(s)}>通过上架</Button>{' '}
          <Button size="small" variant="gray" onClick={() => { setRejecting(s); setReason(''); }}>驳回</Button>
        </div>
      ))}
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="gray" onClick={load}>刷新</Button>
      </div>
      {rejecting && (
        <Dialog open onClose={() => setRejecting(null)} title={`驳回「${rejecting.name}」`}>
          <Field label="驳回原因（会记入审计）">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：提示词模板涉及违规内容" autoFocus />
          </Field>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <Button onClick={reject}>确认驳回</Button>
            <Button variant="gray" onClick={() => setRejecting(null)}>取消</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/* ---------------- 体验 API 配置表单 ---------------- */
function TrialApiForm({
  initial,
  onSaved,
}: {
  initial: TrialApi | null;
  onSaved: () => Promise<void>;
}) {
  const { post, toast } = useApp();
  const [name, setName] = useState(initial ? initial.name : '平台体验 API');
  const [provider, setProvider] = useState(initial ? initial.provider : 'deepseek');
  const [baseUrl, setBaseUrl] = useState(initial ? initial.baseUrl : '');
  const [model, setModel] = useState(initial ? initial.model : '');
  const [pricePerM, setPricePerM] = useState<string>(String(initial ? initial.pricePerM : 2));
  const [apiKey, setApiKey] = useState('');

  async function save(clearKey = false) {
    try {
      await post('/api/admin/trial-api', {
        api: {
          name: name.trim(),
          provider,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          pricePerM: parseFloat(pricePerM) || 0,
          apiKey: apiKey || undefined,
          clearKey: clearKey || undefined,
        },
      });
    } catch { return; }
    setApiKey('');
    toast(clearKey ? '体验 API 的 Key 已清除' : '体验 API 已保存');
    await onSaved();
  }

  return (
    <div className="apicard">
      <div style={{ fontWeight: 900, marginBottom: 4 }}>
        平台体验 API{initial ? `（当前 Key：${initial.hasKey ? initial.apiKeyMasked : '未填'}）` : '（尚未配置）'}
      </div>
      <div className="row">
        <div>
          <label>名称</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label>服务商</label>
          <Select
            value={provider}
            onValueChange={setProvider}
            options={PROVIDERS.map((p) => ({ value: p, label: p }))}
          />
        </div>
      </div>
      <div className="row">
        <div>
          <label>Base URL</label>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div>
          <label>模型</label>
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <div>
          <label>API Key（密码框；留空 = 不修改）</label>
          <Input
            type="password"
            placeholder={initial && initial.hasKey ? `已保存：${initial.apiKeyMasked}` : '尚未填写'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div>
          <label>单价（元/百万 token）</label>
          <Input type="number" step="0.01" min="0" value={pricePerM} onChange={(e) => setPricePerM(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="blue" onClick={() => save()}>保存体验 API</Button>{' '}
        {initial && initial.hasKey && (
          <Button size="small" variant="gray" onClick={() => save(true)}>清除 Key</Button>
        )}
      </div>
    </div>
  );
}

/* ---------------- 体验额度发放表单 ---------------- */
function GrantForm({
  workspaces,
  onGranted,
}: {
  workspaces: AdminWorkspace[];
  onGranted: () => Promise<void>;
}) {
  const { post, toast } = useApp();
  const [workspaceId, setWorkspaceId] = useState('');
  const [amount, setAmount] = useState('10');

  // 空间列表就绪后默认选第一个（与发布表单小组下拉同口径：尽量保留当前选择）
  useEffect(() => {
    if (workspaces.length && !workspaces.some((w) => w.id === workspaceId)) {
      setWorkspaceId(workspaces[0].id);
    }
  }, [workspaces, workspaceId]);

  async function grant() {
    if (!workspaceId) return toast('先选空间');
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return toast('金额要大于 0');
    if (amt > 10) return toast('体验额度单笔上限 ¥10');
    let res: Record<string, unknown>;
    try {
      res = await post('/api/admin/trial-grants', { workspaceId, amountYuan: amt });
    } catch { return; } // 后端新规错误（已发过/未配体验 API 等）已由 post toast 原文
    toast(`已发放 ¥${amt} 体验额度，该空间剩余 ${yuan(res.trialRemainingYuan)}`);
    await onGranted();
  }

  return (
    <div className="apicard">
      <div style={{ fontWeight: 900, marginBottom: 4 }}>发放体验额度</div>
      <div className="row">
        <div>
          <label>目标空间</label>
          <Select
            value={workspaceId}
            onValueChange={setWorkspaceId}
            options={workspaces.map((w) => ({ value: w.id, label: `${w.name}（${w.ownerEmail}）` }))}
          />
        </div>
        <div>
          <label>金额（元，≤ 10，每空间仅一次）</label>
          <Input type="number" step="0.5" min="0" max="10" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="blue" onClick={grant}>发放</Button>
      </div>
    </div>
  );
}
