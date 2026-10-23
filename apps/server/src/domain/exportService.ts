import { milliToYuan, TaskStatus } from '@swarm/shared';
import JSZip from 'jszip';
import { decryptKey, maskKey } from '../store/crypto';
import type { Repos } from '../store/repositories';
import { taskToMarkdown } from './deliveryService';

/**
 * 所有者一键全量导出（G-16）：把一个空间的全部业务数据同步组装为 zip 数据包。
 * 与管理员整库备份（§16，运维出口、整库 swarm.db）严格区分：本条是所有者自助出口，
 * 只含本空间数据、严格空间隔离，且——守 §11 老规矩：apis 只出
 * name/provider/model + 掩码，channels/notify 类配置只出「已配置/未配置」。
 * 体积上限由路由层按 EXPORT_LIMITS 判定（组装后 >50MB 回 VALIDATION 走管理员备份通道）。
 */

/** ledger.csv 口径与 /api/ledger-view/export 完全一致（同表头同列序），此处为全量（不限月份） */
export function ledgerToCsv(repos: Repos, workspaceId: string): string {
  const rows = repos.listLedger(workspaceId);
  const head =
    '时间,任务ID,小组ID,API,阶段,prompt_tokens,completion_tokens,total_tokens,成本(元),估算';
  const lines = rows.map((l) =>
    [
      l.created_at,
      l.task_id,
      l.team_id,
      l.api_id,
      l.stage,
      l.prompt_tokens,
      l.completion_tokens,
      l.total_tokens,
      milliToYuan(l.cost_milli),
      l.estimated === 1 ? '是' : '否',
    ].join(','),
  );
  return [head, ...lines].join('\n') + '\n';
}

function parseJsonSafe(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export interface WorkspaceExportResult {
  buffer: Buffer;
  /** 各文件条目数（落 audit detail 与施工实测用） */
  counts: { tasks: number; results: number; kb: number; assets: number; skills: number };
  elapsedMs: number;
}

/** 同步组装本空间全量 zip（调用方负责所有者校验、体积上限判定与 audit 落账） */
export async function buildWorkspaceExport(
  repos: Repos,
  workspaceId: string,
): Promise<WorkspaceExportResult> {
  const t0 = Date.now();
  const zip = new JSZip();
  const ws = repos.getWorkspace(workspaceId);
  const tasks = repos.listTasks(workspaceId);

  // tasks.jsonl：每行一单，含成果全文与时间线基本字段（状态流水）
  const taskLines = tasks.map((t) =>
    JSON.stringify({
      id: t.id,
      title: t.title,
      type: t.type,
      brief: t.brief,
      status: t.status,
      result: t.result,
      reviewNote: t.review_note,
      rejectReason: t.reject_reason,
      rejectCount: t.reject_count,
      teamId: t.team_id,
      assigneeId: t.assignee_id,
      projectId: t.project_id,
      skillId: t.skill_id ?? null,
      skillVersion: t.skill_version ?? null,
      totalTokens: t.total_tokens,
      totalCostMilli: t.total_cost_milli,
      createdAt: t.created_at,
      claimedAt: t.claimed_at,
      finishedAt: t.finished_at,
      timeline: repos.listTaskEvents(t.id).map((e) => ({
        from: e.from_status ?? null,
        to: e.to_status ?? null,
        actorType: e.actor_type ?? null,
        actorId: e.actor_id ?? null,
        note: e.note ?? null,
        createdAt: e.created_at ?? null,
      })),
    }),
  );
  zip.file('tasks.jsonl', taskLines.join('\n') + (taskLines.length ? '\n' : ''));

  zip.file(
    'projects.json',
    JSON.stringify(
      repos.listProjects(workspaceId).map((p) => ({
        id: p.id,
        name: p.name,
        brief: p.brief,
        teamId: p.team_id,
        clientName: p.client_name,
        status: p.status,
        createdAt: p.created_at,
      })),
      null,
      2,
    ),
  );

  // results/：每份 done 成果一份 md，复用现有单成果导出渲染（taskToMarkdown）
  const doneTasks = tasks.filter((t) => t.status === TaskStatus.DONE);
  const resultsFolder = zip.folder('results');
  for (const t of doneTasks) {
    resultsFolder?.file(`${t.id}.md`, taskToMarkdown(t));
  }

  zip.file(
    'kb.json',
    JSON.stringify(
      repos.listKb(workspaceId).map((k) => ({
        id: k.id,
        title: k.title,
        body: k.body,
        scope: k.scope,
        scopeId: k.scope_id,
        tags: parseJsonSafe(k.tags),
        enabled: k.enabled === 1,
        ownerUserId: k.owner_user_id ?? null,
        createdAt: k.created_at,
        updatedAt: k.updated_at,
      })),
      null,
      2,
    ),
  );

  // assets.json：含全部版本快照
  const assets = repos.listAssets(workspaceId);
  zip.file(
    'assets.json',
    JSON.stringify(
      assets.map((a) => {
        const versions: Array<{ version: number; content: unknown }> = [];
        for (let v = 1; v <= a.version; v++) {
          const content = repos.getAssetVersion(a.id, v);
          if (content !== undefined) versions.push({ version: v, content: parseJsonSafe(content) });
        }
        return {
          id: a.id,
          typeId: a.type_id,
          name: a.name,
          version: a.version,
          content: parseJsonSafe(a.content),
          versions,
          createdBy: a.created_by,
          createdAt: a.created_at,
          updatedAt: a.updated_at,
        };
      }),
      null,
      2,
    ),
  );

  zip.file(
    'skills.json',
    JSON.stringify(
      repos.listWorkspaceSkills(workspaceId).map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        description: s.description,
        role: s.role,
        promptTemplate: s.prompt_template,
        inputSchema: parseJsonSafe(s.input_schema),
        kbBinding: parseJsonSafe(s.kb_binding),
        outputSpec: s.output_spec,
        exampleInput: parseJsonSafe(s.example_input),
        exampleOutput: s.example_output,
        version: s.version,
        status: s.status,
        visibility: s.visibility,
        sourceSkillId: s.source_skill_id,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      })),
      null,
      2,
    ),
  );

  zip.file(
    'members-teams.json',
    JSON.stringify(
      {
        teams: repos
          .listTeams(workspaceId)
          .map((t) => ({ id: t.id, name: t.name, color: t.color, apiId: t.api_id })),
        members: repos.listMembers(workspaceId).map((m) => ({
          id: m.id,
          teamId: m.team_id,
          name: m.name,
          role: m.role,
          persona: m.persona,
          prompt: m.prompt,
          skillTags: parseJsonSafe(m.skill_tags),
        })),
      },
      null,
      2,
    ),
  );

  zip.file('ledger.csv', ledgerToCsv(repos, workspaceId));

  // settings.json：apis 只出 name/provider/model + 掩码；
  // channels / notify 邮箱类配置只出「已配置/未配置」，不带任何地址/令牌/授权码原文。
  const channels = repos.getSetting<{ mj?: { baseUrl?: string; tokenEnc?: string } }>(
    'channels',
    {},
    workspaceId,
  );
  const notifyConfig = repos.getSetting<{ emailEnabled?: boolean; email?: string }>(
    'notifyConfig',
    { emailEnabled: false, email: '' },
    workspaceId,
  );
  zip.file(
    'settings.json',
    JSON.stringify(
      {
        workspace: ws ? { id: ws.id, name: ws.name, industryPackId: ws.industry_pack_id } : null,
        apis: repos.listApis(workspaceId).map((a) => ({
          id: a.id,
          name: a.name,
          provider: a.provider,
          model: a.model,
          apiKeyMasked: maskKey(decryptKey(a.api_key_enc)),
          hasKey: !!decryptKey(a.api_key_enc),
        })),
        defaultApiId: repos.getSetting<string | null>('defaultApiId', null, workspaceId),
        reviewStandards: repos.getSetting(
          'reviewStandards',
          { points: '', clientNeeds: '' },
          workspaceId,
        ),
        params: repos.getSetting('params', { concurrency: 4, taskBudgetTokens: 0 }, workspaceId),
        timezone: repos.getSetting<string>('timezone', 'Asia/Shanghai', workspaceId),
        lowBalanceThresholdMilli: repos.getSetting<number | null>(
          'lowBalanceThresholdMilli',
          null,
          workspaceId,
        ),
        channels: {
          mj: channels.mj?.baseUrl || channels.mj?.tokenEnc ? '已配置' : '未配置',
        },
        notify: {
          email: notifyConfig.email ? '已配置' : '未配置',
        },
      },
      null,
      2,
    ),
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return {
    buffer,
    counts: {
      tasks: tasks.length,
      results: doneTasks.length,
      kb: repos.listKb(workspaceId).length,
      assets: assets.length,
      skills: repos.listWorkspaceSkills(workspaceId).length,
    },
    elapsedMs: Date.now() - t0,
  };
}
