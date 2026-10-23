import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

/**
 * 旧数据迁移对账（设计 §13 M2）：构造 v0 JSON 夹具 → 跑 tools/migrate-from-json.js
 * → 断言退出码 0、对账一致、SQLite 内推导余额正确；再对真实 ../local-app/data 跑一遍。
 */
const SERVER_DIR = process.cwd();
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const TOOL = path.join(REPO_ROOT, 'tools', 'migrate-from-json.js');

function runTool(src: string, dst: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('node', [TOOL, src, dst], { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function writeFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const ts = '2026-10-23T00:00:00.000Z';
  const settings = {
    apis: [
      {
        id: 'api_a',
        name: '夹具 API',
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:9',
        apiKey: 'sk-fixture-123',
        model: 'm',
        pricePerM: 10,
        balanceYuan: 99.996,
      },
    ],
    defaultApiId: 'api_a',
    teams: [{ id: 'team_1', name: '第一小组', color: '#e2574c', apiId: null }],
    members: [
      { id: 'team_1_m2', teamId: 'team_1', role: '文案', name: '妙笔', persona: '文案人设', prompt: '' },
    ],
    reviewStandards: { points: '标题必须带数字', clientNeeds: '' },
    params: { concurrency: 4, taskBudgetTokens: 0 },
  };
  const tasks = [
    {
      id: 'task_1',
      title: '夹具任务',
      type: '文案',
      brief: 'b',
      teamId: 'team_1',
      assigneeId: 'team_1_m2',
      status: '已完成',
      result: '成果正文',
      reviewNote: '符合标准',
      rejectReason: '',
      rejectCount: 0,
      blockedReason: '',
      totalTokens: 300,
      totalCost: 0.004,
      createdAt: ts,
      claimedAt: ts,
      finishedAt: ts,
    },
  ];
  const ledger = [
    { ts, taskId: 'task_1', teamId: 'team_1', apiId: 'api_a', stage: '执行', promptTokens: 100, completionTokens: 50, totalTokens: 150, costYuan: 0.0015 },
    { ts, taskId: 'task_1', teamId: 'team_1', apiId: 'api_a', stage: '审核', promptTokens: 100, completionTokens: 50, totalTokens: 150, costYuan: 0.0015 },
  ];
  const purchases = [{ ts, apiId: 'api_a', amountYuan: 100 }];
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(tasks));
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(ledger));
  fs.writeFileSync(path.join(dir, 'purchases.json'), JSON.stringify(purchases));
}

describe('迁移工具对账', () => {
  it('夹具数据：任务/账本/token/成本迁移前后一致，推导余额正确', async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-mig-src-'));
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-mig-dst-'));
    writeFixture(src);
    const { code, stdout } = await runTool(src, dst);
    expect(code).toBe(0);
    expect(stdout).toContain('对账结果：一致');
    expect(stdout).toContain('任务数：      1 → 1');
    expect(stdout).toContain('总 token：    300 → 300');

    const db = new DatabaseSync(path.join(dst, 'swarm.db'));
    const purchases = db.prepare("SELECT COALESCE(SUM(amount_milli),0) AS s FROM purchases WHERE api_id='api_a'").get() as { s: number };
    const ledgerSum = db.prepare("SELECT COALESCE(SUM(cost_milli),0) AS s FROM ledger_entries WHERE api_id='api_a'").get() as { s: number };
    // 每条 0.0015 元 → round(1.5)=2 厘 ×2 条 = 4 厘；余额 = 100000 − 4
    expect(purchases.s - ledgerSum.s).toBe(99_996);
    const taskCount = db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number };
    expect(taskCount.c).toBe(1);
    db.close();
  });

  it('真实 v0 数据（../local-app/data）可迁移且对账一致', async () => {
    const src = path.resolve(REPO_ROOT, '..', 'local-app', 'data');
    if (!fs.existsSync(path.join(src, 'settings.json'))) return; // 环境无旧数据时跳过
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-mig-real-'));
    const { code, stdout } = await runTool(src, dst);
    expect(code).toBe(0);
    expect(stdout).toContain('对账结果：一致');
  });
});
