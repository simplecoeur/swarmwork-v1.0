import { describe, expect, it } from 'vitest';
import { estimateTokens, normalizeUsage, parseVerdict } from '../../src/llm/parse';

describe('usage 估算（§15.1：中文 1 字≈1 token，英文 4 字符≈1 token）', () => {
  it('纯中文', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('标题必须带数字')).toBe(7);
  });

  it('纯英文', () => {
    expect(estimateTokens('hello world!')).toBe(3); // 12 字符 × 0.25
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('中英混合与空串', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('中文ab')).toBe(3); // 2 + 2×0.25=0.5 → ceil(2.5)=3
  });
});

describe('usage 归一化', () => {
  it('厂商返回完整 usage 时原样采用、estimated=false', () => {
    const u = normalizeUsage({ promptTokens: 100, completionTokens: 50 }, '任意', '任意');
    expect(u).toEqual({ promptTokens: 100, completionTokens: 50, estimated: false });
  });

  it('usage 缺失时按文本估算、estimated=true', () => {
    const u = normalizeUsage({}, '你好世界', 'hello world!');
    expect(u.promptTokens).toBe(4);
    expect(u.completionTokens).toBe(3);
    expect(u.estimated).toBe(true);
  });

  it('只缺一侧时只估算缺失侧', () => {
    const u = normalizeUsage({ promptTokens: 42 }, '你好世界', 'abcd');
    expect(u.promptTokens).toBe(42);
    expect(u.completionTokens).toBe(1);
    expect(u.estimated).toBe(true);
  });
});

describe('审核结论解析兜底（§8）', () => {
  it('标准 JSON', () => {
    expect(parseVerdict('{"pass":true,"reason":"符合标准"}')).toEqual({ pass: true, reason: '符合标准' });
    expect(parseVerdict('{"pass":false,"reason":"违反第2条"}').pass).toBe(false);
  });

  it('JSON 混在解释文本里也能提取', () => {
    const v = parseVerdict('审核完成。结论：{"pass":true,"reason":"ok"} 以上。');
    expect(v.pass).toBe(true);
    expect(v.reason).toBe('ok');
  });

  it('脏数据：pass 不是布尔时兜底', () => {
    const v = parseVerdict('{"pass":"yes","reason":"含糊"}');
    expect(v.pass).toBe(false); // 正则也找不到 "pass":true → 不通过
  });

  it('纯文本脏数据一律不通过且附原文', () => {
    const v = parseVerdict('我觉得写得不错，就这样吧');
    expect(v.pass).toBe(false);
    expect(v.reason).toContain('未返回可解析');
    expect(v.reason).toContain('我觉得写得不错');
  });

  it('空响应不通过', () => {
    expect(parseVerdict('').pass).toBe(false);
  });
});
