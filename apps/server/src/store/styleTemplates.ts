import { nowIso } from '../util';
import type { OfficeStyleConfig } from '../domain/officeStyle';
import type { Repos, StyleTemplateRow } from './repositories';

/**
 * 官方风格模板种子（v1.3.0 F）：6 套，owner_type='platform'、visibility='public'、workspace_id 空。
 * 幂等：按 name 判重，缺才插。config 与 office-style 配置同构（五键齐全）；
 * furniture 槽位键：plantLeft/plantRight/sofa/bookshelf/fishtank/rug/painting/coffee/cat，
 * 值为款式字符串或 null（款式目录由前端定义，服务端只存字符串）。
 */
interface StyleTemplateDef {
  name: string;
  config: OfficeStyleConfig;
}

const cfg = (
  wall: string,
  floor: string,
  accent: string,
  floorPattern: OfficeStyleConfig['floorPattern'],
  furniture: Record<string, string | null>,
  signText = '',
): OfficeStyleConfig => ({
  palette: { wall, floor, accent },
  floorPattern,
  furniture: {
    plantLeft: null,
    plantRight: null,
    sofa: null,
    bookshelf: null,
    fishtank: null,
    rug: null,
    painting: null,
    coffee: null,
    cat: null,
    ...furniture,
  },
  poster: { imageFileId: null },
  sign: { mode: 'text', text: signText, imageFileId: null },
});

export const OFFICIAL_STYLE_TEMPLATES: StyleTemplateDef[] = [
  {
    name: '极简整洁',
    config: cfg('#f4f1ea', '#d9d2c4', '#8a97a5', 'plain', { painting: 'line-art' }),
  },
  {
    name: '樱粉梦境',
    config: cfg('#fbe7ef', '#f3d9e2', '#e77fa2', 'tile', {
      plantLeft: 'sakura',
      plantRight: 'sakura',
      painting: 'blossom',
      rug: 'pink-round',
      cat: 'white',
    }),
  },
  {
    name: '科技蓝调',
    config: cfg('#2e3d52', '#22304a', '#39c2d7', 'checker', {
      bookshelf: 'metal',
      fishtank: 'led',
      coffee: 'machine',
    }),
  },
  {
    name: '原木暖阳',
    config: cfg('#f3e3c8', '#b98a5a', '#d9822b', 'wood', {
      plantLeft: 'fern',
      sofa: 'linen',
      rug: 'woven',
      painting: 'landscape',
    }),
  },
  {
    name: '绿植森系',
    config: cfg('#dcead9', '#a8bf97', '#4e7d4a', 'wood', {
      plantLeft: 'monstera',
      plantRight: 'fern',
      bookshelf: 'wood',
      sofa: 'green',
      rug: 'leaf',
      cat: 'orange',
    }),
  },
  {
    name: '赛博霓虹',
    config: cfg('#1d1b2e', '#14121f', '#ff3d81', 'tile', { fishtank: 'neon', coffee: 'machine' }, 'SWARM HQ'),
  },
];

/** 官方风格模板种子（幂等：同名 platform 模板已存在不覆盖） */
export function ensureOfficialStyleTemplates(repos: Repos): void {
  const ts = nowIso();
  for (const def of OFFICIAL_STYLE_TEMPLATES) {
    const exists = repos.db
      .prepare("SELECT id FROM style_templates WHERE owner_type = 'platform' AND name = ?")
      .get(def.name) as { id: string } | undefined;
    if (exists) continue;
    const row: StyleTemplateRow = {
      id: `styletpl_platform_${def.name}`,
      workspace_id: null,
      owner_type: 'platform',
      name: def.name,
      config: JSON.stringify(def.config),
      visibility: 'public',
      apply_count: 0,
      contributor_name: null,
      contributor_workspace_name: null,
      created_by: null,
      created_at: ts,
      updated_at: ts,
    };
    repos.insertStyleTemplate(row);
  }
}
