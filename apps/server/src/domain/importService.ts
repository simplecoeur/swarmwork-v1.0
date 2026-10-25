import mammoth from 'mammoth';
import { ErrorCode, type AssetSectionDto, type KbImportDraftDto } from '@swarm/shared';
import { DomainError } from './taskService';

/**
 * 文件导入解析（G-06，domain 内自研轻量实现；仅 docx 引 mammoth，不引其他解析库）：
 * - md 按标题层级切分（标题行作 title；无标题段落按空行分段、首行作 title 截断 80 字）；
 * - txt 按空行分段（首行作 title 截断 80 字，正文保留整段以免单行段落正文为空）；
 * - csv 约定列 title,body,tags（首行表头），引号转义按 RFC 4180 基本口径；
 * - docx 经 mammoth 转 HTML 后转纯文本（清洗残留标签）再走与 txt/md 相同的拆分管线；
 * - 资产按集标记行首正则切分（见 EPISODE_MARKER_RE），无标记则整文件单 section（key=full）。
 * 不做云端数据源 / URL 抓取。上限（文件大小/条数）在路由层按 IMPORT_LIMITS 校验，超限零落库。
 */

export type ImportFormat = 'md' | 'txt' | 'csv' | 'docx';

/** 由文件名扩展名判定格式（不支持的扩展名回 null，路由层转 VALIDATION） */
export function detectImportFormat(filename: string): ImportFormat | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'txt') return 'txt';
  if (ext === 'csv') return 'csv';
  if (ext === 'docx') return 'docx';
  return null;
}

/** 文本规整：去 BOM、统一换行（txt/md/csv 共用；不做标签清洗——纯文本里的尖括号是用户原文） */
export function normalizePlainText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** HTML 实体解码（&amp; 最后解，避免 &amp;lt; 被二次解码成 <） */
export function decodeHtmlEntities(html: string): string {
  const out = html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
  return out.replace(/&amp;/g, '&');
}

/**
 * mammoth 的 HTML 输出转纯文本：<br> → 换行、</p> → 空行（段落边界），
 * 其余标签一律剥除，最后解实体并再剥一遍残留标签样式片段，保证正文无格式残留。
 */
export function htmlToPlainText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<\/li\s*>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]*>/g, '');
  return normalizePlainText(decodeHtmlEntities(stripped)).replace(/<[^>]*>/g, '');
}

/** docx → 纯文本（mammoth convertToHtml 后走 htmlToPlainText 清洗管线） */
export async function docxToPlainText(buffer: Buffer): Promise<string> {
  let html: string;
  try {
    html = (await mammoth.convertToHtml({ buffer })).value;
  } catch (e) {
    throw new DomainError(
      ErrorCode.VALIDATION,
      `docx 解析失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return htmlToPlainText(html);
}

export function truncateTitle(s: string, max = 80): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** 按空行分段（txt / 无标题 md / docx 纯文本共用）：首行作 title（截断 80 字），正文为整段原文 */
export function parseParagraphDrafts(text: string): KbImportDraftDto[] {
  const drafts: KbImportDraftDto[] = [];
  for (const block of normalizePlainText(text).split(/\n[ \t]*\n+/)) {
    const body = block.trim();
    if (!body) continue;
    const firstLine = body.split('\n')[0] ?? '';
    drafts.push({ title: truncateTitle(firstLine), body, tags: [] });
  }
  return drafts;
}

const MD_HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

/**
 * md 按标题层级切分：每个标题行开启一条草案（title = 标题文本，正文 = 标题后到下一标题前的内容）。
 * 首个标题之前若有非空前言，按段落口径拆成草案排在最前；全文无标题时整体走段落口径。
 * 不支持 Setext 式标题（===/--- 下划线式）与标题内的行内格式剥离（标题原文即 title）。
 */
export function parseMarkdownDrafts(text: string): KbImportDraftDto[] {
  const lines = normalizePlainText(text).split('\n');
  if (!lines.some((l) => MD_HEADING_RE.test(l))) return parseParagraphDrafts(text);
  const drafts: KbImportDraftDto[] = [];
  const preamble: string[] = [];
  let current: { title: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    drafts.push({
      title: truncateTitle(current.title),
      body: current.lines.join('\n').trim(),
      tags: [],
    });
    current = null;
  };
  for (const line of lines) {
    const m = MD_HEADING_RE.exec(line);
    if (m) {
      flush();
      current = { title: m[1] ?? '', lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  flush();
  const head = parseParagraphDrafts(preamble.join('\n'));
  return [...head, ...drafts];
}

/**
 * CSV 行解析（RFC 4180 基本口径）：逗号分隔、双引号包裹字段（字段内可含逗号/换行）、
 * 字段内双引号以 "" 转义、CRLF 与 LF 均作行界。
 * 不支持的边界（有意不支持，勿当 bug）：自定义分隔符（固定逗号）、单引号转义、
 * 引号只在字段开头才开启引用（字段中途的 " 按字面保留）、未闭合引号按延伸到文件尾收束。
 */
export function parseCsvRows(text: string): string[][] {
  const src = normalizePlainText(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  const endField = (): void => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] ?? '';
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted && field === '') {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (field !== '' || row.length > 0 || fieldStarted) endRow();
  return rows;
}

/** tags 单元格拆分：单元格内多个标签以 ; ； | 或逗号分隔（逗号须在 CSV 层已被引号包裹才进得了单元格） */
export function splitTagsCell(cell: string): string[] {
  return cell
    .split(/[,，;；|]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** csv → KB 草案：首行必须为表头且含 title/body 列（tags 列可选）；全空行跳过 */
export function parseCsvDrafts(text: string): KbImportDraftDto[] {
  const rows = parseCsvRows(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) return [];
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const titleIdx = header.indexOf('title');
  const bodyIdx = header.indexOf('body');
  const tagsIdx = header.indexOf('tags');
  if (titleIdx < 0 || bodyIdx < 0) {
    throw new DomainError(ErrorCode.VALIDATION, 'CSV 首行表头需包含 title,body,tags 列');
  }
  const drafts: KbImportDraftDto[] = [];
  for (const r of rows.slice(1)) {
    drafts.push({
      title: (r[titleIdx] ?? '').trim(),
      body: (r[bodyIdx] ?? '').trim(),
      tags: tagsIdx >= 0 ? splitTagsCell(r[tagsIdx] ?? '') : [],
    });
  }
  return drafts;
}

/** KB 文件 → 草案数组（按扩展名分发；docx 先提纯文本再按段落拆分） */
export async function parseKbDrafts(filename: string, buffer: Buffer): Promise<KbImportDraftDto[]> {
  const format = detectImportFormat(filename);
  if (!format) {
    throw new DomainError(ErrorCode.VALIDATION, `不支持的文件类型「${filename}」，仅支持 .md/.txt/.csv/.docx`);
  }
  if (format === 'docx') return parseParagraphDrafts(await docxToPlainText(buffer));
  const text = buffer.toString('utf8');
  if (format === 'md') return parseMarkdownDrafts(text);
  if (format === 'csv') return parseCsvDrafts(text);
  return parseParagraphDrafts(text);
}

/* ---------- 资产分段 ---------- */

/** 集标记：行首「第<数>集/话/回」（数可为阿拉伯数字或中文数字），与施工图正则同口径 */
export const EPISODE_MARKER_RE = /^第\s*([0-9零一二三四五六七八九十百]+)\s*[集话回]/;

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字 → 整数（支持到「百」位，如 二十三=23、一百二十=120；阿拉伯数字串直接转） */
export function episodeNumberToInt(raw: string): number {
  const s = raw.replace(/\s/g, '');
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let result = 0;
  let current = 0;
  for (const ch of s) {
    if (ch === '十') {
      result += (current === 0 ? 1 : current) * 10;
      current = 0;
    } else if (ch === '百') {
      result += (current === 0 ? 1 : current) * 100;
      current = 0;
    } else if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch] ?? 0;
    }
  }
  return result + current;
}

/**
 * 资产文本 → sections 草案：每个集标记行开启一段（key=ep<序号>、title=该行全文、
 * body=标记行之后到下一标记之前的内容）；标记前的前言并入第一段正文开头（不丢内容，
 * 无第一段时前言按无标记口径处理）；全文无任何标记 → 整文件单 section（key=full）。
 */
export function parseAssetSections(text: string, fallbackTitle: string): AssetSectionDto[] {
  const lines = normalizePlainText(text).split('\n');
  const sections: Array<{ key: string; title: string; lines: string[] }> = [];
  const preamble: string[] = [];
  let current: { key: string; title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = EPISODE_MARKER_RE.exec(line.trimStart());
    if (m) {
      const num = episodeNumberToInt(m[1] ?? '');
      current = { key: `ep${num}`, title: line.trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (!sections.length) {
    const body = normalizePlainText(text).trim();
    return [{ key: 'full', title: fallbackTitle, body }];
  }
  const pre = preamble.join('\n').trim();
  if (pre && sections[0]) {
    const first = sections[0];
    first.lines = [pre, '', ...first.lines];
  }
  return sections.map((s) => ({ key: s.key, title: s.title, body: s.lines.join('\n').trim() }));
}

/** 资产文件 → sections 草案（docx 同走提纯管线；csv 不作资产导入格式） */
export async function parseAssetSectionsFromFile(
  filename: string,
  buffer: Buffer,
  fallbackTitle: string,
): Promise<AssetSectionDto[]> {
  const format = detectImportFormat(filename);
  if (!format || format === 'csv') {
    throw new DomainError(ErrorCode.VALIDATION, `不支持的文件类型「${filename}」，资产导入支持 .txt/.md/.docx`);
  }
  const text = format === 'docx' ? await docxToPlainText(buffer) : buffer.toString('utf8');
  return parseAssetSections(text, fallbackTitle);
}
