import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import {
  fetchApiTokens,
  fetchChannelPushes,
  fetchChannels,
  fetchPreferences,
  fetchVisitLinks,
  fetchWebhookDeliveries,
  fetchWebhooks,
  putPreference,
  requestRaw,
} from '../api';
import RegistryCard from './RegistryCard';
import FeedbackDialog from './FeedbackDialog';
import { NOTIFICATION_TYPE_LABELS, NOTIFICATION_TYPE_ORDER } from './NotificationBell';
import { Badge, Button, Checkbox, Dialog, Input, Select, Spinner, Switch, Textarea, useConfirm } from './ui';
import type {
  ApiItem,
  ApiToken,
  ChannelInfo,
  ChannelPush,
  Delivery,
  Member,
  NotifyPrefs,
  Team,
  WebhookDelivery,
  WebhookItem,
} from '../types';

const PROVIDERS = ['deepseek', 'openai', 'anthropic', 'custom'];
const ROLES = ['组长', '研究员', '文案', '程序员', '审核'];

/* ---------------- API 表单 ---------------- */
function ApiForm({
  api,
  onDone,
}: {
  api: ApiItem | null; // null = 新增草稿
  onDone: () => Promise<void>;
}) {
  const { presets, post, toast } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [name, setName] = useState(api ? api.name : '');
  const [provider, setProvider] = useState(api ? api.provider : 'deepseek');
  const [baseUrl, setBaseUrl] = useState(api ? api.baseUrl : '');
  const [model, setModel] = useState(api ? api.model : '');
  const [apiKey, setApiKey] = useState('');
  const [pricePerM, setPricePerM] = useState<string>(String(api ? api.pricePerM : 2));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; message: string } | null>(null);

  function onProviderChange(p: string) {
    setProvider(p as ApiItem['provider']);
    // 与原生版 presetFill 一致：预设有值才带出
    const preset = presets[p];
    if (!preset) return;
    if (preset.baseUrl) setBaseUrl(preset.baseUrl);
    if (preset.model) setModel(preset.model);
  }

  async function saveApi() {
    try {
      await post('/api/apis/save', {
        api: {
          id: api ? api.id : undefined,
          name: name.trim(),
          provider,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          pricePerM: parseFloat(pricePerM) || 0,
          apiKey,
        },
      });
    } catch { return; }
    toast('API 已保存');
    await onDone();
  }
  async function clearApiKey() {
    if (!api) return;
    try {
      await post('/api/apis/save', { api: { id: api.id, name: api.name, clearKey: true } });
    } catch { return; }
    toast('Key 已清除');
    await onDone();
  }
  function deleteApi() {
    if (!api) return;
    ask({
      title: '删除 API',
      message: '删除这条 API？',
      confirmLabel: '删除',
      onConfirm: async () => {
        try {
          await post('/api/apis/delete', { id: api.id });
        } catch { return; }
        await onDone();
      },
    });
  }
  /** 测试连接（M5）：测当前表单值（Key 留空且已保存过则用库里 Key），探活不记账不扣费 */
  async function testApi() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await post('/api/apis/test', {
        id: api ? api.id : undefined,
        api: { provider, baseUrl: baseUrl.trim(), model: model.trim(), apiKey },
      });
      setTestResult(res.test as { ok: boolean; latencyMs: number; message: string });
    } catch {
      /* post 已 toast 出错信息 */
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="apicard">
      <div className="row">
        <div>
          <label>名称</label>
          <Input value={name} placeholder="如：DeepSeek 主力" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label>服务商预设</label>
          <Select
            value={provider}
            onValueChange={onProviderChange}
            options={PROVIDERS.map((p) => ({ value: p, label: p }))}
          />
        </div>
      </div>
      <div className="row">
        <div>
          <label>Base URL（预设自动带出，可改）</label>
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
            placeholder={api && api.hasKey ? `已保存：${api.apiKeyMasked}` : '尚未填写'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div>
          <label>采购单价（元/百万 token）</label>
          <Input type="number" step="0.01" min="0" value={pricePerM} onChange={(e) => setPricePerM(e.target.value)} />
        </div>
        <div>
          <label>余额（元，到成本中心充值）</label>
          <Input value={api ? api.balanceYuan : 0} disabled readOnly />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="blue" onClick={saveApi}>保存</Button>{' '}
        <Button size="small" variant="gray" onClick={testApi} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </Button>{' '}
        {api && (
          <>
            <Button size="small" variant="gray" onClick={clearApiKey}>清除 Key</Button>{' '}
            <Button size="small" variant="gray" onClick={deleteApi}>删除</Button>
          </>
        )}
      </div>
      {confirmNode}
      {testResult && (
        <p
          className="hint"
          style={{ marginTop: 6, fontWeight: 800, color: testResult.ok ? 'var(--teal)' : 'var(--accent)' }}
        >
          {testResult.ok
            ? `✓ ${testResult.message}（延迟 ${testResult.latencyMs} ms，探活不记账）`
            : `✗ 连接失败：${testResult.message}`}
        </p>
      )}
    </div>
  );
}

/* ---------------- 小组表单 ---------------- */
function TeamForm({
  team,
  onDone,
}: {
  team: Team | null; // null = 新建草稿
  onDone: () => Promise<void>;
}) {
  const { S, post, toast } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [name, setName] = useState(team ? team.name : '');
  const [color, setColor] = useState(team ? team.color || '#e2574c' : '#5b8def');
  const [apiId, setApiId] = useState(team ? team.apiId || '' : '');
  if (!S) return null;

  async function saveTeam() {
    try {
      await post('/api/teams/save', {
        team: {
          id: team ? team.id : undefined,
          name: name.trim(),
          color,
          apiId: apiId || null,
        },
      });
    } catch { return; }
    toast('小组已保存');
    await onDone();
  }
  function deleteTeam() {
    if (!team) return;
    ask({
      title: '删除小组',
      message: '删除该小组及其成员？（已产生的任务与账本保留）',
      confirmLabel: '删除小组',
      onConfirm: async () => {
        try {
          await post('/api/teams/delete', { id: team.id });
        } catch { return; }
        await onDone();
      },
    });
  }

  return (
    <div className="apicard">
      <div className="row">
        <div>
          <label>组名</label>
          <Input value={name} placeholder={team ? undefined : '如：内容组'} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label>地毯颜色</label>
          <Input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </div>
        <div>
          <label>使用 API</label>
          <Select
            value={apiId}
            onValueChange={setApiId}
            emptyLabel="跟随公司默认"
            options={S.apis.map((a) => ({ value: a.id, label: a.name }))}
          />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="blue" onClick={saveTeam}>{team ? '保存' : '创建小组'}</Button>{' '}
        {team && (
          <Button size="small" variant="gray" onClick={deleteTeam}>删除小组</Button>
        )}
      </div>
      {confirmNode}
    </div>
  );
}

/* ---------------- 成员表单（M5） ---------------- */
function MemberForm({
  member,
  initialTeamId,
  onDone,
}: {
  member: Member | null; // null = 新增草稿（归属 initialTeamId 组，可再改）
  initialTeamId: string;
  onDone: () => Promise<void>;
}) {
  const { S, post, toast } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [name, setName] = useState(member ? member.name : '');
  const [role, setRole] = useState(member ? member.role : '文案');
  const [teamId, setTeamId] = useState(member ? member.teamId : initialTeamId);
  const [prompt, setPrompt] = useState(member ? member.prompt || '' : '');
  if (!S) return null;

  async function saveMember() {
    if (!name.trim()) return toast('先填成员名字');
    try {
      await post('/api/members/save', {
        member: {
          id: member ? member.id : undefined,
          name: name.trim(),
          role,
          teamId,
          prompt,
        },
      });
    } catch { return; }
    toast('成员已保存');
    await onDone();
  }
  function deleteMember() {
    if (!member) return;
    ask({
      title: '删除成员',
      message: `删除成员「${member.name}」？名下有未完成任务时后端会拒绝。`,
      confirmLabel: '删除成员',
      onConfirm: async () => {
        try {
          await post('/api/members/delete', { id: member.id });
        } catch { return; }
        toast('成员已删除');
        await onDone();
      },
    });
  }

  return (
    <div className="memberform">
      <div className="row">
        <div>
          <label>名字</label>
          <Input value={name} placeholder="如：妙笔" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label>工种</label>
          <Select
            value={role}
            onValueChange={(v) => setRole(v as Member['role'])}
            options={ROLES.map((r) => ({ value: r, label: r }))}
          />
        </div>
        <div>
          <label>所属小组（可换组）</label>
          <Select
            value={teamId}
            onValueChange={setTeamId}
            options={S.teams.map((t) => ({ value: t.id, label: t.name }))}
          />
        </div>
      </div>
      <label>专属提示词（只对这个成员生效，会拼进他的干活指令）</label>
      <Textarea
        rows={2}
        placeholder="如：文风幽默搞笑，标题爱用反问句……"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="blue" onClick={saveMember}>{member ? '保存' : '创建成员'}</Button>{' '}
        {member && (
          <Button size="small" variant="gray" onClick={deleteMember}>删除成员</Button>
        )}
      </div>
      {confirmNode}
    </div>
  );
}

/* ---------------- 设置后台整页 ---------------- */
export default function Settings() {
  const { S, post, refresh, toast } = useApp();
  // 与原生版一致：设置页内保存/删除后，按服务端最新数据整体重渲染表单
  const [epoch, setEpoch] = useState(0);
  const [apiDrafts, setApiDrafts] = useState<number[]>([]);
  const [teamDrafts, setTeamDrafts] = useState<number[]>([]);
  const [memberDrafts, setMemberDrafts] = useState<Array<{ key: number; teamId: string }>>([]);
  const [draftSeq, setDraftSeq] = useState(1);
  const [defaultApi, setDefaultApi] = useState<string | null>(null);
  const [concurrency, setConcurrency] = useState<string | null>(null);
  const [budget, setBudget] = useState<string | null>(null);

  if (!S) return null;

  const rerender = async () => {
    await refresh();
    setEpoch((e) => e + 1);
    setDefaultApi(null);
    setConcurrency(null);
    setBudget(null);
  };

  async function saveDefaultApi() {
    try {
      await post('/api/settings/default-api', { apiId: defaultApi ?? S!.defaultApiId });
    } catch { return; }
    toast('默认 API 已保存');
    refresh();
  }
  async function saveParams() {
    try {
      await post('/api/settings/params', {
        concurrency: parseInt(concurrency ?? String(S!.params.concurrency), 10),
        taskBudgetTokens: parseInt(budget ?? String(S!.params.taskBudgetTokens), 10),
      });
    } catch { return; }
    toast('参数已保存');
    refresh();
  }

  return (
    <>
      <div className="card">
        <h2>API 配置 <span className="tag">至少填一个 API 的 Key 才能开工 · Key 加密保存在服务器数据库中，页面只显示掩码</span></h2>
        <div>
          {S.apis.map((a) => (
            <ApiForm key={`api-${a.id}-${epoch}`} api={a} onDone={rerender} />
          ))}
          {apiDrafts.map((d) => (
            <ApiForm
              key={`apidraft-${d}`}
              api={null}
              onDone={async () => {
                setApiDrafts((ds) => ds.filter((x) => x !== d));
                await rerender();
              }}
            />
          ))}
        </div>
        <Button
          variant="gray"
          onClick={() => {
            setApiDrafts((ds) => [...ds, draftSeq]);
            setDraftSeq((n) => n + 1);
          }}
        >
          ＋ 新增一条 API
        </Button>
      </div>

      <div className="card">
        <h2>小组管理</h2>
        <div>
          {S.teams.map((t) => (
            <TeamForm key={`team-${t.id}-${epoch}`} team={t} onDone={rerender} />
          ))}
          {teamDrafts.map((d) => (
            <TeamForm
              key={`teamdraft-${d}`}
              team={null}
              onDone={async () => {
                setTeamDrafts((ds) => ds.filter((x) => x !== d));
                await rerender();
              }}
            />
          ))}
        </div>
        <Button
          variant="gray"
          onClick={() => {
            setTeamDrafts((ds) => [...ds, draftSeq]);
            setDraftSeq((n) => n + 1);
          }}
        >
          ＋ 新建小组
        </Button>
        <label style={{ marginTop: 14 }}>公司默认 API（小组未单独指定时使用）</label>
        <div className="row">
          <Select
            value={defaultApi ?? S.defaultApiId ?? ''}
            onValueChange={setDefaultApi}
            options={S.apis.map((a) => ({ value: a.id, label: a.name }))}
          />
          <Button variant="blue" style={{ flex: '0 0 120px' }} onClick={saveDefaultApi}>保存默认</Button>
        </div>

        <label style={{ marginTop: 16, fontSize: 13, color: 'var(--ink)' }}>成员管理（按小组；工种决定派单与审核分工，换组即时生效）</label>
        <div>
          {S.teams.map((t) => {
            const ms = S.members.filter((m) => m.teamId === t.id);
            return (
              <div className="apicard" key={`members-${t.id}-${epoch}`}>
                <div style={{ fontWeight: 900, marginBottom: 4 }}>
                  <span style={{ color: t.color }}>■</span> {t.name} · 成员（{ms.length}）
                </div>
                {ms.map((m) => (
                  <MemberForm key={`member-${m.id}-${epoch}`} member={m} initialTeamId={t.id} onDone={rerender} />
                ))}
                {memberDrafts
                  .filter((d) => d.teamId === t.id)
                  .map((d) => (
                    <MemberForm
                      key={`memberdraft-${d.key}`}
                      member={null}
                      initialTeamId={t.id}
                      onDone={async () => {
                        setMemberDrafts((ds) => ds.filter((x) => x.key !== d.key));
                        await rerender();
                      }}
                    />
                  ))}
                {ms.length === 0 && memberDrafts.every((d) => d.teamId !== t.id) && (
                  <p className="hint">这个组还没有成员，任务会因缺工种停工，先补齐成员。</p>
                )}
                <Button
                  size="small"
                  variant="gray"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    setMemberDrafts((ds) => [...ds, { key: draftSeq, teamId: t.id }]);
                    setDraftSeq((n) => n + 1);
                  }}
                >
                  ＋ 新增成员
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      <RegistryCard />

      <ChannelCard />

      <OpenApiCard />

      <VisitLinksCard />

      <NotifyPrefsCard />

      <div className="card">
        <h2>运行参数</h2>
        <div className="row">
          <div>
            <label>全公司同时执行任务上限（并发闸门）</label>
            <Input
              type="number"
              min="1"
              value={concurrency ?? String(S.params.concurrency)}
              onChange={(e) => setConcurrency(e.target.value)}
            />
          </div>
          <div>
            <label>单任务 token 预算上限（0 = 不限，超了停工待裁决）</label>
            <Input
              type="number"
              min="0"
              value={budget ?? String(S.params.taskBudgetTokens)}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <Button variant="blue" onClick={saveParams}>保存参数</Button>
        </div>
      </div>

      <div className="card">
        <h2>数据管理</h2>
        <p className="hint">
          全部业务数据都存储在服务器的应用数据目录（DATA_DIR，默认部署目录下的 data/）里的一个 SQLite 单文件
          swarm.db（运行期另有同名 -wal / -shm 日志文件），运行日志在同目录的 logs/ 下。
          备份：点下方按钮下载一份一致性快照（服务端会先把 WAL 合并回主文件再打包），或停服务后把整个 data 目录拷走；
          恢复/迁移：把备份文件放回数据目录并命名为 swarm.db，再启动服务即可。没有云端副本，删了就没了，请定期备份。
        </p>
        <div style={{ marginTop: 8 }}>
          <a className="btn small blue" href="/api/backup" download>
            下载备份（swarm.db）
          </a>
        </div>
      </div>

      <HelpEntryCard />
    </>
  );
}

/* ---------------- 帮助与反馈入口（G-05：设置页进帮助中心/反馈） ---------------- */
function HelpEntryCard() {
  const { setTab } = useApp();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  return (
    <div className="card">
      <h2>帮助与反馈 <span className="tag">使用说明、高频问题都在帮助中心；意见与问题可直接留言给平台</span></h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="blue" onClick={() => setTab('help')}>打开帮助中心</Button>
        <Button variant="gray" onClick={() => setFeedbackOpen(true)}>✉️ 意见反馈</Button>
      </div>
      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
    </div>
  );
}

/* ---------------- 参观链接（G-13）：建/复制/撤销；与交付页同一令牌机制，参观页只见成员与聚合 ---------------- */
export function VisitLinksCard() {
  const { S, post, send, toast } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [links, setLinks] = useState<Delivery[]>([]);
  const [password, setPassword] = useState('');
  const [days, setDays] = useState('30');
  const [createdPath, setCreatedPath] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLinks(await fetchVisitLinks());
    } catch {
      /* 列表拉取失败不阻塞设置页 */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!S) return null;

  async function create() {
    let res: Record<string, unknown>;
    try {
      res = await post('/api/visit-links', {
        password: password.trim() ? password.trim() : undefined,
        expiresInDays: days.trim() ? Number(days) : null,
      });
    } catch { return; }
    const v = res.visitLink as (Delivery & { path?: string }) | undefined;
    if (v?.path) setCreatedPath(window.location.origin + v.path);
    setPassword('');
    toast('参观链接已创建（链接只在创建时完整显示一次，请及时复制）');
    void load();
  }

  function revoke(link: Delivery) {
    ask({
      title: '撤销参观链接',
      message: `撤销后该链接立即失效（打开回 404）。浏览数 ${link.viewCount} 次的记录会保留在列表中。`,
      confirmLabel: '撤销链接',
      onConfirm: async () => {
        try {
          await send('DELETE', `/api/visit-links/${link.id}`);
        } catch { return; }
        toast('参观链接已撤销');
        void load();
      },
    });
  }

  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast('已复制'));

  return (
    <div className="card">
      <h2>办公室参观链接 <span className="tag">把团队门面分享给外部看：只见空间名、成员与状态聚合、近 30 天完成数，不含任务内容与账目</span></h2>
      <div className="row">
        <div>
          <label>访问口令（可空）</label>
          <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="留空 = 无口令" />
        </div>
        <div>
          <label>有效期（天，可空 = 长期）</label>
          <Input type="number" min="1" max="365" value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <Button variant="blue" onClick={create}>创建参观链接</Button>
      </div>
      {createdPath && (
        <p className="hint" style={{ marginTop: 8 }}>
          新链接：<code>{createdPath}</code>{' '}
          <Button size="small" variant="gray" onClick={() => copy(createdPath)}>复制</Button>
        </p>
      )}
      <div style={{ marginTop: 10 }}>
        {links.length === 0 && <p className="hint">暂无参观链接。</p>}
        {links.map((l) => (
          <div key={l.id} className="apicard" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700 }}>{l.title || '参观链接'}</span>
            {l.hasPassword && <Badge>有口令</Badge>}
            {l.revoked ? (
              <Badge variant="can">已撤销</Badge>
            ) : l.expiresAt && new Date(l.expiresAt).getTime() < Date.now() ? (
              <Badge variant="can">已过期</Badge>
            ) : (
              <Badge variant="done">有效</Badge>
            )}
            <span className="meta">浏览 {l.viewCount} 次 · 建于 {l.createdAt.slice(0, 10)}{l.expiresAt ? ` · 至 ${l.expiresAt.slice(0, 10)}` : ''}</span>
            {!l.revoked && (
              <Button size="small" variant="gray" onClick={() => revoke(l)}>撤销</Button>
            )}
          </div>
        ))}
      </div>
      {confirmNode}
    </div>
  );
}

/* ---------------- 开放 API（G-07）：Token 列表/新建/吊销 + Webhook 列表/新建/启停/测试投递 ---------------- */
const WEBHOOK_EVENT_OPTIONS = [
  { value: 'task.done', label: '任务完成（task.done）' },
  { value: 'task.adjudication', label: '转待裁决（task.adjudication）' },
  { value: 'task.failed', label: '任务终局失败（task.failed）' },
] as const;

function OpenApiCard() {
  const { post, send, toast } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [hooks, setHooks] = useState<WebhookItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Token 新建表单
  const [tokenName, setTokenName] = useState('');
  const [scopeDispatch, setScopeDispatch] = useState(true);
  const [scopeRead, setScopeRead] = useState(true);
  const [plainOnce, setPlainOnce] = useState<string | null>(null);
  // Webhook 新建弹窗
  const [hookOpen, setHookOpen] = useState(false);
  const [hookUrl, setHookUrl] = useState('');
  const [hookSecret, setHookSecret] = useState('');
  const [hookEvents, setHookEvents] = useState<string[]>(['task.done']);
  // 某 Webhook 的最近投递
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});

  const load = useCallback(async () => {
    try {
      const [ts, hs] = await Promise.all([fetchApiTokens(), fetchWebhooks()]);
      setTokens(ts);
      setHooks(hs);
    } catch {
      /* 拉取失败保持旧状态 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createToken() {
    if (!tokenName.trim()) return toast('先给 Token 起个名字（如：Zapier 集成）');
    const scopes = [
      ...(scopeDispatch ? ['dispatch'] : []),
      ...(scopeRead ? ['read'] : []),
    ];
    if (!scopes.length) return toast('至少勾选一个权限');
    let res: Record<string, unknown>;
    try {
      res = await post('/api/tokens', { name: tokenName.trim(), scopes });
    } catch { return; }
    const created = res.token as { token?: string } | undefined;
    setPlainOnce(created?.token ?? '');
    setTokenName('');
    toast('Token 已创建：明文只显示这一次，请立即保存');
    await load();
  }

  function revokeToken(t: ApiToken) {
    ask({
      title: '吊销 Token',
      message: `吊销「${t.name}」（${t.tokenPrefix}…）？吊销后用它调用开放 API 立即返回 401，不可恢复。`,
      confirmLabel: '吊销',
      onConfirm: async () => {
        try {
          await send('DELETE', `/api/tokens/${t.id}`);
        } catch { return; }
        toast('Token 已吊销');
        await load();
      },
    });
  }

  async function createWebhook() {
    if (!hookUrl.trim()) return toast('先填 Webhook URL（须 https，内网/元数据地址会被拒绝）');
    if (!hookEvents.length) return toast('至少订阅一个事件');
    try {
      await post('/api/webhooks', {
        url: hookUrl.trim(),
        secret: hookSecret.trim() || undefined,
        events: hookEvents,
        enabled: true,
      });
    } catch { return; }
    toast('Webhook 已创建');
    setHookOpen(false);
    setHookUrl('');
    setHookSecret('');
    setHookEvents(['task.done']);
    await load();
  }

  async function toggleWebhook(h: WebhookItem, enabled: boolean) {
    try {
      await send('PUT', `/api/webhooks/${h.id}`, { enabled });
    } catch { return; }
    toast(enabled ? 'Webhook 已启用' : 'Webhook 已停用（停用后不再生成投递）');
    await load();
  }

  function deleteWebhook(h: WebhookItem) {
    ask({
      title: '删除 Webhook',
      message: `删除 Webhook「${h.url}」及其投递记录？`,
      confirmLabel: '删除',
      onConfirm: async () => {
        try {
          await send('DELETE', `/api/webhooks/${h.id}`);
        } catch { return; }
        toast('Webhook 已删除');
        await load();
      },
    });
  }

  async function testWebhook(h: WebhookItem) {
    let res: Record<string, unknown>;
    try {
      res = await post(`/api/webhooks/${h.id}/test`, {});
    } catch { return; }
    const d = res.delivery as WebhookDelivery | undefined;
    toast(
      d?.status === 'success'
        ? '测试投递成功：端点已收到 test 事件'
        : `测试投递${d?.status === 'failed' ? '失败' : '已排队重试'}${d?.lastError ? `：${d.lastError}` : ''}`,
    );
    try {
      const rows = await fetchWebhookDeliveries(h.id);
      setDeliveries((m) => ({ ...m, [h.id]: rows }));
    } catch {
      /* 投递记录拉取失败不影响提示 */
    }
  }

  return (
    <div className="card">
      <h2>
        开放 API{' '}
        <span className="tag">
          用 Token 在外部系统发单/查状态/取成果；任务终态经 Webhook 推送（HMAC 签名）。接口文档见帮助中心「开放 API」章
        </span>
      </h2>
      {!loaded && (
        <p>
          <Spinner label="加载中…" />
        </p>
      )}

      <label>API Token（明文只在创建时显示一次，服务端只存哈希；吊销立即生效）</label>
      {loaded && tokens.length === 0 && <p className="hint">还没有 Token。新建一个给你的外部系统用。</p>}
      {tokens.map((t) => (
        <div className="task" key={t.id}>
          <span className="tt">{t.name}</span>{' '}
          <Badge variant={t.revokedAt ? 'can' : 'run'}>{t.revokedAt ? '已吊销' : '有效'}</Badge>{' '}
          <Badge>{t.scopes.join(' + ') || '无权限'}</Badge>
          <div className="meta">
            前缀 {t.tokenPrefix}… · 创建于 {t.createdAt.slice(0, 16).replace('T', ' ')}
            {t.lastUsedAt ? ` · 最近使用 ${t.lastUsedAt.slice(0, 16).replace('T', ' ')}` : ' · 尚未使用'}
            {t.revokedAt ? ` · 吊销于 ${t.revokedAt.slice(0, 16).replace('T', ' ')}` : ''}
          </div>
          {!t.revokedAt && (
            <div style={{ marginTop: 6 }}>
              <Button size="small" variant="gray" onClick={() => revokeToken(t)}>
                吊销
              </Button>
            </div>
          )}
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <div>
          <label>新 Token 名称</label>
          <Input value={tokenName} placeholder="如：Zapier 集成" onChange={(e) => setTokenName(e.target.value)} />
        </div>
        <div>
          <label>权限</label>
          <div style={{ display: 'flex', gap: 14, paddingTop: 8 }}>
            <Checkbox checked={scopeDispatch} onCheckedChange={setScopeDispatch} label="发单 dispatch" />
            <Checkbox checked={scopeRead} onCheckedChange={setScopeRead} label="查询 read" />
          </div>
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="blue" onClick={createToken}>
          ＋ 新建 Token
        </Button>
      </div>

      <label style={{ marginTop: 16 }}>Webhook（任务终态事件推送到你的服务；secret 加密保存、只显示掩码）</label>
      {loaded && hooks.length === 0 && <p className="hint">还没有 Webhook。新建一个，把任务完成/待裁决/失败事件推到你的系统。</p>}
      {hooks.map((h) => (
        <div className="task" key={h.id}>
          <span className="tt" style={{ overflowWrap: 'anywhere' }}>{h.url}</span>{' '}
          <Badge variant={h.enabled ? 'run' : 'can'}>{h.enabled ? '启用中' : '已停用'}</Badge>
          <div className="meta">
            订阅：{h.events.join('、') || '（无）'} · 签名密钥 {h.hasSecret ? h.secretMasked : '（未设置）'} · 创建于{' '}
            {h.createdAt.slice(0, 16).replace('T', ' ')}
          </div>
          <div style={{ marginTop: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Switch checked={h.enabled} onCheckedChange={(on) => toggleWebhook(h, on)} ariaLabel="Webhook 启停" />
            <span className="hint">{h.enabled ? '开' : '关'}</span>
            <Button size="small" variant="gray" onClick={() => testWebhook(h)}>
              测试投递
            </Button>
            <Button size="small" variant="gray" onClick={() => deleteWebhook(h)}>
              删除
            </Button>
          </div>
          {(deliveries[h.id] ?? []).length > 0 && (
            <div className="meta" style={{ marginTop: 6 }}>
              最近投递：
              {(deliveries[h.id] ?? []).slice(0, 5).map((d) => (
                <div key={d.id}>
                  {d.createdAt.slice(0, 16).replace('T', ' ')} · {d.event} · {d.status}（尝试 {d.attempts} 次）
                  {d.lastError ? ` · ${d.lastError}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="blue" onClick={() => setHookOpen(true)}>
          ＋ 新建 Webhook
        </Button>
      </div>

      <Dialog open={hookOpen} onClose={() => setHookOpen(false)} title="新建 Webhook">
        <label>接收地址 URL（仅 https；本机/内网/云元数据地址会被 SSRF 守卫拒绝）</label>
        <Input value={hookUrl} placeholder="https://hooks.example.com/swarm" onChange={(e) => setHookUrl(e.target.value)} />
        <label style={{ marginTop: 10 }}>签名密钥 secret（留空自动生成；投递时用它算 HMAC 签名头 X-Swarm-Signature）</label>
        <Input value={hookSecret} placeholder="留空自动生成" onChange={(e) => setHookSecret(e.target.value)} />
        <label style={{ marginTop: 10 }}>订阅事件</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {WEBHOOK_EVENT_OPTIONS.map((o) => (
            <Checkbox
              key={o.value}
              checked={hookEvents.includes(o.value)}
              onCheckedChange={(on) =>
                setHookEvents((es) => (on ? [...es, o.value] : es.filter((x) => x !== o.value)))
              }
              label={o.label}
            />
          ))}
        </div>
        <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
          <Button variant="blue" onClick={createWebhook}>
            创建
          </Button>
          <Button variant="gray" onClick={() => setHookOpen(false)}>
            取消
          </Button>
        </div>
      </Dialog>

      <Dialog open={plainOnce !== null} onClose={() => setPlainOnce(null)} title="Token 明文（只显示一次）">
        <p className="hint">
          这是新 Token 的明文，关闭后任何页面都不再显示（服务端只存哈希）。调用时放在请求头
          Authorization: Bearer &lt;token&gt;。
        </p>
        <pre className="result" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{plainOnce}</pre>
        <div style={{ marginTop: 12 }}>
          <Button variant="blue" onClick={() => setPlainOnce(null)}>
            我已保存，关闭
          </Button>
        </div>
      </Dialog>
      {confirmNode}
    </div>
  );
}

/* ---------------- 通知偏好（G-03）：notifyPrefs 站内逐类型开关（邮件开关暂缓，不展示） ---------------- */
function NotifyPrefsCard() {
  const { toast } = useApp();
  const [prefs, setPrefs] = useState<NotifyPrefs>({ inapp: {} });
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await fetchPreferences();
      const raw = all.notifyPrefs as NotifyPrefs | undefined;
      setPrefs({ inapp: raw?.inapp ?? {}, mail: raw?.mail });
    } catch {
      /* 保持默认全开 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(type: string, on: boolean) {
    const next: NotifyPrefs = {
      inapp: { ...prefs.inapp, [type]: on },
      // mail 字段位原样保留（邮件通道暂缓，本卡不展示邮件开关）
      mail: prefs.mail,
    };
    setPrefs(next);
    try {
      await putPreference('notifyPrefs', next);
      toast(on ? '该类通知已开启' : '该类通知已关闭（之后同类事件不再生成站内通知）');
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
      load();
    }
  }

  return (
    <div className="card">
      <h2>通知偏好 <span className="tag">站内通知逐类型开关，关掉后同类事件不再落通知；邮件通知待邮箱通道接入后开放</span></h2>
      {!loaded && <p><Spinner label="加载中…" /></p>}
      {NOTIFICATION_TYPE_ORDER.map((t) => (
        <div
          key={t}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: '2px dashed var(--line)' }}
        >
          <span style={{ flex: 1, fontSize: 13.5, fontWeight: 700 }}>
            {NOTIFICATION_TYPE_LABELS[t] ?? t}
            <span className="hint" style={{ marginLeft: 8 }}>{t}</span>
          </span>
          <Switch
            checked={prefs.inapp[t] !== false}
            onCheckedChange={(on) => toggle(t, on)}
            ariaLabel={`${NOTIFICATION_TYPE_LABELS[t] ?? t}站内通知开关`}
          />
          <span className="hint">{prefs.inapp[t] !== false ? '开' : '关'}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- 渠道绑定（M7：MJ 直推） ---------------- */
function ChannelCard() {
  const { toast } = useApp();
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  const [pushes, setPushes] = useState<ChannelPush[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [chs, ps] = await Promise.all([fetchChannels(), fetchChannelPushes()]);
      setChannel(chs.find((c) => c.type === 'mj') ?? chs[0] ?? null);
      setPushes(ps);
    } catch {
      /* 拉取失败保持旧状态 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function refreshPush(p: ChannelPush) {
    let res: Record<string, unknown>;
    try {
      res = await requestRaw('POST', `/api/channels/pushes/${p.id}/refresh`);
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    const m = res.metrics as { ok?: boolean; message?: string; metrics?: Record<string, unknown> } | undefined;
    toast(`回查：${m?.message ?? ''}${m?.metrics ? ` · 指标 ${JSON.stringify(m.metrics)}` : ''}`);
    load();
  }

  return (
    <div className="card">
      <h2>渠道绑定（MJ 直推） <span className="tag">绑定后成果库可一键把成果直推到 MJ 平台；令牌加密保存、页面不回显</span></h2>
      {!loaded && <p><Spinner label="加载中…" /></p>}
      {loaded && channel && (
        <ChannelBindForm key={`${channel.baseUrl}|${channel.account}|${channel.bound}`} channel={channel} onSaved={load} />
      )}
      {loaded && !channel && <p className="hint">暂无可用渠道。</p>}

      <label style={{ marginTop: 14 }}>推送记录</label>
      {pushes.length === 0 && <p className="hint">暂无推送记录。在成果库对已完成成果点「推送 MJ」后会出现在这里。</p>}
      {pushes.map((p) => (
        <div className="task" key={p.id}>
          <span className="tt">{p.channelType.toUpperCase()} 推送</span>
          <Badge variant={p.status === 'ok' || p.status === 'success' ? 'done' : p.status === 'failed' ? 'rej' : 'adj'}>
            {p.status}
          </Badge>
          <div className="meta">
            {p.createdAt.slice(0, 16).replace('T', ' ')}
            {p.remoteRef ? ` · 远程引用：${p.remoteRef}` : ''}
            {p.taskId ? ` · 任务 ${p.taskId}` : ''}
            {p.message ? <><br />{p.message}</> : null}
          </div>
          <div style={{ marginTop: 6 }}>
            <Button size="small" variant="gray" onClick={() => refreshPush(p)}>回查指标</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ChannelBindForm({
  channel,
  onSaved,
}: {
  channel: ChannelInfo;
  onSaved: () => Promise<void>;
}) {
  const { post, toast } = useApp();
  const [baseUrl, setBaseUrl] = useState(channel.baseUrl ?? '');
  const [token, setToken] = useState('');
  const [account, setAccount] = useState(channel.account ?? '');
  const [bindMsg, setBindMsg] = useState('');

  async function bind() {
    if (!baseUrl.trim()) return toast('先填 MJ 平台地址（baseUrl）');
    let res: Record<string, unknown>;
    try {
      res = await post('/api/channels/bind', {
        channelType: 'mj',
        baseUrl: baseUrl.trim(),
        token: token || undefined,
        account: account.trim() || undefined,
      });
    } catch { return; }
    const bind = res.bind as { bound?: boolean; accountLabel?: string; message?: string } | undefined;
    setBindMsg(bind?.message ?? '');
    setToken('');
    toast(
      bind?.bound
        ? `MJ 已绑定${bind.accountLabel ? `：${bind.accountLabel}` : ''}${bind.message ? ` · ${bind.message}` : ''}`
        : `绑定未完成：${bind?.message ?? '请检查地址与令牌'}`,
    );
    await onSaved();
  }

  return (
    <div className="apicard">
      <div style={{ fontWeight: 900, marginBottom: 4 }}>
        {channel.name}（{channel.type}）· 当前状态：
        {channel.bound ? (
          <span style={{ color: 'var(--teal)' }}>已绑定{channel.account ? `（账号 ${channel.account}）` : ''}</span>
        ) : (
          <span className="warn">未绑定</span>
        )}
      </div>
      <div className="row">
        <div>
          <label>平台地址 baseUrl</label>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="如：https://mjdramacente.cn" />
        </div>
        <div>
          <label>账号（可空，用于标注绑定身份）</label>
          <Input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="如：MJ Drama 运营号" />
        </div>
      </div>
      <label>访问令牌（密码框；留空 = 不修改已保存的令牌）</label>
      <Input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={channel.hasToken ? '已保存令牌，留空不改' : '尚未填写令牌'}
      />
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="blue" onClick={bind}>保存绑定</Button>
      </div>
      {bindMsg && <p className="hint" style={{ marginTop: 6, fontWeight: 700 }}>{bindMsg}</p>}
    </div>
  );
}
