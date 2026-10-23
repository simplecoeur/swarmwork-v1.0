import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { requestRaw } from '../api';
import { yuan } from '../utils';
import type { AdminUser, AdminWorkspace, IndustryPack, TrialApi } from '../types';

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
  const { post, toast } = useApp();
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
  async function disableUser(u: AdminUser) {
    if (!window.confirm(`停用 ${u.email}？其全部会话会立即失效。`)) return;
    try {
      await post(`/api/admin/users/${u.id}/disable`);
    } catch { return; }
    toast(`已停用 ${u.email}`);
    loadUsers();
  }
  async function resetPassword(u: AdminUser) {
    if (!window.confirm(`给 ${u.email} 重置密码？旧密码立即失效、其会话被吊销，下次登录须改密。`)) return;
    let res: Record<string, unknown>;
    try {
      res = await post(`/api/admin/users/${u.id}/reset-password`);
    } catch { return; }
    // 临时密码只此一次返回：弹窗一次性展示，管理员自行转交用户
    setResetResult({ email: u.email, temp: String(res.temporaryPassword ?? '') });
    loadUsers();
  }

  return (
    <>
      {/* ---------- 用户管理 ---------- */}
      <div className="card">
        <h2>用户管理 <span className="tag">待审核的通过后自动按其注册意向建空间</span></h2>
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
                  {u.isPlatformAdmin && <span className="chip rev">管理员</span>}
                  {u.mustChangePassword && <span className="chip adj">待改密</span>}
                </td>
                <td>{u.displayName}</td>
                <td>{STATUS_LABEL[u.status] ?? u.status}</td>
                <td>{u.workspaceCount}</td>
                <td>{fmtTime(u.createdAt)}</td>
                <td>{fmtTime(u.lastLoginAt)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {u.status === 'pending' && (
                    <button className="btn small green" onClick={() => approveUser(u)}>通过</button>
                  )}{' '}
                  {u.status === 'disabled' && (
                    <button className="btn small green" onClick={() => approveUser(u)}>启用</button>
                  )}{' '}
                  {u.status === 'active' && (
                    <button className="btn small gray" onClick={() => disableUser(u)}>停用</button>
                  )}{' '}
                  <button className="btn small gray" onClick={() => resetPassword(u)}>重置密码</button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={7} className="hint">暂无用户（或加载失败）。</td></tr>
            )}
          </tbody>
        </table>
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
        <table>
          <thead>
            <tr>
              <th>空间</th><th>所有者</th><th>任务数</th><th>总消费</th>
              <th>自有余额</th><th>体验额度（已发 / 剩余）</th><th>状态</th>
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
              </tr>
            ))}
            {workspaces.length === 0 && (
              <tr><td colSpan={7} className="hint">暂无空间（或加载失败）。</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ---------- 行业包（只读） ---------- */}
      <div className="card">
        <h2>行业包 <span className="tag">只读列表；包的编辑走服务端种子/接口，本台不做编辑</span></h2>
        {packs.length === 0 && <p className="hint">暂无行业包。</p>}
        {packs.map((p) => (
          <div className="task" key={p.id}>
            <span className="tt">{p.name}</span>
            <span className="chip">{p.industry}</span>
            <span className="chip">v{p.version}</span>
            <span className="chip">{p.status}</span>
            <div className="meta">{p.description}（作者：{p.author}）</div>
          </div>
        ))}
      </div>

      {/* ---------- 重置密码结果（一次性展示） ---------- */}
      {resetResult && (
        <div className="modal show">
          <div className="box">
            <h2 style={{ marginTop: 0 }}>临时密码（只显示这一次）</h2>
            <p className="hint">
              账号 <b>{resetResult.email}</b> 的临时密码如下，请立即转交给用户本人；
              关闭后无法再查看，用户用它登录后会被要求改密。
            </p>
            <pre className="result" style={{ fontSize: 18, textAlign: 'center' }}>{resetResult.temp}</pre>
            <div style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => setResetResult(null)}>已转交，关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
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
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label>服务商</label>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="row">
        <div>
          <label>Base URL</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div>
          <label>模型</label>
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <div>
          <label>API Key（密码框；留空 = 不修改）</label>
          <input
            type="password"
            placeholder={initial && initial.hasKey ? `已保存：${initial.apiKeyMasked}` : '尚未填写'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div>
          <label>单价（元/百万 token）</label>
          <input type="number" step="0.01" min="0" value={pricePerM} onChange={(e) => setPricePerM(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="btn small blue" onClick={() => save()}>保存体验 API</button>{' '}
        {initial && initial.hasKey && (
          <button className="btn small gray" onClick={() => save(true)}>清除 Key</button>
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
          <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}（{w.ownerEmail}）
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>金额（元，≤ 10，每空间仅一次）</label>
          <input type="number" step="0.5" min="0" max="10" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="btn small blue" onClick={grant}>发放</button>
      </div>
    </div>
  );
}
