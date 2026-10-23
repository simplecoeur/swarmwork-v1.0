import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchChannelPushes, fetchChannels, requestRaw } from '../api';
import RegistryCard from './RegistryCard';
import type { ApiItem, ChannelInfo, ChannelPush, Member, Team } from '../types';

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
  async function deleteApi() {
    if (!api) return;
    if (!window.confirm('删除这条 API？')) return;
    try {
      await post('/api/apis/delete', { id: api.id });
    } catch { return; }
    await onDone();
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
          <input value={name} placeholder="如：DeepSeek 主力" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label>服务商预设</label>
          <select value={provider} onChange={(e) => onProviderChange(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="row">
        <div>
          <label>Base URL（预设自动带出，可改）</label>
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
            placeholder={api && api.hasKey ? `已保存：${api.apiKeyMasked}` : '尚未填写'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div>
          <label>采购单价（元/百万 token）</label>
          <input type="number" step="0.01" min="0" value={pricePerM} onChange={(e) => setPricePerM(e.target.value)} />
        </div>
        <div>
          <label>余额（元，到成本中心充值）</label>
          <input value={api ? api.balanceYuan : 0} disabled readOnly />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="btn small blue" onClick={saveApi}>保存</button>{' '}
        <button className="btn small gray" onClick={testApi} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </button>{' '}
        {api && (
          <>
            <button className="btn small gray" onClick={clearApiKey}>清除 Key</button>{' '}
            <button className="btn small gray" onClick={deleteApi}>删除</button>
          </>
        )}
      </div>
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
  async function deleteTeam() {
    if (!team) return;
    if (!window.confirm('删除该小组及其成员？（已产生的任务与账本保留）')) return;
    try {
      await post('/api/teams/delete', { id: team.id });
    } catch { return; }
    await onDone();
  }

  return (
    <div className="apicard">
      <div className="row">
        <div>
          <label>组名</label>
          <input value={name} placeholder={team ? undefined : '如：内容组'} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label>地毯颜色</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </div>
        <div>
          <label>使用 API</label>
          <select value={apiId} onChange={(e) => setApiId(e.target.value)}>
            <option value="">跟随公司默认</option>
            {S.apis.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="btn small blue" onClick={saveTeam}>{team ? '保存' : '创建小组'}</button>{' '}
        {team && (
          <button className="btn small gray" onClick={deleteTeam}>删除小组</button>
        )}
      </div>
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
  async function deleteMember() {
    if (!member) return;
    if (!window.confirm(`删除成员「${member.name}」？名下有未完成任务时后端会拒绝。`)) return;
    try {
      await post('/api/members/delete', { id: member.id });
    } catch { return; }
    toast('成员已删除');
    await onDone();
  }

  return (
    <div className="memberform">
      <div className="row">
        <div>
          <label>名字</label>
          <input value={name} placeholder="如：妙笔" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label>工种</label>
          <select value={role} onChange={(e) => setRole(e.target.value as Member['role'])}>
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        <div>
          <label>所属小组（可换组）</label>
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            {S.teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      </div>
      <label>专属提示词（只对这个成员生效，会拼进他的干活指令）</label>
      <textarea
        rows={2}
        placeholder="如：文风幽默搞笑，标题爱用反问句……"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div style={{ marginTop: 8 }}>
        <button className="btn small blue" onClick={saveMember}>{member ? '保存' : '创建成员'}</button>{' '}
        {member && (
          <button className="btn small gray" onClick={deleteMember}>删除成员</button>
        )}
      </div>
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
        <button
          className="btn gray"
          onClick={() => {
            setApiDrafts((ds) => [...ds, draftSeq]);
            setDraftSeq((n) => n + 1);
          }}
        >
          ＋ 新增一条 API
        </button>
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
        <button
          className="btn gray"
          onClick={() => {
            setTeamDrafts((ds) => [...ds, draftSeq]);
            setDraftSeq((n) => n + 1);
          }}
        >
          ＋ 新建小组
        </button>
        <label style={{ marginTop: 14 }}>公司默认 API（小组未单独指定时使用）</label>
        <div className="row">
          <select
            value={defaultApi ?? S.defaultApiId ?? ''}
            onChange={(e) => setDefaultApi(e.target.value)}
          >
            {S.apis.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button className="btn blue" style={{ flex: '0 0 120px' }} onClick={saveDefaultApi}>保存默认</button>
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
                <button
                  className="btn small gray"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    setMemberDrafts((ds) => [...ds, { key: draftSeq, teamId: t.id }]);
                    setDraftSeq((n) => n + 1);
                  }}
                >
                  ＋ 新增成员
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <RegistryCard />

      <ChannelCard />

      <div className="card">
        <h2>运行参数</h2>
        <div className="row">
          <div>
            <label>全公司同时执行任务上限（并发闸门）</label>
            <input
              type="number"
              min="1"
              value={concurrency ?? String(S.params.concurrency)}
              onChange={(e) => setConcurrency(e.target.value)}
            />
          </div>
          <div>
            <label>单任务 token 预算上限（0 = 不限，超了停工待裁决）</label>
            <input
              type="number"
              min="0"
              value={budget ?? String(S.params.taskBudgetTokens)}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="btn blue" onClick={saveParams}>保存参数</button>
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
    </>
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
      {!loaded && <p className="hint">加载中…</p>}
      {loaded && channel && (
        <ChannelBindForm key={`${channel.baseUrl}|${channel.account}|${channel.bound}`} channel={channel} onSaved={load} />
      )}
      {loaded && !channel && <p className="hint">暂无可用渠道。</p>}

      <label style={{ marginTop: 14 }}>推送记录</label>
      {pushes.length === 0 && <p className="hint">暂无推送记录。在成果库对已完成成果点「推送 MJ」后会出现在这里。</p>}
      {pushes.map((p) => (
        <div className="task" key={p.id}>
          <span className="tt">{p.channelType.toUpperCase()} 推送</span>
          <span className={`chip ${p.status === 'ok' || p.status === 'success' ? 'done' : p.status === 'failed' ? 'rej' : 'adj'}`}>
            {p.status}
          </span>
          <div className="meta">
            {p.createdAt.slice(0, 16).replace('T', ' ')}
            {p.remoteRef ? ` · 远程引用：${p.remoteRef}` : ''}
            {p.taskId ? ` · 任务 ${p.taskId}` : ''}
            {p.message ? <><br />{p.message}</> : null}
          </div>
          <div style={{ marginTop: 6 }}>
            <button className="btn small gray" onClick={() => refreshPush(p)}>回查指标</button>
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
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="如：https://mjdramacente.cn" />
        </div>
        <div>
          <label>账号（可空，用于标注绑定身份）</label>
          <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="如：MJ Drama 运营号" />
        </div>
      </div>
      <label>访问令牌（密码框；留空 = 不修改已保存的令牌）</label>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={channel.hasToken ? '已保存令牌，留空不改' : '尚未填写令牌'}
      />
      <div style={{ marginTop: 8 }}>
        <button className="btn small blue" onClick={bind}>保存绑定</button>
      </div>
      {bindMsg && <p className="hint" style={{ marginTop: 6, fontWeight: 700 }}>{bindMsg}</p>}
    </div>
  );
}
