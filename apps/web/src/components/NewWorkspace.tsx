import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchIndustryPacks, testApiConnection, type Questionnaire } from '../api';
import { Button, Checkbox, Dialog, Input, RadioGroup, RadioItem, Select, Stepper, Switch, Textarea } from './ui';
import type { IndustryPack } from '../types';

/** 行业包内容简述：从 manifest 里挑老板看得懂的几项（短剧包等都走这套通用口径） */
function packSummary(pack: IndustryPack): string {
  const c = pack.content ?? {};
  const parts: string[] = [];
  const kbSeeds = c.kb_seeds;
  if (Array.isArray(kbSeeds) && kbSeeds.length) parts.push(`预置知识库 ${kbSeeds.length} 条`);
  const roleExt = c.role_extensions;
  if (Array.isArray(roleExt) && roleExt.length) parts.push(`专属工种扩展 ${roleExt.length} 个`);
  else if (roleExt && typeof roleExt === 'object' && Object.keys(roleExt).length) {
    parts.push(`专属工种扩展 ${Object.keys(roleExt).length} 个`);
  }
  const skills = c.skill_slugs;
  if (Array.isArray(skills) && skills.length) parts.push(`配套技能 ${skills.length} 个`);
  if (c.company_template) parts.push('带公司模板（小组/成员开局即备）');
  return parts.join(' · ');
}

/*
 * 服务商预设（问卷第 1 步）：与 Settings.tsx 的 API 表单同源——context.presets
 * （服务端 GET /api/presets = shared PROVIDER_PRESETS，六家齐全）为运行时准。
 * 下方 FALLBACK_PRESETS 与 shared PROVIDER_PRESETS 逐项同值（集成时已核对），
 * 仅作 context 未就绪时的初始值；不能直接 import shared 常量——web 此前只有类型
 * 导入，shared 的 CJS 桶文件使 Rollup 无法静态解析其值导出（v1.3.0 集成定案）。
 */
const PROVIDER_OPTIONS = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'tongyi', label: '通义千问' },
  { value: 'zhipu', label: '智谱' },
  { value: 'custom', label: '自定义' },
] as const;

const FALLBACK_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  tongyi: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  custom: { baseUrl: '', model: '' },
};

const USE_OPTIONS = ['内容生产', '日常办公', '学习研究', '运营推广', '其他'] as const;

const WIZARD_STEPS = [
  { label: '公司信息' },
  { label: '接入你的 AI' },
  { label: '关于你' },
  { label: '提醒与督促' },
  { label: '确认' },
];

/**
 * 「开新公司」弹窗（v1.3.0 C2 分步向导）：
 * 步骤 0 公司信息（原 name + 行业包，原样保留）→ 1 接入 AI → 2 关于你 → 3 提醒与督促 → 4 确认。
 * 全程可跳过：步骤 0 底部「直接创建」与每步「跳过问卷」都走旧路径（不带 questionnaire 提交）。
 */
export default function NewWorkspaceModal({ onClose }: { onClose: () => void }) {
  const { post, toast, refreshAuth, refresh, presets } = useApp();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);

  /* 步骤 0：公司信息 */
  const [name, setName] = useState('');
  const [packs, setPacks] = useState<IndustryPack[]>([]);
  const [packsLoaded, setPacksLoaded] = useState(false);
  const [packId, setPackId] = useState(''); // '' = 不选行业包（通用开局）

  /* 步骤 1：接入 AI */
  const [provider, setProvider] = useState('deepseek');
  const [baseUrl, setBaseUrl] = useState(FALLBACK_PRESETS.deepseek.baseUrl);
  const [model, setModel] = useState(FALLBACK_PRESETS.deepseek.model);
  const [apiKey, setApiKey] = useState('');
  const [apiSkipped, setApiSkipped] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<{ ok: boolean; message: string } | null>(null);

  /* 步骤 2：关于你 */
  const [industry, setIndustry] = useState('');
  const [industryOther, setIndustryOther] = useState('');
  const [job, setJob] = useState('');
  const [uses, setUses] = useState<string[]>([]);
  const [usesOther, setUsesOther] = useState('');
  const [problems, setProblems] = useState('');

  /* 步骤 3：提醒与督促 */
  const [checkinReminderEnabled, setCheckinReminderEnabled] = useState(true);
  const [checkinReminderTime, setCheckinReminderTime] = useState('10:00');
  const [briefingEnabled, setBriefingEnabled] = useState(true);
  const [briefingTime, setBriefingTime] = useState('09:00');
  const [supervisionItems, setSupervisionItems] = useState('');

  useEffect(() => {
    fetchIndustryPacks()
      .then(setPacks)
      .catch(() => setPacks([]))
      .finally(() => setPacksLoaded(true));
  }, []);

  const selected = packs.find((p) => p.id === packId) ?? null;
  const providerLabel = PROVIDER_OPTIONS.find((o) => o.value === provider)?.label ?? provider;
  const hasApi = !apiSkipped && apiKey.trim().length > 0;
  const resolvedIndustry = industry === '其他' ? industryOther.trim() : industry;
  const resolvedUses = [
    ...uses.filter((u) => u !== '其他'),
    ...(uses.includes('其他') && usesOther.trim() ? [`其他：${usesOther.trim()}`] : []),
  ];

  function onProviderChange(p: string) {
    setProvider(p);
    setApiSkipped(false);
    setTestState(null);
    const preset = presets[p] ?? FALLBACK_PRESETS[p];
    if (!preset) return;
    if (preset.baseUrl) setBaseUrl(preset.baseUrl);
    if (preset.model) setModel(preset.model);
  }

  async function testConnection() {
    if (!apiKey.trim()) return toast('先填 API Key 再测试连接');
    setTesting(true);
    setTestState(null);
    try {
      await testApiConnection({
        provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
      });
      setTestState({ ok: true, message: '✓ 连接成功，这个 Key 可以用' });
    } catch (e) {
      // 后端错误原文留在步内（requestRaw 抛的即后端 message）
      setTestState({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  function buildQuestionnaire(): Questionnaire {
    return {
      api: hasApi
        ? { provider, baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() }
        : null,
      industry: resolvedIndustry,
      job: job.trim(),
      uses: resolvedUses,
      problems: problems.trim(),
      checkinReminderEnabled,
      checkinReminderTime,
      briefingEnabled,
      briefingTime,
      supervisionItems: supervisionItems.trim(),
    };
  }

  /** withQuestionnaire=false 即旧行为：只带 name + industryPackId，与改版前完全一致 */
  async function create(withQuestionnaire: boolean) {
    if (!name.trim()) {
      setStep(0);
      return toast('先填公司名');
    }
    setBusy(true);
    try {
      await post('/api/workspaces', {
        name: name.trim(),
        industryPackId: packId || null,
        ...(withQuestionnaire ? { questionnaire: buildQuestionnaire() } : {}),
      });
    } catch {
      setBusy(false);
      return;
    }
    await refreshAuth();
    await refresh();
    toast(
      withQuestionnaire
        ? '公司已创建，已按你的问卷生成默认团队'
        : '新公司已开通，已切换到新空间',
    );
    onClose();
  }

  function next() {
    if (step === 0 && !name.trim()) return toast('先填公司名');
    setStep((s) => Math.min(s + 1, WIZARD_STEPS.length - 1));
  }

  const skipQuestionnaire = (
    <Button variant="gray" onClick={() => create(false)} disabled={busy}>
      跳过问卷（直接创建）
    </Button>
  );

  return (
    <Dialog open onClose={onClose} title="开新公司">
      <Stepper steps={WIZARD_STEPS} current={step} onStepClick={setStep} />

      {step === 0 && (
        <div>
          <label>公司名（空间名）</label>
          <Input
            placeholder="如：星尘短剧"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <label>行业包（选一个，公司的工种/知识/模板按包开局；之后也能在设置里补）</label>
          <RadioGroup value={packId} onValueChange={setPackId} ariaLabel="行业包">
            <RadioItem value="" className="packopt">
              <b>不选行业包（通用开局）</b>
              <span className="hint" style={{ display: 'block' }}>白纸开局：只有系统通用工种，自己慢慢配。</span>
            </RadioItem>
            {packs.map((p) => (
              <RadioItem className="packopt" key={p.id} value={p.id}>
                <b>{p.name}</b> <span className="tag">v{p.version}</span>
                <span className="hint" style={{ display: 'block' }}>{p.description}</span>
              </RadioItem>
            ))}
          </RadioGroup>
          {!packsLoaded && <p className="hint">行业包加载中…</p>}
          {packsLoaded && packs.length === 0 && (
            <p className="hint">暂无可选行业包（平台还没上架），可先通用开局。</p>
          )}
          {selected && (
            <p className="hint" style={{ fontWeight: 700 }}>
              「{selected.name}」内容：{selected.description}
              {packSummary(selected) ? `（${packSummary(selected)}）` : ''}
            </p>
          )}
        </div>
      )}

      {step === 1 && (
        <div>
          <label>服务商预设</label>
          <Select
            value={provider}
            onValueChange={onProviderChange}
            options={PROVIDER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <label>Base URL（预设自动带出，可改）</label>
          <Input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setApiSkipped(false); }} />
          <label>模型（预设自动带出，可改）</label>
          <Input value={model} onChange={(e) => { setModel(e.target.value); setApiSkipped(false); }} />
          <label>API Key</label>
          <Input
            type="password"
            placeholder="粘贴你的 API Key"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setApiSkipped(false); setTestState(null); }}
          />
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button size="small" variant="blue" onClick={testConnection} disabled={testing}>
              {testing ? '测试中…' : '测试连接'}
            </Button>
            <Button
              size="small"
              variant="gray"
              onClick={() => {
                setApiSkipped(true);
                setTestState(null);
                setStep(2);
              }}
            >
              跳过这一步
            </Button>
          </div>
          {apiSkipped && (
            <p className="hint" style={{ marginTop: 6 }}>已跳过 API 接入。</p>
          )}
          <p className="hint" style={{ marginTop: 6 }}>
            可先用体验额度试跑，之后在设置里补。
          </p>
          {testState && (
            <p
              className="hint"
              style={{ marginTop: 6, fontWeight: 800, color: testState.ok ? 'var(--teal)' : 'var(--accent)' }}
            >
              {testState.ok ? testState.message : `✗ 连接失败：${testState.message}`}
            </p>
          )}
        </div>
      )}

      {step === 2 && (
        <div>
          <label>你所在的行业</label>
          <Select
            value={industry}
            onValueChange={setIndustry}
            placeholder="请选择行业"
            options={[
              ...packs.map((p) => ({ value: p.industry || p.name, label: p.name })),
              { value: '其他', label: '其他' },
            ]}
          />
          {industry === '其他' && (
            <>
              <label>行业名称（自由填写）</label>
              <Input
                value={industryOther}
                onChange={(e) => setIndustryOther(e.target.value)}
                placeholder="如：跨境电商"
              />
            </>
          )}
          <label>你具体在做的工作</label>
          <Input
            value={job}
            onChange={(e) => setJob(e.target.value)}
            placeholder="如：短剧切片分发与账号运营"
          />
          <label>打算怎么用蜂群（可多选）</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {USE_OPTIONS.map((u) => (
              <Checkbox
                key={u}
                checked={uses.includes(u)}
                onCheckedChange={(on) =>
                  setUses((xs) => (on ? [...xs, u] : xs.filter((x) => x !== u)))
                }
                label={u}
              />
            ))}
          </div>
          {uses.includes('其他') && (
            <>
              <label>其他用法（自由填写）</label>
              <Input value={usesOther} onChange={(e) => setUsesOther(e.target.value)} />
            </>
          )}
          <label>最希望解决的问题</label>
          <Textarea
            rows={3}
            value={problems}
            onChange={(e) => setProblems(e.target.value)}
            placeholder="如：每天要产出大量短视频文案，人手不够"
          />
        </div>
      )}

      {step === 3 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
            <span style={{ flex: 1, fontSize: 13.5, fontWeight: 700 }}>签到提醒（未签到才提醒）</span>
            <Switch checked={checkinReminderEnabled} onCheckedChange={setCheckinReminderEnabled} ariaLabel="签到提醒开关" />
            <span className="hint">{checkinReminderEnabled ? '开' : '关'}</span>
          </div>
          <label>签到提醒时间（HH:MM）</label>
          <Input type="time" value={checkinReminderTime} onChange={(e) => setCheckinReminderTime(e.target.value)} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
            <span style={{ flex: 1, fontSize: 13.5, fontWeight: 700 }}>总经理晨报</span>
            <Switch checked={briefingEnabled} onCheckedChange={setBriefingEnabled} ariaLabel="总经理晨报开关" />
            <span className="hint">{briefingEnabled ? '开' : '关'}</span>
          </div>
          <label>晨报时间（HH:MM）</label>
          <Input type="time" value={briefingTime} onChange={(e) => setBriefingTime(e.target.value)} />
          <label>督促事项（总经理会在晨报里盯这些事）</label>
          <Textarea
            rows={3}
            value={supervisionItems}
            onChange={(e) => setSupervisionItems(e.target.value)}
            placeholder="如：每天发一集短剧"
          />
        </div>
      )}

      {step === 4 && (
        <div>
          <p className="hint" style={{ marginTop: 0 }}>确认一下，点任意一项可跳回修改：</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button type="button" className="hint" style={{ textAlign: 'left', fontWeight: 700 }} onClick={() => setStep(0)}>
              公司：{name.trim() || '（未填）'} · 行业包：{selected ? selected.name : '不选（通用开局）'}
            </button>
            <button type="button" className="hint" style={{ textAlign: 'left', fontWeight: 700 }} onClick={() => setStep(1)}>
              API：{hasApi ? `${providerLabel} · ${model || '（未填模型）'} · Key ••••` : '未接入（可用体验额度）'}
            </button>
            <button type="button" className="hint" style={{ textAlign: 'left', fontWeight: 700 }} onClick={() => setStep(2)}>
              关于你：行业 {resolvedIndustry || '（未填）'} · 工作 {job.trim() || '（未填）'}
              {resolvedUses.length ? ` · 用法 ${resolvedUses.join('、')}` : ''}
              {problems.trim() ? ` · 想解决：${problems.trim()}` : ''}
            </button>
            <button type="button" className="hint" style={{ textAlign: 'left', fontWeight: 700 }} onClick={() => setStep(3)}>
              提醒：签到提醒 {checkinReminderEnabled ? `${checkinReminderTime} 开` : '关'} · 晨报{' '}
              {briefingEnabled ? `${briefingTime} 开` : '关'}
              {supervisionItems.trim() ? ` · 督促：${supervisionItems.trim()}` : ''}
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {step > 0 && (
          <Button variant="gray" onClick={() => setStep((s) => Math.max(s - 1, 0))} disabled={busy}>
            上一步
          </Button>
        )}
        {step < WIZARD_STEPS.length - 1 && (
          <Button onClick={next} disabled={busy}>
            下一步
          </Button>
        )}
        {step === WIZARD_STEPS.length - 1 && (
          <Button onClick={() => create(true)} disabled={busy}>
            {busy ? '创建中…' : '创建公司'}
          </Button>
        )}
        {step === 0 ? (
          <Button variant="gray" onClick={() => create(false)} disabled={busy}>
            {busy ? '开通中…' : '直接创建'}
          </Button>
        ) : (
          skipQuestionnaire
        )}
        <Button variant="gray" onClick={onClose} disabled={busy}>取消</Button>
      </div>
    </Dialog>
  );
}
