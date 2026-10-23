import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * v1.3.0 集成测试（A3 任务模板 / B 精选与署名公示 / F 办公室风格）：
 * - 模板：官方 4 个全空间可见；短剧行业 6 个仅短剧空间可见；自建 CRUD；
 *   删官方/删他人空间模板 → 404 且列表隔离；from-task 内容一致、跨空间任务 → 404。
 * - 精选：非管理员 403；官方/未上架 skill → 400；精选落 featured + 署名快照（贡献者改名后仍显旧名）；
 *   贡献者收到 skill_featured 通知；取消精选生效；activity 含 listed 事件。
 * - 风格：office-style PUT/GET 往返；风格模板 建→提交→驳回（无 reason 400 / 有 reason 回 workspace）
 *   →再提交→通过 public；未过审模板引用的图片跨空间 GET 404、过审后 200；apply 后风格被覆盖且 apply_count=1；
 *   官方 6 套在 library 可见。
 */
const SERVER_DIR = process.cwd();
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface Rig {
  base: string;
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

async function startRig(serverPort: number, mockPort: number): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v130-'));
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
    },
    stdio: 'pipe',
    detached: true,
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  const rig: Rig = { base: `http://127.0.0.1:${serverPort}`, procs: [mock, server], dataDir, adminCookie: '' };
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
async function raw(base: string, p: string, method: string, cookie: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(base + p, {
    method,
    headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function registerUser(base: string, email: string, displayName: string, workspaceName?: string): Promise<{ cookie: string; userId: string; workspaceId: string }> {
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
  return { cookie, userId: me.user.id as string, workspaceId: me.workspace.id as string };
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
let userA: { cookie: string; userId: string; workspaceId: string };
let userB: { cookie: string; userId: string; workspaceId: string };
let dramaWsId = '';

beforeAll(async () => {
  rig = await startRig(8993, 9003);
  userA = await registerUser(rig.base, 'v130-a@test.local', '作者甲', '甲空间');
  userB = await registerUser(rig.base, 'v130-b@test.local', '用户乙', '乙空间');
  // 管理员建短剧行业空间（industryPackId 用行业标识 short_drama）
  const w = await jpost(rig.base, '/api/workspaces', { name: '短剧空间', industryPackId: 'short_drama' }, rig.adminCookie);
  expect(w.ok).toBe(true);
  dramaWsId = w.workspace.id as string;
  // 切回管理员默认空间，避免后续管理员操作落错空间
  const me = await jget(rig.base, '/api/auth/me', rig.adminCookie);
  const first = (me.workspaces as Array<{ id: string }>).find((x) => x.id !== dramaWsId);
  if (first) await jpost(rig.base, '/api/auth/switch-workspace', { workspaceId: first.id }, rig.adminCookie);
}, 60_000);

afterAll(() => {
  if (rig) stopRig(rig);
});

/* ================= A3 任务模板 ================= */
describe('A3 任务模板：可见集与 CRUD', () => {
  it('任意空间见 4 个官方模板；非短剧空间不见行业模板', async () => {
    const j = await jget(rig.base, '/api/templates', userA.cookie);
    expect(j.ok).toBe(true);
    const officials = (j.templates as any[]).filter((t) => t.scope === 'official');
    expect(officials.map((t) => t.name).sort()).toEqual(
      ['会议纪要整理', '活动推文三连', '竞品动态速览', '长文摘要速览'].sort(),
    );
    expect((j.templates as any[]).filter((t) => t.scope === 'industry')).toHaveLength(0);
    expect(officials.find((t) => t.name === '长文摘要速览')!.briefTemplate).toContain('{{原文}}');
  });

  it('短剧空间见 6 个行业模板', async () => {
    const sw = await jpost(rig.base, '/api/auth/switch-workspace', { workspaceId: dramaWsId }, rig.adminCookie);
    expect(sw.ok).toBe(true);
    const j = await jget(rig.base, '/api/templates', rig.adminCookie);
    const industry = (j.templates as any[]).filter((t) => t.scope === 'industry');
    expect(industry).toHaveLength(6);
    expect(industry.map((t) => t.name)).toContain('爆款标题组');
    expect(industry.every((t) => t.industryPackId === 'short_drama')).toBe(true);
    expect((j.templates as any[]).filter((t) => t.scope === 'official')).toHaveLength(4);
  });

  it('自建模板 CRUD + 删除隔离（官方 404 / 他空间 404 / 列表隔离）', async () => {
    // 甲自建
    const created = await jpost(
      rig.base,
      '/api/templates',
      { name: '甲的模板', typeId: '文案', briefTemplate: '骨架 {{主题}}', suggestedRole: '文案' },
      userA.cookie,
    );
    expect(created.ok).toBe(true);
    const tplA = created.template.id as string;
    const listA = await jget(rig.base, '/api/templates', userA.cookie);
    expect((listA.templates as any[]).some((t) => t.id === tplA)).toBe(true);
    // 乙列表隔离：看不到甲的
    const listB = await jget(rig.base, '/api/templates', userB.cookie);
    expect((listB.templates as any[]).some((t) => t.id === tplA)).toBe(false);
    // 乙删甲的 → 404
    expect((await raw(rig.base, `/api/templates/${tplA}`, 'DELETE', userB.cookie)).status).toBe(404);
    // 甲删官方 → 404
    const officials = (listA.templates as any[]).filter((t) => t.scope === 'official');
    expect((await raw(rig.base, `/api/templates/${officials[0].id}`, 'DELETE', userA.cookie)).status).toBe(404);
    // 空名 → 400 VALIDATION
    const bad = await raw(rig.base, '/api/templates', 'POST', userA.cookie, { name: '  ' });
    expect(bad.status).toBe(400);
    // 甲删自己的 → ok 且列表消失
    expect((await raw(rig.base, `/api/templates/${tplA}`, 'DELETE', userA.cookie)).json.ok).toBe(true);
    const listA2 = await jget(rig.base, '/api/templates', userA.cookie);
    expect((listA2.templates as any[]).some((t) => t.id === tplA)).toBe(false);
  });

  it('from-task：内容与任务一致；他空间任务 → 404', async () => {
    const st = await jget(rig.base, '/api/state', userA.cookie);
    const teamId = st.teams[0].id as string;
    const task = await jpost(
      rig.base,
      '/api/tasks',
      { title: '模板源头任务', type: '文案', brief: '这是源头任务的说明全文', teamId },
      userA.cookie,
    );
    expect(task.ok).toBe(true);
    const from = await jpost(rig.base, `/api/templates/from-task/${task.id}`, {}, userA.cookie);
    expect(from.ok).toBe(true);
    expect(from.template.name).toBe('模板源头任务');
    expect(from.template.typeId).toBe('文案');
    expect(from.template.briefTemplate).toBe('这是源头任务的说明全文');
    expect(from.template.suggestedRole).toBe('');
    // 短剧空间（管理员）的任务，甲来 from-task → 404
    const sw = await jpost(rig.base, '/api/auth/switch-workspace', { workspaceId: dramaWsId }, rig.adminCookie);
    expect(sw.ok).toBe(true);
    const stD = await jget(rig.base, '/api/state', rig.adminCookie);
    const taskD = await jpost(
      rig.base,
      '/api/tasks',
      { title: '短剧空间任务', type: '文案', brief: '短剧说明', teamId: stD.teams[0].id },
      rig.adminCookie,
    );
    expect(taskD.ok).toBe(true);
    expect((await raw(rig.base, `/api/templates/from-task/${taskD.id}`, 'POST', userA.cookie)).status).toBe(404);
  });
});

/* ================= B 精选与署名 ================= */
describe('B 精选与署名公示', () => {
  let skillId = '';
  let draftSkillId = '';

  it('建 skill → 发布 → 提交审核 → 管理员 approve：listed_at 与署名快照落定', async () => {
    const created = await jpost(
      rig.base,
      '/api/skills',
      {
        skill: {
          name: '甲的公开 skill',
          description: '供精选测试',
          role: '文案',
          promptTemplate: '做 {{thing}}',
          visibility: 'workspace',
        },
      },
      userA.cookie,
    );
    expect(created.ok).toBe(true);
    skillId = created.id as string;
    expect((await jpost(rig.base, `/api/skills/${skillId}/publish`, {}, userA.cookie)).ok).toBe(true);
    expect((await jpost(rig.base, `/api/skills/${skillId}/submit-review`, {}, userA.cookie)).ok).toBe(true);
    expect((await jpost(rig.base, `/api/admin/skills/${skillId}/approve`, {}, rig.adminCookie)).ok).toBe(true);
    const dto = (await jget(rig.base, `/api/skills/${skillId}`, userA.cookie)).skill;
    expect(dto.visibility).toBe('public');
    expect(dto.listedAt).toBeTruthy();
    expect(dto.contributorName).toBe('作者甲');
    expect(dto.contributorWorkspaceName).toBe('甲空间');
    // 未上架的草稿 skill（feature 400 用例）
    const draft = await jpost(
      rig.base,
      '/api/skills',
      { skill: { name: '甲的私有 skill', description: '', role: '文案', promptTemplate: 'x' } },
      userA.cookie,
    );
    draftSkillId = draft.id as string;
  });

  it('署名快照不随贡献者改名变化', async () => {
    const put = await fetch(rig.base + '/api/account/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: userA.cookie },
      body: JSON.stringify({ displayName: '改名后的甲' }),
    });
    expect((await put.json()).ok).toBe(true);
    const dto = (await jget(rig.base, `/api/skills/${skillId}`, userA.cookie)).skill;
    expect(dto.contributorName).toBe('作者甲');
  });

  it('feature：非管理员 403；官方 skill 400；未上架 400；精选/取消 + 通知 + 幂等', async () => {
    expect((await raw(rig.base, `/api/admin/skills/${skillId}/feature`, 'POST', userA.cookie, { featured: true })).status).toBe(403);
    const official = (await jget(rig.base, '/api/skills', rig.adminCookie)).skills.find(
      (s: any) => s.ownerType === 'platform',
    );
    expect(official).toBeTruthy();
    const fOff = await raw(rig.base, `/api/admin/skills/${official.id}/feature`, 'POST', rig.adminCookie, { featured: true });
    expect(fOff.status).toBe(400);
    expect(fOff.json.error.code).toBe('VALIDATION');
    const fDraft = await raw(rig.base, `/api/admin/skills/${draftSkillId}/feature`, 'POST', rig.adminCookie, { featured: true });
    expect(fDraft.status).toBe(400);

    const f1 = await jpost(rig.base, `/api/admin/skills/${skillId}/feature`, { featured: true }, rig.adminCookie);
    expect(f1.ok).toBe(true);
    expect(f1.skill.featured).toBe(true);
    expect(f1.skill.featuredAt).toBeTruthy();
    expect(f1.skill.contributorName).toBe('作者甲');
    // 幂等重复：仍 ok，通知不增
    expect((await jpost(rig.base, `/api/admin/skills/${skillId}/feature`, { featured: true }, rig.adminCookie)).ok).toBe(true);
    const countFeatured = () =>
      withDb(rig, (db) =>
        Number(
          (
            db
              .prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'skill_featured'")
              .get(userA.userId) as { c: number }
          ).c,
        ),
      );
    expect(countFeatured()).toBe(1);
    // 取消精选
    const f2 = await jpost(rig.base, `/api/admin/skills/${skillId}/feature`, { featured: false }, rig.adminCookie);
    expect(f2.skill.featured).toBe(false);
    expect(f2.skill.featuredAt).toBeNull();
    const unCount = withDb(rig, (db) =>
      Number(
        (
          db
            .prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'skill_unfeatured'")
            .get(userA.userId) as { c: number }
        ).c,
      ),
    );
    expect(unCount).toBe(1);
  });

  it('activity：含该 skill 的 listed 事件与署名', async () => {
    const j = await jget(rig.base, '/api/skills/activity', userB.cookie);
    expect(j.ok).toBe(true);
    const items = j.items as any[];
    const listed = items.find((i) => i.skillId === skillId && i.kind === 'listed');
    expect(listed).toBeTruthy();
    expect(listed.contributorName).toBe('作者甲');
    expect(listed.contributorWorkspaceName).toBe('甲空间');
    expect(listed.at).toBeTruthy();
  });
});

/* ================= F 办公室风格 ================= */
describe('F 办公室风格与风格模板', () => {
  const styleA = {
    palette: { wall: '#111111', floor: '#222222', accent: '#333333' },
    floorPattern: 'tile',
    furniture: { sofa: 'linen', plantLeft: 'fern' },
    poster: { imageFileId: null as string | null },
    sign: { mode: 'text', text: '甲的办公室', imageFileId: null as string | null },
  };
  let imageFileId = '';
  let styleTplId = '';

  it('office-style：默认配置五键齐全；PUT/GET 往返一致（{style} 与裸体两种形态）', async () => {
    const d = await jget(rig.base, '/api/office-style', userB.cookie);
    expect(d.ok).toBe(true);
    expect(d.style.palette.wall).toBeTruthy();
    expect(d.style.floorPattern).toBe('wood');
    expect(d.style.poster.imageFileId).toBeNull();
    const put = await fetch(rig.base + '/api/office-style', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: userA.cookie },
      body: JSON.stringify({ style: styleA }),
    });
    expect((await put.json()).ok).toBe(true);
    const got = await jget(rig.base, '/api/office-style', userA.cookie);
    expect(got.style).toEqual(styleA);
    // 裸体形态（前端 api.ts 口径）
    const put2 = await fetch(rig.base + '/api/office-style', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: userA.cookie },
      body: JSON.stringify(styleA),
    });
    expect((await put2.json()).style).toEqual(styleA);
    // 非法 floorPattern → 400
    const bad = await fetch(rig.base + '/api/office-style', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: userA.cookie },
      body: JSON.stringify({ style: { ...styleA, floorPattern: 'diagonal' } }),
    });
    expect(bad.status).toBe(400);
  });

  it('风格图片：上传后本空间可读、跨空间 404', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'poster.png');
    const up = await fetch(rig.base + '/api/style-images', {
      method: 'POST',
      headers: { cookie: userA.cookie },
      body: fd,
    });
    const uj: any = await up.json();
    expect(uj.ok).toBe(true);
    imageFileId = uj.fileId as string;
    expect(uj.url).toBe(`/api/style-images/${imageFileId}`);
    const own = await fetch(rig.base + `/api/style-images/${imageFileId}`, { headers: { cookie: userA.cookie } });
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type')).toContain('image/png');
    const other = await fetch(rig.base + `/api/style-images/${imageFileId}`, { headers: { cookie: userB.cookie } });
    expect(other.status).toBe(404);
  });

  it('风格模板审核链：建→提交→驳回(无 reason 400/有 reason 回 workspace)→再提交→通过 public；图片随过审放行', async () => {
    const cfg = { ...styleA, poster: { imageFileId: imageFileId } };
    const created = await jpost(rig.base, '/api/style-templates', { name: '甲的风格', config: cfg }, userA.cookie);
    expect(created.ok).toBe(true);
    styleTplId = created.template.id as string;
    expect(created.template.visibility).toBe('private');
    expect(created.template.contributorName).toBe('改名后的甲');
    expect(created.template.config.poster.imageFileId).toBe(imageFileId);

    expect((await jpost(rig.base, `/api/style-templates/${styleTplId}/submit-review`, {}, userA.cookie)).ok).toBe(true);
    const noReason = await raw(rig.base, `/api/admin/style-templates/${styleTplId}/reject`, 'POST', rig.adminCookie, {});
    expect(noReason.status).toBe(400);
    const rejected = await jpost(rig.base, `/api/admin/style-templates/${styleTplId}/reject`, { reason: '配色再斟酌' }, rig.adminCookie);
    expect(rejected.ok).toBe(true);
    const mine1 = await jget(rig.base, '/api/style-templates', userA.cookie);
    expect((mine1.mine as any[]).find((t) => t.id === styleTplId)!.visibility).toBe('workspace');
    // 未过审：乙读图仍 404
    expect((await fetch(rig.base + `/api/style-images/${imageFileId}`, { headers: { cookie: userB.cookie } })).status).toBe(404);

    expect((await jpost(rig.base, `/api/style-templates/${styleTplId}/submit-review`, {}, userA.cookie)).ok).toBe(true);
    expect((await jpost(rig.base, `/api/admin/style-templates/${styleTplId}/approve`, {}, rig.adminCookie)).ok).toBe(true);
    const mine2 = await jget(rig.base, '/api/style-templates', userA.cookie);
    expect((mine2.mine as any[]).find((t) => t.id === styleTplId)!.visibility).toBe('public');
    // 过审后：乙可读被 public 模板引用的图
    const pub = await fetch(rig.base + `/api/style-images/${imageFileId}`, { headers: { cookie: userB.cookie } });
    expect(pub.status).toBe(200);
  });

  it('apply：套用后 office-style 等于模板 config 且 apply_count=1；官方 6 套在 library', async () => {
    const before = await jget(rig.base, '/api/style-templates', userB.cookie);
    const officials = (before.library as any[]).filter((t) => t.ownerType === 'platform');
    expect(officials.map((t) => t.name).sort()).toEqual(
      ['原木暖阳', '极简整洁', '樱粉梦境', '科技蓝调', '绿植森系', '赛博霓虹'].sort(),
    );
    const cyber = officials.find((t) => t.name === '赛博霓虹')!;
    expect(cyber.config.sign.text).toBe('SWARM HQ');

    const applied = await jpost(rig.base, `/api/style-templates/${styleTplId}/apply`, {}, userB.cookie);
    expect(applied.ok).toBe(true);
    const got = await jget(rig.base, '/api/office-style', userB.cookie);
    expect(got.style.palette).toEqual(styleA.palette);
    expect(got.style.poster.imageFileId).toBe(imageFileId);
    const after = await jget(rig.base, '/api/style-templates', userB.cookie);
    const tpl = (after.library as any[]).find((t) => t.id === styleTplId)!;
    expect(tpl.applyCount).toBe(1);
    // 不可见模板（他人 private）apply → 404
    const priv = await jpost(rig.base, '/api/style-templates', { name: '乙的私有', config: styleA }, userB.cookie);
    expect((await raw(rig.base, `/api/style-templates/${priv.template.id}/apply`, 'POST', userA.cookie)).status).toBe(404);
  });
});
