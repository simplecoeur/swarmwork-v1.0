import { createHash } from 'node:crypto';
import {
  PLATFORM_WORKSPACE_ID,
  type AgentTemplateRow,
  type Repos,
} from '../store/repositories';
import { nowIso, uid } from '../util';
import { parseAgencyAgent, parseFrontmatter } from './parseAgencyAgent';

/**
 * v1.4.0 J：GitHub 智能体同步服务（白名单源 → agent_templates 草稿区）。
 * 同步只写 draft_*：新文件建 pending_review；已上架文件有变更只置 has_pending_update，
 * pub 快照一字不动，等管理员复审（approve/reject 在路由层）。哈希未变不写库（幂等）。
 * fetcher 可注入（测试离线跑 fixture + 假 fetch）；默认走全局 fetch 拉 GitHub。
 * 基址可用 env AGENT_SYNC_GITHUB_API / AGENT_SYNC_GITHUB_RAW 覆盖（本地桩测试用），默认官方地址。
 */

export interface AgentSyncSource {
  id: string;
  repo: string;
  branch: string;
  license: string;
  author: string;
  /** v1.5.0 C：许可证漂移整源暂停标记（管理员在源管理里手动恢复） */
  paused?: boolean;
  pauseReason?: string;
}

export const AGENT_SYNC_SOURCES_KEY = 'agentSyncSources';

/** 首源（协调者已核实：163k stars、MIT、LICENSE 署名 AgentLand Contributors） */
export const DEFAULT_AGENT_SYNC_SOURCES: AgentSyncSource[] = [
  {
    id: 'agency-agents',
    repo: 'msitarzewski/agency-agents',
    branch: 'main',
    license: 'MIT',
    author: 'AgentLand Contributors',
  },
];

/** divisions.json 拉取失败时的内置兜底 division 集合（与首源仓库 divisions.json 的键一致） */
export const FALLBACK_DIVISIONS = [
  'academic', 'design', 'engineering', 'finance', 'game-development', 'gis', 'healthcare',
  'marketing', 'paid-media', 'product', 'project-management', 'research', 'sales', 'security',
  'spatial-computing', 'specialized', 'support', 'testing',
];

/** 读白名单（平台伪空间 settings）；首次读取把首源种子写入后返回 */
export function getAgentSyncSources(repos: Repos): AgentSyncSource[] {
  const existing = repos.getSetting<AgentSyncSource[] | null>(
    AGENT_SYNC_SOURCES_KEY,
    null,
    PLATFORM_WORKSPACE_ID,
  );
  if (Array.isArray(existing)) return existing;
  repos.setSetting(AGENT_SYNC_SOURCES_KEY, DEFAULT_AGENT_SYNC_SOURCES, PLATFORM_WORKSPACE_ID);
  return [...DEFAULT_AGENT_SYNC_SOURCES];
}

export function saveAgentSyncSources(repos: Repos, sources: AgentSyncSource[]): AgentSyncSource[] {
  repos.setSetting(AGENT_SYNC_SOURCES_KEY, sources, PLATFORM_WORKSPACE_ID);
  return sources;
}

/** 可注入的取数函数：返回响应文本，非 2xx 抛错（message 带状态码与 URL） */
export type AgentFetcher = (url: string) => Promise<string>;

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'user-agent': 'agent-swarm-agent-sync',
    accept: 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

export const defaultAgentFetcher: AgentFetcher = async (url: string): Promise<string> => {
  const r = await fetch(url, { headers: githubHeaders() });
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
  return r.text();
};

const apiBase = (): string => process.env.AGENT_SYNC_GITHUB_API ?? 'https://api.github.com';
const rawBase = (): string => process.env.AGENT_SYNC_GITHUB_RAW ?? 'https://raw.githubusercontent.com';

export interface AgentSyncResult {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** v1.5.0 C：单文件失败明细（结构校验不过/拉取失败），进 run 记录 */
  failedDetails: Array<{ path: string; reason: string }>;
}

/**
 * v1.5.0 C 内容安全预筛（只标记 risk、不自动驳回，最终过/驳由管理员在审核中心定）：
 * sensitive_word 敏感词 / external_link 正文含外链 / install_command 含安装或执行命令段落 /
 * prompt_injection 疑似提示词注入话术 / overlong 正文超长。
 */
const RISK_SENSITIVE_WORDS = [
  '身份证号', '银行卡号', '转账到', '提供密码', '短信验证码',
  'credit card number', 'wire transfer to', 'send your password', 'social security number',
];
const RISK_INJECTION_PATTERNS = [
  '忽略以上指令', '忽略之前的指令', '无视系统提示', 'ignore previous instructions',
  'ignore all previous', 'disregard the system prompt', 'you are now in developer mode',
];
export function scanAgentRiskFlags(persona: string): string[] {
  const flags: string[] = [];
  const lower = persona.toLowerCase();
  if (RISK_SENSITIVE_WORDS.some((w) => lower.includes(w.toLowerCase()))) flags.push('sensitive_word');
  if (/https?:\/\/[^\s)]+/i.test(persona)) flags.push('external_link');
  if (/(npm install|pip install|yarn add|pnpm add|curl\s+https?:|wget\s+https?:|bash\s+-c|powershell\s)/i.test(persona)) {
    flags.push('install_command');
  }
  if (RISK_INJECTION_PATTERNS.some((w) => lower.includes(w.toLowerCase()))) flags.push('prompt_injection');
  if (persona.length > 20000) flags.push('overlong');
  return flags;
}

interface TreeEntry {
  path?: string;
  type?: string;
}

/** divisions.json → division 集合；任何失败（拉取/解析/无 divisions 键）回内置兜底 */
async function fetchDivisions(source: AgentSyncSource, fetcher: AgentFetcher): Promise<Set<string>> {
  try {
    const text = await fetcher(`${rawBase()}/${source.repo}/${source.branch}/divisions.json`);
    const parsed = JSON.parse(text) as { divisions?: Record<string, unknown> };
    const keys = parsed.divisions ? Object.keys(parsed.divisions) : [];
    if (keys.length > 0) return new Set(keys);
  } catch {
    /* 落到兜底 */
  }
  return new Set(FALLBACK_DIVISIONS);
}

/** 并发池：最多 limit 个任务同时跑（同步逐文件拉取限 6 以内） */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 同步一个白名单源 → agent_templates。
 * 整源级失败（trees 请求失败/结构不对）抛错，由路由回 502 带原文，不编造计数；
 * 单文件失败计 failed、不中断整体。
 */
export async function syncAgentSource(
  repos: Repos,
  source: AgentSyncSource,
  fetcher: AgentFetcher = defaultAgentFetcher,
): Promise<AgentSyncResult> {
  const treeUrl = `${apiBase()}/repos/${source.repo}/git/trees/${source.branch}?recursive=1`;
  const treeText = await fetcher(treeUrl);
  let tree: TreeEntry[];
  try {
    const parsed = JSON.parse(treeText) as { tree?: TreeEntry[] };
    if (!Array.isArray(parsed.tree)) throw new Error('响应缺少 tree 数组');
    tree = parsed.tree;
  } catch (e) {
    throw new Error(`解析 GitHub trees 响应失败（${treeUrl}）：${e instanceof Error ? e.message : String(e)}`);
  }
  const divisions = await fetchDivisions(source, fetcher);
  const paths = tree
    .filter((t) => t.type === 'blob' && typeof t.path === 'string')
    .map((t) => t.path as string)
    .filter((p) => {
      // 只收 division 直属 *.md（division/*.md）；子目录、非 division 目录不收
      const m = /^([^/]+)\/([^/]+\.md)$/.exec(p);
      return m !== null && divisions.has(m[1]);
    })
    .sort();

  const result: AgentSyncResult = {
    fetched: paths.length, created: 0, updated: 0, unchanged: 0, failed: 0, failedDetails: [],
  };
  await mapPool(paths, 6, async (sourcePath) => {
    try {
      const raw = await fetcher(`${rawBase()}/${source.repo}/${source.branch}/${sourcePath}`);
      // v1.5.0 C 结构校验：frontmatter 缺 name/description 的文件不进待审，直接记 failed 明细
      const { fm } = parseFrontmatter(raw);
      if (!(fm.name ?? '').trim() || !(fm.description ?? '').trim()) {
        result.failed++;
        result.failedDetails.push({
          path: sourcePath,
          reason: `frontmatter 缺 ${!(fm.name ?? '').trim() ? 'name' : 'description'}`,
        });
        return;
      }
      const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
      const parsed = parseAgencyAgent(raw, sourcePath);
      const riskFlags = JSON.stringify(scanAgentRiskFlags(parsed.persona));
      const division = sourcePath.split('/')[0];
      const existing = repos.getAgentTemplateBySource(source.repo, sourcePath);
      const ts = nowIso();
      if (!existing) {
        const row: AgentTemplateRow = {
          id: uid('agenttpl'),
          source_repo: source.repo,
          source_path: sourcePath,
          division,
          draft_name: parsed.name,
          draft_specialty: parsed.specialty,
          draft_persona: parsed.persona,
          draft_role: parsed.suggestedRole,
          pub_name: null,
          pub_specialty: null,
          pub_persona: null,
          pub_role: null,
          language: parsed.language,
          source_author: source.author,
          license: source.license,
          content_hash: hash,
          status: 'pending_review',
          has_pending_update: 0,
          reject_reason: '',
          recruit_count: 0,
          created_at: ts,
          updated_at: ts,
          risk_flags: riskFlags,
          pub_at: null,
        };
        repos.insertAgentTemplate(row);
        result.created++;
        return;
      }
      if (existing.content_hash === hash) {
        result.unchanged++;
        return;
      }
      // hash 变了：只更新 draft（+ 哈希/语言/division/署名随源刷新），pub 快照一字不动
      const next: AgentTemplateRow = {
        ...existing,
        division,
        draft_name: parsed.name,
        draft_specialty: parsed.specialty,
        draft_persona: parsed.persona,
        draft_role: parsed.suggestedRole,
        language: parsed.language,
        source_author: source.author,
        license: source.license,
        content_hash: hash,
        risk_flags: riskFlags,
        updated_at: ts,
      };
      if (existing.status === 'public') {
        next.has_pending_update = 1;
      } else if (existing.status === 'rejected') {
        next.status = 'pending_review';
        next.reject_reason = '';
      }
      repos.updateAgentTemplate(next);
      result.updated++;
    } catch (e) {
      result.failed++;
      result.failedDetails.push({
        path: sourcePath,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  });
  return result;
}
