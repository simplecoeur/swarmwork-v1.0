/**
 * usage 估算与审核结论解析（设计 §8、§15.1）。
 * 估算口径：中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isCjk =
      (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
      (cp >= 0x4e00 && cp <= 0x9fff) || // 基本汉字
      (cp >= 0xf900 && cp <= 0xfaff) || // 兼容汉字
      (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
      (cp >= 0xff00 && cp <= 0xffef); // 全角字符
    tokens += isCjk ? 1 : 0.25;
  }
  return Math.max(1, Math.ceil(tokens));
}

/** 厂商 usage 归一化：缺失字段按文本估算并标记 estimated */
export function normalizeUsage(
  raw: { promptTokens?: number | null; completionTokens?: number | null },
  promptText: string,
  completionText: string,
): { promptTokens: number; completionTokens: number; estimated: boolean } {
  const promptEstimated = raw.promptTokens == null;
  const completionEstimated = raw.completionTokens == null;
  return {
    promptTokens: promptEstimated ? estimateTokens(promptText) : (raw.promptTokens as number),
    completionTokens: completionEstimated
      ? estimateTokens(completionText)
      : (raw.completionTokens as number),
    estimated: promptEstimated || completionEstimated,
  };
}

export interface Verdict {
  pass: boolean;
  reason: string;
}

/**
 * 审核结论解析兜底（§8）：先提取 JSON；失败再正则找 "pass":true；
 * 仍失败 → 视为不通过并附原文，绝不让脏数据蒙混过关。
 */
export function parseVerdict(text: string): Verdict {
  const m = (text || '').match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { pass?: unknown; reason?: unknown };
      if (typeof j.pass === 'boolean') {
        return { pass: j.pass, reason: String(j.reason ?? '') };
      }
    } catch {
      /* 落到兜底 */
    }
  }
  if (/"pass"\s*:\s*true/.test(text || '')) return { pass: true, reason: '符合标准' };
  return {
    pass: false,
    reason: '审核未返回可解析的结论，原文：' + (text || '').slice(0, 200),
  };
}

/** 审核提示词组装（两 Provider 共用，保证判定口径一致，§15.1） */
export function buildReviewSystem(persona: string, standards: { points: string; clientNeeds: string }): string {
  return (
    persona +
    '\n老板审核要点：\n' +
    (standards.points || '（未设置，按常识与任务说明核对完整性与质量）') +
    '\n甲方需求：\n' +
    (standards.clientNeeds || '（未设置）') +
    '\n判定口径：硬要点（必须包含/禁止出现/字数上限类可机检项）不满足必须打回；其余要点综合判定，结论必须逐条引用要点。' +
    '\n你是审核员，只返回 JSON，不要输出任何其他内容：{"pass":true 或 false,"reason":"通过理由或打回理由（打回时写明违反哪一条）"}'
  );
}

export function buildReviewUser(taskTitle: string, taskBrief: string, draft: string): string {
  return (
    '请审核以下成果。\n任务标题：' +
    taskTitle +
    '\n任务说明：\n' +
    (taskBrief || '') +
    '\n待审核成果：\n' +
    draft
  );
}
