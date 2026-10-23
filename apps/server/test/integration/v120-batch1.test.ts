import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db';
import { Repos } from '../../src/store/repositories';

/**
 * v1.2.0 批次一集成测试（G-02 / G-03 站内 / G-05 / G-08）：
 * - G-02：新用户选短剧包建空间 → capabilities 货架数据 → onboarding 偏好（跳过/推进，用户×空间）
 *   → 以官方 skill example_input 走体验额度 dispatch 首单（真任务真记账）→ step 推进 →
 *   体验额度耗尽后 trial_exhausted 通知（兼 G-03 既有提醒回归）。
 * - G-03：待裁决通知出现/已读/read-all、偏好关停 adjudication 后不再落库、重开恢复；
 *   balance / reject_max 既有提醒回归；分页与 type 过滤（仓储级 25 条 + HTTP 形状）。
 * - G-05：反馈落库 + 管理台可见、非管理员 403、10 分钟第 6 条 VALIDATION、置 handled + audit。
 * - G-08：estimate 退级链（skill/type/workspace/none）与手工计算对账、summary 独立计算对账、
 *   阈值上穿下穿各恰一次（消费跌破 → 采购回升清标记 → 再消费跌破再发一条）。
 * 另含存量库升级对账：001–008 库直接升级 009 后旧数据完好、feedback 可用。
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
  adminCookie: string;
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

async function loginAdmin(base: string): Promise<string> {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: '<MASKED_SECRET_001>!' }),
  });
  const j: any = await r.json();
  expect(j.ok).toBe(true);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const r2 = await fetch(base + '/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ currentPassword: '<MASKED_SECRET_001>!', newPassword: '<MASKED_SECRET_002>!' }),
  });
  expect((await r2.json()).ok).toBe(true);
  return cookie;
}

async function startRig(serverPort: number, mockPort: number, reviewMode: string): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v120b1-'));
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
    adminCookie: '',
  };
  expect(await waitUp(rig.mockBase + '/__counts')).toBe(true);
  expect(await waitUp(rig.base + '/api/health')).toBe(true);
  rig.adminCookie = await loginAdmin(rig.base);
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

async function jget(base: string, p: string, cookie: string): Promise<any> {
  const r = await fetch(base + p, { headers: { cookie } });
  return r.json();
}
async function jpost(base: string, p: string, body: unknown, cookie: string): Promise<any> {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}
async function jput(base: string, p: string, body: unknown, cookie: string): Promise<any> {
  const r = await fetch(base + p, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}
async function rawPost(
  base: string,
  p: string,
  body: unknown,
  cookie: string,
): Promise<{ status: number; json: any }> {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function rawGet(base: string, p: string, cookie: string): Promise<{ status: number; json: any }> {
  const r = await fetch(base + p, { headers: { cookie } });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function waitFor<T>(fn: () => Promise<T | null>, timeout = 45_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error('waitFor 超时');
}

/** 把当前空间第一条 API 改到 mock 并（可选）采购；返回 { apiId, teamId } */
async function configureMock(
  rig: Rig,
  cookie: string,
  opts: { purchaseYuan?: number; pricePerM?: number } = {},
): Promise<{ apiId: string; teamId: string }> {
  const st = await jget(rig.base, '/api/state', cookie);
  const apiId = st.apis[0].id as string;
  const teamId = st.teams[0].id as string;
  const sv = await jpost(
    rig.base,
    '/api/apis/save',
    {
      api: {
        id: apiId,
        name: 'Mock API',
        provider: 'custom',
        baseUrl: rig.mockBase,
        model: 'mock-model',
        pricePerM: opts.pricePerM ?? 10,
        apiKey: 'fake-key-123',
      },
    },
    cookie,
  );
  expect(sv.ok).toBe(true);
  if (opts.purchaseYuan) {
    const pu = await jpost(rig.base, '/api/purchase', { apiId, amountYuan: opts.purchaseYuan }, cookie);
    expect(pu.ok).toBe(true);
  }
  const ts = await jpost(
    rig.base,
    '/api/teams/save',
    { team: { id: teamId, name: st.teams[0].name, color: '#e2574c', apiId } },
    cookie,
  );
  expect(ts.ok).toBe(true);
  return { apiId, teamId };
}

async function taskById(rig: Rig, cookie: string, taskId: string): Promise<any> {
  const st = await jget(rig.base, '/api/state', cookie);
  return st.tasks.find((t: any) => t.id === taskId);
}
async function waitStatus(rig: Rig, cookie: string, taskId: string, status: string): Promise<any> {
  return waitFor(async () => {
    const t = await taskById(rig, cookie, taskId);
    return t && t.status === status ? t : null;
  });
}

/* ================= G-02 新手端到端 + G-05 反馈 + trial 提醒回归 ================= */
describe('G-02 验收①②③：选短剧包建空间 → 三步卡偏好 → 体验额度 dispatch 首单', () => {
  it('capabilities 货架、onboarding 跳过/推进、首单快照与 ledger 记账、trial_exhausted 回归', async () => {
    const rig = await startRig(8914, 8924, 'pass');
    try {
      const admin = rig.adminCookie;
      // 平台体验 API 指向 mock（单价拉高：一单约 ¥30，两次调用各 150 token × ¥100000/M）
      const trialSave = await jpost(
        rig.base,
        '/api/admin/trial-api',
        {
          api: {
            name: '平台体验 API',
            provider: 'custom',
            baseUrl: rig.mockBase,
            model: 'mock-model',
            pricePerM: 100000,
            apiKey: 'fake-trial-key',
          },
        },
        admin,
      );
      expect(trialSave.ok).toBe(true);

      // 新用户注册并选短剧包建空间
      const reg = await fetch(rig.base + '/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'g02-user@test.local',
          password: 'UserPass123!',
          displayName: '短剧老板',
          industryPackId: 'pack_short_drama',
          workspaceName: 'G02 短剧公司',
        }),
      });
      const regJson: any = await reg.json();
      expect(regJson.ok).toBe(true);
      expect(regJson.pending).toBe(false);
      const uCookie = (reg.headers.get('set-cookie') || '').split(';')[0];
      const wsId = regJson.workspace.id as string;

      // 管理员发体验额度 ¥5（一次性）
      const grant = await jpost(
        rig.base,
        '/api/admin/trial-grants',
        { workspaceId: wsId, amountYuan: 5 },
        admin,
      );
      expect(grant.ok).toBe(true);

      const st = await jget(rig.base, '/api/state', uCookie);
      // 断言③（后端数据）：成员卡数 = 空间成员数、工种名取注册表、推荐位 6 个官方 skill 且已装（行业包装入）
      expect(st.capabilities).toBeTruthy();
      expect(st.capabilities.members.length).toBe(st.members.length);
      expect(st.capabilities.members.length).toBeGreaterThan(0);
      expect(st.capabilities.members.every((m: any) => m.roleName && m.roleName.length > 0)).toBe(true);
      expect(st.capabilities.recommendedSkills.length).toBe(6);
      expect(st.capabilities.recommendedSkills.every((s: any) => s.installed)).toBe(true);

      // 断言③另一半：无行业包空间推荐位只出已装项（§12.5 零行业词口径，见 routes 衔接注释；
      // 管理员默认空间 ws_default 存量挂短剧包，不作此断言对象，另注册无包用户验证）；
      // 从平台库安装后，推荐位出现该 skill 且 installed=true（前端据此切换「安装/发一单」按钮）
      const reg2 = await fetch(rig.base + '/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'g02-plain@test.local',
          password: 'PlainPass123!',
          displayName: '通用老板',
        }),
      });
      const reg2Json: any = await reg2.json();
      expect(reg2Json.ok).toBe(true);
      const plainCookie = (reg2.headers.get('set-cookie') || '').split(';')[0];
      const plainSt = await jget(rig.base, '/api/state', plainCookie);
      expect(plainSt.capabilities.recommendedSkills.length).toBe(0);
      expect(JSON.stringify(plainSt)).not.toContain('短剧');
      const plainSkills = await jget(rig.base, '/api/skills', plainCookie);
      const rec0 = (plainSkills.skills as any[]).find((s) => s.slug === 'viral-title');
      expect(rec0).toBeTruthy();
      const inst = await jpost(rig.base, `/api/skills/${rec0.id}/install`, {}, plainCookie);
      expect(inst.ok).toBe(true);
      const plainSt2 = await jget(rig.base, '/api/state', plainCookie);
      const rec0b = plainSt2.capabilities.recommendedSkills.find((s: any) => s.skillId === rec0.id);
      expect(rec0b).toBeTruthy();
      expect(rec0b.installed).toBe(true);
      expect(rec0b.installedCopyId).toBeTruthy();

      // 断言①：onboarding 初始无记录 → 前端默认 step=0；点「跳过」= PUT skipped=true 落 preferences
      const prefs0 = await jget(rig.base, '/api/preferences', uCookie);
      expect(prefs0.preferences.onboarding?.[wsId]).toBeUndefined();
      const skip = await jput(
        rig.base,
        '/api/preferences',
        { key: 'onboarding', value: { [wsId]: { step: 0, skipped: true, doneAt: null } } },
        uCookie,
      );
      expect(skip.ok).toBe(true);
      const prefs1 = await jget(rig.base, '/api/preferences', uCookie);
      expect(prefs1.preferences.onboarding[wsId].skipped).toBe(true);
      // 用户 × 空间维度：管理员空间的 onboarding 互不影响（独立键）
      expect(prefs1.preferences.onboarding[reg2Json.workspace.id]).toBeUndefined();
      // 重置回 step=0 继续端到端
      await jput(
        rig.base,
        '/api/preferences',
        { key: 'onboarding', value: { [wsId]: { step: 0, skipped: false, doneAt: null } } },
        uCookie,
      );

      // 断言②：①完成 → step=1；以官方 skill example_input dispatch 首单（走体验额度）
      await jput(
        rig.base,
        '/api/preferences',
        { key: 'onboarding', value: { [wsId]: { step: 1, skipped: false, doneAt: null } } },
        uCookie,
      );
      const skills = await jget(rig.base, '/api/skills', uCookie);
      const copy = (skills.skills as any[]).find(
        (s) => s.workspaceId === wsId && s.slug === 'viral-title',
      );
      expect(copy).toBeTruthy();
      const teamId = st.teams[0].id as string;
      const disp = await jpost(
        rig.base,
        `/api/skills/${copy.id}/dispatch`,
        { params: copy.exampleInput, teamId },
        uCookie,
      );
      expect(disp.ok).toBe(true);
      const taskId = disp.id as string;
      const created = await taskById(rig, uCookie, taskId);
      expect(created.skillId).toBe(copy.id);
      expect(created.skillParams).toEqual(copy.exampleInput);
      expect(created.isSkillTest).toBeFalsy();
      // step 自动推进到 2（前端事件驱动写 preferences，此处按同一口径落）
      await jput(
        rig.base,
        '/api/preferences',
        { key: 'onboarding', value: { [wsId]: { step: 2, skipped: false, doneAt: null } } },
        uCookie,
      );
      const prefs2 = await jget(rig.base, '/api/preferences', uCookie);
      expect(prefs2.preferences.onboarding[wsId].step).toBe(2);

      // 任务跑完（体验额度记账）：ledger 有该任务行且成本 > 0；③ 成果库可达对应成果
      const done = await waitStatus(rig, uCookie, taskId, '已完成');
      expect(done).toBeTruthy();
      const st2 = await jget(rig.base, '/api/state', uCookie);
      const rows = st2.ledger.filter((l: any) => l.taskId === taskId);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.reduce((s: number, l: any) => s + l.costYuan, 0)).toBeGreaterThan(0);
      const results = await jget(rig.base, '/api/results', uCookie);
      expect((results.results as any[]).some((r) => r.taskId === taskId)).toBe(true);

      // G-03 断言④（trial 分型回归）：体验额度已被首单耗尽（¥5 发放、约 ¥30 消耗），
      // 再发一单 → 停工且所有者收到 trial_exhausted 通知（文案分型与既有口径一致）
      const disp2 = await jpost(
        rig.base,
        `/api/skills/${copy.id}/dispatch`,
        { params: copy.exampleInput, teamId },
        uCookie,
      );
      expect(disp2.ok).toBe(true);
      await waitFor(async () => {
        const n = await jget(rig.base, '/api/notifications?type=trial_exhausted', uCookie);
        return (n.notifications as any[]).some((x) => x.taskId === disp2.id) ? n : null;
      });

      /* ---------- G-05 反馈（同 rig 续跑） ---------- */
      const fb = await jpost(
        rig.base,
        '/api/feedback',
        { category: 'suggestion', content: 'G05 反馈内容：希望能批量导出成果', contact: 'g02@test.local' },
        uCookie,
      );
      expect(fb.ok).toBe(true);
      // 非管理员读管理台反馈 → 403
      const forbidden = await rawGet(rig.base, '/api/admin/feedback', uCookie);
      expect(forbidden.status).toBe(403);
      // 管理台列表可见（含分类与原文）
      const list = await jget(rig.base, '/api/admin/feedback', admin);
      const mine = (list.feedback as any[]).find((f) => f.id === fb.id);
      expect(mine).toBeTruthy();
      expect(mine.category).toBe('suggestion');
      expect(mine.content).toContain('批量导出成果');
      expect(mine.status).toBe('open');
      // 频率限制：同用户 10 分钟内第 6 条 → VALIDATION（已提交 1 条，再补 4 条，第 6 条被拒）
      for (let k = 0; k < 4; k++) {
        const more = await jpost(
          rig.base,
          '/api/feedback',
          { category: 'other', content: `G05 补条 ${k}` },
          uCookie,
        );
        expect(more.ok).toBe(true);
      }
      const sixth = await rawPost(
        rig.base,
        '/api/feedback',
        { category: 'other', content: 'G05 第六条应被限流' },
        uCookie,
      );
      expect(sixth.status).toBe(400);
      expect(sixth.json.error.code).toBe('VALIDATION');
      // 管理员置 handled → status/handled_at 落库 + audit 一条（台账可见）
      const handled = await jpost(
        rig.base,
        `/api/admin/feedback/${fb.id}/handle`,
        { adminNote: '已记录进需求池' },
        admin,
      );
      expect(handled.ok).toBe(true);
      expect(handled.feedback.status).toBe('handled');
      expect(handled.feedback.handledAt).toBeTruthy();
      expect(handled.feedback.adminNote).toBe('已记录进需求池');
      const ledgerView = await jget(rig.base, '/api/ledger-view', admin);
      expect(
        (ledgerView.timeline as any[]).some(
          (x) => x.kind === 'audit' && String(x.text).includes('handle_feedback'),
        ),
      ).toBe(true);
    } finally {
      stopRig(rig);
    }
  });
});

/* ================= G-03 通知中心：已读/read-all、偏好关停、既有提醒回归 ================= */
describe('G-03 验收①②④：待裁决通知全流程 + 偏好关停实测 + balance/reject_max 回归', () => {
  it('balance 停工通知 → 充值后打回满次/待裁决通知 → 已读回落 → 关偏好不再落库 → 重开恢复', async () => {
    const rig = await startRig(8915, 8925, 'fail-always');
    try {
      const admin = rig.adminCookie;
      const { teamId } = await configureMock(rig, admin, { purchaseYuan: 0 });

      // 余额为 0 时发单 → 停工 + balance 通知（断言④回归之一）
      const t0 = await jpost(
        rig.base,
        '/api/tasks',
        { title: 'G03 余额单', type: '文案', brief: '写标题', teamId },
        admin,
      );
      expect(t0.ok).toBe(true);
      await waitFor(async () => {
        const n = await jget(rig.base, '/api/notifications?type=balance', admin);
        return (n.notifications as any[]).some((x) => x.taskId === t0.id) ? n : null;
      });

      // 充值后 T0 自动开工，fail-always → 打回满次转待裁决 + reject_max 通知（断言④回归之二）
      const st = await jget(rig.base, '/api/state', admin);
      await jpost(rig.base, '/api/purchase', { apiId: st.apis[0].id, amountYuan: 100 }, admin);
      await waitStatus(rig, admin, t0.id, '待裁决');
      const rj = await jget(rig.base, '/api/notifications?type=reject_max', admin);
      expect(rj.total).toBe(1);
      expect((rj.notifications as any[])[0].taskId).toBe(t0.id);

      // adjudication 型通知走预算超限转裁决路径（toAdjudication）：设单任务预算 100 token（单次执行 150 必超）
      const prm = await jpost(
        rig.base,
        '/api/settings/params',
        { concurrency: 4, taskBudgetTokens: 100 },
        admin,
      );
      expect(prm.ok).toBe(true);
      const tA = await jpost(
        rig.base,
        '/api/tasks',
        { title: 'G03 预算裁决单', type: '文案', brief: '写标题', teamId },
        admin,
      );
      await waitStatus(rig, admin, tA.id, '待裁决');
      const adj1 = await jget(rig.base, '/api/notifications?type=adjudication', admin);
      expect(adj1.total).toBe(1);
      expect((adj1.notifications as any[])[0].taskId).toBe(tA.id);

      // 断言①：未读数 → 单条已读回落 → read-all 归零
      const all1 = await jget(rig.base, '/api/notifications', admin);
      expect(all1.unread).toBeGreaterThanOrEqual(3);
      const first = (all1.notifications as any[])[0];
      const rd = await jpost(rig.base, `/api/notifications/${first.id}/read`, {}, admin);
      expect(rd.unread).toBe(all1.unread - 1);
      const rdAll = await jpost(rig.base, '/api/notifications/read-all', {}, admin);
      expect(rdAll.unread).toBe(0);
      const all2 = await jget(rig.base, '/api/notifications', admin);
      expect(all2.unread).toBe(0);

      // 断言②：关掉 adjudication 站内开关 → 新待裁决不再落通知
      const pref = await jput(
        rig.base,
        '/api/preferences',
        { key: 'notifyPrefs', value: { inapp: { adjudication: false } } },
        admin,
      );
      expect(pref.ok).toBe(true);
      const t1 = await jpost(
        rig.base,
        '/api/tasks',
        { title: 'G03 关偏好单', type: '文案', brief: '写标题', teamId },
        admin,
      );
      await waitStatus(rig, admin, t1.id, '待裁决');
      const adj2 = await jget(rig.base, '/api/notifications?type=adjudication', admin);
      expect(adj2.total).toBe(1); // 没有新增行

      // 重开后恢复：再一单待裁决 → adjudication 总数变 2
      await jput(
        rig.base,
        '/api/preferences',
        { key: 'notifyPrefs', value: { inapp: { adjudication: true } } },
        admin,
      );
      const t2 = await jpost(
        rig.base,
        '/api/tasks',
        { title: 'G03 重开偏好单', type: '文案', brief: '写标题', teamId },
        admin,
      );
      await waitStatus(rig, admin, t2.id, '待裁决');
      await waitFor(async () => {
        const n = await jget(rig.base, '/api/notifications?type=adjudication', admin);
        return n.total === 2 ? n : null;
      });
    } finally {
      stopRig(rig);
    }
  });
});

/* ================= G-03 分页（仓储级）+ 存量库升级 009 对账 ================= */
describe('G-03 验收③：分页与 type 过滤（25 条）+ G-05 迁移 009 升级对账', () => {
  it('page=2 返回剩余且总数正确；type 过滤计数正确', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v120b1-page-'));
    const db = openDb(path.join(dir, 'swarm.db'));
    try {
      const repos = new Repos(db);
      for (let k = 0; k < 25; k++) {
        repos.insertNotification({
          workspace_id: 'ws_default',
          user_id: null,
          type: k % 2 === 0 ? 'adjudication' : 'balance',
          title: `分页通知 ${k}`,
          body: '',
          task_id: null,
          read_at: null,
          created_at: new Date(Date.now() + k).toISOString(),
        });
      }
      const p1 = repos.listNotificationsPaged('ws_default', { page: 1, pageSize: 20 });
      expect(p1.total).toBe(25);
      expect(p1.rows.length).toBe(20);
      const p2 = repos.listNotificationsPaged('ws_default', { page: 2, pageSize: 20 });
      expect(p2.total).toBe(25);
      expect(p2.rows.length).toBe(5);
      const ids = new Set([...p1.rows, ...p2.rows].map((r) => r.id));
      expect(ids.size).toBe(25);
      const filtered = repos.listNotificationsPaged('ws_default', { type: 'adjudication', page: 1, pageSize: 20 });
      expect(filtered.total).toBe(13);
      expect(filtered.rows.every((r) => r.type === 'adjudication')).toBe(true);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('存量库（只应用 001–008）可直接升级 009，旧任务数据完好、feedback 可用', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v120b1-upg-'));
    const dbPath = path.join(dir, 'swarm.db');
    const migDir = path.join(SERVER_DIR, 'src', 'store', 'migrations');
    const raw = new DatabaseSync(dbPath);
    raw.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const f of fs.readdirSync(migDir).filter((x) => /^00[1-8]_/.test(x)).sort()) {
      raw.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
      raw
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(f.replace(/\.sql$/, ''), '2026-10-23T00:00:00.000Z');
    }
    raw
      .prepare(
        `INSERT INTO tasks (id, team_id, title, type, status, created_at, workspace_id)
         VALUES ('task_legacy_b1', 'team_x', '批次一存量任务', '文案', '已完成', '2026-10-23T00:00:00.000Z', 'ws_default')`,
      )
      .run();
    raw.close();

    const db = openDb(dbPath); // 启动迁移：应只补跑 009
    try {
      const versions = (
        db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>
      ).map((r) => r.version);
      expect(versions).toContain('009_feedback');
      const legacy = db.prepare("SELECT title FROM tasks WHERE id = 'task_legacy_b1'").get() as { title: string };
      expect(legacy.title).toBe('批次一存量任务');
      const repos = new Repos(db);
      const id = repos.insertFeedback({
        user_id: 'user_x',
        workspace_id: 'ws_default',
        category: 'bug',
        content: '存量库升级后反馈可用',
        contact: null,
        status: 'open',
        admin_note: null,
        created_at: new Date().toISOString(),
        handled_at: null,
      });
      expect(repos.getFeedback(id)?.content).toContain('存量库升级后反馈可用');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================= G-08 预估 / 摘要 / 阈值预警 ================= */
describe('G-08 验收①②③：estimate 退级链与对账、summary 独立计算、阈值上穿下穿各恰一次', () => {
  it('同 type 10 单预估一致；skill/workspace/none 退级正确；消费跌破恰 1 条、采购回升后再跌破再 1 条', async () => {
    const rig = await startRig(8916, 8926, 'pass');
    try {
      const admin = rig.adminCookie;
      const { teamId } = await configureMock(rig, admin, { purchaseYuan: 100 });

      // 同 type（文案）10 单跑完
      const ids: string[] = [];
      for (let k = 0; k < 10; k++) {
        const ct = await jpost(
          rig.base,
          '/api/tasks',
          { title: `G08 样本单 ${k}`, type: '文案', brief: '写一句文案', teamId },
          admin,
        );
        expect(ct.ok).toBe(true);
        ids.push(ct.id);
      }
      for (const id of ids) await waitStatus(rig, admin, id, '已完成');

      // 独立计算：按 state.ledger 逐任务汇总（厘）
      const perTaskMilli = async (): Promise<number[]> => {
        const st = await jget(rig.base, '/api/state', admin);
        const map = new Map<string, number>();
        for (const l of st.ledger as any[]) {
          map.set(l.taskId, (map.get(l.taskId) ?? 0) + Math.round(l.costYuan * 1000));
        }
        return [...map.values()];
      };
      const costs10 = await perTaskMilli();
      expect(costs10.length).toBe(10);
      const avg10 = Math.round(costs10.reduce((s, c) => s + c, 0) / 10);

      // 断言①：type 预估与手工计算一致（厘级），sampleCount=10、basis='type'
      const est = await jget(rig.base, '/api/cost/estimate?type=文案', admin);
      expect(est.estimate.basis).toBe('type');
      expect(est.estimate.sampleCount).toBe(10);
      expect(est.estimate.avgMilli).toBe(avg10);
      expect(est.estimate.p25Milli).toBe(costs10[0]);
      expect(est.estimate.p75Milli).toBe(costs10[0]);

      // 退级：无样本的 type（代码）→ workspace（全空间均值，样本仍为 10）
      const estWs = await jget(rig.base, '/api/cost/estimate?type=代码', admin);
      expect(estWs.estimate.basis).toBe('workspace');
      expect(estWs.estimate.sampleCount).toBe(10);
      expect(estWs.estimate.avgMilli).toBe(avg10);

      // skill 退级链：同 skill 发 5 单 → basis='skill'、sampleCount=5
      const skills = await jget(rig.base, '/api/skills', admin);
      const official = (skills.skills as any[]).find((s) => s.slug === 'viral-title');
      expect(official).toBeTruthy();
      const inst = await jpost(rig.base, `/api/skills/${official.id}/install`, {}, admin);
      expect(inst.ok).toBe(true);
      const copyId = inst.id as string;
      const copy = (await jget(rig.base, '/api/skills', admin)).skills.find((s: any) => s.id === copyId);
      for (let k = 0; k < 5; k++) {
        const d = await jpost(
          rig.base,
          `/api/skills/${copyId}/dispatch`,
          { params: copy.exampleInput, teamId },
          admin,
        );
        expect(d.ok).toBe(true);
        await waitStatus(rig, admin, d.id, '已完成');
      }
      const estSkill = await jget(rig.base, `/api/cost/estimate?skillId=${copyId}`, admin);
      expect(estSkill.estimate.basis).toBe('skill');
      expect(estSkill.estimate.sampleCount).toBe(5);

      // 无历史空间 → basis='none'
      const reg = await fetch(rig.base + '/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'g08-fresh@test.local',
          password: 'FreshPass123!',
          displayName: '新空间老板',
        }),
      });
      const regJson: any = await reg.json();
      expect(regJson.ok).toBe(true);
      const freshCookie = (reg.headers.get('set-cookie') || '').split(';')[0];
      const estNone = await jget(rig.base, '/api/cost/estimate?type=文案', freshCookie);
      expect(estNone.estimate.basis).toBe('none');
      expect(estNone.estimate.sampleCount).toBe(0);

      // 断言③：summary 与独立计算一致（自有余额 / 单均 / 约可跑单数）
      const stNow = await jget(rig.base, '/api/state', admin);
      const ownMilli = (stNow.apis as any[]).reduce(
        (s, a) => s + Math.round(a.balanceYuan * 1000),
        0,
      );
      const costsAll = await perTaskMilli();
      const avgAll = Math.round(costsAll.reduce((s, c) => s + c, 0) / costsAll.length);
      const report = await jget(rig.base, '/api/cost/report', admin);
      const sum = report.report.summary;
      expect(sum).toBeTruthy();
      expect(sum.balanceMilli).toBe(ownMilli);
      expect(sum.trialBalanceMilli).toBe(0);
      expect(sum.avgCostPerTaskMilli).toBe(avgAll);
      expect(sum.approxTasksRemaining).toBe(Math.floor(ownMilli / avgAll));

      // 断言②：阈值设到余额下 1 厘 → 消费一单跌破 → 恰好 1 条 balance_low；再消费不重复
      const balNow = sum.balanceMilli as number;
      const set1 = await jput(
        rig.base,
        '/api/cost/settings',
        { lowBalanceThresholdYuan: (balNow - 1) / 1000 },
        admin,
      );
      expect(set1.ok).toBe(true);
      const lowCount = async (): Promise<number> => {
        const n = await jget(rig.base, '/api/notifications?type=balance_low', admin);
        return n.total as number;
      };
      expect(await lowCount()).toBe(0);
      const c1 = await jpost(
        rig.base,
        '/api/tasks',
        { title: 'G08 跌破单 1', type: '文案', brief: '写一句文案', teamId },
        admin,
      );
      await waitStatus(rig, admin, c1.id, '已完成');
      expect(await lowCount()).toBe(1);
      const c2 = await jpost(
        rig.base,
        '/api/tasks',
        { title: 'G08 跌破单 2', type: '文案', brief: '写一句文案', teamId },
        admin,
      );
      await waitStatus(rig, admin, c2.id, '已完成');
      expect(await lowCount()).toBe(1); // 继续消费不重复轰炸

      // 采购回阈值上（清标记，不发新通知）→ 阈值重设到新余额下 1 厘 → 再消费跌破 → 再发 1 条
      // 注：先把首条预警标已读——未读去重（G-03 口径）与标记防重复叠加，未读未清时同类不再落新行
      await jpost(rig.base, '/api/notifications/read-all', {}, admin);
      const st2 = await jget(rig.base, '/api/state', admin);
      await jpost(rig.base, '/api/purchase', { apiId: st2.apis[0].id, amountYuan: 1 }, admin);
      expect(await lowCount()).toBe(1);
      const rep2 = await jget(rig.base, '/api/cost/report', admin);
      const bal2 = rep2.report.summary.balanceMilli as number;
      await jput(
        rig.base,
        '/api/cost/settings',
        { lowBalanceThresholdYuan: (bal2 - 1) / 1000 },
        admin,
      );
      const c3 = await jpost(
        rig.base,
        '/api/tasks',
        { title: 'G08 再跌破单', type: '文案', brief: '写一句文案', teamId },
        admin,
      );
      await waitStatus(rig, admin, c3.id, '已完成');
      expect(await lowCount()).toBe(2);
    } finally {
      stopRig(rig);
    }
  });
});
