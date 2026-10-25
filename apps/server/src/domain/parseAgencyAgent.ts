/**
 * v1.4.0 J：agency-agents 风格 agent 文件解析适配器。
 * 文件格式 = YAML frontmatter（扁平 key: value，值可带引号）+ Markdown 正文（完整人设）。
 * 只做本项目需要的事：name / description / 正文 / 语言粗判 / 工种粗映射，不引 YAML 依赖。
 */

/** 注册表基础工种（与 seed ROLE_PERSONAS / 迁移 004 一致，映射结果只许落在这五个里） */
export const BASE_ROLES = ['组长', '研究员', '文案', '程序员', '审核'] as const;

export interface ParsedAgent {
  name: string;
  specialty: string;
  persona: string;
  language: 'en' | 'zh';
  suggestedRole: string;
}

/** 扁平 frontmatter 解析：只认首个 --- ... --- 块内的 `key: value` 行，值去成对引号 */
export function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return { fm: {}, body: text };
  const lines = text.split('\n');
  const fm: Record<string, string> = {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---' || line.trim() === '...') {
      end = i;
      break;
    }
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) {
      let v = m[2].trim();
      if (
        v.length >= 2 &&
        ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      ) {
        v = v.slice(1, -1);
      }
      fm[m[1]] = v;
    }
  }
  if (end < 0) return { fm: {}, body: text };
  return { fm, body: lines.slice(end + 1).join('\n') };
}

/** 文件名美化回退名：marketing-content-creator → Marketing Content Creator */
function prettyNameFromPath(sourcePath: string): string {
  const base = sourcePath.split('/').pop() ?? sourcePath;
  return base
    .replace(/\.md$/i, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** 正文汉字占比（汉字数 / 非空白字符数）> 0.25 判 zh */
export function detectLanguage(body: string): 'en' | 'zh' {
  const chars = body.replace(/\s/g, '');
  if (!chars) return 'en';
  const han = (body.match(/[一-鿿]/g) ?? []).length;
  return han / chars.length > 0.25 ? 'zh' : 'en';
}

/**
 * 工种粗映射（顺序即优先级，关键词对 name+description+division 小写全文匹配）：
 * 审核 → 程序员 → 研究员 → 组长 → 文案，兜底文案。
 */
const ROLE_RULES: Array<{ role: string; keywords: string[] }> = [
  { role: '审核', keywords: ['review', 'audit', 'qa', 'quality', 'test', 'compliance'] },
  {
    role: '程序员',
    keywords: ['engineer', 'develop', 'architect', 'devops', 'software', 'code', 'security', 'data engineer'],
  },
  { role: '研究员', keywords: ['research', 'analyst', 'scientist', 'seo', 'data'] },
  { role: '组长', keywords: ['manager', 'lead', 'director', 'strategist', 'product manager', 'head'] },
  { role: '文案', keywords: ['content', 'writ', 'copy', 'market', 'brand', 'social', 'design', 'editor'] },
];

/** 关键词按「词」命中：两侧须为非小写字母边界，避免 develops 误命中 develop、testing 误命中 test */
function keywordHit(hay: string, keyword: string): boolean {
  const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`).test(hay);
}

export function suggestRole(name: string, description: string, division: string): string {
  const hay = `${name} ${description} ${division}`.toLowerCase();
  for (const rule of ROLE_RULES) {
    if (rule.keywords.some((k) => keywordHit(hay, k))) return rule.role;
  }
  return '文案';
}

/** 解析一个 agent 文件全文 → 模板草稿字段 */
export function parseAgencyAgent(raw: string, sourcePath: string): ParsedAgent {
  const { fm, body } = parseFrontmatter(raw);
  const persona = body.trim();
  const name = (fm.name ?? '').trim() || prettyNameFromPath(sourcePath);
  let specialty = (fm.description ?? '').trim();
  if (!specialty) {
    // 回退：正文首个实段（跳过纯标题段）纯文本截 200 字
    const paras = persona
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const para = paras.find((p) => !/^#+\s/.test(p)) ?? paras[0] ?? '';
    specialty = para.replace(/^#+\s*/, '').slice(0, 200);
  }
  const division = sourcePath.split('/')[0] ?? '';
  return {
    name,
    specialty,
    persona,
    language: detectLanguage(persona),
    suggestedRole: suggestRole(name, fm.description ?? '', division),
  };
}
