import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  computeHeatSnapshots,
  runAgentMonthlyTick,
  runAgentSyncPipeline,
} from '../../src/domain/agentSyncPipeline';
import { getAgentSyncSources, saveAgentSyncSources, type AgentFetcher, type AgentSyncSource } from '../../src/domain/agentSyncService';
import {
  createAiOpsRun,
  executeAiOpsRun,
  parseAiOpsPlan,
  rollbackAiOpsStep,
  type AuditFn,
} from '../../src/domain/aiOpsService';
import { importSkillsFromGithub, pushSkillToWorkspaces } from '../../src/domain/skillImportService';
import { ensurePlatformKb, PLATFORM_KB_SEEDS } from '../../src/store/platformKb';
import { openDb } from '../../src/store/db';
import { Repos } from '../../src/store/repositories';
import { nowIso } from '../../src/util';

/**
 * v1.5.0 域服务集成测试（离线、假 fetcher 注入）：
 * A 平台知识幂等播种；C 流水线（漂移暂停/结构校验/risk 标记/run 记录/热度快照/月度 tick 防重）；
 * K GitHub 导入（许可证预检/SKILL.md 校验/署名）与推送幂等；M 计划校验/执行审计/破坏性确认/三类回滚。
 */
function freshRepos(): { repos: Repos; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v150-svc-'));
  const db = openDb(path.join(dir, 't.db'));
  return {
    repos: new Repos(db),
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const MIT_TEXT = 'MIT License\n\nCopyright (c) 2026 Test\n\nPermission is hereby granted, free of charge, to any person obtaining a copy';
const GPL_TEXT = 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n\nCopyright (C) 2007 Free Software Foundation';

/* ---------------- A ---------------- */
describe('A 平台知识播种', () => {
  it('首批种子幂等落库（platform scope、workspace 为空）', () => {
    const { repos, cleanup } = freshRepos();
    try {
      ensurePlatformKb(repos);
      const first = repos.listPlatformKb();
      expect(first).toHaveLength(PLATFORM_KB_SEEDS.length);
      expect(first.every((k) => k.scope === 'platform' && k.workspace_id === null)).toBe(true);
      ensurePlatformKb(repos);
      expect(repos.listPlatformKb()).toHaveLength(PLATFORM_KB_SEEDS.length);
    } finally {
      cleanup();
    }
  });
});

/* ---------------- C ---------------- */
const AGENT_GOOD = `---
name: Risky Helper
description: 带安装命令的人设（应被预筛标记）。
---

# Risky Helper

先执行 npm install some-tool 再开始工作。
`;
const AGENT_PLAIN = `---
name: Plain Helper
description: 普通人设。
---

# Plain Helper

认真完成被分配的工作，产出清晰可靠。
`;
const AGENT_BROKEN = `---
name: Broken Helper
---

# Broken Helper

缺 description，应进 failed 明细而不是落库。
`;
const SRC: AgentSyncSource = { id: 't-src', repo: 'owner/agents', branch: 'main', license: 'MIT', author: 'Tester' };

function agentFetcher(licenseText: string): AgentFetcher {
  const files = new Map<string, string>([
    ['marketing/good.md', AGENT_GOOD],
    ['marketing/plain.md', AGENT_PLAIN],
    ['marketing/broken.md', AGENT_BROKEN],
  ]);
  return async (url: string) => {
    if (url.endsWith('/LICENSE')) return licenseText;
    if (url.includes('/git/trees/')) {
      return JSON.stringify({ tree: [...files.keys()].map((p) => ({ path: p, type: 'blob' })) });
    }
    if (url.includes('/commits/')) return JSON.stringify({ sha: 'abc1234deadbeef' });
    if (url.endsWith('/repos/owner/agents')) {
      return JSON.stringify({ stargazers_count: 12345, pushed_at: nowIso() });
    }
    if (url.endsWith('/divisions.json')) return JSON.stringify({ divisions: { marketing: {} } });
    const p = decodeURIComponent(url.split('/main/')[1] ?? '');
    const c = files.get(p);
    if (c === undefined) throw new Error(`GET ${url} → HTTP 404`);
    return c;
  };
}

describe('C 同步流水线', () => {
  it('正常同步：结构校验计 failed、risk 标记、run 记录、热度快照', async () => {
    const { repos, cleanup } = freshRepos();
    try {
      saveAgentSyncSources(repos, [SRC]);
      const out = await runAgentSyncPipeline(repos, SRC, 'manual', agentFetcher(MIT_TEXT));
      expect(out.paused).toBe(false);
      expect(out.result).toMatchObject({ fetched: 3, created: 2, failed: 1 });
      expect(out.result!.failedDetails[0]).toMatchObject({ path: 'marketing/broken.md' });
      const run = out.run;
      expect(run.status).toBe('success');
      expect(run.source_commit).toBe('abc1234deadbeef');
      expect(repos.listAgentSyncRuns(10)).toHaveLength(1);
      const risky = repos.getAgentTemplateBySource('owner/agents', 'marketing/good.md')!;
      expect(JSON.parse(risky.risk_flags)).toContain('install_command');
      expect(repos.getAgentTemplateBySource('owner/agents', 'marketing/broken.md')).toBeUndefined();

      // 过审后热度快照：stars 12345 + 新鲜度 → 分数 > 0.5
      repos.updateAgentTemplate({
        ...risky,
        status: 'public',
        pub_name: risky.draft_name,
        pub_specialty: risky.draft_specialty,
        pub_persona: risky.draft_persona,
        pub_role: risky.draft_role,
        pub_at: nowIso(),
      });
      computeHeatSnapshots(repos, new Date());
      const snaps = repos.listAgentHeatSnapshots(nowIso().slice(0, 7));
      expect(snaps).toHaveLength(1); // 只有已上架（public）的 risky 进榜
      expect(snaps[0]).toMatchObject({ template_id: risky.id, source_stars: 12345 });
      expect(snaps[0]!.score).toBeGreaterThan(0.5);
    } finally {
      cleanup();
    }
  });

  it('许可证漂移：整源暂停 + run 留痕 + 待审不写', async () => {
    const { repos, cleanup } = freshRepos();
    try {
      saveAgentSyncSources(repos, [SRC]);
      const out = await runAgentSyncPipeline(repos, SRC, 'manual', agentFetcher(GPL_TEXT));
      expect(out.paused).toBe(true);
      expect(out.run.status).toBe('paused_license_drift');
      const saved = getAgentSyncSources(repos).find((s) => s.id === SRC.id)!;
      expect(saved.paused).toBe(true);
      expect(repos.listAgentTemplates()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('月度 tick：每月 1 日触发、当月防重', async () => {
    const { repos, cleanup } = freshRepos();
    try {
      saveAgentSyncSources(repos, [SRC]);
      const nov1 = new Date('2026-10-31T16:30:00.000Z'); // 上海时间 2026-11-01 00:30
      const r1 = await runAgentMonthlyTick(repos, nov1, agentFetcher(MIT_TEXT));
      expect(r1.ran).toBe(true);
      const r2 = await runAgentMonthlyTick(repos, nov1, agentFetcher(MIT_TEXT));
      expect(r2.ran).toBe(false);
      const nov2 = new Date('2026-11-01T16:30:00.000Z'); // 上海 11-02
      const r3 = await runAgentMonthlyTick(repos, nov2, agentFetcher(MIT_TEXT));
      expect(r3.ran).toBe(false);
      expect(repos.listAgentSyncRuns(10).filter((x) => x.trigger_type === 'auto')).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

/* ---------------- K ---------------- */
function skillFetcher(licenseText: string): AgentFetcher {
  const skillGood = `---
name: 标题工场
description: 按钩子公式批量产出标题。
role: 文案
---

# 标题工场

先给结论型标题，再给悬念型，各 5 条。
`;
  const skillBad = `---
name: 缺说明技能
---

正文没有 description。
`;
  const files = new Map<string, string>([
    ['writing/SKILL.md', skillGood],
    ['bad/SKILL.md', skillBad],
  ]);
  return async (url: string) => {
    if (url.endsWith('/LICENSE')) return licenseText;
    if (url.includes('/git/trees/')) {
      return JSON.stringify({ tree: [...files.keys(), 'README.md'].map((p) => ({ path: p, type: 'blob' })) });
    }
    if (url.endsWith('/repos/owner/skills')) return JSON.stringify({ owner: { login: 'owner' } });
    const p = decodeURIComponent(url.split('/main/')[1] ?? '');
    const c = files.get(p);
    if (c === undefined) throw new Error(`GET ${url} → HTTP 404`);
    return c;
  };
}

describe('K 技能导入与推送', () => {
  it('MIT 仓库：合格落平台草稿（署名三字段）、不合格进明细', async () => {
    const { repos, cleanup } = freshRepos();
    try {
      const out = await importSkillsFromGithub(repos, { repoUrl: 'https://github.com/owner/skills', importedBy: 'admin' }, skillFetcher(MIT_TEXT));
      expect(out.record.status).toBe('imported');
      expect(out.createdSkillIds).toHaveLength(1);
      expect(out.record.detail).toContain('bad/SKILL.md');
      const skill = repos.getSkill(out.createdSkillIds[0]!)!;
      expect(skill.owner_type).toBe('platform');
      expect(skill.status).toBe('draft');
      expect(skill.source_repo).toBe('owner/skills');
      expect(skill.source_license).toBe('MIT');
      expect(skill.role).toBe('文案');
    } finally {
      cleanup();
    }
  });

  it('GPL 仓库：许可证预检拒绝并留痕、不落技能', async () => {
    const { repos, cleanup } = freshRepos();
    try {
      const out = await importSkillsFromGithub(repos, { repoUrl: 'owner/skills', importedBy: 'admin' }, skillFetcher(GPL_TEXT));
      expect(out.record.status).toBe('rejected_license');
      expect(out.createdSkillIds).toHaveLength(0);
      expect(repos.listSkillSourceImports(10)).toHaveLength(1);
      expect(repos.listPlatformSkills()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('推送：快照安装 + 同版幂等 + 线程说明消息', async () => {
    const { repos, cleanup } = freshRepos();
    try {
      const wsId = 'ws_push_test';
      repos.insertWorkspace({
        id: wsId, name: '推送测试空间', owner_user_id: 'user_x', status: 'active',
        industry_pack_id: null, created_at: nowIso(),
      });
      const imp = await importSkillsFromGithub(repos, { repoUrl: 'owner/skills', importedBy: 'admin' }, skillFetcher(MIT_TEXT));
      const skill = repos.getSkill(imp.createdSkillIds[0]!)!;
      repos.updateSkill({ ...skill, status: 'published', visibility: 'public' });
      const fresh = repos.getSkill(skill.id)!;
      const o1 = pushSkillToWorkspaces(repos, fresh, [wsId], 'admin');
      expect(o1.installed).toBe(1);
      const copy = repos.findInstalledCopy(wsId, skill.id)!;
      expect(repos.getSkillPushByCopyId(copy.id)).toBeTruthy();
      const thread = repos.getThreadByWorkspace(wsId)!;
      const msgs = repos.listMessages(thread.id, 10);
      expect(msgs.some((m) => m.kind === 'skill_push' && m.body.includes('标题工场'))).toBe(true);
      const o2 = pushSkillToWorkspaces(repos, fresh, [wsId], 'admin');
      expect(o2).toMatchObject({ installed: 0, skipped: 1 });
    } finally {
      cleanup();
    }
  });
});

/* ---------------- M ---------------- */
describe('M 运营官计划与执行', () => {
  it('计划校验：合法计划标注破坏性；未知 op / 非 JSON 整单拒绝', () => {
    const plan = parseAiOpsPlan('{"steps":[{"op":"get_pending_summary","params":{}},{"op":"delete_platform_kb","params":{"kb":"x"}}]}');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.destructive).toBe(false);
    expect(plan.steps[1]!.destructive).toBe(true);
    expect(() => parseAiOpsPlan('{"steps":[{"op":"drop_everything","params":{}}]}')).toThrow(/op 非法/);
    expect(() => parseAiOpsPlan('好的，我来处理')).toThrow();
    expect(() => parseAiOpsPlan('{"steps":[]}')).toThrow(/为空/);
  });

  it('执行：公告+平台知识两步全成、每步 audit 关联 run 与指令；回滚两步生效', async () => {
    const { repos, cleanup } = freshRepos();
    try {
      const audits: Array<{ action: string; detail: string }> = [];
      const auditFn: AuditFn = (action, _t, _id, detail) => audits.push({ action, detail });
      const plan = parseAiOpsPlan(JSON.stringify({
        steps: [
          { op: 'publish_announcement', params: { title: '维护通知', body: '周六维护', workspaces: 'all' } },
          { op: 'create_platform_kb', params: { title: '运营官新建条目', body: '内容', tags: ['测试'] } },
        ],
      }));
      const run = createAiOpsRun(repos, '发公告并加一条平台知识', plan, 'admin');
      const done = await executeAiOpsRun(repos, run.id, auditFn);
      expect(done.status).toBe('done');
      expect(audits).toHaveLength(2);
      expect(audits.every((a) => a.detail.includes(run.id) && a.detail.includes('发公告并加一条平台知识'))).toBe(true);
      const ann = repos.listAnnouncements()[0]!;
      expect(ann.status).toBe('published');
      expect(repos.listPlatformKb().some((k) => k.title === '运营官新建条目')).toBe(true);
      const back1 = await rollbackAiOpsStep(repos, run.id, 0, auditFn);
      expect(back1.summary).toContain('撤下');
      expect(repos.getAnnouncement(ann.id)!.status).toBe('withdrawn');
      await rollbackAiOpsStep(repos, run.id, 1, auditFn);
      expect(repos.listPlatformKb().some((k) => k.title === '运营官新建条目')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('破坏性步骤：未确认只置 awaiting_confirm 不执行，确认后执行', async () => {
    const { repos, cleanup } = freshRepos();
    try {
      ensurePlatformKb(repos);
      const target = repos.listPlatformKb()[0]!;
      const auditFn: AuditFn = () => {};
      const plan = parseAiOpsPlan(JSON.stringify({
        steps: [{ op: 'delete_platform_kb', params: { kb: target.id } }],
      }));
      const run = createAiOpsRun(repos, '删掉一条平台知识', plan, 'admin');
      const held = await executeAiOpsRun(repos, run.id, auditFn);
      expect(held.status).toBe('awaiting_confirm');
      expect(repos.listPlatformKb().some((k) => k.id === target.id)).toBe(true);
      const done = await executeAiOpsRun(repos, run.id, auditFn, { confirmDestructive: true });
      expect(done.status).toBe('done');
      expect(repos.listPlatformKb().some((k) => k.id === target.id)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
