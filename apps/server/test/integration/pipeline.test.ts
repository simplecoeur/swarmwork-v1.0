import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 集成测试（设计 §12）：起 mock-llm + 新 server（临时 DATA_DIR），跑完整流水线。
 * 覆盖 v0 的 13 项自测断言精神（种子/配置/充值/分配/发单/完成/成果/账本 2 条/300 token/余额推导）。
 * 金额差异说明：v0 浮点口径下总成本 0.003 元；新版整数厘按条取整（每条 1.5 厘→2 厘），合计 0.004 元、余额 99.996 元。
 * 并扩展打回分支与裁决分支（含项目聚合，§15.2）。
 */
const SERVER_DIR = process.cwd(); // apps/server
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig {
  base: string;
  mockBase: string;
  procs: ChildProcess[];
  dataDir: string;
}

async function waitUp(url: string, timeout = 25_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* 继续等 */
    }
    await sleep(300);
  }
  return false;
}

async function startRig(serverPort: number, mockPort: number, reviewMode: string): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-int-'));
  const mock = spawn('node', [MOCK], {
    env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_REVIEW_MODE: reviewMode },
    stdio: 'pipe',
    detached: true,
  });
  // 直接以 node --import tsx 启动（避免 npx 包装层导致子进程残留），detached 便于整组击杀
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(serverPort),
      DATA_DIR: dataDir,
      LLM_RETRY_BASE_MS: '10',
    },
    stdio: 'pipe',
    detached: true,
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  const rig: Rig = {
    base: `http://127.0.0.1:${serverPort}`,
    mockBase: `http://127.0.0.1:${mockPort}`,
    procs: [mock, server],
    dataDir,
  };
  expect(await waitUp(rig.mockBase + '/__counts')).toBe(true);
  expect(await waitUp(rig.base + '/api/state')).toBe(true);
  return rig;
}

function stopRig(rig: Rig): void {
  for (const p of rig.procs) {
    try {
      if (p.pid) process.kill(-p.pid, 'SIGKILL'); // 整组击杀（含 tsx 子进程）
    } catch {
      try {
        p.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
  try {
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

async function jget(base: string, p: string): Promise<any> {
  const r = await fetch(base + p);
  return r.json();
}
async function jpost(base: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}

async function waitFor<T>(fn: () => Promise<T | null>, timeout = 40_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error('waitFor 超时');
}

/** 与 v0 自测相同的配置动作：API 指向 mock、单价 10 元/百万、充值 100、小组分配 */
async function configure(rig: Rig): Promise<{ apiId: string; teamId: string }> {
  const st = await jget(rig.base, '/api/state');
  const apiId = st.apis[0].id as string;
  const teamId = st.teams[0].id as string;
  expect(st.teams.length).toBe(1);
  expect(st.apis.length).toBe(1);
  expect(st.tasks.length).toBe(0);
  const sv = await jpost(rig.base, '/api/apis/save', {
    api: {
      id: apiId,
      name: 'Mock API',
      provider: 'custom',
      baseUrl: rig.mockBase,
      model: 'mock-model',
      pricePerM: 10,
      apiKey: 'fake-key-123',
    },
  });
  expect(sv.ok).toBe(true);
  const pu = await jpost(rig.base, '/api/purchase', { apiId, amountYuan: 100 });
  expect(pu.ok).toBe(true);
  expect(pu.balanceYuan).toBe(100);
  const ts = await jpost(rig.base, '/api/teams/save', {
    team: { id: teamId, name: '第一小组', color: '#e2574c', apiId },
  });
  expect(ts.ok).toBe(true);
  return { apiId, teamId };
}

async function taskById(rig: Rig, taskId: string): Promise<any> {
  const st = await jget(rig.base, '/api/state');
  return st.tasks.find((t: any) => t.id === taskId);
}

describe('集成：完整流水线（审核通过分支）', () => {
  it('发单→完成→ledger 2 条对账→余额推导正确', async () => {
    const rig = await startRig(8851, 8861, 'pass');
    try {
      // 冒烟：首页与 /api/state 200
      const home = await fetch(rig.base + '/');
      expect(home.status).toBe(200);

      const { apiId, teamId } = await configure(rig);
      const ct = await jpost(rig.base, '/api/tasks', {
        title: '自测文案单',
        type: '文案',
        brief: '写一句测试文案',
        teamId,
      });
      expect(ct.ok).toBe(true);

      const task = await waitFor(async () => {
        const t = await taskById(rig, ct.id);
        return t && t.status === '已完成' ? t : null;
      });
      expect(typeof task.result).toBe('string');
      expect(task.result.length).toBeGreaterThan(10);

      const st = await jget(rig.base, '/api/state');
      const entries = st.ledger.filter((l: any) => l.taskId === ct.id);
      expect(entries.length).toBe(2);
      expect(entries.map((e: any) => e.stage)).toEqual(['执行', '审核']);
      const totTok = entries.reduce((s: number, e: any) => s + e.totalTokens, 0);
      expect(totTok).toBe(300); // 2 次调用 × mock usage 150
      // 整数厘口径：每条 150×10000/1e6=1.5 厘 → 取整 2 厘，两条合计 4 厘 = 0.004 元
      expect(Math.abs(task.totalCost - 0.004)).toBeLessThan(1e-9);
      const api = st.apis.find((a: any) => a.id === apiId);
      expect(Math.abs(api.balanceYuan - 99.996)).toBeLessThan(1e-9);
      // Key 只出掩码
      expect(api.hasKey).toBe(true);
      expect(api.apiKeyMasked).not.toContain('fake-key-123');
      expect(api.apiKeyMasked).toContain('123');

      const report = (await jget(rig.base, '/api/cost/report')).report;
      expect(report.totals.totalTokens).toBe(300);
      expect(report.totals.totalCostYuan).toBeCloseTo(0.004, 9);
      expect(report.adjudication).toEqual({ pending: 0, passed: 0 });
      expect(report.byApi[0].calls).toBe(2);
    } finally {
      stopRig(rig);
    }
  });
});

describe('集成：打回分支（第一次审核不过→重做通过）', () => {
  it('rejectCount=1，账本含 重做 阶段，最终完成', async () => {
    const rig = await startRig(8852, 8862, 'fail-once');
    try {
      const { teamId } = await configure(rig);
      const ct = await jpost(rig.base, '/api/tasks', {
        title: '打回测试单',
        type: '文案',
        brief: '标题要带数字',
        teamId,
      });
      const task = await waitFor(async () => {
        const t = await taskById(rig, ct.id);
        return t && t.status === '已完成' ? t : null;
      });
      expect(task.rejectCount).toBe(1);
      const st = await jget(rig.base, '/api/state');
      const stages = st.ledger.filter((l: any) => l.taskId === ct.id).map((e: any) => e.stage);
      expect(stages).toEqual(['执行', '审核', '重做', '审核']);
      const counts = await jget(rig.mockBase, '/__counts');
      expect(counts.review).toBe(2);
    } finally {
      stopRig(rig);
    }
  });
});

describe('集成：裁决分支（两次不过→待裁决→裁决通过）+ 项目聚合', () => {
  it('任务待裁决→裁决通过单列统计；项目子任务待裁决→项目待裁决→交付', async () => {
    const rig = await startRig(8853, 8863, 'fail-always');
    try {
      const { teamId } = await configure(rig);
      const ct = await jpost(rig.base, '/api/tasks', {
        title: '裁决测试单',
        type: '文案',
        brief: '怎么都过不了',
        teamId,
      });
      const adj = await waitFor(async () => {
        const t = await taskById(rig, ct.id);
        return t && t.status === '待裁决' ? t : null;
      });
      expect(adj.rejectCount).toBe(2);

      const before = (await jget(rig.base, '/api/cost/report')).report;
      expect(before.adjudication.pending).toBe(1);
      expect(before.adjudication.passed).toBe(0);

      const ad = await jpost(rig.base, '/api/tasks/adjudicate', { taskId: ct.id });
      expect(ad.ok).toBe(true);
      const done = await taskById(rig, ct.id);
      expect(done.status).toBe('已完成');
      expect(done.adjudicated).toBe(true);
      expect(done.reviewNote).toContain('老板裁决');

      // 项目：拆单解析失败兜底为单子任务 → 子任务待裁决 → 项目显示待裁决
      const pj = await jpost(rig.base, '/api/projects', {
        name: '短剧项目',
        brief: '做一支短剧',
        teamId,
        clientName: '甲方A',
      });
      expect(pj.ok).toBe(true);
      expect(pj.taskIds.length).toBe(1);
      await waitFor(async () => {
        const t = await taskById(rig, pj.taskIds[0]);
        return t && t.status === '待裁决' ? t : null;
      });
      let st = await jget(rig.base, '/api/state');
      let project = st.projects.find((p: any) => p.id === pj.id);
      expect(project.status).toBe('待裁决');

      await jpost(rig.base, '/api/tasks/adjudicate', { taskId: pj.taskIds[0] });
      project = await waitFor(async () => {
        const s2 = await jget(rig.base, '/api/state');
        const p = s2.projects.find((x: any) => x.id === pj.id);
        return p && p.status === '已交付' ? p : null;
      });
      expect(project.status).toBe('已交付');

      const report = (await jget(rig.base, '/api/cost/report')).report;
      expect(report.adjudication.pending).toBe(0);
      expect(report.adjudication.passed).toBe(2);
      st = await jget(rig.base, '/api/state');
      expect(st.projects.length).toBe(1);
    } finally {
      stopRig(rig);
    }
  });
});
