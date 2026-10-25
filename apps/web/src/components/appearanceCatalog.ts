import type { HairStyle } from '@swarm/shared';

/**
 * v1.4.0 I 小人形象定制目录（web 本地同值常量）。
 *
 * web 因打包约束不能从 shared 取「值」导出（shared CJS 桶文件无法被 Rollup 静态解析值导出，
 * v1.3.0 问卷预设收口同一先例：4b36e8d 改回本地同值常量），故此处与服务端同值维护：
 * - SKINS 与服务端 repositories.MEMBER_SKINS 同值，也与 PixelOffice 画布原 SKINS 同值（5 档，顺序一致，
 *   顺序决定未定制成员的哈希推导结果，不可改序）；
 * - HAIR_STYLES 的 value 与 shared HairStyle 枚举 / 服务端 HAIR_STYLES 同值。
 * shirt / hairColor 服务端只校验 #rrggbb，下方色板为编辑器取色口径（含画布 ROLE_SHIRT / FALLBACK_SHIRTS /
 * ROLE_HAIR 的主要色，保证「自动推导出的颜色」都能在色板里找到对应块）。
 */

/** 肤色 5 档（与服务端 MEMBER_SKINS / 画布 SKINS 同值同序） */
export const SKINS: string[] = ['#f2c79b', '#eec39a', '#f6cfae', '#e9bd8d', '#d9a06b'];

/** 衬衫色板（≥10 色）：前 5 = ROLE_SHIRT 五工种色，次 5 = FALLBACK_SHIRTS，后 2 为补充常用色 */
export const SHIRT_PALETTE: Array<{ hex: string; name: string }> = [
  { hex: '#e8862e', name: '组长橙' },
  { hex: '#1f8a70', name: '研究绿' },
  { hex: '#d93a2b', name: '文案红' },
  { hex: '#3a6fd8', name: '程序蓝' },
  { hex: '#5a5f6a', name: '审核灰' },
  { hex: '#8a5aa8', name: '紫' },
  { hex: '#d98a16', name: '金' },
  { hex: '#3f9e4d', name: '草绿' },
  { hex: '#e8503f', name: '朱红' },
  { hex: '#274156', name: '深海蓝' },
  { hex: '#e77fa2', name: '粉' },
  { hex: '#39c2d7', name: '青' },
];

/** 发色板（≥8 色）：前 5 含 ROLE_HAIR 主要色，其余为常用发色 */
export const HAIR_PALETTE: Array<{ hex: string; name: string }> = [
  { hex: '#3a2a1a', name: '深棕' },
  { hex: '#20303a', name: '蓝黑' },
  { hex: '#5a2320', name: '酒红棕' },
  { hex: '#14181f', name: '墨黑' },
  { hex: '#101010', name: '纯黑' },
  { hex: '#a83c1e', name: '红棕' },
  { hex: '#d9a441', name: '金棕' },
  { hex: '#e8e3d8', name: '银白' },
  { hex: '#8a5aa8', name: '紫' },
  { hex: '#3a6fd8', name: '蓝' },
];

/** 发型 4 款（value 与 shared HairStyle / 服务端 HAIR_STYLES 同值） */
export const HAIR_STYLES: Array<{ value: HairStyle; label: string }> = [
  { value: 'short', label: '短发' },
  { value: 'long', label: '长发' },
  { value: 'bald', label: '光头' },
  { value: 'bun', label: '束发' },
];
