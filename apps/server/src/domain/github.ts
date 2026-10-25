/**
 * v1.5.0 GitHub 通用工具（C 同步流水线与 K 技能导入共用）：
 * 基址口径与 agentSyncService 一致（env AGENT_SYNC_GITHUB_API / AGENT_SYNC_GITHUB_RAW 可覆盖，本地桩测试用）。
 * 许可证识别只做宽松名单判定：抓 LICENSE 原文按特征词归类，识别不了的一律 'other'（从严）。
 */

export const githubApiBase = (): string => process.env.AGENT_SYNC_GITHUB_API ?? 'https://api.github.com';
export const githubRawBase = (): string => process.env.AGENT_SYNC_GITHUB_RAW ?? 'https://raw.githubusercontent.com';

export type LicenseKind = 'MIT' | 'Apache-2.0' | 'BSD-2-Clause' | 'BSD-3-Clause' | 'ISC' | 'other';

export const PERMISSIVE_LICENSES: readonly string[] = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];

/** LICENSE 原文 → 许可证种类（特征词判定；GPL/AGPL/LGPL 等一律落 other） */
export function classifyLicenseText(text: string): LicenseKind {
  const t = text.slice(0, 20000);
  if (/GNU (AFFERO |LESSER )?GENERAL PUBLIC LICENSE/i.test(t)) return 'other';
  if (/Apache License/i.test(t) && /Version 2\.0/.test(t)) return 'Apache-2.0';
  if (/MIT License/i.test(t) || /Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t)) {
    return 'MIT';
  }
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    // BSD：含「Neither the name」条款为 3-Clause，无则 2-Clause
    return /Neither the name/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  if (/ISC License/i.test(t) || /Permission to use, copy, modify, and\/or distribute this software/i.test(t)) return 'ISC';
  return 'other';
}

/** 许可证字符串归一（白名单源里手填的 'MIT'/'Apache-2.0' 等与归类结果可比） */
export function normalizeLicenseKind(s: string): LicenseKind | '' {
  const v = (s || '').trim();
  if (!v) return '';
  if (/^mit$/i.test(v)) return 'MIT';
  if (/^apache/i.test(v)) return 'Apache-2.0';
  if (/^bsd-3/i.test(v)) return 'BSD-3-Clause';
  if (/^bsd-2/i.test(v) || /^bsd$/i.test(v)) return 'BSD-2-Clause';
  if (/^isc$/i.test(v)) return 'ISC';
  return 'other';
}
