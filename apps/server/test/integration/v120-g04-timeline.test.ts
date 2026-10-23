import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { recordTaskStep } from '../../src/domain/taskSteps';
import { openDb } from '../../src/store/db';
import { Repos } from '../../src/store/repositories';

/**
 * G-04 任务过程时间线集成测试（v1.2.0 施工设计 G-04 验收断言 1–5）：
 * ① mock 跑通一单（项目子任务）：timeline 含 split/plan/inject/execute/review 且顺序正确；
 *    execute 步 cost = ledger 执行类 stage 行之和；全步 cost 总和 = 任务总耗（ledger 口径）。
 * ② 打回重做：review（不通过，含要点摘要）→ retry → execute，且 retry 步数与 reject_count 一致。
 * ③ 同 call_key 重复写步被唯一约束拒绝（recordTaskStep 返回 false、直插抛错）。
 * ④ 跨空间 timeline 回 404；已完成任务两次回放一致且与终局账本一致。
 * ⑤ 注入步 detail 含实际命中的知识条目名与资产名，并与 mock 侧注入回显交叉核对。
 * 另含存量库升级对账：001–007 库直接升级 008 后旧数据完好、task_steps 可用。
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

let COOKIE = '';
async function loginAdmin(base: string): Promise<void> {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: '<MASKED_SECRET_001>!' }),
  });
  const j: any = await r.json();
  expect(j.ok).toBe(true);
  COOKIE = (r.headers.get('set-cookie') || '').split(';')[0];
  const r2 = await fetch(base + '/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    body: JSON.stringify({ currentPassword: '<MASKED_SECRET_001>!', newPassword: '<MASKED_SECRET_002>!' }),
  });
  expect((await r2.json()).ok).toBe(true);
}

async function startRig(serverPort: number, mockPort: number, reviewMode: string): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-g04-'));
  const mock = spawn('node', [MOCK], {
    env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_REVIEW_MODE: reviewMode },
    stdio: 'pipe',
    detached: true,
  });
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(serverPort),
      DATA_DIR: dataDir,
      LLM_RETRY_BASE_MS: '10',
      SWARM_ADMIN_EMAIL: 'admin@test.local',
      SWARM_ADMIN_PASSWORD: '<MASKED_SECRET_001>!',
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
  expect(await waitUp(rig.base + '/api/health')).toBe(true);
  await loginAdmin(rig.base);
  return rig;
}

function stopRig(rig: Rig): void {
  for (const p of rig.procs) {
    try {
      if (p.pid) process.kill(-p.pid, 'SIGKILL');
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

async function jget(base: string, p: string, cookie = COOKIE): Promise<any> {
  const r = await fetch(base + p, { headers: { cookie } });
  return r.json();
}
async function jpost(base: string, p: string, body?: unknown, cookie = COOKIE): Promise<any> {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}
async function rawGet(base: string, p: string, cookie: string): Promise<{ status: number; json: any }> {
  const r = await fetch(base + p, { headers: { cookie } });
  return { status: r.status, json: await r.json().catch(() => ({})) };
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

async function configure(rig: Rig): Promise<{ apiId: string; teamId: string }> {
  const st = await jget(rig.base, '/api/state');
  const apiId = st.apis[0].id as string;
  const teamId = st.teams[0].id as string;
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
async function waitDone(rig: Rig, taskId: string): Promise<any> {
  return waitFor(async () => {
    const t = await taskById(rig, taskId);
    return t && t.status === '已完成' ? t : null;
  });
}
/** 某任务的 ledger（state 口径，元）按 stage 汇总（厘，取整对账） */
async function ledgerMilli(rig: Rig, taskId: string): Promise<{ total: number; execLike: number }> {
  const st = await jget(rig.base, '/api/state');
  const rows = st.ledger.filter((l: any) => l.taskId === taskId);
  const sum = (rs: any[]) => rs.reduce((s, e) => s + Math.round(e.costYuan * 1000), 0);
  return {
    total: sum(rows),
    execLike: sum(rows.filter((e: any) => e.stage === '执行' || e.stage === '重做')),
  };
}

describe('G-04 验收①⑤：项目单时间线完整步骤 + 成本对账 + 注入名单', () => {
  it('split/plan/inject/execute/review 顺序正确、成本与 ledger 同源、注入 detail 含命中名单', async () => {
    const rig = await startRig(8911, 8921, 'pass');
    try {
      const { teamId } = await configure(rig);
      // 注入素材：公司级知识条目（必命中）+ 资产（单任务显式引用）
      const kb = await jpost(rig.base, '/api/kb', {
        title: 'G04命中知识条目',
        body: '短剧标题要突出反转与悬念。G04KBKEY',
        scope: 'company',
        tags: [],
        enabled: true,
      });
      expect(kb.ok).toBe(true);
      const asset = await jpost(rig.base, '/api/assets', {
        asset: {
          typeId: '通用文档',
          name: 'G04命中资产',
          content: { sections: [{ key: 'full', title: '全文', body: '资产正文 G04ASSETKEY' }] },
        },
      });
      expect(asset.ok).toBe(true);

      // 项目单：mock 拆单返回非 JSON → 兜底 1 个子任务；拆单调用真实发生（有 split 步与拆单账本行）
      const pj = await jpost(rig.base, '/api/projects', {
        name: 'G04项目',
        brief: '为新剧做上线物料',
        teamId,
        clientName: '',
      });
      expect(pj.ok).toBe(true);
      expect(pj.taskIds.length).toBe(1);
      const childId = pj.taskIds[0] as string;
      const child = await waitDone(rig, childId);

      const tl = await jget(rig.base, `/api/tasks/${childId}/timeline`);
      expect(tl.ok).toBe(true);
      const kinds = (tl.steps as any[]).map((s) => s.kind);
      const idx = (k: string) => kinds.indexOf(k);
      // ① 含 split/inject/execute/review 且顺序正确（plan 位于 split 之后、inject 之前）
      for (const k of ['split', 'plan', 'inject', 'execute', 'review']) {
        expect(idx(k), `缺少步骤 ${k}`).toBeGreaterThanOrEqual(0);
      }
      expect(idx('split')).toBeLessThan(idx('plan'));
      expect(idx('plan')).toBeLessThan(idx('inject'));
      expect(idx('inject')).toBeLessThan(idx('execute'));
      expect(idx('execute')).toBeLessThan(idx('review'));
      // split 步 detail 带子任务清单（计划卡同源）
      const splitStep = (tl.steps as any[]).find((s) => s.kind === 'split');
      expect(Array.isArray(splitStep.detail.subtasks)).toBe(true);
      expect(splitStep.detail.subtasks.length).toBe(1);
      // events 辅轨存在且含终局状态
      expect((tl.events as any[]).some((e) => e.toStatus === '已完成')).toBe(true);

      // ① 成本对账：execute 步 cost 之和 = ledger 执行类 stage 行之和；全步总和 = 任务总耗
      const lm = await ledgerMilli(rig, childId);
      const steps: any[] = tl.steps;
      const execCost = steps.filter((s) => s.kind === 'execute').reduce((s, x) => s + x.costMilli, 0);
      expect(execCost).toBe(lm.execLike);
      const totalStepCost = steps.reduce((s, x) => s + x.costMilli, 0);
      expect(totalStepCost).toBe(lm.total);
      expect(Math.round(child.totalCost * 1000)).toBe(lm.total);
      // execute/review 步带 usage 与耗时（Provider 步指标完整）
      const execStep = steps.find((s) => s.kind === 'execute');
      expect(execStep.promptTokens + execStep.completionTokens).toBe(150);
      expect(execStep.durationMs).toBeGreaterThanOrEqual(0);
      const reviewStep = steps.find((s) => s.kind === 'review');
      expect(reviewStep.detail.pass).toBe(true);

      // ⑤ 独立单（显式引用资产）：注入步 detail 含知识条目名与资产名，并与 mock 回显交叉核对
      const ct = await jpost(rig.base, '/api/tasks', {
        title: 'G04注入单',
        type: '文案',
        brief: '写标题，参考 G04KBKEY',
        teamId,
        assetRefs: [{ assetId: asset.id }],
      });
      expect(ct.ok).toBe(true);
      await waitDone(rig, ct.id);
      const tl2 = await jget(rig.base, `/api/tasks/${ct.id}/timeline`);
      const inject = (tl2.steps as any[]).find((s) => s.kind === 'inject');
      expect(inject).toBeTruthy();
      const kbTitles = (inject.detail.kb as any[]).map((k) => k.title);
      const assetNames = (inject.detail.assets as any[]).map((a) => a.name);
      expect(kbTitles).toContain('G04命中知识条目');
      expect(assetNames).toContain('G04命中资产');
      const reqs = await jget(rig.mockBase, '/__requests').catch(() => []);
      const seen = Array.isArray(reqs) ? reqs : [];
      expect(
        seen.some(
          (r: any) => r.kind === 'chat' && r.user.includes('G04命中知识条目') && r.user.includes('G04命中资产'),
        ),
      ).toBe(true);
    } finally {
      stopRig(rig);
    }
  });
});

describe('G-04 验收②：打回重做的时间线序列', () => {
  it('review（不通过含要点摘要）→ retry → execute，retry 步数与 reject_count 一致', async () => {
    const rig = await startRig(8912, 8922, 'fail-once');
    try {
      const { teamId } = await configure(rig);
      const ct = await jpost(rig.base, '/api/tasks', {
        title: 'G04打回单',
        type: '文案',
        brief: '标题要带数字',
        teamId,
      });
      const task = await waitDone(rig, ct.id);
      expect(task.rejectCount).toBe(1);

      const tl = await jget(rig.base, `/api/tasks/${ct.id}/timeline`);
      const steps: any[] = tl.steps;
      const failReviewIdx = steps.findIndex((s) => s.kind === 'review' && s.detail.pass === false);
      expect(failReviewIdx).toBeGreaterThanOrEqual(0);
      // 不通过的 review 步含要点摘要（mock 打回理由）
      expect(String(steps[failReviewIdx].detail.reason)).toContain('标题必须带数字');
      const retryIdx = steps.findIndex((s) => s.kind === 'retry');
      expect(retryIdx).toBeGreaterThan(failReviewIdx);
      const executeAfter = steps.findIndex((s, i) => s.kind === 'execute' && i > retryIdx);
      expect(executeAfter).toBeGreaterThan(retryIdx);
      // retry 步数与 reject_count 一致；审核共两步（不过 → 通过）
      expect(steps.filter((s) => s.kind === 'retry').length).toBe(task.rejectCount);
      expect(steps.filter((s) => s.kind === 'review').length).toBe(2);
      expect(steps.filter((s) => s.kind === 'review')[1].detail.pass).toBe(true);
      // 全步成本仍与 ledger 对账（含重做 stage）
      const lm = await ledgerMilli(rig, ct.id);
      expect(steps.reduce((s, x) => s + x.costMilli, 0)).toBe(lm.total);
    } finally {
      stopRig(rig);
    }
  });
});

describe('G-04 验收③ + 存量库升级对账（001–007 → 008）', () => {
  it('同 call_key 重复写步被唯一约束拒绝', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-g04-dup-'));
    const db = openDb(path.join(dir, 'swarm.db'));
    try {
      const repos = new Repos(db);
      const input = {
        taskId: 'task_dup',
        workspaceId: 'ws_default',
        kind: 'execute' as const,
        summary: '执行完成',
        callKey: 'task_dup:执行:0',
        costMilli: 2,
      };
      expect(recordTaskStep(repos, input)).toBe(true);
      // 同 call_key 再写：旁路助手被唯一约束拒绝（返回 false、不抛、不产生第二步）
      expect(recordTaskStep(repos, input)).toBe(false);
      expect(repos.listTaskSteps('task_dup').length).toBe(1);
      // 直插同样被 UNIQUE(task_id, call_key) 拒绝
      expect(() =>
        repos.insertTaskStep({
          task_id: 'task_dup',
          workspace_id: 'ws_default',
          kind: 'execute',
          actor_member_id: null,
          summary: '重复',
          detail: '{}',
          call_key: 'task_dup:执行:0',
          duration_ms: null,
          prompt_tokens: null,
          completion_tokens: null,
          cost_milli: 0,
        }),
      ).toThrow();
      expect(repos.listTaskSteps('task_dup').length).toBe(1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('存量库（只应用 001–007）可直接升级 008，旧任务数据完好', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-g04-upg-'));
    const dbPath = path.join(dir, 'swarm.db');
    const migDir = path.join(SERVER_DIR, 'src', 'store', 'migrations');
    const raw = new DatabaseSync(dbPath);
    raw.exec(
      'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    for (const f of fs.readdirSync(migDir).filter((x) => /^00[1-7]_/.test(x)).sort()) {
      raw.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
      raw
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(f.replace(/\.sql$/, ''), '2026-10-23T00:00:00.000Z');
    }
    raw
      .prepare(
        `INSERT INTO tasks (id, team_id, title, type, status, created_at, workspace_id)
         VALUES ('task_legacy', 'team_x', '存量任务', '文案', '已完成', '2026-10-23T00:00:00.000Z', 'ws_default')`,
      )
      .run();
    raw.close();

    const db = openDb(dbPath); // 启动迁移：应只补跑 008
    try {
      const versions = (
        db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>
      ).map((r) => r.version);
      expect(versions).toContain('008_task_steps');
      const legacy = db.prepare("SELECT title FROM tasks WHERE id = 'task_legacy'").get() as { title: string };
      expect(legacy.title).toBe('存量任务');
      const repos = new Repos(db);
      expect(
        recordTaskStep(repos, {
          taskId: 'task_legacy',
          workspaceId: 'ws_default',
          kind: 'plan',
          summary: '存量任务补记',
          callKey: 'plan:task_legacy',
        }),
      ).toBe(true);
      expect(repos.listTaskSteps('task_legacy').length).toBe(1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('G-04 验收④：跨空间 404 + 已完成回放一致性', () => {
  it('他人空间取 timeline 回 404；已完成任务两次回放与终局数据一致', async () => {
    const rig = await startRig(8913, 8923, 'pass');
    try {
      const { teamId } = await configure(rig);
      const ct = await jpost(rig.base, '/api/tasks', {
        title: 'G04回放单',
        type: '文案',
        brief: '写一句文案',
        teamId,
      });
      const done = await waitDone(rig, ct.id);

      const tl1 = await jget(rig.base, `/api/tasks/${ct.id}/timeline`);
      const tl2 = await jget(rig.base, `/api/tasks/${ct.id}/timeline`);
      // 回放口径：已完成任务重复读取返回同一份终局数据
      expect(JSON.stringify(tl1.steps)).toBe(JSON.stringify(tl2.steps));
      expect(JSON.stringify(tl1.events)).toBe(JSON.stringify(tl2.events));
      const lm = await ledgerMilli(rig, ct.id);
      expect((tl1.steps as any[]).reduce((s, x) => s + x.costMilli, 0)).toBe(lm.total);
      expect(Math.round(done.totalCost * 1000)).toBe(lm.total);

      // 跨空间：另一用户（自带新空间）取本任务 timeline → 404
      const reg = await fetch(rig.base + '/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'g04-other@test.local',
          password: 'OtherPass123!',
          displayName: '另一个老板',
        }),
      });
      const regJson: any = await reg.json();
      expect(regJson.ok).toBe(true);
      const otherCookie = (reg.headers.get('set-cookie') || '').split(';')[0];
      expect(otherCookie).toContain('swarm_session=');
      const cross = await rawGet(rig.base, `/api/tasks/${ct.id}/timeline`, otherCookie);
      expect(cross.status).toBe(404);
      // 本空间不存在的任务同样 404（不泄露存在性差异）
      const missing = await rawGet(rig.base, '/api/tasks/task_不存在/timeline', COOKIE);
      expect(missing.status).toBe(404);
    } finally {
      stopRig(rig);
    }
  });
});
