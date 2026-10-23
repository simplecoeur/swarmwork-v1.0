import * as fs from 'fs';
import * as path from 'path';
import { generateTempPassword, hashPassword } from '../auth/auth';
import type { Logger } from '../logger';
import { nowIso, uid } from '../util';
import { ensureShortDramaPack, parseManifest, registerPackExtensions } from './industry';
import {
  DEFAULT_WORKSPACE_ID,
  type IndustryPackRow,
  type Repos,
  type WorkspaceRow,
} from './repositories';
import { makeMemberRows } from './seed';

export const ADMIN_USER_ID = 'user_admin';

/**
 * 平台 bootstrap（M6）：管理员用户 + 行业包种子。
 * 管理员邮箱/初始密码读环境变量 SWARM_ADMIN_EMAIL / SWARM_ADMIN_PASSWORD；
 * 未设密码时生成随机口令写入 DATA_DIR/admin-initial-password.txt（0600）并在日志提示路径，
 * 管理员置 must_change_password=1。代码与日志中不出现明文口令。
 */
export async function ensurePlatform(
  repos: Repos,
  dataDir: string,
  logger: Logger,
): Promise<void> {
  ensureShortDramaPack(repos);
  const pack = repos.getIndustryPack('pack_short_drama');
  if (pack) registerPackExtensions(repos, pack);

  if (repos.getUser(ADMIN_USER_ID)) return;
  const email = (process.env.SWARM_ADMIN_EMAIL || 'admin@swarm.local').toLowerCase();
  const existing = repos.getUserByEmail(email);
  if (existing) return;
  let password = process.env.SWARM_ADMIN_PASSWORD || '';
  if (!password) {
    password = generateTempPassword() + generateTempPassword();
    const file = path.join(dataDir, 'admin-initial-password.txt');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, password + '\n', { mode: 0o600 });
    logger.info('auth', `管理员初始口令已生成并写入 ${file}（0600），首次登录须改密`);
  } else {
    logger.info('auth', '管理员账号已按环境变量 SWARM_ADMIN_EMAIL/SWARM_ADMIN_PASSWORD 创建，首次登录须改密');
  }
  repos.insertUser({
    id: ADMIN_USER_ID,
    email,
    password_hash: await hashPassword(password),
    display_name: '平台管理员',
    status: 'active',
    is_platform_admin: 1,
    must_change_password: 1,
    failed_attempts: 0,
    locked_until: null,
    registration_ip: '',
    last_login_at: null,
    created_at: nowIso(),
  });
}

/** 空间通用默认设置（零行业词） */
export function seedWorkspaceSettings(repos: Repos, workspaceId: string): void {
  repos.setSetting('defaultApiId', null, workspaceId);
  repos.setSetting('params', { concurrency: 4, taskBudgetTokens: 0 }, workspaceId);
  repos.setSetting('reviewStandards', { points: '', clientNeeds: '' }, workspaceId);
}

/** 通用种子（不选行业包）：一个通用小组 + 五工种默认人设，全程零行业词（§12.5） */
export function seedGenericWorkspace(repos: Repos, workspaceId: string): void {
  const teamId = uid('team');
  repos.insertTeam({
    id: teamId,
    name: '通用小组',
    color: '#5b8def',
    api_id: null,
    created_at: nowIso(),
    deleted_at: null,
    workspace_id: workspaceId,
  });
  for (const m of makeMemberRows(teamId, '通用小组', true, workspaceId)) {
    repos.insertMember({ ...m, id: uid('member') });
  }
}

/** 按行业包 manifest 快照装入：小组/人设/知识种子（装后与源包脱钩，§12.1） */
export function applyIndustryPack(repos: Repos, workspaceId: string, pack: IndustryPackRow): void {
  const manifest = parseManifest(pack);
  for (const t of manifest.teams) {
    const teamId = uid('team');
    repos.insertTeam({
      id: teamId,
      name: t.name,
      color: t.color || '#5b8def',
      api_id: null,
      created_at: nowIso(),
      deleted_at: null,
      workspace_id: workspaceId,
    });
    for (const m of t.members) {
      repos.insertMember({
        id: uid('member'),
        team_id: teamId,
        name: m.name,
        role: m.role,
        persona: m.persona,
        prompt: '',
        skill_tags: '[]',
        color: '',
        workspace_id: workspaceId,
      });
    }
  }
  for (const k of manifest.kbSeeds) {
    const ts = nowIso();
    repos.insertKb({
      id: uid('kb'),
      title: k.title,
      body: k.body,
      scope: 'company',
      scope_id: null,
      tags: JSON.stringify(k.tags ?? []),
      enabled: 1,
      created_at: ts,
      updated_at: ts,
      workspace_id: workspaceId,
      owner_user_id: null,
    });
  }
}

/**
 * 开空间（注册即时开通 / POST /api/workspaces 共用）：
 * 建 workspace + owner membership + 默认设置；选包则快照装入包内容，否则只装通用种子。
 */
export function provisionWorkspace(
  repos: Repos,
  ownerUserId: string,
  name: string,
  industryPackId?: string | null,
): WorkspaceRow {
  const pack = industryPackId ? repos.getIndustryPack(industryPackId) : undefined;
  if (industryPackId && !pack) throw new Error('行业包不存在');
  if (pack && pack.status !== 'published') throw new Error('行业包未上架');
  const ws: WorkspaceRow = {
    id: uid('ws'),
    name,
    owner_user_id: ownerUserId,
    status: 'active',
    industry_pack_id: pack ? pack.id : null,
    created_at: nowIso(),
  };
  repos.tx(() => {
    repos.insertWorkspace(ws);
    repos.insertMembership({
      user_id: ownerUserId,
      workspace_id: ws.id,
      role: 'owner',
      status: 'active',
      joined_at: nowIso(),
    });
    seedWorkspaceSettings(repos, ws.id);
    if (pack) applyIndustryPack(repos, ws.id, pack);
    else seedGenericWorkspace(repos, ws.id);
  });
  return ws;
}

export { DEFAULT_WORKSPACE_ID };
