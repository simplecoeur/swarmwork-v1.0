import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * G-06 知识 / 资产文件导入集成（两段式 preview → confirm）：
 * ① 3 标题 md → 预览 3 草案 title 正确、confirm 后 KB +3 且 scope 正确、发单命中导入条目（injected_kb_ids 含之）；
 * ② csv 4 行 → 4 条且 tags 解析正确（含引号转义/逗号字段）；
 * ③ 「第1集…第30集」txt 导入资产 → v1 含 30 sections 顺序/key 正确、按 ep5 引用发单只注入第 5 集（mock 回显核对）；
 * ④ 6MB 文件与 501 条草案分别 VALIDATION 且零落库；
 * ⑤ docx 两段 → 2 草案且正文无格式残留标签（docx 在测试内以最小 zip 结构自造）。
 */
const SERVER_DIR = process.cwd(); // apps/server
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');
const PORT = 8931;
const MOCK_PORT = 8941;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUp(url: string, timeout = 25_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* 继续等 */
    }
    await sleep(300);
  }
  return false;
}

async function waitFor<T>(fn: () => Promise<T | null>, timeout = 45_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error('waitFor 超时');
}

interface Client {
  cookie: string;
  req: (method: string, p: string, body?: unknown) => Promise<{ status: number; json: any; text: string }>;
  get: (p: string) => Promise<{ status: number; json: any; text: string }>;
  post: (p: string, body?: unknown) => Promise<{ status: number; json: any; text: string }>;
}

function makeClient(base: string): Client {
  const c: Client = {
    cookie: '',
    async req(method, p, body) {
      const r = await fetch(base + p, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(c.cookie ? { cookie: c.cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = r.headers.get('set-cookie');
      if (sc && sc.includes('swarm_session=')) {
        const v = sc.split(';')[0];
        if (v.length > 'swarm_session='.length) c.cookie = v;
        if (v === 'swarm_session=') c.cookie = '';
      }
      const text = await r.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON */
      }
      return { status: r.status, json, text };
    },
    get: (p) => c.req('GET', p),
    post: (p, body) => c.req('POST', p, body ?? {}),
  };
  return c;
}

const procs: ChildProcess[] = [];
let dataDir = '';
const client = makeClient(BASE);
let teamId = '';

/** multipart 预览请求（fields 先行、file 在后，与前端 FormData 顺序一致） */
async function multipartPost(
  p: string,
  fields: Record<string, string>,
  filename: string,
  content: string | Buffer,
  contentType = 'application/octet-stream',
): Promise<{ status: number; json: any }> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([content as BlobPart], { type: contentType }), filename);
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: client.cookie ? { cookie: client.cookie } : {},
    body: fd,
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, json };
}

async function mockRequests(): Promise<Array<{ kind: string; user: string }>> {
  const r = await fetch(MOCK_BASE + '/__requests');
  return (await r.json()) as Array<{ kind: string; user: string }>;
}

async function waitTaskDone(taskId: string): Promise<any> {
  return waitFor(async () => {
    const r = await client.get(`/api/tasks/${taskId}`);
    const t = r.json?.task;
    return t && t.status === '已完成' ? t : null;
  });
}

/* ---------- 最小 docx 自造（store 型 zip + CRC32，mammoth/JSZip 可读） ---------- */
const CRC_TABLE = ((): Int32Array => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function buildStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, e.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + size;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
function buildDocx(paragraphs: string[]): Buffer {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const ps = paragraphs.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('');
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${ps}</w:body></w:document>`;
  return buildStoredZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-g06-'));
  const mock = spawn('node', [MOCK], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_REVIEW_MODE: 'pass' },
    stdio: 'pipe',
    detached: true,
  });
  procs.push(mock);
  expect(await waitUp(MOCK_BASE + '/__counts')).toBe(true);
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      LLM_RETRY_BASE_MS: '10',
      SWARM_ADMIN_EMAIL: 'admin@test.local',
      SWARM_ADMIN_PASSWORD: '<MASKED_SECRET_001>!',
    },
    stdio: 'pipe',
    detached: true,
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  procs.push(server);
  expect(await waitUp(BASE + '/api/health')).toBe(true);

  const login = await client.post('/api/auth/login', {
    email: 'admin@test.local',
    password: '<MASKED_SECRET_001>!',
  });
  expect(login.json.ok).toBe(true);
  const chpw = await client.post('/api/auth/change-password', {
    currentPassword: '<MASKED_SECRET_001>!',
    newPassword: '<MASKED_SECRET_002>!',
  });
  expect(chpw.json.ok).toBe(true);

  const st = (await client.get('/api/state')).json;
  const apiId = st.apis[0].id as string;
  teamId = st.teams[0].id as string;
  const sv = await client.post('/api/apis/save', {
    api: { id: apiId, name: 'Mock API', provider: 'custom', baseUrl: MOCK_BASE, model: 'mock-model', pricePerM: 10, apiKey: 'fake-key-123' },
  });
  expect(sv.json.ok).toBe(true);
  expect((await client.post('/api/purchase', { apiId, amountYuan: 100 })).json.ok).toBe(true);
  expect(
    (await client.post('/api/teams/save', { team: { id: teamId, name: st.teams[0].name, color: '#e2574c', apiId } })).json.ok,
  ).toBe(true);
  const type = await client.post('/api/asset-types', {
    assetType: { name: 'G06剧本类型', structureSchema: { sections: '按集分段' } },
  });
  expect(type.json.ok).toBe(true);
}, 60_000);

afterAll(() => {
  for (const p of procs) {
    try {
      if (p.pid) process.kill(-p.pid, 'SIGKILL');
    } catch {
      try {
        p.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

describe('G-06 文件导入', () => {
  it('① md 三标题：预览 3 草案 title 正确 → confirm KB +3 且 scope 正确 → 发单命中导入条目', async () => {
    const before = (await client.get('/api/kb')).json.entries as any[];
    const md = [
      '# G06标题甲ZZQ',
      '正文甲 MDBODYAZZQ 第一段内容',
      '',
      '## G06标题乙ZZQ',
      '正文乙 MDBODYBZZQ 第二段内容',
      '',
      '# G06标题丙ZZQ',
      '正文丙 MDBODYCZZQ 第三段内容',
      '',
    ].join('\n');
    const preview = await multipartPost(
      '/api/kb/import/preview',
      { scope: 'team', scopeId: teamId },
      'g06-notes.md',
      md,
      'text/markdown',
    );
    expect(preview.status).toBe(200);
    expect(preview.json.ok).toBe(true);
    expect(preview.json.drafts).toHaveLength(3);
    expect(preview.json.drafts.map((d: any) => d.title)).toEqual([
      'G06标题甲ZZQ',
      'G06标题乙ZZQ',
      'G06标题丙ZZQ',
    ]);
    expect(preview.json.drafts[0].body).toContain('MDBODYAZZQ');
    // 预览不落库
    expect((await client.get('/api/kb')).json.entries).toHaveLength(before.length);

    const confirm = await client.post('/api/kb/import/confirm', {
      filename: 'g06-notes.md',
      scope: 'team',
      scopeId: teamId,
      drafts: preview.json.drafts,
    });
    expect(confirm.json.ok).toBe(true);
    expect(confirm.json.created).toBe(3);
    expect(confirm.json.failed).toBe(0);
    const ids = (confirm.json.results as any[]).map((r) => r.id as string);
    expect(ids.every(Boolean)).toBe(true);

    const after = (await client.get('/api/kb')).json.entries as any[];
    expect(after).toHaveLength(before.length + 3);
    for (const id of ids) {
      const entry = after.find((e) => e.id === id);
      expect(entry).toBeTruthy();
      expect(entry.scope).toBe('team');
      expect(entry.scopeId).toBe(teamId);
    }
    // 导入动作落 audit（台账可见 import_kb + 文件名）
    const view = (await client.get('/api/ledger-view')).json;
    expect(
      (view.timeline as any[]).some(
        (x) => x.kind === 'audit' && String(x.text).includes('import_kb') && String(x.text).includes('g06-notes.md'),
      ),
    ).toBe(true);

    // 发单命中导入条目（小组级靠正文关键词 MDBODYAZZQ 命中条目甲）
    const task = await client.post('/api/tasks', {
      title: 'G06 导入命中单',
      type: '文案',
      brief: '参考正文甲 MDBODYAZZQ 写一段文案',
      teamId,
    });
    expect(task.json.ok).toBe(true);
    const done = await waitTaskDone(task.json.id as string);
    expect(done.injectedKbIds).toContain(ids[0]);
    const reqs = await mockRequests();
    expect(reqs.some((r) => r.kind === 'chat' && r.user.includes('MDBODYAZZQ'))).toBe(true);
  });

  it('② csv 四行：预览 4 草案、tags 解析正确（引号转义/逗号字段/空 tags）', async () => {
    const csv = [
      'title,body,tags',
      'CSV标题一ZZQ,"正文一, 含逗号 CSVBODY1ZZQ",标签甲;标签乙',
      'CSV标题二ZZQ,"正文二含""引号"" CSVBODY2ZZQ",标签丙',
      'CSV标题三ZZQ,正文三 CSVBODY3ZZQ,标签丁;标签戊',
      'CSV标题四ZZQ,正文四 CSVBODY4ZZQ,',
      '',
    ].join('\n');
    const preview = await multipartPost(
      '/api/kb/import/preview',
      { scope: 'company' },
      'g06-rows.csv',
      csv,
      'text/csv',
    );
    expect(preview.json.ok).toBe(true);
    expect(preview.json.drafts).toHaveLength(4);
    expect(preview.json.drafts[0].title).toBe('CSV标题一ZZQ');
    expect(preview.json.drafts[0].body).toBe('正文一, 含逗号 CSVBODY1ZZQ');
    expect(preview.json.drafts[0].tags).toEqual(['标签甲', '标签乙']);
    expect(preview.json.drafts[1].body).toBe('正文二含"引号" CSVBODY2ZZQ');
    expect(preview.json.drafts[1].tags).toEqual(['标签丙']);
    expect(preview.json.drafts[2].tags).toEqual(['标签丁', '标签戊']);
    expect(preview.json.drafts[3].tags).toEqual([]);

    const confirm = await client.post('/api/kb/import/confirm', {
      filename: 'g06-rows.csv',
      scope: 'company',
      drafts: preview.json.drafts,
    });
    expect(confirm.json.ok).toBe(true);
    expect(confirm.json.created).toBe(4);
    const entries = (await client.get('/api/kb')).json.entries as any[];
    const one = entries.find((e) => e.title === 'CSV标题一ZZQ');
    expect(one).toBeTruthy();
    expect(one.tags).toEqual(['标签甲', '标签乙']);
    expect(one.scope).toBe('company');
  });

  it('③ txt 三十集导入资产：v1 含 30 sections 顺序/key 正确 → 按 ep5 引用只注入第 5 集', async () => {
    const lines: string[] = [];
    for (let n = 1; n <= 30; n++) {
      lines.push(`第${n}集 第${n}集标题ZZQ`);
      lines.push(`EP${n}BODYZZQ 第${n}集正文内容`);
    }
    const preview = await multipartPost(
      '/api/assets/import/preview',
      { typeId: 'G06剧本类型' },
      'g06-drama.txt',
      lines.join('\n'),
      'text/plain',
    );
    expect(preview.json.ok).toBe(true);
    expect(preview.json.sections).toHaveLength(30);
    expect(preview.json.sections.map((s: any) => s.key)).toEqual(
      Array.from({ length: 30 }, (_, i) => `ep${i + 1}`),
    );
    expect(preview.json.sections[4].title).toContain('第5集');
    expect(preview.json.sections[4].body).toContain('EP5BODYZZQ');
    // 预览不落库
    const assetsBefore = (await client.get('/api/assets')).json.assets as any[];

    const confirm = await client.post('/api/assets/import/confirm', {
      filename: 'g06-drama.txt',
      name: 'G06导入剧本ZZQ',
      typeId: 'G06剧本类型',
      sections: preview.json.sections,
    });
    expect(confirm.json.ok).toBe(true);
    const assetId = confirm.json.id as string;
    expect(confirm.json.asset.version).toBe(1);
    expect(confirm.json.asset.content.sections).toHaveLength(30);
    const assetsAfter = (await client.get('/api/assets')).json.assets as any[];
    expect(assetsAfter).toHaveLength(assetsBefore.length + 1);

    const v1 = await client.get(`/api/assets/${assetId}/versions/1`);
    expect(v1.json.ok).toBe(true);
    const v1Sections = (v1.json.content as any).sections as any[];
    expect(v1Sections).toHaveLength(30);
    expect(v1Sections.map((s) => s.key)).toEqual(Array.from({ length: 30 }, (_, i) => `ep${i + 1}`));
    // 导入动作落 audit
    const view = (await client.get('/api/ledger-view')).json;
    expect(
      (view.timeline as any[]).some(
        (x) => x.kind === 'audit' && String(x.text).includes('import_asset'),
      ),
    ).toBe(true);

    const task = await client.post('/api/tasks', {
      title: 'G06 按集引用单',
      type: '文案',
      brief: '依据第5集写钩子',
      teamId,
      assetRefs: [{ assetId, sections: ['ep5'] }],
    });
    expect(task.json.ok).toBe(true);
    const done = await waitTaskDone(task.json.id as string);
    expect(done.injectedAssets).toContain(`${assetId}@1`);
    const reqs = await mockRequests();
    const hits = reqs.filter((r) => r.kind === 'chat' && r.user.includes('G06导入剧本ZZQ'));
    expect(hits.length).toBeGreaterThan(0);
    const last = hits[hits.length - 1]!;
    expect(last.user).toContain('EP5BODYZZQ');
    expect(last.user).not.toContain('EP4BODYZZQ');
    expect(last.user).not.toContain('EP6BODYZZQ');
  });

  it('④ 超限：6MB 文件与 501 条草案分别 VALIDATION 且零落库', async () => {
    const kbBefore = (await client.get('/api/kb')).json.entries as any[];
    const assetsBefore = (await client.get('/api/assets')).json.assets as any[];

    const big = 'x'.repeat(6 * 1024 * 1024);
    const bigKb = await multipartPost('/api/kb/import/preview', { scope: 'company' }, 'g06-big.txt', big, 'text/plain');
    expect(bigKb.status).toBe(400);
    expect(bigKb.json.ok).toBe(false);
    expect(bigKb.json.error.code).toBe('VALIDATION');
    expect(String(bigKb.json.error.message)).toContain('5MB');
    const bigAsset = await multipartPost(
      '/api/assets/import/preview',
      { typeId: 'G06剧本类型' },
      'g06-big.txt',
      big,
      'text/plain',
    );
    expect(bigAsset.json.ok).toBe(false);
    expect(bigAsset.json.error.code).toBe('VALIDATION');

    const drafts501 = Array.from({ length: 501 }, (_, i) => ({
      title: `批量草案 ${i}`,
      body: '正文',
      tags: [] as string[],
    }));
    const confirm501 = await client.post('/api/kb/import/confirm', {
      filename: 'g06-501.md',
      scope: 'company',
      drafts: drafts501,
    });
    expect(confirm501.json.ok).toBe(false);
    expect(confirm501.json.error.code).toBe('VALIDATION');

    const sections201 = Array.from({ length: 201 }, (_, i) => ({
      key: `ep${i + 1}`,
      title: `第${i + 1}集`,
      body: '正文',
    }));
    const asset201 = await client.post('/api/assets/import/confirm', {
      filename: 'g06-201.txt',
      name: 'G06超限资产',
      typeId: 'G06剧本类型',
      sections: sections201,
    });
    expect(asset201.json.ok).toBe(false);
    expect(asset201.json.error.code).toBe('VALIDATION');

    expect((await client.get('/api/kb')).json.entries).toHaveLength(kbBefore.length);
    expect((await client.get('/api/assets')).json.assets).toHaveLength(assetsBefore.length);
  });

  it('⑤ docx 两段：预览 2 草案且正文无格式残留标签', async () => {
    const docx = buildDocx([
      'DOCX标题一ZZQ 第一段正文 docxbody1',
      'DOCX标题二ZZQ 第二段 &amp; 正文 docxbody2',
    ]);
    const preview = await multipartPost(
      '/api/kb/import/preview',
      { scope: 'company' },
      'g06-doc.docx',
      docx,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(preview.json.ok).toBe(true);
    expect(preview.json.drafts).toHaveLength(2);
    expect(preview.json.drafts[0].body).toContain('DOCX标题一ZZQ');
    expect(preview.json.drafts[0].body).toContain('docxbody1');
    expect(preview.json.drafts[1].body).toContain('DOCX标题二ZZQ');
    expect(preview.json.drafts[1].body).toContain('& 正文');
    for (const d of preview.json.drafts as any[]) {
      expect(d.body).not.toContain('<');
      expect(d.body).not.toContain('&amp;');
      expect(d.body).not.toContain('w:');
      expect(d.title).not.toContain('<');
    }
  });
});
