import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAgencyAgent, suggestRole } from '../../src/domain/parseAgencyAgent';
import {
  getAgentSyncSources,
  syncAgentSource,
  type AgentFetcher,
} from '../../src/domain/agentSyncService';
import { openDb } from '../../src/store/db';
import { Repos } from '../../src/store/repositories';

/**
 * v1.4.0 J 集成测试（GitHub 智能体同步 → 官方人才库）：
 * - 解析：离线跑真 fixture（agency-agents 的 marketing/engineering 两文件），断言
 *   name/specialty/persona/语言/工种映射（词界匹配 + 规则顺序）。
 * - 同步服务：可注入假 fetcher 直测幂等与草稿语义（离线）。
 * - HTTP 全链：本地 GitHub 桩（env 覆盖基址）→ 同步计数/幂等 → 管理员审核（通过带工种覆盖、
 *   首次驳回原因必填、public 后变更只动 draft、复审驳回 draft 回滚）→ 用户列表只见 pub 快照
 *   → 招募生成成员（persona 全文、工种回退、计数+1、跨空间小组 400）→ 非管理员 403 → 整源失败 502。
 */
const SERVER_DIR = process.cwd();
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');
const FIXTURE_DIR = path.join(SERVER_DIR, 'test', 'fixtures', 'agency');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FIXTURE_MARKETING = fs.readFileSync(path.join(FIXTURE_DIR, 'marketing-content-creator.md'), 'utf8');
const FIXTURE_ENGINEERING = fs.readFileSync(path.join(FIXTURE_DIR, 'engineering-software-architect.md'), 'utf8');
const MARKETING_PATH = 'marketing/marketing-content-creator.md';
const ENGINEERING_PATH = 'engineering/engineering-software-architect.md';
const SUPPORT_PATH = 'support/support-helper.md';
const REPO = 'msitarzewski/agency-agents';

/** 中文智能体（support 恢复后用）：验 zh 粗判与 rejected → pending_review 回流 */
const SUPPORT_ZH_V1 = `---
name: 客服小助手
description: 中文客服智能体，负责解答常见问题与工单分流。
---

# 客服小助手

你是一名耐心的中文客服，负责解答用户常见问题、整理工单要点并分流给对应同事。表达礼貌清晰，先确认问题再给方案，遇到不确定的情况如实说明并转人工处理。
`;
const SUPPORT_ZH_V2 = SUPPORT_ZH_V1.replace('耐心的中文客服', '耐心的中文客服（二版）');

/* ================= 解析（离线 fixture） ================= */
describe('J 解析适配器（真 fixture）', () => {
  it('marketing fixture：name/specialty/persona/语言/工种', () => {
    const p = parseAgencyAgent(FIXTURE_MARKETING, MARKETING_PATH);
    expect(p.name).toBe('Content Creator');
    expect(p.specialty).toContain('Expert content strategist and creator');
    expect(p.persona.startsWith('# Marketing Content Creator Agent')).toBe(true);
    expect(p.persona).toContain('## Core Capabilities');
    expect(p.persona).not.toContain('name: Content Creator'); // frontmatter 不进 persona
    expect(p.language).toBe('en');
    // 规则顺序：审核/程序员/研究员均未以词命中（develops 不算 develop），组长规则 strategist 先于文案 content 命中
    expect(p.suggestedRole).toBe('组长');
  });

  it('engineering fixture：architect 以词命中程序员', () => {
    const p = parseAgencyAgent(FIXTURE_ENGINEERING, ENGINEERING_PATH);
    expect(p.name).toBe('Software Architect');
    expect(p.specialty).toContain('Expert software architect');
    expect(p.persona.startsWith('# Software Architect Agent')).toBe(true);
    expect(p.language).toBe('en');
    expect(p.suggestedRole).toBe('程序员');
  });

  it('工种映射顺序与词界：qa 先于 engineer、data analyst 走研究员、纯中文判 zh', () => {
    expect(suggestRole('QA Engineer', 'tests and codes', 'testing')).toBe('审核');
    expect(suggestRole('Data Analyst', 'sql dashboards', 'research')).toBe('研究员');
    expect(suggestRole('Engineering Manager', 'leads the team', 'engineering')).toBe('组长');
    expect(suggestRole('Brand Designer', 'visual identity', 'design')).toBe('文案');
    const zh = parseAgencyAgent(SUPPORT_ZH_V1, SUPPORT_PATH);
    expect(zh.name).toBe('客服小助手');
    expect(zh.language).toBe('zh');
  });

  it('frontmatter 缺失回退：文件名美化 + 正文首段截专长', () => {
    const p = parseAgencyAgent('# Lonely Agent\n\nJust a body paragraph here.', 'design/lonely-agent.md');
    expect(p.name).toBe('Lonely Agent');
    expect(p.specialty).toBe('Just a body paragraph here.');
    expect(p.persona).toContain('Just a body paragraph here.');
  });
});

/* ================= 同步服务（假 fetcher 注入，离线） ================= */
describe('J 同步服务（注入 fetcher）', () => {
  it('白名单种子 + 幂等二刷 + 变更只动 draft', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v140j-svc-'));
    const db = openDb(path.join(dir, 't.db'));
    const repos = new Repos(db);
    try {
      const sources = getAgentSyncSources(repos);
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({ repo: REPO, branch: 'main', license: 'MIT', author: 'AgentLand Contributors' });
      // 种子已落 settings：再读不重复写
      expect(getAgentSyncSources(repos)).toHaveLength(1);

      const files = new Map<string, string>([[MARKETING_PATH, FIXTURE_MARKETING]]);
      const fetcher: AgentFetcher = async (url) => {
        if (url.includes('/git/trees/')) {
          return JSON.stringify({ tree: [{ path: MARKETING_PATH, type: 'blob' }] });
        }
        if (url.endsWith('/divisions.json')) {
          return JSON.stringify({ divisions: { marketing: {} } });
        }
        const p = decodeURIComponent(url.split('/main/')[1] ?? '');
        const c = files.get(p);
        if (c === undefined) throw new Error(`GET ${url} → HTTP 404`);
        return c;
      };
      const src = sources[0];
      const r1 = await syncAgentSource(repos, src, fetcher);
      expect(r1).toEqual({ fetched: 1, created: 1, updated: 0, unchanged: 0, failed: 0 });
      const r2 = await syncAgentSource(repos, src, fetcher);
      expect(r2).toEqual({ fetched: 1, created: 0, updated: 0, unchanged: 1, failed: 0 });

      // 管理员过审后源文件变更：pub 快照不动、has_pending_update=1
      const row = repos.getAgentTemplateBySource(REPO, MARKETING_PATH)!;
      repos.updateAgentTemplate({
        ...row,
        status: 'public',
        pub_name: row.draft_name,
        pub_specialty: row.draft_specialty,
        pub_persona: row.draft_persona,
        pub_role: row.draft_role,
      });
      files.set(MARKETING_PATH, FIXTURE_MARKETING.replace('Expert content strategist', 'Expert content strategist v2'));
      const r3 = await syncAgentSource(repos, src, fetcher);
      expect(r3).toEqual({ fetched: 1, created: 0, updated: 1, unchanged: 0, failed: 0 });
      const after = repos.getAgentTemplateBySource(REPO, MARKETING_PATH)!;
      expect(after.has_pending_update).toBe(1);
      expect(after.draft_specialty).toContain('v2');
      expect(after.pub_specialty).not.toContain('v2');
      expect(after.pub_persona).toBe(row.draft_persona);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================= HTTP 全链（本地 GitHub 桩） ================= */
interface Rig {
  base: string;
  procs: ChildProcess[];
  dataDir: string;
  adminCookie: string;
  stub: http.Server;
}

const stubFiles = new Map<string, string>([
  [MARKETING_PATH, FIXTURE_MARKETING],
  [ENGINEERING_PATH, FIXTURE_ENGINEERING],
  ['strategy/playbook.md', '# playbook（非 division，不收）'],
  ['game-development/unity/unity-architect.md', '# deep（子目录，不收）'],
  ['README.md', '# readme（根目录，不收）'],
]);
let stubSupportFails = true;

function startStub(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const p = decodeURIComponent(url.pathname);
    const send = (code: number, body: string, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(body);
    };
    const treeM = /^\/repos\/(.+)\/git\/trees\/[^/]+$/.exec(p);
    if (treeM) {
      if (treeM[1] !== REPO) return send(404, JSON.stringify({ message: 'Not Found' }));
      const tree = [...stubFiles.keys(), SUPPORT_PATH].map((x) => ({ path: x, type: 'blob' }));
      return send(200, JSON.stringify({ tree }));
    }
    if (p === `/${REPO}/main/divisions.json`) {
      return send(200, JSON.stringify({ divisions: { marketing: {}, engineering: {}, support: {} } }));
    }
    const rawM = new RegExp(`^/${REPO.replace('/', '\\/')}/main/(.+)$`).exec(p);
    if (rawM) {
      const fp = rawM[1];
      if (fp === SUPPORT_PATH && stubSupportFails) return send(500, 'boom', 'text/plain');
      const c = stubFiles.get(fp);
      if (c === undefined) return send(404, 'not found', 'text/plain');
      return send(200, c, 'text/plain');
    }
    return send(404, 'not found', 'text/plain');
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

async function startRig(serverPort: number, mockPort: number): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v140j-'));
  const stub = await startStub();
  const stubActual = (stub.server.address() as AddressInfo).port;
  const mock = spawn('node', [MOCK], {
    env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_REVIEW_MODE: 'pass' },
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
      AGENT_SYNC_GITHUB_API: `http://127.0.0.1:${stubActual}`,
      AGENT_SYNC_GITHUB_RAW: `http://127.0.0.1:${stubActual}`,
    },
    stdio: 'pipe',
    detached: true,
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  const rig: Rig = { base: `http://127.0.0.1:${serverPort}`, procs: [mock, server], dataDir, adminCookie: '', stub: stub.server };
  expect(await waitUp(`http://127.0.0.1:${mockPort}/__counts`)).toBe(true);
  expect(await waitUp(rig.base + '/api/health')).toBe(true);
  rig.adminCookie = await loginAdmin(rig.base);
  return rig;
}

function stopRig(rig: Rig): void {
  for (const p of rig.procs) {
    try {
      if (p.pid) process.kill(-p.pid, 'SIGKILL');
    } catch {
      try { p.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }
  try { rig.stub.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(rig.dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
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
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function registerUser(base: string, email: string, displayName: string, workspaceName?: string): Promise<{ cookie: string; userId: string; workspaceId: string; teamId: string }> {
  const r = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: '<MASKED_SECRET_005>!', displayName, workspaceName }),
  });
  const j: any = await r.json();
  expect(j.ok).toBe(true);
  expect(j.pending).toBe(false);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const me = await jget(base, '/api/auth/me', cookie);
  const state = await jget(base, '/api/state', cookie);
  return { cookie, userId: me.user.id as string, workspaceId: me.workspace.id as string, teamId: state.teams[0].id as string };
}
function withDb<T>(rig: Rig, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(rig.dataDir, 'swarm.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

let rig: Rig;
let userA: { cookie: string; userId: string; workspaceId: string; teamId: string };
let userB: { cookie: string; userId: string; workspaceId: string; teamId: string };
let marketingId = '';
let engineeringId = '';
let supportId = '';

beforeAll(async () => {
  rig = await startRig(9031, 9041);
  userA = await registerUser(rig.base, 'v140j-a@test.local', '用户甲', '甲空间');
  userB = await registerUser(rig.base, 'v140j-b@test.local', '用户乙', '乙空间');
}, 60_000);

afterAll(() => {
  if (rig) stopRig(rig);
});

const syncAsAdmin = () => jpost(rig.base, '/api/admin/agent-sync', { sourceId: 'agency-agents' }, rig.adminCookie);
const adminTemplates = async (): Promise<any[]> => (await jget(rig.base, '/api/admin/agent-templates', rig.adminCookie)).templates as any[];

describe('J HTTP：白名单与权限', () => {
  it('白名单首次读取种子写入首源', async () => {
    const j = await jget(rig.base, '/api/admin/agent-sources', rig.adminCookie);
    expect(j.ok).toBe(true);
    expect(j.sources).toHaveLength(1);
    expect(j.sources[0]).toMatchObject({ id: 'agency-agents', repo: REPO, branch: 'main', license: 'MIT', author: 'AgentLand Contributors' });
  });

  it('非管理员调管理端点 403', async () => {
    expect((await raw(rig.base, '/api/admin/agent-templates', 'GET', userA.cookie)).status).toBe(403);
    expect((await raw(rig.base, '/api/admin/agent-sources', 'GET', userA.cookie)).status).toBe(403);
    expect((await raw(rig.base, '/api/admin/agent-sync', 'POST', userA.cookie, { sourceId: 'agency-agents' })).status).toBe(403);
    expect((await raw(rig.base, '/api/admin/agent-templates/whatever/approve', 'POST', userA.cookie, {})).status).toBe(403);
  });

  it('未知 sourceId 同步 → 404', async () => {
    expect((await raw(rig.base, '/api/admin/agent-sync', 'POST', rig.adminCookie, { sourceId: 'nope' })).status).toBe(404);
  });
});

describe('J HTTP：同步 → 审核 → 上架', () => {
  it('首次同步：只收 division 直属 md，单文件失败计 failed 不中断', async () => {
    const j = await syncAsAdmin();
    expect(j.ok).toBe(true);
    // 桩 divisions = marketing/engineering/support；tree 里 strategy、深层 game-development、根 README 不收
    expect(j).toMatchObject({ fetched: 3, created: 2, updated: 0, unchanged: 0, failed: 1 });
    const list = await adminTemplates();
    expect(list).toHaveLength(2);
    const m = list.find((t) => t.sourcePath === MARKETING_PATH);
    const e = list.find((t) => t.sourcePath === ENGINEERING_PATH);
    expect(m.status).toBe('pending_review');
    expect(m.draftName).toBe('Content Creator');
    expect(m.draftRole).toBe('组长');
    expect(m.pubName).toBeNull();
    expect(m.language).toBe('en');
    expect(m.sourceAuthor).toBe('AgentLand Contributors');
    expect(m.license).toBe('MIT');
    expect(e.draftRole).toBe('程序员');
    marketingId = m.id;
    engineeringId = e.id;
    // 用户列表：未上架不可见
    const pub = await jget(rig.base, '/api/agent-templates', userA.cookie);
    expect(pub.templates).toHaveLength(0);
  });

  it('二刷幂等：created=0 / unchanged=2', async () => {
    const j = await syncAsAdmin();
    expect(j).toMatchObject({ fetched: 3, created: 0, updated: 0, unchanged: 2, failed: 1 });
  });

  it('通过（带工种覆盖）→ pub=draft 快照，用户列表只见 pub 字段', async () => {
    const j = await jpost(rig.base, `/api/admin/agent-templates/${marketingId}/approve`, { suggestedRole: '文案' }, rig.adminCookie);
    expect(j.ok).toBe(true);
    expect(j.template.status).toBe('public');
    expect(j.template.pubRole).toBe('文案');
    expect(j.template.pubName).toBe('Content Creator');
    expect(j.template.pubPersona).toContain('## Core Capabilities');
    const pub = await jget(rig.base, '/api/agent-templates', userA.cookie);
    expect(pub.templates).toHaveLength(1);
    const t = pub.templates[0];
    expect(t).toMatchObject({
      id: marketingId, name: 'Content Creator', role: '文案', division: 'marketing',
      language: 'en', sourceRepo: REPO, sourceAuthor: 'AgentLand Contributors', license: 'MIT', recruitCount: 0,
    });
    expect(t.persona).toContain('## Core Capabilities');
    expect(t.draftName).toBeUndefined(); // 用户侧不漏 draft 字段
  });

  it('approve 工种覆盖非法值 → 400', async () => {
    const r = await raw(rig.base, `/api/admin/agent-templates/${engineeringId}/approve`, 'POST', rig.adminCookie, { suggestedRole: '厨师' });
    expect(r.status).toBe(400);
  });
});

describe('J HTTP：招募', () => {
  it('招募生成成员：persona 全文落库、计数+1', async () => {
    const j = await jpost(rig.base, `/api/agent-templates/${marketingId}/recruit`, { teamId: userA.teamId }, userA.cookie);
    expect(j.ok).toBe(true);
    expect(j.memberId).toBeTruthy();
    const member = withDb(rig, (db) =>
      db.prepare('SELECT * FROM members WHERE id = ?').get(j.memberId) as any,
    );
    const expectedPersona = parseAgencyAgent(FIXTURE_MARKETING, MARKETING_PATH).persona;
    expect(member.name).toBe('Content Creator');
    expect(member.persona).toBe(expectedPersona);
    expect(member.prompt).toBe('');
    expect(member.role).toBe('文案');
    expect(member.skill_tags).toBe('[]');
    expect(member.appearance).toBe('');
    expect(member.api_id).toBeNull();
    expect(member.team_id).toBe(userA.teamId);
    expect(member.workspace_id).toBe(userA.workspaceId);
    const pub = await jget(rig.base, '/api/agent-templates', userA.cookie);
    expect(pub.templates[0].recruitCount).toBe(1);
  });

  it('招募守卫：跨空间小组 400 / 未上架模板 404 / 不存在 404', async () => {
    expect((await raw(rig.base, `/api/agent-templates/${marketingId}/recruit`, 'POST', userA.cookie, { teamId: userB.teamId })).status).toBe(400);
    expect((await raw(rig.base, `/api/agent-templates/${engineeringId}/recruit`, 'POST', userA.cookie, { teamId: userA.teamId })).status).toBe(404);
    expect((await raw(rig.base, '/api/agent-templates/nope/recruit', 'POST', userA.cookie, { teamId: userA.teamId })).status).toBe(404);
  });

  it('工种回退：pub_role 不在本空间注册表可见集 → 文案', async () => {
    await jpost(rig.base, `/api/admin/agent-templates/${engineeringId}/approve`, {}, rig.adminCookie);
    const before = await jget(rig.base, '/api/agent-templates', userA.cookie);
    expect(before.templates.find((t: any) => t.id === engineeringId).role).toBe('程序员');
    // 正常招募先验一遍：注册表可见的工种原样落库
    const ok = await jpost(rig.base, `/api/agent-templates/${engineeringId}/recruit`, { teamId: userA.teamId }, userA.cookie);
    expect(ok.ok).toBe(true);
    const m1 = withDb(rig, (db) => db.prepare('SELECT * FROM members WHERE id = ?').get(ok.memberId) as any);
    expect(m1.role).toBe('程序员');
    // 人为把 pub_role 改成注册表不存在的工种（模拟源工种与本空间注册表脱节），再招募应回退文案
    withDb(rig, (db) => db.prepare("UPDATE agent_templates SET pub_role = '幽灵工种' WHERE id = ?").run(engineeringId));
    const fb = await jpost(rig.base, `/api/agent-templates/${engineeringId}/recruit`, { teamId: userA.teamId }, userA.cookie);
    expect(fb.ok).toBe(true);
    const m2 = withDb(rig, (db) => db.prepare('SELECT * FROM members WHERE id = ?').get(fb.memberId) as any);
    expect(m2.role).toBe('文案');
    const after = await jget(rig.base, '/api/agent-templates', userA.cookie);
    expect(after.templates.find((t: any) => t.id === engineeringId).recruitCount).toBe(2);
    withDb(rig, (db) => db.prepare("UPDATE agent_templates SET pub_role = '程序员' WHERE id = ?").run(engineeringId));
  });
});

describe('J HTTP：public 后变更与复审', () => {
  const V2_MARKER = 'Expert content strategist v2';

  it('源变更 → draft 更新、pub 快照一字不动、has_pending_update=1', async () => {
    stubFiles.set(MARKETING_PATH, FIXTURE_MARKETING.replace('Expert content strategist', V2_MARKER));
    const j = await syncAsAdmin();
    expect(j).toMatchObject({ fetched: 3, created: 0, updated: 1, unchanged: 1, failed: 1 });
    const list = await adminTemplates();
    const m = list.find((t) => t.id === marketingId);
    expect(m.hasPendingUpdate).toBe(true);
    expect(m.draftSpecialty).toContain('v2');
    expect(m.pubSpecialty).not.toContain('v2');
    expect(m.status).toBe('public');
    // 用户侧仍是旧快照
    const pub = await jget(rig.base, '/api/agent-templates', userA.cookie);
    expect(pub.templates.find((t: any) => t.id === marketingId).specialty).not.toContain('v2');
  });

  it('复审驳回（无原因 400）→ draft 回滚为 pub、保留 public', async () => {
    expect((await raw(rig.base, `/api/admin/agent-templates/${marketingId}/reject`, 'POST', rig.adminCookie, {})).status).toBe(400);
    const j = await jpost(rig.base, `/api/admin/agent-templates/${marketingId}/reject`, { reason: 'v2 文案质量不达标' }, rig.adminCookie);
    expect(j.ok).toBe(true);
    expect(j.template.status).toBe('public');
    expect(j.template.hasPendingUpdate).toBe(false);
    expect(j.template.draftSpecialty).toBe(j.template.pubSpecialty);
    expect(j.template.rejectReason).toBe('v2 文案质量不达标');
  });

  it('回滚后哈希已清：再同步重新检出变更，复审通过后 pub 换新', async () => {
    const j = await syncAsAdmin();
    expect(j).toMatchObject({ updated: 1, unchanged: 1 });
    const list = await adminTemplates();
    expect(list.find((t) => t.id === marketingId).hasPendingUpdate).toBe(true);
    const ap = await jpost(rig.base, `/api/admin/agent-templates/${marketingId}/approve`, {}, rig.adminCookie);
    expect(ap.template.hasPendingUpdate).toBe(false);
    expect(ap.template.pubSpecialty).toContain('v2');
    const pub = await jget(rig.base, '/api/agent-templates', userA.cookie);
    expect(pub.templates.find((t: any) => t.id === marketingId).specialty).toContain('v2');
  });
});

describe('J HTTP：首次驳回与回流、白名单存取、整源失败', () => {
  it('新文件同步进来（zh）→ 驳回必填原因 → rejected；源再变更回 pending_review 并清原因', async () => {
    stubSupportFails = false;
    stubFiles.set(SUPPORT_PATH, SUPPORT_ZH_V1);
    const j = await syncAsAdmin();
    expect(j).toMatchObject({ created: 1, failed: 0 });
    const list = await adminTemplates();
    const s = list.find((t) => t.sourcePath === SUPPORT_PATH);
    expect(s).toBeTruthy();
    supportId = s.id;
    expect(s.status).toBe('pending_review');
    expect(s.language).toBe('zh');
    expect(s.draftName).toBe('客服小助手');

    expect((await raw(rig.base, `/api/admin/agent-templates/${supportId}/reject`, 'POST', rig.adminCookie, { reason: ' ' })).status).toBe(400);
    const rj = await jpost(rig.base, `/api/admin/agent-templates/${supportId}/reject`, { reason: '人设过于简略' }, rig.adminCookie);
    expect(rj.template.status).toBe('rejected');
    expect(rj.template.rejectReason).toBe('人设过于简略');
    // rejected 不进用户列表
    const pub = await jget(rig.base, '/api/agent-templates', userA.cookie);
    expect(pub.templates.some((t: any) => t.id === supportId)).toBe(false);

    stubFiles.set(SUPPORT_PATH, SUPPORT_ZH_V2);
    const j2 = await syncAsAdmin();
    expect(j2).toMatchObject({ updated: 1 });
    const after = (await adminTemplates()).find((t) => t.id === supportId);
    expect(after.status).toBe('pending_review');
    expect(after.rejectReason).toBe('');
    expect(after.draftPersona).toContain('二版');
  });

  it('白名单存取：POST 保存后 GET 原样返回', async () => {
    const cur = (await jget(rig.base, '/api/admin/agent-sources', rig.adminCookie)).sources as any[];
    const next = [...cur, { id: 'extra', repo: 'foo/bar', branch: 'dev', license: 'Apache-2.0', author: 'Foo' }];
    const saved = await jpost(rig.base, '/api/admin/agent-sources', { sources: next }, rig.adminCookie);
    expect(saved.ok).toBe(true);
    expect(saved.sources).toHaveLength(2);
    const again = await jget(rig.base, '/api/admin/agent-sources', rig.adminCookie);
    expect(again.sources).toHaveLength(2);
    expect(again.sources[1]).toMatchObject({ id: 'extra', repo: 'foo/bar', branch: 'dev' });
    // 还原，避免影响其他断言
    await jpost(rig.base, '/api/admin/agent-sources', { sources: cur }, rig.adminCookie);
  });

  it('整源拉取失败 → 502 带上游原文，不编造计数', async () => {
    const cur = (await jget(rig.base, '/api/admin/agent-sources', rig.adminCookie)).sources as any[];
    await jpost(rig.base, '/api/admin/agent-sources', {
      sources: [...cur, { id: 'bad', repo: 'no/such-repo', branch: 'main', license: '', author: '' }],
    }, rig.adminCookie);
    const r = await raw(rig.base, '/api/admin/agent-sync', 'POST', rig.adminCookie, { sourceId: 'bad' });
    expect(r.status).toBe(502);
    expect(r.json.ok).toBe(false);
    expect(String(r.json.error.message)).toContain('404');
    expect(r.json.created).toBeUndefined();
    await jpost(rig.base, '/api/admin/agent-sources', { sources: cur }, rig.adminCookie);
  });
});
