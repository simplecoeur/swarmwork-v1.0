/**
 * 办公室风格配置（v1.3.0 F）：当前空间风格存 settings(key='officeStyle', workspace 维度)，
 * 风格模板存 style_templates 表（迁移 016）。本文件只定义配置形状与默认值。
 * 默认值 = 现有办公室观感：墙面取 PixelOffice 隔断主色 #b09a76、地板取其浅木色 #ead9b8、
 * 点缀取品牌红 #d93a2b；floorPattern 默认 'wood'。
 */
export interface OfficeStyleConfig {
  palette: { wall: string; floor: string; accent: string };
  floorPattern: 'plain' | 'wood' | 'tile' | 'checker';
  furniture: Record<string, string | null>;
  poster: { imageFileId: string | null };
  sign: { mode: 'text' | 'image'; text: string; imageFileId: string | null };
}

export const DEFAULT_OFFICE_STYLE: OfficeStyleConfig = {
  palette: { wall: '#b09a76', floor: '#ead9b8', accent: '#d93a2b' },
  floorPattern: 'wood',
  furniture: {},
  poster: { imageFileId: null },
  sign: { mode: 'text', text: '', imageFileId: null },
};

/** 家具槽位全集（种子/校验参考；前端目录为准，服务端只存字符串或 null） */
export const FURNITURE_SLOTS = [
  'plantLeft',
  'plantRight',
  'sofa',
  'bookshelf',
  'fishtank',
  'rug',
  'painting',
  'coffee',
  'cat',
] as const;

/** 宽松归一：存量/外部传入的配置缺键时补默认，保证五键齐全再出 DTO */
export function normalizeOfficeStyle(raw: unknown): OfficeStyleConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<OfficeStyleConfig>;
  const p = (c.palette ?? {}) as Partial<OfficeStyleConfig['palette']>;
  const poster = (c.poster ?? {}) as Partial<OfficeStyleConfig['poster']>;
  const sign = (c.sign ?? {}) as Partial<OfficeStyleConfig['sign']>;
  return {
    palette: {
      wall: typeof p.wall === 'string' ? p.wall : DEFAULT_OFFICE_STYLE.palette.wall,
      floor: typeof p.floor === 'string' ? p.floor : DEFAULT_OFFICE_STYLE.palette.floor,
      accent: typeof p.accent === 'string' ? p.accent : DEFAULT_OFFICE_STYLE.palette.accent,
    },
    floorPattern: (['plain', 'wood', 'tile', 'checker'] as const).includes(
      c.floorPattern as OfficeStyleConfig['floorPattern'],
    )
      ? (c.floorPattern as OfficeStyleConfig['floorPattern'])
      : 'wood',
    furniture:
      c.furniture && typeof c.furniture === 'object' ? (c.furniture as Record<string, string | null>) : {},
    poster: { imageFileId: typeof poster.imageFileId === 'string' ? poster.imageFileId : null },
    sign: {
      mode: sign.mode === 'image' ? 'image' : 'text',
      text: typeof sign.text === 'string' ? sign.text : '',
      imageFileId: typeof sign.imageFileId === 'string' ? sign.imageFileId : null,
    },
  };
}

/** 从一份风格配置里收集被引用的图片 fileId（poster + sign 图模式），供文件可见性判定 */
export function styleImageFileIds(config: OfficeStyleConfig): string[] {
  const ids = [config.poster.imageFileId, config.sign.imageFileId];
  return ids.filter((x): x is string => !!x);
}
