import { TaskStatus } from '@swarm/shared';
import type { Repos } from '../store/repositories';
import { escapeHtml } from './markdown';

/**
 * 办公室参观页（G-13）：公开只读呈现一个空间的「门面」——空间名、行业包名、成员名单与
 * 状态聚合、近 30 天完成数、成员能力卡。
 *
 * 参观数据只经 buildVisitPageData 一个出口组装，可出字段在
 * 下方逐个显式列举；绝不包含：任何任务标题 / brief / result、账本金额、知识与资产内容。
 * review 时逐字段对照此清单（验收断言 1 的零泄漏清单同源）。
 */

export type VisitMemberStatus = '待命' | '执行中' | '待审核';

export interface VisitMemberCard {
  name: string;
  roleName: string;
  skillTags: string[];
  personaFirstLine: string;
  status: VisitMemberStatus;
}

export interface VisitPageData {
  workspaceName: string;
  industryPackName: string | null;
  members: VisitMemberCard[];
  /** 成员状态聚合计数（按成员当前状态计人头，非任务数） */
  statusCounts: Record<VisitMemberStatus, number>;
  completedLast30Days: number;
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 参观页数据组装（白名单出口）：状态口径与办公室画布 statusOf 同源（state 同源聚合） */
export function buildVisitPageData(repos: Repos, workspaceId: string): VisitPageData {
  const ws = repos.getWorkspace(workspaceId);
  const tasks = repos.listTasks(workspaceId);
  const packId = ws?.industry_pack_id ?? null;
  const pack = packId ? repos.getIndustryPack(packId) : undefined;
  const roleNameById = new Map(
    repos.listRolesVisible(workspaceId, packId).map((r) => [r.role_id, r.name] as const),
  );
  const statusCounts: Record<VisitMemberStatus, number> = { 待命: 0, 执行中: 0, 待审核: 0 };
  const members: VisitMemberCard[] = repos.listMembers(workspaceId).map((m) => {
    // 与 PixelOffice.statusOf 同口径：自己有执行中任务 → 执行中；审核工种且本组有待审核 → 待审核；余皆待命
    let status: VisitMemberStatus = '待命';
    if (tasks.some((t) => t.assignee_id === m.id && t.status === TaskStatus.RUNNING)) {
      status = '执行中';
    } else if (
      (roleNameById.get(m.role) ?? m.role).includes('审核') &&
      tasks.some((t) => t.team_id === m.team_id && t.status === TaskStatus.REVIEWING)
    ) {
      status = '待审核';
    }
    statusCounts[status]++;
    return {
      name: m.name,
      roleName: roleNameById.get(m.role) ?? m.role,
      skillTags: parseTags(m.skill_tags),
      personaFirstLine: (m.persona || '').split('\n')[0] ?? '',
      status,
    };
  });
  const since = Date.now() - 30 * 86_400_000;
  const completedLast30Days = tasks.filter(
    (t) =>
      t.status === TaskStatus.DONE &&
      t.finished_at !== null &&
      new Date(t.finished_at).getTime() >= since,
  ).length;
  return {
    workspaceName: ws?.name ?? '',
    industryPackName: pack?.name ?? null,
    members,
    statusCounts,
    completedLast30Days,
  };
}

/** 参观页服务端渲染（独立页，套现有视觉 token 的静态 CSS，与交付页同法；全部字段转义） */
export function renderVisitHtml(data: VisitPageData): string {
  const cards = data.members
    .map(
      (
        m,
      ) => `<div class="mcard"><div class="mname">${escapeHtml(m.name)} <span class="mrole">${escapeHtml(m.roleName)}</span></div>
<div class="mstatus">${escapeHtml(m.status)}</div>
${m.personaFirstLine ? `<div class="mpersona">${escapeHtml(m.personaFirstLine)}</div>` : ''}
${m.skillTags.length ? `<div class="mtags">${m.skillTags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
</div>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(data.workspaceName)} · 办公室参观</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f1e7;color:#2b2620;margin:0;padding:32px 16px}
.wrap{max-width:820px;margin:0 auto;background:#fffdf7;border:2px solid #2b2620;border-radius:14px;padding:28px 30px;box-shadow:4px 4px 0 #2b2620}
h1{font-size:22px;margin:0 0 6px}.meta{color:#8a7f6d;font-size:13px;margin-bottom:18px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}
.stat{border:2px solid #2b2620;border-radius:10px;padding:8px 14px;background:#fff;box-shadow:2px 2px 0 #2b2620;font-size:14px}
.stat b{font-size:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.mcard{border:2px solid #2b2620;border-radius:10px;padding:12px 14px;background:#fff}
.mname{font-weight:800}.mrole{color:#8a7f6d;font-weight:600;font-size:13px}
.mstatus{display:inline-block;margin-top:6px;font-size:12px;border:1.5px solid #2b2620;border-radius:999px;padding:1px 8px;background:#f6f1e7}
.mpersona{margin-top:8px;font-size:13px;line-height:1.6;color:#4a4237}
.mtags{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.tag{font-size:12px;border:1.5px solid #cbbfa5;border-radius:999px;padding:0 7px;color:#4a4237}
.foot{margin-top:24px;padding-top:12px;border-top:1px dashed #cbbfa5;color:#8a7f6d;font-size:12px}
@media (max-width:600px){body{padding:16px 8px}.wrap{padding:18px 16px}h1{font-size:19px}.grid{grid-template-columns:1fr}}
</style></head>
<body><div class="wrap"><h1>${escapeHtml(data.workspaceName)}</h1>
<div class="meta">AI 团队办公室参观${data.industryPackName ? ` · 行业包：${escapeHtml(data.industryPackName)}` : ''}</div>
<div class="stats">
<span class="stat">成员 <b>${data.members.length}</b></span>
<span class="stat">待命 <b>${data.statusCounts['待命']}</b></span>
<span class="stat">执行中 <b>${data.statusCounts['执行中']}</b></span>
<span class="stat">待审核 <b>${data.statusCounts['待审核']}</b></span>
<span class="stat">近 30 天完成 <b>${data.completedLast30Days}</b> 单</span>
</div>
<div class="grid">
${cards}
</div>
<div class="foot">由「干活蜂群」生成 · 只读参观页（不含任务内容与账目）</div></div></body></html>`;
}

/** XML 文本节点转义（分享卡 SVG 专用，与 HTML 转义同线） */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text: string, perLine: number, maxLines: number): string[] {
  const chars = [...text];
  const lines: string[] = [];
  for (let i = 0; i < chars.length && lines.length < maxLines; i += perLine) {
    lines.push(chars.slice(i, i + perLine).join(''));
  }
  if (chars.length > perLine * maxLines && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1]!.slice(0, -1) + '…';
  }
  return lines;
}

/**
 * 成果分享卡（G-13）：1200×630 SVG，server 模板字符串拼装，全部文本节点 XML 转义。
 * 内容 = 成果标题 + 摘要前 140 字 + 空间名 + 平台标识 + 日期。
 */
export function renderShareCardSvg(input: {
  title: string;
  result: string;
  workspaceName: string;
  date: string;
}): string {
  const summary = [...(input.result || '').replace(/\s+/g, ' ').trim()].slice(0, 140).join('');
  const titleLines = wrapText(input.title || '未命名成果', 24, 2);
  const summaryLines = wrapText(summary, 42, 3);
  const titleSvg = titleLines
    .map(
      (l, i) =>
        `<text x="72" y="${168 + i * 58}" font-size="46" font-weight="800" fill="#2b2620">${escapeXml(l)}</text>`,
    )
    .join('');
  const summarySvg = summaryLines
    .map(
      (l, i) =>
        `<text x="72" y="${330 + i * 40}" font-size="26" fill="#4a4237">${escapeXml(l)}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#f6f1e7"/>
<rect x="36" y="36" width="1128" height="558" rx="18" fill="#fffdf7" stroke="#2b2620" stroke-width="4"/>
<rect x="72" y="72" width="52" height="52" rx="10" fill="#e2574c"/>
<text x="98" y="110" font-size="30" font-weight="800" fill="#ffffff" text-anchor="middle">MJ</text>
<text x="140" y="110" font-size="28" font-weight="700" fill="#2b2620">干活蜂群 · 成果分享</text>
${titleSvg}
${summarySvg}
<text x="72" y="540" font-size="24" fill="#8a7f6d">${escapeXml(input.workspaceName)} · ${escapeXml(input.date)}</text>
<text x="1128" y="540" font-size="24" fill="#8a7f6d" text-anchor="end">干活蜂群</text>
</svg>`;
}
