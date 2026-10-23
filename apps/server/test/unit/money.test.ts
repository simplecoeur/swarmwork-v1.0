import { describe, expect, it } from 'vitest';
import { deriveBalanceMilli, milliToYuan, tokenCostMilli, yuanToMilli } from '@swarm/shared';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb } from '../../src/store/db';
import { Repos } from '../../src/store/repositories';
import { balanceMilli } from '../../src/domain/costService';

describe('金额换算（厘）', () => {
  it('元 ↔ 厘往返', () => {
    expect(yuanToMilli(100)).toBe(100_000);
    expect(yuanToMilli(0.003)).toBe(3);
    expect(yuanToMilli(99.997)).toBe(99_997);
    expect(milliToYuan(99_997)).toBe(99.997);
    expect(milliToYuan(3)).toBe(0.003);
  });

  it('token 成本 = 总 token × 单价 ÷ 1e6（整数厘）', () => {
    // mock 口径：300 token、单价 10 元/百万 = 10000 厘/百万 → 3 厘 = 0.003 元
    expect(tokenCostMilli(300, yuanToMilli(10))).toBe(3);
    expect(tokenCostMilli(0, 10_000)).toBe(0);
    expect(tokenCostMilli(150, yuanToMilli(2))).toBe(0); // 0.3 厘四舍五入为 0
  });

  it('余额推导 = purchases − ledger', () => {
    expect(deriveBalanceMilli([100_000], [3])).toBe(99_997);
    expect(deriveBalanceMilli([], [])).toBe(0);
    expect(deriveBalanceMilli([50], [80])).toBe(-30); // 可为负（欠费标记）
  });
});

describe('余额推导（仓储层，真实 SQLite）', () => {
  it('插入采购与账本后按 API 推导', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-unit-'));
    const db = openDb(path.join(dir, 't.db'));
    const repos = new Repos(db);
    repos.insertApi({
      id: 'api_x',
      name: 'X',
      provider: 'custom',
      base_url: '',
      api_key_enc: '',
      model: 'm',
      price_per_m_milli: 10_000,
      created_at: new Date().toISOString(),
    });
    repos.insertPurchase('api_x', 100_000);
    repos.insertLedger({
      task_id: 't1',
      team_id: 'team1',
      api_id: 'api_x',
      stage: '执行',
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cost_milli: 2,
      estimated: 0,
      created_at: new Date().toISOString(),
    });
    repos.insertLedger({
      task_id: 't1',
      team_id: 'team1',
      api_id: 'api_x',
      stage: '审核',
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cost_milli: 1,
      estimated: 0,
      created_at: new Date().toISOString(),
    });
    expect(balanceMilli(repos, 'api_x')).toBe(99_997);
    // append-only：仓储层不存在账本更新/删除方法
    expect((repos as unknown as Record<string, unknown>).updateLedger).toBeUndefined();
    expect((repos as unknown as Record<string, unknown>).deleteLedger).toBeUndefined();
    db.close();
  });
});
