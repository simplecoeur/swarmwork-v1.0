import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMBER_SKINS, memberAppearanceOf, sanitizeAppearance } from '../../src/store/repositories';

/**
 * v1.4.0 I（小人形象定制）集成测试：
 * - 进程内：sanitizeAppearance 清洗口径（skin 须在 MEMBER_SKINS 5 档内、shirt/hairColor 须 #rrggbb、
 *   hairStyle 须在枚举内，非法字段逐个丢弃）、memberAppearanceOf 解析（空串/坏 JSON/清洗后无字段 → null）。
 * - HTTP：members/save 的 appearance DTO 往返（对象覆盖 → state 回同值；undefined 省略不改；null 清除回 null 且 DB 落空串）、
 *   部分字段定制（只回给出的字段）、非法字段经路由清洗、hairStyle 非法枚举被 zod 拒（400 且原值不变）、
 *   新建成员带 appearance 落库、跨空间成员不可改。
 * 口径备注：skin/shirt/hairColor 的非法值不是报错，而是仓储 sanitizeAppearance 逐字段丢弃；
 * hairStyle 是 zod 枚举，非法值在入参校验层直接 400。
 */
const SERVER_DIR = process.cwd();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ================= 进程内 ================= */

describe('I 进程内：sanitizeAppearance / memberAppearanceOf', () => {
  it('合法字段全保留；skin 5 档与目录同值', () => {
    expect([...MEMBER_SKINS]).toEqual(['#f2c79b', '#eec39a', '#f6cfae', '#e9bd8d', '#d9a06b']);
    expect(
      sanitizeAppearance({ skin: '#d9a06b', shirt: '#3a6fd8', hairColor: '#D9A441', hairStyle: 'bun' }),
    ).toEqual({ skin: '#d9a06b', shirt: '#3a6fd8', hairColor: '#D9A441', hairStyle: 'bun' });
  });

  it('非法字段逐个丢弃：skin 不在 5 档、shirt/hairColor 非 #rrggbb、hairStyle 不在枚举', () => {
    expect(
      sanitizeAppearance({ skin: '#000000', shirt: 'red', hairColor: '#12345', hairStyle: 'mohawk' }),
    ).toEqual({});
    expect(sanitizeAppearance({ skin: '#000000', shirt: '#e77fa2' })).toEqual({ shirt: '#e77fa2' });
    expect(sanitizeAppearance(null)).toEqual({});
    expect(sanitizeAppearance('x')).toEqual({});
    expect(sanitizeAppearance({ skin: 123, hairStyle: 'long' })).toEqual({ hairStyle: 'long' });
  });

  it('memberAppearanceOf：空串/坏 JSON/清洗后无合法字段 → null；合法 JSON 回清洗后对象', () => {
    expect(memberAppearanceOf({ appearance: '' })).toBeNull();
    expect(memberAppearanceOf({ appearance: null })).toBeNull();
    expect(memberAppearanceOf({})).toBeNull();
    expect(memberAppearanceOf({ appearance: '{bad json' })).toBeNull();
    expect(memberAppearanceOf({ appearance: '{}' })).toBeNull();
    expect(memberAppearanceOf({ appearance: '{"skin":"#000000"}' })).toBeNull();
    expect(memberAppearanceOf({ appearance: '{"shirt":"#e77fa2","skin":"#000000"}' })).toEqual({
      shirt: '#e77fa2',
    });
  });
});

/* ================= HTTP 黑盒 ================= */

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

async function startRig(serverPort: number): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-i-'));
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(serverPort),
      DATA_DIR: dataDir,
      LLM_RETRY_BASE_MS: '10',
      SWARM_ADMIN_EMAIL: 'admin@test.local',
      SWARM_ADMIN_PASSWORD: '<MASKED_SECRET_00' + '1>!',
      SWARM_SCHEDULE_TICK_MS: '3600000',
    },
    stdio: 'pipe',
    detached: true,
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  const rig: Rig = { base: `http://127.0.0.1:${serverPort}`, procs: [server], dataDir, adminCookie: '' };
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
async function raw(
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
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function registerUser(
  base: string,
  email: string,
  displayName: string,
  workspaceName?: string,
): Promise<{ cookie: string; userId: string; workspaceId: string }> {
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

beforeAll(async () => {
  rig = await startRig(9051);
  userA = await registerUser(rig.base, 'i-a@test.local', '甲', '甲空间I');
  userB = await registerUser(rig.base, 'i-b@test.local', '乙', '乙空间I');
}, 60_000);

afterAll(() => {
  if (rig) stopRig(rig);
});

async function stateOf(cookie: string): Promise<any> {
  const st = await jget(rig.base, '/api/state', cookie);
  expect(st.ok ?? true).toBeTruthy();
  return st;
}
async function firstMember(cookie: string): Promise<any> {
  const st = await stateOf(cookie);
  const member = (st.members as any[])[0];
  expect(member).toBeTruthy();
  return member;
}
function saveMember(cookie: string, member: any, patch: Record<string, unknown>): Promise<any> {
  return jpost(
    rig.base,
    '/api/members/save',
    {
      member: {
        id: member.id,
        name: member.name,
        role: member.role,
        teamId: member.teamId,
        prompt: member.prompt ?? '',
        ...patch,
      },
    },
    cookie,
  );
}
async function appearanceOf(cookie: string, memberId: string): Promise<any> {
  const st = await stateOf(cookie);
  return (st.members as any[]).find((m) => m.id === memberId)?.appearance;
}

describe('I HTTP：members/save appearance DTO 往返', () => {
  it('全字段对象 → state 回同值；省略（undefined）不改；null 清除回 null 且 DB 落空串', async () => {
    const member = await firstMember(userA.cookie);
    expect(member.appearance).toBeNull();

    const full = { skin: '#d9a06b', shirt: '#3a6fd8', hairColor: '#d9a441', hairStyle: 'long' };
    expect((await saveMember(userA.cookie, member, { appearance: full })).ok).toBe(true);
    expect(await appearanceOf(userA.cookie, member.id)).toEqual(full);

    // 省略 appearance → 不改（顺带改名验证 save 其余字段照常）
    expect((await saveMember(userA.cookie, member, { name: '改名甲I' })).ok).toBe(true);
    const st = await stateOf(userA.cookie);
    const renamed = (st.members as any[]).find((m) => m.id === member.id);
    expect(renamed.name).toBe('改名甲I');
    expect(renamed.appearance).toEqual(full);

    // null → 清除：state 回 null，DB 原文落空串（未定制口径）
    expect((await saveMember(userA.cookie, renamed, { appearance: null })).ok).toBe(true);
    expect(await appearanceOf(userA.cookie, member.id)).toBeNull();
    const row = withDb(rig, (db) =>
      db.prepare('SELECT appearance FROM members WHERE id = ?').get(member.id),
    ) as any;
    expect(row.appearance).toBe('');
  });

  it('部分字段定制：只给 shirt 时 DTO 只回 shirt，其余字段缺省', async () => {
    const member = await firstMember(userA.cookie);
    expect((await saveMember(userA.cookie, member, { appearance: { shirt: '#e77fa2' } })).ok).toBe(true);
    const ap = await appearanceOf(userA.cookie, member.id);
    expect(ap).toEqual({ shirt: '#e77fa2' });
    expect(Object.keys(ap)).toEqual(['shirt']);
    expect((await saveMember(userA.cookie, member, { appearance: null })).ok).toBe(true);
  });

  it('非法字段经路由清洗逐个丢弃；全非法 → 回 null；hairStyle 非法枚举被 zod 拒（400，原值不变）', async () => {
    const member = await firstMember(userA.cookie);
    // skin 非 5 档 / shirt 非 hex / hairColor 位数不对 → 丢弃；hairStyle 合法保留
    expect(
      (
        await saveMember(userA.cookie, member, {
          appearance: { skin: '#000000', shirt: 'red', hairColor: '#12345', hairStyle: 'short' },
        })
      ).ok,
    ).toBe(true);
    expect(await appearanceOf(userA.cookie, member.id)).toEqual({ hairStyle: 'short' });

    // 全部字段非法 → 清洗后无字段，DTO 回 null（未定制）
    expect(
      (await saveMember(userA.cookie, member, { appearance: { skin: '#000000', shirt: 'red' } })).ok,
    ).toBe(true);
    expect(await appearanceOf(userA.cookie, member.id)).toBeNull();

    // 先落一个合法值，再试非法枚举：zod 在入参层拒绝（400），原值不被覆盖
    expect(
      (await saveMember(userA.cookie, member, { appearance: { hairStyle: 'bun' } })).ok,
    ).toBe(true);
    const bad = await raw(
      rig.base,
      '/api/members/save',
      {
        member: {
          id: member.id,
          name: member.name,
          role: member.role,
          teamId: member.teamId,
          prompt: '',
          appearance: { hairStyle: 'mohawk' },
        },
      },
      userA.cookie,
    );
    expect(bad.status).toBe(400);
    expect(await appearanceOf(userA.cookie, member.id)).toEqual({ hairStyle: 'bun' });
    expect((await saveMember(userA.cookie, member, { appearance: null })).ok).toBe(true);
  });

  it('新建成员带 appearance 落库；跨空间用户改不了他空间成员', async () => {
    const stA = await stateOf(userA.cookie);
    const team = (stA.teams as any[])[0];
    const created = await jpost(
      rig.base,
      '/api/members/save',
      {
        member: {
          name: '新成员I',
          role: '文案',
          teamId: team.id,
          prompt: '',
          appearance: { skin: '#f2c79b', hairStyle: 'bun' },
        },
      },
      userA.cookie,
    );
    expect(created.ok).toBe(true);
    expect(await appearanceOf(userA.cookie, created.id)).toEqual({ skin: '#f2c79b', hairStyle: 'bun' });

    // 乙空间用户拿甲空间成员 id + 自己空间的 teamId 保存 → 成员在本空间不存在，404
    const stB = await stateOf(userB.cookie);
    const teamB = (stB.teams as any[])[0];
    const cross = await raw(
      rig.base,
      '/api/members/save',
      {
        member: {
          id: created.id,
          name: '新成员I',
          role: '文案',
          teamId: teamB.id,
          prompt: '',
          appearance: { shirt: '#000000' },
        },
      },
      userB.cookie,
    );
    expect(cross.status).toBe(404);
    expect(await appearanceOf(userA.cookie, created.id)).toEqual({ skin: '#f2c79b', hairStyle: 'bun' });
  });
});
