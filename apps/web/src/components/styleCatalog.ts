import type { OfficeStyleConfig } from '../types';

/**
 * F 公司风格定制目录（v1.3.0）：家具槽位/款式、配色预设、一键搭配预设与本地默认风格。
 * 服务端只存字符串（款式键），目录以前端为准；画布遇未知款式键回退该槽默认款（defaultStyle）。
 * 本地默认风格 = PixelOffice 现状观感（context 尚未拿到服务端风格时的回退，保证像素级一致）：
 * 墙 #b09a76（老板办公室隔断色）、地板 #ead9b8（现地板浅格色）、点缀 #d93a2b（现品牌红）、
 * 地板纹样 checker（现画布本就是双色交替格，暗格由 floor 程序加深得到 #e3cfa6）。
 */
export const DEFAULT_OFFICE_STYLE: OfficeStyleConfig = {
  palette: { wall: '#b09a76', floor: '#ead9b8', accent: '#d93a2b' },
  floorPattern: 'checker',
  furniture: { plantLeft: 'green', plantRight: 'green' },
  poster: { imageFileId: null },
  sign: { mode: 'text', text: '', imageFileId: null },
};

export interface FurnitureSlotDef {
  slot: string;
  label: string;
  /** 款式键 → 中文名；第一项即默认款（未知键回退它） */
  styles: Record<string, string>;
  defaultStyle: string;
}

export const FURNITURE_SLOTS: FurnitureSlotDef[] = [
  { slot: 'plantLeft', label: '左绿植', defaultStyle: 'green', styles: { green: '绿萝', sakura: '樱花', cactus: '仙人掌', flower: '花艺' } },
  { slot: 'plantRight', label: '右绿植', defaultStyle: 'green', styles: { green: '绿萝', sakura: '樱花', fern: '蕨叶', monstera: '龟背竹' } },
  { slot: 'sofa', label: '沙发', defaultStyle: 'fabric', styles: { fabric: '布艺沙发', linen: '亚麻沙发', green: '森系绿沙发', leather: '皮沙发' } },
  { slot: 'bookshelf', label: '书柜', defaultStyle: 'wood', styles: { wood: '原木书柜', metal: '金属书柜', white: '白色书柜' } },
  { slot: 'fishtank', label: '鱼缸', defaultStyle: 'classic', styles: { classic: '经典鱼缸', led: 'LED 鱼缸', neon: '霓虹鱼缸' } },
  { slot: 'rug', label: '地毯', defaultStyle: 'woven', styles: { woven: '编织地毯', 'pink-round': '粉色圆毯', leaf: '叶纹地毯', geo: '几何地毯' } },
  { slot: 'painting', label: '挂画', defaultStyle: 'landscape', styles: { landscape: '风景画', 'line-art': '线条画', blossom: '花卉画', abstract: '抽象画' } },
  { slot: 'coffee', label: '茶水角', defaultStyle: 'kettle', styles: { kettle: '手冲壶', machine: '咖啡机', teapot: '茶壶' } },
  { slot: 'cat', label: '办公室猫', defaultStyle: 'orange', styles: { orange: '橘猫', white: '白猫', black: '黑猫', gray: '灰猫' } },
];

export function slotDef(slot: string): FurnitureSlotDef | undefined {
  return FURNITURE_SLOTS.find((s) => s.slot === slot);
}

/** 画布用：槽位实际款式（未设/未知键 → 默认款；显式 null/'' → 不画，返回 null） */
export function resolveStyleKey(slot: string, value: string | null | undefined, present: boolean): string | null {
  const def = slotDef(slot);
  if (!def) return null;
  if (!present) return null;
  if (value && def.styles[value]) return value;
  if (value) return def.defaultStyle; // 未知字符串（服务端种子口径不一）回退默认款
  return null;
}

export const FLOOR_PATTERN_OPTIONS = [
  { value: 'plain', label: '纯色' },
  { value: 'wood', label: '木纹' },
  { value: 'tile', label: '瓷砖网格' },
  { value: 'checker', label: '双色格' },
];

/** 配色预设色板（墙面/地板/点缀各一组和谐色） */
export const PALETTE_SWATCHES: Record<'wall' | 'floor' | 'accent', Array<{ hex: string; name: string }>> = {
  wall: [
    { hex: '#b09a76', name: '原木米' },
    { hex: '#f4f1ea', name: '极简白' },
    { hex: '#fbe7ef', name: '樱花粉' },
    { hex: '#2e3d52', name: '科技蓝灰' },
    { hex: '#dcead9', name: '森系浅绿' },
    { hex: '#1d1b2e', name: '赛博深紫' },
    { hex: '#f3e3c8', name: '暖阳奶油' },
    { hex: '#e8e3d8', name: '高级灰' },
  ],
  floor: [
    { hex: '#ead9b8', name: '浅木' },
    { hex: '#d9d2c4', name: '水泥灰' },
    { hex: '#f3d9e2', name: '粉瓷' },
    { hex: '#22304a', name: '深蓝' },
    { hex: '#a8bf97', name: '草地绿' },
    { hex: '#14121f', name: '暗夜' },
    { hex: '#b98a5a', name: '胡桃木' },
    { hex: '#cbb99a', name: '燕麦' },
  ],
  accent: [
    { hex: '#d93a2b', name: '品牌红' },
    { hex: '#8a97a5', name: '雾灰蓝' },
    { hex: '#e77fa2', name: '樱粉' },
    { hex: '#39c2d7', name: '电光青' },
    { hex: '#4e7d4a', name: '深绿' },
    { hex: '#ff3d81', name: '霓虹粉' },
    { hex: '#d9822b', name: '暖橙' },
    { hex: '#3a6fd8', name: '宝蓝' },
  ],
};

/* ---------- 一键生成搭配：站内预设（与官方模板同名的 6 套 + 站内 2 套） ---------- */

export interface StyleCombo {
  name: string;
  style: OfficeStyleConfig;
}

function combo(
  name: string,
  wall: string,
  floor: string,
  accent: string,
  floorPattern: string,
  furniture: Record<string, string | null>,
  signText = '',
): StyleCombo {
  return {
    name,
    style: {
      palette: { wall, floor, accent },
      floorPattern,
      furniture: {
        plantLeft: null, plantRight: null, sofa: null, bookshelf: null, fishtank: null,
        rug: null, painting: null, coffee: null, cat: null,
        ...furniture,
      },
      poster: { imageFileId: null },
      sign: { mode: 'text', text: signText, imageFileId: null },
    },
  };
}

export const STYLE_COMBOS: StyleCombo[] = [
  combo('极简整洁', '#f4f1ea', '#d9d2c4', '#8a97a5', 'plain', { painting: 'line-art' }),
  combo('樱粉梦境', '#fbe7ef', '#f3d9e2', '#e77fa2', 'tile', {
    plantLeft: 'sakura', plantRight: 'sakura', painting: 'blossom', rug: 'pink-round', cat: 'white',
  }),
  combo('科技蓝调', '#2e3d52', '#22304a', '#39c2d7', 'checker', {
    bookshelf: 'metal', fishtank: 'led', coffee: 'machine',
  }),
  combo('原木暖阳', '#f3e3c8', '#b98a5a', '#d9822b', 'wood', {
    plantLeft: 'fern', sofa: 'linen', rug: 'woven', painting: 'landscape',
  }),
  combo('绿植森系', '#dcead9', '#a8bf97', '#4e7d4a', 'wood', {
    plantLeft: 'monstera', plantRight: 'fern', bookshelf: 'wood', sofa: 'green', rug: 'leaf', cat: 'orange',
  }),
  combo('赛博霓虹', '#1d1b2e', '#14121f', '#ff3d81', 'tile', { fishtank: 'neon', coffee: 'machine' }, 'SWARM HQ'),
  combo('奶油 Ins', '#faf3e7', '#efe3cd', '#c98d5e', 'plain', {
    plantLeft: 'flower', sofa: 'fabric', rug: 'geo', painting: 'abstract', cat: 'gray',
  }),
  combo('复古书房', '#8a6a4a', '#a5713d', '#274156', 'wood', {
    bookshelf: 'wood', sofa: 'leather', painting: 'landscape', coffee: 'teapot', cat: 'black',
  }),
];
