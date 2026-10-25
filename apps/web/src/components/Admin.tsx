import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import {
  adminFeatureSkill,
  fetchAdminAnnouncements,
  fetchAdminPlatformKb,
  fetchAdminThreadMessages,
  fetchAdminThreads,
  fetchAgentSyncRuns,
  fetchAgentSyncSources,
  fetchAiOpsRuns,
  fetchPlatformSkillsAdmin,
  fetchReviewCenter,
  fetchSkillImports,
  fetchSkills,
  requestRaw,
  runAgentSync,
  saveAgentSyncSources,
  type AdminPlatformKbItem,
  type AdminThreadItem,
  type AgentSyncBoardItem,
  type AgentSyncRunItem,
  type AgentSyncSourceItem,
  type AiOpsRunItem,
  type AnnouncementItem,
  type ReviewCenterItem,
  type SkillImportItem,
  type ThreadMessageItem,
} from '../api';
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

      {/* ---------- 平台知识维护（v1.5.0 A） ---------- */}
      <PlatformKbCard />

      {/* ---------- 沟通运营：公告 + 按空间消息（v1.5.0 L） ---------- */}
      <AdminCommsCard />

      {/* ---------- 技能下发（v1.5.0 K） ---------- */}
      <SkillDispatchCard />

      {/* ---------- AI 平台运营官（v1.5.0 M） ---------- */}
      <AiOpsCard />

      {/* ---------- 统一审核中心（v1.5.0 D，合并原 skill/风格/智能体三条待审队列） ---------- */}
      <ReviewCenterCard />

      {/* ---------- skill 精选管理（v1.3.0 生态） ---------- */}
      <SkillFeaturedCard />

      {/* ---------- 智能体人才库（v1.4.0 J） ---------- */}
      <AgentTalentCard />

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

/* ---------------- 智能体人才库（v1.4.0 J + v1.5.0 C） ----------------
 * 本卡只管同步源与流水线（白名单源 + 立即同步 + 月度自动同步看板）；
 * 模板审核自 v1.5.0 D 起统一走「审核中心」（含变更摘要与风险标记）。 */

function AgentTalentCard() {
  const { toast } = useApp();
  const [sources, setSources] = useState<AgentSyncSourceItem[]>([]);
  const [, setLoaded] = useState(false);
  const [syncingId, setSyncingId] = useState('');
  const [syncResult, setSyncResult] = useState('');
  const [newSource, setNewSource] = useState<AgentSyncSourceItem>({ id: '', repo: '', branch: 'main', license: '', author: '' });
  /* v1.5.0 C 流水线看板 */
  const [board, setBoard] = useState<AgentSyncBoardItem[]>([]);
  const [runs, setRuns] = useState<AgentSyncRunItem[]>([]);

  const load = useCallback(async () => {
    try {
      const [src, pipe] = await Promise.all([
        fetchAgentSyncSources(),
        fetchAgentSyncRuns().catch(() => ({ board: [], runs: [] })),
      ]);
      setSources(src);
      setBoard(pipe.board);
      setRuns(pipe.runs);
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoaded(true);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function sync(src: AgentSyncSourceItem) {
    setSyncingId(src.id);
    setSyncResult('');
    try {
      const r = await runAgentSync(src.id);
      if (r.paused) {
        setSyncResult(`${src.repo}：${r.message ?? '源已暂停'}`);
        toast('源已被暂停（许可证漂移）');
      } else {
        setSyncResult(
          `${src.repo}：拉取 ${r.fetched} · 新增 ${r.created} · 更新 ${r.updated} · 未变 ${r.unchanged} · 失败 ${r.failed}` +
            (r.sourceCommit ? ` · 锚定 commit ${r.sourceCommit.slice(0, 7)}` : ''),
        );
        toast('同步完成');
      }
      load();
    } catch (e) {
      // 整源失败：后端 502 原文（含上游状态）直接回显
      setSyncResult(`${src.repo}：同步失败——${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncingId('');
    }
  }

  async function resumeSource(src: AgentSyncSourceItem) {
    try {
      const saved = await saveAgentSyncSources(
        sources.map((s) => (s.id === src.id ? { ...s, paused: false, pauseReason: '' } : s)),
      );
      setSources(saved);
      toast(`已恢复源 ${src.repo}，可重新同步`);
      load();
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function addSource() {
    if (!newSource.id.trim() || !newSource.repo.trim()) {
      toast('源 id 与 repo 必填');
      return;
    }
    try {
      const saved = await saveAgentSyncSources([...sources, { ...newSource, id: newSource.id.trim(), repo: newSource.repo.trim() }]);
      setSources(saved);
      setNewSource({ id: '', repo: '', branch: 'main', license: '', author: '' });
      toast('已保存白名单');
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function removeSource(src: AgentSyncSourceItem) {
    try {
      const saved = await saveAgentSyncSources(sources.filter((s) => s.id !== src.id));
      setSources(saved);
      toast(`已移除源 ${src.id}`);
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  const pendingCount = board.reduce((s, b) => s + b.pendingCount, 0);

  return (
    <div className="card">
      <h2>
        智能体人才库{' '}
        <span className="tag">GitHub 白名单源同步 → 审核中心过审上架 → 用户在人才库招募；待审 {pendingCount} 条（去审核中心处理）</span>
      </h2>

      <h3>同步源（白名单）</h3>
      {sources.length === 0 && <p className="hint">暂无同步源。</p>}
      {sources.map((s) => (
        <div className="task" key={s.id}>
          <span className="tt">{s.repo}</span> <Badge>{s.branch}</Badge> <Badge>{s.license || '未标注许可'}</Badge>
          {s.paused && <Badge variant="rej">已暂停</Badge>}
          <div className="meta">
            id：{s.id} · 署名：{s.author || '—'}
            {s.paused && s.pauseReason ? <><br />暂停原因：{s.pauseReason}</> : null}
          </div>
          <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
            <Button size="small" variant="blue" disabled={syncingId === s.id || !!s.paused} onClick={() => sync(s)}>
              {syncingId === s.id ? '同步中…' : '立即同步'}
            </Button>
            {s.paused && (
              <Button size="small" variant="gray" onClick={() => resumeSource(s)}>恢复源</Button>
            )}
            <Button size="small" variant="gray" onClick={() => removeSource(s)}>移除源</Button>
          </div>
        </div>
      ))}
      {syncResult && <p className="hint">最近同步：{syncResult}</p>}

      <h3 style={{ marginTop: 16 }}>同步流水线（月度自动同步每月 1 日凌晨自动跑）</h3>
      {board.length === 0 && <p className="hint">暂无流水线数据。</p>}
      {board.map((b) => (
        <div className="task" key={b.sourceId}>
          <span className="tt">{b.repo}</span>{' '}
          {b.paused ? <Badge variant="rej">已暂停</Badge> : <Badge variant="done">正常</Badge>}{' '}
          <Badge>待审 {b.pendingCount}</Badge>
          {b.consecutiveFailures > 0 && <Badge variant="rej">连续失败 {b.consecutiveFailures} 次</Badge>}
          <div className="meta">
            最近成功：{b.lastSuccessAt ? fmtTime(b.lastSuccessAt) : '—'} · 最近运行：{b.lastRunAt ? fmtTime(b.lastRunAt) : '—'}
            （{b.lastStatus ?? '—'}）
            {b.lastCommit ? <> · 锚定 commit {b.lastCommit.slice(0, 7)}</> : null}
          </div>
        </div>
      ))}
      {runs.slice(0, 8).map((r) => (
        <div className="task" key={r.id} style={{ opacity: 0.85 }}>
          <span className="tt" style={{ fontSize: 13 }}>
            {fmtTime(r.createdAt)} · {r.sourceRepo} · {r.trigger === 'auto' ? '自动' : '手动'} · {r.status}
          </span>
          <div className="meta">
            拉取 {r.fetched} · 新增 {r.created} · 更新 {r.updated} · 未变 {r.unchanged} · 失败 {r.failed} · 耗时 {r.durationMs}ms
            {r.error ? <><br />错误：{r.error}</> : null}
            {r.failedDetails.length > 0 && (
              <>
                <br />失败明细：{r.failedDetails.map((d) => `${d.path}（${d.reason}）`).join('；')}
              </>
            )}
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <Input placeholder="源 id（如 agency-agents）" value={newSource.id} onChange={(e) => setNewSource({ ...newSource, id: e.target.value })} />
        <Input placeholder="仓库 owner/repo" value={newSource.repo} onChange={(e) => setNewSource({ ...newSource, repo: e.target.value })} />
        <Input placeholder="分支" value={newSource.branch} onChange={(e) => setNewSource({ ...newSource, branch: e.target.value })} />
        <Input placeholder="许可证（如 MIT）" value={newSource.license} onChange={(e) => setNewSource({ ...newSource, license: e.target.value })} />
        <Input placeholder="署名作者" value={newSource.author} onChange={(e) => setNewSource({ ...newSource, author: e.target.value })} />
        <Button size="small" onClick={addSource}>添加源</Button>
      </div>

      <p className="hint" style={{ marginTop: 14 }}>
        模板审核已统一到上方「审核中心」（含变更摘要与风险标记、支持批量处理）。
      </p>
    </div>
  );
}

const FEEDBACK_CATEGORY_LABEL: Record<string, string> = {
  bug: '问题',
  suggestion: '建议',
  question: '疑问',
  other: '其他',
};

/* ---------------- 平台知识维护（v1.5.0 A） ----------------
 * platform 条目的增删改走既有 /api/kb（服务端已管理员收口、写审计）；
 * 列表带「累计被注入次数」（由任务 injected_kb_ids 聚合），让管理员看得见哪条真在被用。 */
function PlatformKbCard() {
  const { post, send, toast } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [items, setItems] = useState<AdminPlatformKbItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', body: '', tags: '', enabled: true });

  const load = useCallback(async () => {
    try {
      setItems(await fetchAdminPlatformKb());
    } catch {
      /* 忽略瞬时错误 */
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    const payload = {
      title: form.title.trim(),
      body: form.body,
      scope: 'platform',
      scopeId: null,
      tags: form.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      enabled: form.enabled,
    };
    if (!payload.title) return toast('标题不能为空');
    try {
      if (editingId === '') await post('/api/kb', payload);
      else await send('PUT', `/api/kb/${editingId}`, payload);
    } catch { return; }
    toast('平台知识已保存');
    setEditingId(null);
    load();
  }

  function remove(item: AdminPlatformKbItem) {
    ask({
      title: '删除平台知识',
      message: `删除平台知识「${item.title}」？所有空间立即不再注入这条。`,
      confirmLabel: '删除',
      onConfirm: async () => {
        try {
          await send('DELETE', `/api/kb/${item.id}`);
        } catch { return; }
        toast('已删除');
        load();
      },
    });
  }

  return (
    <div className="card">
      <h2>平台知识 <span className="tag">全平台公共知识：所有空间干活时最高优先级注入；增删改均写审计</span></h2>
      {!loaded && <p><Spinner label="加载中…" /></p>}
      {loaded && items.length === 0 && <p className="hint">暂无平台知识条目（服务启动时会自动播种首批）。</p>}
      {items.map((e) => (
        <div className={`task${e.enabled ? '' : ' kb-off'}`} key={e.id}>
          <span className="tt">{e.title}</span>
          <Badge variant="adj">平台公共</Badge>
          <Badge variant={e.enabled ? 'done' : 'rej'}>{e.enabled ? '启用' : '停用'}</Badge>
          <Badge>累计注入 {e.injectedCount} 次</Badge>
          <div className="meta">
            {e.tags.length ? <>标签：{e.tags.join('、')} · </> : null}
            更新于 {fmtTime(e.updatedAt)}
          </div>
          <pre className="result" style={{ maxHeight: 140 }}>{e.body}</pre>
          <Button
            size="small"
            variant="gray"
            onClick={() => {
              setForm({ title: e.title, body: e.body, tags: e.tags.join(', '), enabled: e.enabled });
              setEditingId(e.id);
            }}
          >
            编辑
          </Button>{' '}
          <Button size="small" variant="gray" onClick={() => remove(e)}>删除</Button>
        </div>
      ))}
      {editingId === null ? (
        <div style={{ marginTop: 10 }}>
          <Button
            size="small"
            onClick={() => {
              setForm({ title: '', body: '', tags: '', enabled: true });
              setEditingId('');
            }}
          >
            ＋ 新增平台知识
          </Button>
        </div>
      ) : (
        <div className="apicard" style={{ marginTop: 10 }}>
          <label>标题</label>
          <Input value={form.title} onChange={(ev) => setForm({ ...form, title: ev.target.value })} />
          <label>标签（逗号分隔）</label>
          <Input value={form.tags} onChange={(ev) => setForm({ ...form, tags: ev.target.value })} />
          <label>正文</label>
          <textarea
            rows={6}
            value={form.body}
            onChange={(ev) => setForm({ ...form, body: ev.target.value })}
            style={{ width: '100%' }}
          />
          <div style={{ marginTop: 8 }}>
            <label>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(ev) => setForm({ ...form, enabled: ev.target.checked })}
              />{' '}
              启用（停用后不再注入）
            </label>
          </div>
          <div style={{ marginTop: 8 }}>
            <Button size="small" variant="blue" onClick={save}>保存</Button>{' '}
            <Button size="small" variant="gray" onClick={() => setEditingId(null)}>取消</Button>
          </div>
        </div>
      )}
      {confirmNode}
    </div>
  );
}

/* ---------------- 沟通运营（v1.5.0 L）：平台公告 + 按空间双向消息 ----------------
 * 公告：发布即经站内通知触达目标空间 + 用户端办公室首页公告区；撤下写审计。
 * 消息：按空间一条线程，收件人恒为空间所有者；未读计数在收件箱列表呈现，打开线程即已读。 */
function AdminCommsCard() {
  const { post, send, toast } = useApp();
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [threads, setThreads] = useState<AdminThreadItem[]>([]);
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [annForm, setAnnForm] = useState({ title: '', body: '', scope: 'all' as 'all' | 'selected', workspaceId: '' });
  const [editingAnn, setEditingAnn] = useState<AnnouncementItem | null>(null);
  const [openWs, setOpenWs] = useState('');
  const [threadMsgs, setThreadMsgs] = useState<ThreadMessageItem[]>([]);
  const [reply, setReply] = useState('');
  const [replyTeamId, setReplyTeamId] = useState('');
  const [threadTeams, setThreadTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [newMsgWs, setNewMsgWs] = useState('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [anns, ths, wsj] = await Promise.all([
        fetchAdminAnnouncements(),
        fetchAdminThreads(),
        requestRaw('GET', '/api/admin/workspaces'),
      ]);
      setAnnouncements(anns);
      setThreads(ths);
      setWorkspaces((wsj.workspaces as AdminWorkspace[]) ?? []);
    } catch {
      /* 忽略瞬时错误 */
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function publishAnn() {
    if (!annForm.title.trim() || !annForm.body.trim()) return toast('公告标题与正文必填');
    const payload = {
      title: annForm.title.trim(),
      body: annForm.body.trim(),
      scope: annForm.scope,
      workspaceIds: annForm.scope === 'selected' ? [annForm.workspaceId].filter(Boolean) : [],
    };
    try {
      if (editingAnn) await send('PUT', `/api/admin/announcements/${editingAnn.id}`, payload);
      else await post('/api/admin/announcements', payload);
    } catch { return; }
    toast(editingAnn ? '公告已更新' : '公告已发布并触达目标空间');
    setAnnForm({ title: '', body: '', scope: 'all', workspaceId: '' });
    setEditingAnn(null);
    load();
  }

  async function withdrawAnn(a: AnnouncementItem) {
    try {
      await post(`/api/admin/announcements/${a.id}/withdraw`);
    } catch { return; }
    toast('公告已撤下');
    load();
  }

  async function openThread(workspaceId: string) {
    setOpenWs(workspaceId);
    try {
      setThreadMsgs(await fetchAdminThreadMessages(workspaceId));
      const j = await requestRaw('GET', `/api/admin/workspaces/${workspaceId}/teams`).catch(() => null);
      setThreadTeams(((j?.teams as Array<{ id: string; name: string }>) ?? []));
      await post(`/api/admin/threads/${workspaceId}/read`);
      setThreads((prev) => prev.map((t) => (t.workspaceId === workspaceId ? { ...t, unread: 0 } : t)));
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function sendReply() {
    const target = openWs || newMsgWs;
    if (!target) return toast('先选择一个空间');
    if (!reply.trim()) return;
    try {
      await post(`/api/admin/threads/${target}/messages`, {
        body: reply.trim(),
        ...(replyTeamId ? { teamId: replyTeamId } : {}),
      });
    } catch { return; }
    setReply('');
    setReplyTeamId('');
    await openThread(target);
    load();
  }

  const totalUnread = threads.reduce((s, t) => s + t.unread, 0);

  return (
    <div className="card">
      <h2>
        沟通运营{' '}
        <span className="tag">平台公告（首页公告区 + 通知触达）与按空间消息线程；收件箱未读 {totalUnread} 条</span>
      </h2>

      <h3>发布公告</h3>
      <div className="apicard">
        <label>标题</label>
        <Input value={annForm.title} onChange={(e) => setAnnForm({ ...annForm, title: e.target.value })} />
        <label>正文</label>
        <textarea rows={3} value={annForm.body} onChange={(e) => setAnnForm({ ...annForm, body: e.target.value })} style={{ width: '100%' }} />
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 6 }}>
          <div style={{ flex: '0 0 180px' }}>
            <label>投放范围</label>
            <Select
              value={annForm.scope}
              onValueChange={(v) => setAnnForm({ ...annForm, scope: v as 'all' | 'selected' })}
              options={[
                { value: 'all', label: '全部空间' },
                { value: 'selected', label: '选定空间' },
              ]}
            />
          </div>
          {annForm.scope === 'selected' && (
            <div style={{ flex: '0 0 220px' }}>
              <label>空间</label>
              <Select
                value={annForm.workspaceId}
                onValueChange={(v) => setAnnForm({ ...annForm, workspaceId: v })}
                placeholder="选择空间"
                options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
              />
            </div>
          )}
          <div>
            <Button size="small" variant="blue" onClick={publishAnn}>{editingAnn ? '保存修改' : '发布公告'}</Button>{' '}
            {editingAnn && (
              <Button size="small" variant="gray" onClick={() => { setEditingAnn(null); setAnnForm({ title: '', body: '', scope: 'all', workspaceId: '' }); }}>
                取消编辑
              </Button>
            )}
          </div>
        </div>
      </div>
      {loaded && announcements.length === 0 && <p className="hint">暂无公告。</p>}
      {announcements.map((a) => (
        <div className="task" key={a.id}>
          <span className="tt">{a.title}</span>{' '}
          <Badge variant={a.status === 'published' ? 'done' : 'rej'}>{a.status === 'published' ? '已发布' : '已撤下'}</Badge>{' '}
          <Badge>{a.scope === 'all' ? '全部空间' : `选定 ${a.workspaceIds.length} 个空间`}</Badge>
          <div className="meta">发布于 {fmtTime(a.publishedAt)}</div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{a.body}</div>
          <Button
            size="small"
            variant="gray"
            onClick={() => {
              setEditingAnn(a);
              setAnnForm({ title: a.title, body: a.body, scope: a.scope, workspaceId: a.workspaceIds[0] ?? '' });
            }}
          >
            编辑
          </Button>{' '}
          {a.status === 'published' && (
            <Button size="small" variant="gray" onClick={() => withdrawAnn(a)}>撤下</Button>
          )}
        </div>
      ))}

      <h3 style={{ marginTop: 16 }}>空间收件箱</h3>
      {loaded && threads.length === 0 && <p className="hint">暂无任何空间的会话（给空间发第一条消息后会出现）。</p>}
      {threads.map((t) => (
        <div className="task" key={t.workspaceId}>
          <span className="tt">{t.workspaceName}</span>{' '}
          {t.unread > 0 && <Badge variant="rej">未读 {t.unread}</Badge>}
          <div className="meta">
            所有者：{t.ownerName || '—'}
            {t.lastMessage ? <> · 最近：{t.lastMessage.body.slice(0, 60)}（{fmtTime(t.lastMessage.createdAt)}）</> : null}
          </div>
          <Button size="small" variant="gray" onClick={() => openThread(t.workspaceId)}>
            {openWs === t.workspaceId ? '收起' : '打开会话'}
          </Button>
        </div>
      ))}
      <div className="apicard" style={{ marginTop: 10 }}>
        <label>{openWs ? `回复「${threads.find((t) => t.workspaceId === openWs)?.workspaceName ?? openWs}」` : '给空间发新消息'}</label>
        {!openWs && (
          <div style={{ maxWidth: 260, marginBottom: 6 }}>
            <Select
              value={newMsgWs}
              onValueChange={setNewMsgWs}
              placeholder="选择空间"
              options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
            />
          </div>
        )}
        {openWs && threadMsgs.map((m) => (
          <div key={m.id} className="meta" style={{ margin: '4px 0' }}>
            <b>{m.senderType === 'owner' ? '空间所有者' : m.senderUserId === 'user_ai_operator' ? 'AI 运营官' : '平台（我方）'}</b>
            {m.kind === 'skill_push' ? ' · 技能下发说明' : m.kind === 'review_note' ? ' · 审核说明' : ''}
            {m.teamName ? ` · 关于小组「${m.teamName}」` : ''} · {fmtTime(m.createdAt)}
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
          </div>
        ))}
        <textarea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} style={{ width: '100%' }} placeholder="输入消息正文…" />
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 6 }}>
          {openWs && threadTeams.length > 0 && (
            <div style={{ flex: '0 0 200px' }}>
              <label>关联小组（可选）</label>
              <Select
                value={replyTeamId}
                onValueChange={setReplyTeamId}
                placeholder="不关联"
                emptyLabel="不关联"
                options={threadTeams.map((t) => ({ value: t.id, label: t.name }))}
              />
            </div>
          )}
          <div>
            <Button size="small" variant="blue" onClick={sendReply}>发送</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 技能下发（v1.5.0 K） ----------------
 * GitHub 导入（LICENSE 预检，非宽松拒绝并留痕）→ 平台草稿（可编辑）→ 上架平台库 /
 * 推送下发（选空间或全部，服务端快照安装、同版幂等，空间线程同步落说明消息）。 */
function SkillDispatchCard() {
  const { post, send, toast } = useApp();
  const [repoUrl, setRepoUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [imports, setImports] = useState<SkillImportItem[]>([]);
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [editing, setEditing] = useState<SkillListItem | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', role: '', promptTemplate: '', outputSpec: '' });
  const [pushTarget, setPushTarget] = useState<Record<string, string>>({});
  const [pushNote, setPushNote] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [imps, sks, wsj] = await Promise.all([
        fetchSkillImports(),
        fetchPlatformSkillsAdmin(),
        requestRaw('GET', '/api/admin/workspaces'),
      ]);
      setImports(imps);
      setSkills(sks);
      setWorkspaces((wsj.workspaces as AdminWorkspace[]) ?? []);
    } catch {
      /* 忽略瞬时错误 */
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function doImport() {
    if (!repoUrl.trim()) return toast('先填 GitHub 仓库地址');
    setImporting(true);
    try {
      const j = await post('/api/admin/skill-imports', { repoUrl: repoUrl.trim() });
      const rec = j.record as SkillImportItem;
      toast(
        rec.status === 'imported'
          ? `导入完成：${rec.detail}`
          : rec.status === 'rejected_license'
            ? `已拒绝：${rec.detail}`
            : `导入失败：${rec.detail}`,
      );
      setRepoUrl('');
      load();
    } catch {
      /* post 已 toast */
    } finally {
      setImporting(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    try {
      await send('PUT', `/api/admin/skills/${editing.id}`, editForm);
    } catch { return; }
    toast('草稿已保存');
    setEditing(null);
    load();
  }

  async function publish(s: SkillListItem) {
    try {
      await post(`/api/admin/skills/${s.id}/publish`);
    } catch { return; }
    toast(`「${s.name}」已上架平台技能库`);
    load();
  }

  async function push(s: SkillListItem) {
    const target = pushTarget[s.id] ?? 'all';
    try {
      const j = await post(`/api/admin/skills/${s.id}/push`, {
        workspaceIds: target === 'all' ? 'all' : [target],
        ...(pushNote[s.id]?.trim() ? { note: pushNote[s.id].trim() } : {}),
      });
      toast(`推送完成：新装 ${j.installed} · 升级 ${j.upgraded} · 跳过 ${j.skipped}（同版不重复装）`);
    } catch {
      /* post 已 toast */
    }
  }

  return (
    <div className="card">
      <h2>技能下发 <span className="tag">从 GitHub 导入平台技能（许可证预检）→ 草稿编辑 → 上架自装 / 推送下发到空间</span></h2>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 320px' }}>
          <label>GitHub 仓库地址（内含 SKILL.md 定义文件）</label>
          <Input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="如 https://github.com/owner/repo 或 owner/repo"
          />
        </div>
        <div>
          <Button variant="blue" disabled={importing} onClick={doImport}>
            {importing ? '导入中…' : '导入'}
          </Button>
        </div>
      </div>
      {imports.slice(0, 5).map((r) => (
        <div className="meta" key={r.id} style={{ marginTop: 6 }}>
          {fmtTime(r.created_at)} · {r.repo || r.repo_url} · 许可证 {r.license || '—'}
          {r.license_ok ? '' : '（未过预检）'} · {r.status}——{r.detail}
        </div>
      ))}

      <h3 style={{ marginTop: 14 }}>平台技能（导入来源）</h3>
      {loaded && skills.filter((s) => s.sourceRepo).length === 0 && (
        <p className="hint">暂无导入的平台技能（上方导入后在这里编辑、上架、推送）。</p>
      )}
      {skills
        .filter((s) => s.sourceRepo)
        .map((s) => (
          <div className="task" key={s.id}>
            <span className="tt">{s.name}</span>{' '}
            <Badge>{s.role}</Badge> <Badge>v{s.version}</Badge>{' '}
            <Badge variant={s.status === 'published' ? 'done' : 'adj'}>{s.status === 'published' ? '已上架' : '草稿'}</Badge>
            <div className="meta">
              来源：{s.sourceRepo} · {s.sourceAuthor} · {s.sourceLicense}
              <br />
              {s.description || '（无说明）'}
            </div>
            <div className="row" style={{ alignItems: 'flex-end', marginTop: 6 }}>
              <div>
                <Button
                  size="small"
                  variant="gray"
                  onClick={() => {
                    setEditing(s);
                    setEditForm({
                      name: s.name,
                      description: s.description,
                      role: s.role,
                      promptTemplate: s.promptTemplate,
                      outputSpec: s.outputSpec ?? '',
                    });
                  }}
                >
                  编辑
                </Button>{' '}
                {s.status !== 'published' && (
                  <Button size="small" variant="green" onClick={() => publish(s)}>上架平台库</Button>
                )}
              </div>
              {s.status === 'published' && (
                <>
                  <div style={{ flex: '0 0 200px' }}>
                    <label>推送到</label>
                    <Select
                      value={pushTarget[s.id] ?? 'all'}
                      onValueChange={(v) => setPushTarget((m) => ({ ...m, [s.id]: v }))}
                      options={[
                        { value: 'all', label: '全部空间' },
                        ...workspaces.map((w) => ({ value: w.id, label: w.name })),
                      ]}
                    />
                  </div>
                  <div style={{ flex: '1 1 160px' }}>
                    <label>附言（可选，进空间线程）</label>
                    <Input
                      value={pushNote[s.id] ?? ''}
                      onChange={(e) => setPushNote((m) => ({ ...m, [s.id]: e.target.value }))}
                      placeholder="如：本周统一改用这个写标题"
                    />
                  </div>
                  <div>
                    <Button size="small" variant="blue" onClick={() => push(s)}>推送下发</Button>
                  </div>
                </>
              )}
            </div>
            {editing?.id === s.id && (
              <div className="apicard" style={{ marginTop: 8 }}>
                <label>名称</label>
                <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                <label>说明</label>
                <Input value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
                <label>工种</label>
                <Input value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })} />
                <label>提示词模板</label>
                <textarea rows={6} value={editForm.promptTemplate} onChange={(e) => setEditForm({ ...editForm, promptTemplate: e.target.value })} style={{ width: '100%' }} />
                <label>产出规格</label>
                <Input value={editForm.outputSpec} onChange={(e) => setEditForm({ ...editForm, outputSpec: e.target.value })} />
                <div style={{ marginTop: 8 }}>
                  <Button size="small" variant="blue" onClick={saveEdit}>保存草稿</Button>{' '}
                  <Button size="small" variant="gray" onClick={() => setEditing(null)}>取消</Button>
                </div>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

/* ---------------- AI 平台运营官（v1.5.0 M，一期） ----------------
 * 一句话指令 → 平台级 API 解析为结构化计划 → 预览（破坏性步骤标红、需一次确认）→ 逐步执行 →
 * 每步写审计并关联原指令与 run；公告/平台知识/技能下发三类支持按步回滚。未配置平台体验 API 时后端明确报错。 */
function AiOpsCard() {
  const { post, toast } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [instruction, setInstruction] = useState('');
  const [current, setCurrent] = useState<AiOpsRunItem | null>(null);
  const [runs, setRuns] = useState<AiOpsRunItem[]>([]);
  const [busy, setBusy] = useState('');

  const loadRuns = useCallback(async () => {
    try {
      setRuns(await fetchAiOpsRuns());
    } catch {
      /* 忽略 */
    }
  }, []);
  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  async function plan() {
    if (!instruction.trim()) return toast('先输入一句指令');
    setBusy('plan');
    try {
      const j = await post('/api/admin/ai-ops/plan', { instruction: instruction.trim() });
      setCurrent(j.run as AiOpsRunItem);
      loadRuns();
    } catch {
      /* post 已 toast（未配置平台 API 等明确错误在这里呈现） */
    } finally {
      setBusy('');
    }
  }

  async function execute(confirmDestructive: boolean) {
    if (!current) return;
    setBusy('exec');
    try {
      const j = await post(`/api/admin/ai-ops/runs/${current.id}/execute`, { confirmDestructive });
      const run = j.run as AiOpsRunItem;
      setCurrent(run);
      if (run.status === 'awaiting_confirm') {
        toast('计划含破坏性步骤，请核对后点「确认破坏性步骤并执行」');
      } else {
        toast(`执行完成：成功 ${run.report?.done ?? 0} 步、失败 ${run.report?.failed ?? 0} 步`);
      }
      loadRuns();
    } catch {
      /* post 已 toast */
    } finally {
      setBusy('');
    }
  }

  function rollback(run: AiOpsRunItem, stepIndex: number) {
    ask({
      title: '回滚该步',
      message: `回滚第 ${stepIndex + 1} 步（${run.steps[stepIndex]?.op}）？公告会撤下、平台知识会还原、技能下发会卸载对应空间副本。`,
      confirmLabel: '回滚',
      onConfirm: async () => {
        try {
          const j = await post(`/api/admin/ai-ops/runs/${run.id}/rollback/${stepIndex}`);
          toast(String(j.summary ?? '已回滚'));
          if (j.run) setCurrent(j.run as AiOpsRunItem);
          loadRuns();
        } catch {
          /* post 已 toast */
        }
      },
    });
  }

  const stepLine = (run: AiOpsRunItem, s: AiOpsRunItem['steps'][number], i: number) => (
    <div className="task" key={`${run.id}-${i}`}>
      <span className="tt" style={{ fontSize: 13.5 }}>
        {i + 1}. {s.op}
      </span>{' '}
      {s.destructive && <Badge variant="rej">破坏性</Badge>}{' '}
      <Badge
        variant={s.status === 'done' ? 'done' : s.status === 'failed' ? 'rej' : s.status === 'rolled_back' ? 'can' : 'adj'}
      >
        {s.status === 'done' ? '已执行' : s.status === 'failed' ? '失败' : s.status === 'rolled_back' ? '已回滚' : '待执行'}
      </Badge>
      <div className="meta">
        参数：{JSON.stringify(s.params)}
        {s.summary ? <><br />结果：{s.summary}</> : null}
        {s.error ? <><br />失败：{s.error}</> : null}
      </div>
      {s.status === 'done' && s.rollback && (
        <Button size="small" variant="gray" onClick={() => rollback(run, i)}>回滚这一步</Button>
      )}
    </div>
  );

  return (
    <div className="card">
      <h2>
        AI 运营{' '}
        <span className="tag">一句话自动维护平台：指令 → 结构化计划 → 执行 → 审计留痕；驱动模型用平台体验 API（未配置会明确提示）</span>
      </h2>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 380px' }}>
          <label>给运营官的指令</label>
          <Input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="如：给全部空间发一条公告：本周六凌晨维护；或：现在有多少待审积压"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void plan();
            }}
          />
        </div>
        <div>
          <Button variant="blue" disabled={busy === 'plan'} onClick={plan}>
            {busy === 'plan' ? '解析中…' : '生成计划'}
          </Button>
        </div>
      </div>

      {current && (
        <div style={{ marginTop: 10 }}>
          <div className="hint" style={{ fontWeight: 600 }}>
            当前计划（run {current.id}，状态 {current.status}）：{current.instruction}
          </div>
          {current.steps.map((s, i) => stepLine(current, s, i))}
          {current.status === 'planned' && (
            <Button variant="blue" disabled={busy === 'exec'} onClick={() => execute(false)}>
              {busy === 'exec' ? '执行中…' : '执行计划'}
            </Button>
          )}
          {current.status === 'awaiting_confirm' && (
            <Button variant="blue" disabled={busy === 'exec'} onClick={() => execute(true)}>
              {busy === 'exec' ? '执行中…' : '⚠️ 确认破坏性步骤并执行'}
            </Button>
          )}
          {current.report && (
            <p className="hint">
              执行报告：共 {current.report.total} 步，成功 {current.report.done}、失败 {current.report.failed}
              {current.finishedAt ? `，完成于 ${fmtTime(current.finishedAt)}` : ''}
            </p>
          )}
        </div>
      )}

      <h3 style={{ marginTop: 16 }}>历史 run（可回看/回滚）</h3>
      {runs.length === 0 && <p className="hint">暂无运营记录。</p>}
      {runs.slice(0, 10).map((r) => (
        <div className="task" key={r.id} style={{ opacity: 0.9 }}>
          <span className="tt" style={{ fontSize: 13.5 }}>{r.instruction}</span>{' '}
          <Badge>{r.status}</Badge> <Badge>{fmtTime(r.createdAt)}</Badge>
          <div className="meta">
            {r.steps.map((s, i) => (
              <span key={i}>
                {i + 1}.{s.op}（{s.status}）{s.summary ? `：${s.summary}` : ''}{s.error ? `：失败 ${s.error}` : ''}；
              </span>
            ))}
          </div>
          <Button size="small" variant="gray" onClick={() => setCurrent(r)}>回看</Button>
        </div>
      ))}
      {confirmNode}
    </div>
  );
}

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

/* ---------------- 统一审核中心（v1.5.0 D） ----------------
 * skill 上架 / 风格模板 / 智能体模板三条待审队列合一：类型筛选、逐项变更摘要（含风险标记）、
 * 勾选批量通过/驳回（驳回原因必填，可附一条说明消息进对应空间线程——智能体模板无所属空间不落线程）。 */
const REVIEW_TYPE_LABEL: Record<string, string> = { skill: '技能', style: '风格模板', agent: '智能体' };
function ReviewCenterCard() {
  const { post, toast } = useApp();
  const [items, setItems] = useState<ReviewCenterItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await fetchReviewCenter());
      setSelected(new Set());
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoaded(true);
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);

  const visible = items.filter((i) => !typeFilter || i.type === typeFilter);
  const key = (i: ReviewCenterItem) => `${i.type}:${i.id}`;
  const selItems = items.filter((i) => selected.has(key(i)));

  async function batch(action: 'approve' | 'reject') {
    if (selItems.length === 0) return toast('先勾选要处理的条目');
    if (action === 'reject' && !reason.trim()) return toast('驳回原因必填');
    setBusy(true);
    try {
      const j = await post('/api/admin/review-center/batch', {
        action,
        reason: action === 'reject' ? reason.trim() : undefined,
        note: action === 'reject' && note.trim() ? note.trim() : undefined,
        items: selItems.map((i) => ({ type: i.type, id: i.id })),
      });
      const results = (j.results as Array<{ ok: boolean }>) ?? [];
      const okCount = results.filter((r) => r.ok).length;
      toast(`已处理 ${okCount}/${results.length} 条${action === 'approve' ? '（通过）' : '（驳回）'}`);
      setRejectOpen(false);
      setReason('');
      setNote('');
      load();
    } catch {
      /* post 已 toast */
    } finally {
      setBusy(false);
    }
  }

  async function single(item: ReviewCenterItem, action: 'approve' | 'reject') {
    if (action === 'reject') {
      setSelected(new Set([key(item)]));
      setRejectOpen(true);
      return;
    }
    setBusy(true);
    try {
      await post('/api/admin/review-center/batch', { action, items: [{ type: item.type, id: item.id }] });
      toast(`已通过「${item.title}」`);
      load();
    } catch {
      /* post 已 toast */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>审核中心 <span className="tag">skill 上架 / 风格模板 / 智能体模板三条待审队列合一；待处理 {items.length} 条</span></h2>
      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 8 }}>
        <div style={{ flex: '0 0 170px' }}>
          <label>类型筛选</label>
          <Select
            value={typeFilter}
            onValueChange={setTypeFilter}
            emptyLabel="全部类型"
            options={[
              { value: 'skill', label: '技能' },
              { value: 'style', label: '风格模板' },
              { value: 'agent', label: '智能体' },
            ]}
          />
        </div>
        <div>
          <Button size="small" variant="green" disabled={busy || selItems.length === 0} onClick={() => batch('approve')}>
            批量通过（{selItems.length}）
          </Button>{' '}
          <Button size="small" variant="gray" disabled={busy || selItems.length === 0} onClick={() => setRejectOpen(true)}>
            批量驳回
          </Button>{' '}
          <Button size="small" variant="gray" onClick={load}>刷新</Button>
        </div>
      </div>
      {!loaded && <p><Spinner label="加载中…" /></p>}
      {loaded && visible.length === 0 && <p className="hint">暂无待审条目。</p>}
      {visible.map((i) => (
        <div className="task" key={key(i)}>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={selected.has(key(i))}
              onChange={(e) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(key(i));
                  else next.delete(key(i));
                  return next;
                });
              }}
            />
            <span className="tt">{i.title}</span>
          </label>{' '}
          <Badge variant="adj">{REVIEW_TYPE_LABEL[i.type]}</Badge>{' '}
          <Badge>{i.subtitle}</Badge>
          {i.riskFlags.map((f) => (
            <Badge key={f} variant="rej">风险：{f}</Badge>
          ))}
          <div className="meta">{i.changeSummary}</div>
          {i.styleDetail && (
            <div className="meta">
              配色{' '}
              <span className="style-admin-swatches">
                <span style={{ background: i.styleDetail.wall }} title={`墙面 ${i.styleDetail.wall}`} />
                <span style={{ background: i.styleDetail.floor }} title={`地板 ${i.styleDetail.floor}`} />
                <span style={{ background: i.styleDetail.accent }} title={`点缀 ${i.styleDetail.accent}`} />
              </span>{' '}
              · 地板纹样 {i.styleDetail.floorPattern}
              {i.styleDetail.signText ? <> · 招牌文字：{i.styleDetail.signText}</> : null}
            </div>
          )}
          {i.styleDetail && i.styleDetail.images.length > 0 && (
            <div className="style-admin-thumbs">
              {i.styleDetail.images.map((im) => (
                <span key={im.id}>
                  <img src={`/api/style-images/${im.id}`} alt={`${im.label}（待审图）`} />
                  <div className="hint">{im.label}</div>
                </span>
              ))}
            </div>
          )}
          <Button size="small" variant="green" disabled={busy} onClick={() => single(i, 'approve')}>通过</Button>{' '}
          <Button size="small" variant="gray" disabled={busy} onClick={() => single(i, 'reject')}>驳回</Button>
        </div>
      ))}
      {rejectOpen && (
        <Dialog open onClose={() => setRejectOpen(false)} title={`驳回 ${selItems.length} 条`}>
          <Field label="驳回原因（必填，记入审计；智能体模板会回显给平台记录）">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：内容质量不达标 / 含违规表述" autoFocus />
          </Field>
          <Field label="附一条说明消息（可选，进对应空间的消息线程；智能体模板无所属空间不发送）">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：改完第 2 段再提交即可" />
          </Field>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <Button disabled={busy} onClick={() => batch('reject')}>确认驳回</Button>
            <Button variant="gray" onClick={() => setRejectOpen(false)}>取消</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/* ---------------- skill 精选管理（v1.3.0 生态） ----------------
 * 操作走 api.ts 的 adminFeatureSkill(id, featured)（外壳子任务契约，开工后已落地）；
 * 失败时 toast 抛出的后端原文 message，成功后本地刷新列表。 */
function SkillFeaturedCard() {
  const { toast } = useApp();
  const [items, setItems] = useState<SkillListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try {
      const all = await fetchSkills();
      setItems(all.filter((s) => s.ownerType === 'workspace' && s.visibility === 'public'));
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoaded(true);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(s: SkillListItem, featured: boolean) {
    setBusyId(s.id);
    try {
      await adminFeatureSkill(s.id, featured);
    } catch (e) {
      setBusyId('');
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    setBusyId('');
    toast(featured ? `「${s.name}」已晋升官方精选` : `「${s.name}」已取消官方精选`);
    load();
  }

  return (
    <div className="card">
      <h2>精选管理 <span className="tag">已上架的用户贡献技能可晋升「官方精选」，在平台库置顶成区展示；取消精选即撤下</span></h2>
      {!loaded && <p><Spinner label="加载中…" /></p>}
      {loaded && items.length === 0 && <p className="hint">暂无已上架的用户贡献技能。</p>}
      {items.map((s) => (
        <div className="task" key={s.id}>
          <span className="tt">{s.name}</span>
          <Badge>{s.role}</Badge>
          <Badge>v{s.version}</Badge>
          {s.featured && <Badge variant="adj">官方精选</Badge>}
          <div className="meta">
            {s.description || '（无说明）'}
            <br />
            {s.contributorWorkspaceName || s.contributorName
              ? `由 ${s.contributorWorkspaceName ?? ''}${s.contributorWorkspaceName && s.contributorName ? ' · ' : ''}${s.contributorName ?? ''} 贡献`
              : '平台用户贡献'}
            {' '}· 已被安装 {s.installCount} 次
            {s.listedAt ? ` · 上架于 ${s.listedAt.slice(0, 16).replace('T', ' ')}` : ''}
            {s.featuredAt ? ` · 精选于 ${s.featuredAt.slice(0, 16).replace('T', ' ')}` : ''}
          </div>
          <div style={{ marginTop: 6 }}>
            {s.featured ? (
              <Button size="small" variant="gray" disabled={busyId === s.id} onClick={() => toggle(s, false)}>
                取消精选
              </Button>
            ) : (
              <Button size="small" variant="green" disabled={busyId === s.id} onClick={() => toggle(s, true)}>
                晋升官方精选
              </Button>
            )}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="gray" onClick={load}>刷新</Button>
      </div>
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
