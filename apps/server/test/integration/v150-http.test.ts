import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * v1.5.0 HTTP 全链集成测试（真实服务器 + 本地 GitHub 桩 + 本地计划桩 LLM）：
 * A 平台知识呈现/权限；E 搜索测试；L 公告范围过滤/线程隔离/未读计数；
 * K 导入→上架→推送→用户端徽标+幂等；D 审核中心批量（驳回原因必填）；
 * C 同步走流水线（run 记录+看板）；M 403 隔离/未配置 API 明确报错/计划执行/audit 关联。
 */
const SERVER_DIR = process.cwd();
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MIT_TEXT = 'MIT License\n\nCopyright (c) 2026 Test\n\nPermission is hereby granted, free of charge, to any person obtaining a copy';
const AGENT_PLAIN = `---
name: Plain Helper
description: 普通人设智能体。
---

# Plain Helper

认真完成被分配的工作，产出清晰可靠。
`;
const SKILL_MD = `---
name: 标题工场
description: 按钩子公式批量产出标题。
role: 文案
---

# 标题工场

先给结论型标题，再给悬念型，各 5 条。
`;

interface Rig {
  base: string;
  procs: ChildProcess[];
  dataDir: string;
  adminCookie: string;
  stubs: http.Server[];
}

function startGithubStub(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const p = decodeURIComponent(url.pathname);
    const send = (code: number, body: string, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(body);
    };
    if (p === '/repos/owner/agents') return send(200, JSON.stringify({ stargazers_count: 999, pushed_at: new Date().toISOString() }));
    if (p === '/repos/owner/agents/commits/main') return send(200, JSON.stringify({ sha: 'cafe1234beef' }));
    if (p === '/repos/owner/agents/git/trees/main') {
      return send(200, JSON.stringify({ tree: [{ path: 'marketing/plain.md', type: 'blob' }] }));
    }
    if (p === '/owner/agents/main/LICENSE') return send(200, MIT_TEXT, 'text/plain');
    if (p === '/owner/agents/main/divisions.json') return send(200, JSON.stringify({ divisions: { marketing: {} } }));
    if (p === '/owner/agents/main/marketing/plain.md') return send(200, AGENT_PLAIN, 'text/plain');
    if (p === '/repos/owner/skills') return send(200, JSON.stringify({ owner: { login: 'owner' } }));
    if (p === '/repos/owner/skills/git/trees/main') {
      return send(200, JSON.stringify({ tree: [{ path: 'writing/SKILL.md', type: 'blob' }] }));
    }
    if (p === '/owner/skills/main/LICENSE') return send(200, MIT_TEXT, 'text/plain');
    if (p === '/owner/skills/main/writing/SKILL.md') return send(200, SKILL_MD, 'text/plain');
    return send(404, JSON.stringify({ message: 'Not Found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

/** 计划桩：OpenAI 兼容端点，无论问什么都回「查待审积压」的合法计划 */
function startPlanStub(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const plan = JSON.stringify({ steps: [{ op: 'get_pending_summary', params: {} }] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: plan } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

async function waitUp(url: string, timeout = 25_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* 继续等 */ }
    await sleep(300);
  }
  return false;
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
async function raw(base: string, p: string, method: string, cookie: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(base + p, {
    method,
    headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function loginAdmin(base: string): Promise<string> {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: '<MASKED_SECRET_001>!' }),
  });
  expect((await r.json()).ok).toBe(true);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const r2 = await fetch(base + '/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ currentPassword: '<MASKED_SECRET_001>!', newPassword: '<MASKED_SECRET_002>!' }),
  });
  expect((await r2.json()).ok).toBe(true);
  return cookie;
}

async function registerUser(base: string, email: string, displayName: string, workspaceName: string): Promise<{ cookie: string; userId: string; workspaceId: string }> {
  const r = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: '<MASKED_SECRET_003>!', displayName, workspaceName }),
  });
  const j: any = await r.json();
  expect(j.ok).toBe(true);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const me = await jget(base, '/api/auth/me', cookie);
  return { cookie, userId: me.user.id, workspaceId: me.workspace.id };
}

let rig: Rig;
let planStubPort = 0;
let userA: { cookie: string; userId: string; workspaceId: string };
let userB: { cookie: string; userId: string; workspaceId: string };

beforeAll(async () => {
  const gh = await startGithubStub();
  const ps = await startPlanStub();
  planStubPort = ps.port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v150-http-'));
  const mock = spawn('node', [MOCK], {
    env: { ...process.env, MOCK_PORT: '9081', MOCK_REVIEW_MODE: 'pass' },
    stdio: 'pipe',
    detached: true,
  });
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: '9071',
      DATA_DIR: dataDir,
      LLM_RETRY_BASE_MS: '10',
      SWARM_ADMIN_EMAIL: 'admin@test.local',
      SWARM_ADMIN_PASSWORD: '<MASKED_SECRET_001>!',
      AGENT_SYNC_GITHUB_API: `http://127.0.0.1:${gh.port}`,
      AGENT_SYNC_GITHUB_RAW: `http://127.0.0.1:${gh.port}`,
    },
    stdio: 'pipe',
    detached: true,
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  rig = { base: 'http://127.0.0.1:9071', procs: [mock, server], dataDir, adminCookie: '', stubs: [gh.server, ps.server] };
  expect(await waitUp('http://127.0.0.1:9081/__counts')).toBe(true);
  expect(await waitUp(rig.base + '/api/health')).toBe(true);
  rig.adminCookie = await loginAdmin(rig.base);
  userA = await registerUser(rig.base, 'v150-a@test.local', '用户甲', '甲空间');
  userB = await registerUser(rig.base, 'v150-b@test.local', '用户乙', '乙空间');
}, 120_000);

afterAll(() => {
  for (const p of rig.procs) {
    try {
      if (p.pid) process.kill(-p.pid, 'SIGKILL');
    } catch {
      try { p.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }
  for (const s of rig.stubs) {
    try { s.close(); } catch { /* 忽略 */ }
  }
  try { fs.rmSync(rig.dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('A 平台知识（HTTP）', () => {
  it('用户端 KB 含 platform 分组种子；非管理员建 platform 条目 403', async () => {
    const kb = await jget(rig.base, '/api/kb', userA.cookie);
    const platform = (kb.entries as any[]).filter((e) => e.scope === 'platform');
    expect(platform.length).toBeGreaterThanOrEqual(9);
    const r = await raw(rig.base, '/api/kb', 'POST', userA.cookie, {
      title: '越权平台条目', body: 'x', scope: 'platform', tags: [],
    });
    expect(r.status).toBe(403);
  });

  it('管理台平台知识列表带注入计数', async () => {
    const j = await jget(rig.base, '/api/admin/platform-kb', rig.adminCookie);
    expect(j.entries.length).toBeGreaterThanOrEqual(9);
    expect(typeof j.entries[0].injectedCount).toBe('number');
  });
});

describe('E 搜索测试（HTTP）', () => {
  it('一句话命中平台条目并带排序档', async () => {
    const j = await jpost(rig.base, '/api/kb/search-test', { query: '我要发单，写法有什么规范' }, userA.cookie);
    expect(j.ok).toBe(true);
    const titles = (j.hits as any[]).map((h) => h.title);
    expect(titles.some((t: string) => t.includes('发单写法规范'))).toBe(true);
    expect((j.hits as any[])[0].rankLabel).toContain('平台');
  });
});

describe('L 公告与线程（HTTP）', () => {
  it('公告范围过滤：选定甲空间，乙空间不可见', async () => {
    const pub = await jpost(rig.base, '/api/admin/announcements', {
      title: '仅甲可见', body: '只给甲空间', scope: 'selected', workspaceIds: [userA.workspaceId],
    }, rig.adminCookie);
    expect(pub.ok).toBe(true);
    expect(pub.reached).toBe(1);
    const forA = await jget(rig.base, '/api/announcements', userA.cookie);
    expect((forA.announcements as any[]).some((a) => a.title === '仅甲可见')).toBe(true);
    const forB = await jget(rig.base, '/api/announcements', userB.cookie);
    expect((forB.announcements as any[]).some((a) => a.title === '仅甲可见')).toBe(false);
  });

  it('线程双向 + 隔离 + 未读计数', async () => {
    await jpost(rig.base, `/api/admin/threads/${userA.workspaceId}/messages`, { body: '给甲的第一条' }, rig.adminCookie);
    await jpost(rig.base, `/api/admin/threads/${userB.workspaceId}/messages`, { body: '给乙的专属消息' }, rig.adminCookie);
    const tA = await jget(rig.base, '/api/messages/thread', userA.cookie);
    expect(tA.unread).toBe(1);
    expect((tA.messages as any[]).some((m) => m.body === '给甲的第一条')).toBe(true);
    // 隔离：甲看不到乙的专属消息
    expect((tA.messages as any[]).some((m) => m.body === '给乙的专属消息')).toBe(false);
    // 甲回复 → 管理台收件箱甲线程未读 +1
    await jpost(rig.base, '/api/messages/thread/messages', { body: '甲回复了' }, userA.cookie);
    const inbox = await jget(rig.base, '/api/admin/threads', rig.adminCookie);
    const rowA = (inbox.threads as any[]).find((t) => t.workspaceId === userA.workspaceId);
    expect(rowA.unread).toBe(1);
    // 管理员续回
    await jpost(rig.base, `/api/admin/threads/${userA.workspaceId}/messages`, { body: '管理员续回' }, rig.adminCookie);
    const tA2 = await jget(rig.base, '/api/messages/thread', userA.cookie);
    expect((tA2.messages as any[]).map((m) => m.body)).toContain('管理员续回');
  });
});

describe('C 同步流水线（HTTP）', () => {
  let templateId = '';
  it('手动同步走流水线：计数 + runId；看板有该源', async () => {
    await jpost(rig.base, '/api/admin/agent-sources', {
      sources: [{ id: 'stub-agents', repo: 'owner/agents', branch: 'main', license: 'MIT', author: 'Tester' }],
    }, rig.adminCookie);
    const r = await jpost(rig.base, '/api/admin/agent-sync', { sourceId: 'stub-agents' }, rig.adminCookie);
    expect(r.ok).toBe(true);
    expect(r.created).toBe(1);
    expect(typeof r.runId).toBe('string');
    const board = await jget(rig.base, '/api/admin/agent-sync-runs', rig.adminCookie);
    const row = (board.board as any[]).find((b) => b.sourceId === 'stub-agents');
    expect(row).toBeTruthy();
    expect(row.pendingCount).toBe(1);
    expect(board.runs[0].sourceCommit).toBe('cafe1234beef');
    const adminTpl = await jget(rig.base, '/api/admin/agent-templates', rig.adminCookie);
    templateId = (adminTpl.templates as any[])[0].id;
  });

  it('D 审核中心：聚合出智能体待审、驳回缺原因 400、批量通过后用户端可见且本月上新', async () => {
    const center = await jget(rig.base, '/api/admin/review-center', rig.adminCookie);
    const item = (center.items as any[]).find((i) => i.type === 'agent' && i.id === templateId);
    expect(item).toBeTruthy();
    const bad = await raw(rig.base, '/api/admin/review-center/batch', 'POST', rig.adminCookie, {
      action: 'reject', items: [{ type: 'agent', id: templateId }],
    });
    expect(bad.status).toBe(400);
    const ok = await jpost(rig.base, '/api/admin/review-center/batch', {
      action: 'approve', items: [{ type: 'agent', id: templateId }],
    }, rig.adminCookie);
    expect(ok.results[0].ok).toBe(true);
    const talents = await jget(rig.base, '/api/agent-templates', userA.cookie);
    const t = (talents.templates as any[]).find((x) => x.id === templateId);
    expect(t).toBeTruthy();
    expect(t.isNewThisMonth).toBe(true);
    expect(t.lastSyncAt).toBeTruthy();
  });
});

describe('K 技能下发（HTTP）', () => {
  let skillId = '';
  it('导入 → 上架 → 推送甲空间 → 甲技能库带平台下发徽标；重复推送幂等', async () => {
    const imp = await jpost(rig.base, '/api/admin/skill-imports', { repoUrl: 'https://github.com/owner/skills' }, rig.adminCookie);
    expect(imp.record.status).toBe('imported');
    expect(imp.createdSkillIds).toHaveLength(1);
    skillId = imp.createdSkillIds[0];
    await jpost(rig.base, `/api/admin/skills/${skillId}/publish`, {}, rig.adminCookie);
    const push1 = await jpost(rig.base, `/api/admin/skills/${skillId}/push`, { workspaceIds: [userA.workspaceId] }, rig.adminCookie);
    expect(push1.installed).toBe(1);
    const skillsA = await jget(rig.base, '/api/skills', userA.cookie);
    const copy = (skillsA.skills as any[]).find((s) => s.sourceSkillId === skillId);
    expect(copy).toBeTruthy();
    expect(copy.platformPushed).toBe(true);
    expect(copy.sourceRepo).toBe('owner/skills');
    // 甲线程里有下发说明
    const th = await jget(rig.base, '/api/messages/thread', userA.cookie);
    expect((th.messages as any[]).some((m) => m.kind === 'skill_push' && m.body.includes('标题工场'))).toBe(true);
    const push2 = await jpost(rig.base, `/api/admin/skills/${skillId}/push`, { workspaceIds: [userA.workspaceId] }, rig.adminCookie);
    expect(push2.skipped).toBe(1);
  });
});

describe('M AI 运营官（HTTP）', () => {
  it('权限隔离：普通用户调运营端点 403', async () => {
    const r = await raw(rig.base, '/api/admin/ai-ops/plan', 'POST', userA.cookie, { instruction: '查积压' });
    expect(r.status).toBe(403);
  });

  it('未配置平台 API：管理员生成计划得到明确错误（不静默失败）', async () => {
    const r = await raw(rig.base, '/api/admin/ai-ops/plan', 'POST', rig.adminCookie, { instruction: '现在有多少待审积压' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toContain('平台级 API');
  });

  it('配平台 API 后：计划→执行→报告真实计数；audit 落库关联 run', async () => {
    const save = await jpost(rig.base, '/api/admin/trial-api', {
      api: {
        name: '计划桩', provider: 'custom', baseUrl: `http://127.0.0.1:${planStubPort}/v1`,
        model: 'stub-model', pricePerM: 0, apiKey: 'stub-key',
      },
    }, rig.adminCookie);
    expect(save.ok).toBe(true);
    const planned = await jpost(rig.base, '/api/admin/ai-ops/plan', { instruction: '现在有多少待审积压，分别是什么' }, rig.adminCookie);
    expect(planned.ok).toBe(true);
    expect(planned.run.steps).toHaveLength(1);
    expect(planned.run.steps[0].op).toBe('get_pending_summary');
    const exec = await jpost(rig.base, `/api/admin/ai-ops/runs/${planned.run.id}/execute`, {}, rig.adminCookie);
    expect(exec.run.status).toBe('done');
    expect(exec.run.steps[0].summary).toContain('待审积压');
    // audit 关联：直查 DB 的 audit_logs（测试侧取证，非业务写入）
    const dbPath = path.join(rig.dataDir, 'swarm.db');
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT action, detail FROM audit_logs WHERE action LIKE 'ai_ops%'")
        .all() as Array<{ action: string; detail: string }>;
      expect(rows.some((r) => r.action === 'ai_ops_get_pending_summary' && r.detail.includes(planned.run.id))).toBe(true);
    } finally {
      db.close();
    }
  });
});
