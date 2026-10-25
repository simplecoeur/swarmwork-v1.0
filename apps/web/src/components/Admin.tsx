import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import {
  adminApproveStyleTemplate,
  adminFeatureSkill,
  adminRejectStyleTemplate,
  fetchAdminAgentTemplates,
  fetchAdminPlatformKb,
  fetchAdminStyleTemplatesPending,
  fetchAgentSyncRuns,
  fetchAgentSyncSources,
  fetchSkills,
  requestRaw,
  runAgentSync,
  saveAgentSyncSources,
  type AdminAgentTemplateItem,
  type AdminPlatformKbItem,
  type AgentSyncBoardItem,
  type AgentSyncRunItem,
  type AgentSyncSourceItem,
  type StyleTemplateItem,
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

      {/* ---------- skill 上架审核（M7） ---------- */}
      <SkillReviewCard />

      {/* ---------- skill 精选管理（v1.3.0 生态） ---------- */}
      <SkillFeaturedCard />

      {/* ---------- 风格模板审核（v1.3.0 F） ---------- */}
      <StyleTemplateReviewCard />

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

/* ---------------- 智能体人才库（v1.4.0 J） ----------------
 * 白名单源（settings 平台伪空间）+ 立即同步（结果计数原文回显）+ 模板审核：
 * 通过 = pub 快照取 draft（可改工种）；驳回原因必填——首次审置 rejected，
 * 已上架模板的更新被驳则 draft 回滚为 pub、保留上架。基础工种与服务端注册表一致。 */
const AGENT_BASE_ROLES = ['组长', '研究员', '文案', '程序员', '审核'];
const AGENT_STATUS_BADGE: Record<AdminAgentTemplateItem['status'], { label: string; variant: 'adj' | 'done' | 'rej' }> = {
  pending_review: { label: '待审核', variant: 'adj' },
  public: { label: '已上架', variant: 'done' },
  rejected: { label: '已驳回', variant: 'rej' },
};

function AgentTalentCard() {
  const { post, toast } = useApp();
  const [sources, setSources] = useState<AgentSyncSourceItem[]>([]);
  const [templates, setTemplates] = useState<AdminAgentTemplateItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [syncingId, setSyncingId] = useState('');
  const [syncResult, setSyncResult] = useState('');
  const [roleByTpl, setRoleByTpl] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<AdminAgentTemplateItem | null>(null);
  const [reason, setReason] = useState('');
  const [newSource, setNewSource] = useState<AgentSyncSourceItem>({ id: '', repo: '', branch: 'main', license: '', author: '' });
  /* v1.5.0 C 流水线看板 */
  const [board, setBoard] = useState<AgentSyncBoardItem[]>([]);
  const [runs, setRuns] = useState<AgentSyncRunItem[]>([]);

  const load = useCallback(async () => {
    try {
      const [src, tpl, pipe] = await Promise.all([
        fetchAgentSyncSources(),
        fetchAdminAgentTemplates(),
        fetchAgentSyncRuns().catch(() => ({ board: [], runs: [] })),
      ]);
      setSources(src);
      setTemplates(tpl);
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

  async function approve(t: AdminAgentTemplateItem) {
    const role = roleByTpl[t.id] || t.draftRole;
    try {
      await post(`/api/admin/agent-templates/${t.id}/approve`, role !== t.draftRole ? { suggestedRole: role } : {});
    } catch { return; }
    toast(`已通过「${t.draftName}」，已上架人才库`);
    load();
  }

  async function reject() {
    if (!rejecting) return;
    if (!reason.trim()) {
      toast('驳回原因必填');
      return;
    }
    const t = rejecting;
    try {
      await post(`/api/admin/agent-templates/${t.id}/reject`, { reason: reason.trim() });
    } catch { return; }
    toast(
      t.status === 'public'
        ? `已驳回「${t.draftName}」的更新，草稿已回滚为上架版`
        : `已驳回「${t.draftName}」`,
    );
    setRejecting(null);
    setReason('');
    load();
  }

  const pendingCount = templates.filter((t) => t.status === 'pending_review' || t.hasPendingUpdate).length;

  return (
    <div className="card">
      <h2>
        智能体人才库{' '}
        <span className="tag">GitHub 白名单源同步 → 本台审核上架 → 用户在人才库招募；待处理 {pendingCount} 条</span>
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

      <h3 style={{ marginTop: 16 }}>模板审核（全部 {templates.length} 条）</h3>
      {!loaded && <p><Spinner label="加载中…" /></p>}
      {loaded && templates.length === 0 && <p className="hint">暂无模板，先对同步源点「立即同步」。</p>}
      {templates.map((t) => {
        const st = AGENT_STATUS_BADGE[t.status];
        const actionable = t.status === 'pending_review' || t.hasPendingUpdate;
        return (
          <div className="task" key={t.id}>
            <span className="tt">{t.draftName}</span>{' '}
            <Badge variant={st.variant}>{st.label}</Badge>{' '}
            {t.hasPendingUpdate && <Badge variant="rev">有更新待复审</Badge>}{' '}
            <Badge>{t.draftRole}</Badge> <Badge>{t.language === 'zh' ? '中文' : '英文'}</Badge>{' '}
            <Badge>已招募 {t.recruitCount} 次</Badge>
            {(t.riskFlags ?? []).map((f) => (
              <Badge key={f} variant="rej">风险：{f}</Badge>
            ))}
            <div className="meta">
              来源：{t.sourceRepo}/{t.sourcePath} · 署名 {t.sourceAuthor} · {t.license}
              <br />
              {t.diffSummary}
              <br />
              草稿专长：{t.draftSpecialty || '（无）'}
              {t.status === 'public' && (
                <>
                  <br />
                  已上架：{t.pubName}（{t.pubRole}）{t.hasPendingUpdate ? '——上方为待复审的新草稿，线上仍是此版' : ''}
                </>
              )}
              {t.rejectReason && (
                <>
                  <br />
                  驳回原因：{t.rejectReason}
                </>
              )}
            </div>
            {actionable && (
              <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Select
                  value={roleByTpl[t.id] || t.draftRole}
                  onValueChange={(v) => setRoleByTpl((m) => ({ ...m, [t.id]: v }))}
                  options={AGENT_BASE_ROLES.map((r) => ({ value: r, label: r }))}
                  ariaLabel="上架工种"
                />
                <Button size="small" variant="green" onClick={() => approve(t)}>
                  {t.hasPendingUpdate ? '通过更新' : '通过上架'}
                </Button>
                <Button size="small" variant="gray" onClick={() => { setRejecting(t); setReason(''); }}>驳回</Button>
              </div>
            )}
          </div>
        );
      })}
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="gray" onClick={load}>刷新</Button>
      </div>
      {rejecting && (
        <Dialog open onClose={() => setRejecting(null)} title={`驳回「${rejecting.draftName}」`}>
          <Field label="驳回原因（必填，会记入审计）">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：人设含违规内容 / 质量不达标" autoFocus />
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

/* ---------------- 风格模板审核（v1.3.0 F） ----------------
 * 审核即含图片内容审核：模板 config 带海报/招牌图时展示缩略图供管理员肉眼过审。
 * 待审列表端点为服务端第二阶段补口（GET /api/admin/style-templates/pending），先行对接。 */
function StyleTemplateReviewCard() {
  const { toast } = useApp();
  const [pending, setPending] = useState<StyleTemplateItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [rejecting, setRejecting] = useState<StyleTemplateItem | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try {
      setPending(await fetchAdminStyleTemplatesPending());
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoaded(true);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(t: StyleTemplateItem) {
    setBusyId(t.id);
    try {
      await adminApproveStyleTemplate(t.id);
    } catch (e) {
      setBusyId('');
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    setBusyId('');
    toast(`已通过「${t.name}」，已上架平台风格库`);
    load();
  }

  async function reject() {
    if (!rejecting) return;
    const t = rejecting;
    setBusyId(t.id);
    try {
      await adminRejectStyleTemplate(t.id, reason);
    } catch (e) {
      setBusyId('');
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    setBusyId('');
    toast(`已驳回「${t.name}」，退回提交方空间可见状态`);
    setRejecting(null);
    setReason('');
    load();
  }

  return (
    <div className="card">
      <h2>风格模板审核 <span className="tag">用户提交上架的办公室风格在此过审（含海报/招牌图片内容审核）：通过 → 进平台库公开；驳回 → 退回本空间可见</span></h2>
      {!loaded && <p><Spinner label="加载中…" /></p>}
      {loaded && pending.length === 0 && <p className="hint">暂无待审核的风格模板。</p>}
      {pending.map((t) => {
        const cfg = t.config;
        const furnCount = Object.values(cfg.furniture ?? {}).filter((v) => v).length;
        const imgs: Array<{ label: string; id: string }> = [];
        if (cfg.poster?.imageFileId) imgs.push({ label: '海报', id: cfg.poster.imageFileId });
        if (cfg.sign?.mode === 'image' && cfg.sign.imageFileId) imgs.push({ label: '招牌图', id: cfg.sign.imageFileId });
        return (
          <div className="task" key={t.id}>
            <span className="tt">{t.name}</span>
            <Badge variant="adj">待审核</Badge>
            <div className="meta">
              由 {t.contributorWorkspaceName ?? ''} · {t.contributorName ?? ''} 贡献 · 提交于 {t.createdAt.slice(0, 16).replace('T', ' ')}
              <br />
              配色{' '}
              <span className="style-admin-swatches">
                <span style={{ background: cfg.palette.wall }} title={`墙面 ${cfg.palette.wall}`} />
                <span style={{ background: cfg.palette.floor }} title={`地板 ${cfg.palette.floor}`} />
                <span style={{ background: cfg.palette.accent }} title={`点缀 ${cfg.palette.accent}`} />
              </span>{' '}
              {cfg.palette.wall} / {cfg.palette.floor} / {cfg.palette.accent} · 地板纹样 {cfg.floorPattern} · 家具 {furnCount} 件
              {cfg.sign?.mode === 'text' && cfg.sign.text ? <><br />招牌文字：{cfg.sign.text}</> : null}
            </div>
            {imgs.length > 0 && (
              <div className="style-admin-thumbs">
                {imgs.map((im) => (
                  <span key={im.id}>
                    <img src={`/api/style-images/${im.id}`} alt={`${im.label}（待审图）`} />
                    <div className="hint">{im.label}</div>
                  </span>
                ))}
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              <Button size="small" variant="green" disabled={busyId === t.id} onClick={() => approve(t)}>通过上架</Button>{' '}
              <Button size="small" variant="gray" disabled={busyId === t.id} onClick={() => { setRejecting(t); setReason(''); }}>驳回</Button>
            </div>
          </div>
        );
      })}
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="gray" onClick={load}>刷新</Button>
      </div>
      {rejecting && (
        <Dialog open onClose={() => setRejecting(null)} title={`驳回「${rejecting.name}」`}>
          <Field label="驳回原因（会记入审计）">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：海报图片涉及违规内容" autoFocus />
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
