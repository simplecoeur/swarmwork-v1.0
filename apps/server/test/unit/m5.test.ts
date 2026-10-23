import { describe, expect, it } from 'vitest';
import { canTransition, TaskStatus } from '@swarm/shared';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb } from '../../src/store/db';
import { Repos, type TaskRow } from '../../src/store/repositories';
import {
  cancelTask,
  deleteTask,
  DomainError,
  refreshProjectStatus,
  retryTask,
} from '../../src/domain/taskService';

/**
 * M5 单元：已取消状态迁移合法性 + 后悔药 domain 口径（取消/重试/删除）+ 项目聚合的已取消扩展。
 * 全部走内存级临时 SQLite，不起服务、不调模型。
 */
function setup(): Repos {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-m5-'));
  const repos = new Repos(openDb(path.join(dir, 't.db')));
  repos.insertTeam({
    id: 'team_1',
    name: '第一小组',
    color: '#000',
    api_id: null,
    created_at: new Date().toISOString(),
    deleted_at: null,
  });
  return repos;
}

let seq = 0;
function makeTask(repos: Repos, patch: Partial<TaskRow> = {}): TaskRow {
  seq += 1;
  const row: TaskRow = {
    id: `task_${seq}`,
    project_id: null,
    team_id: 'team_1',
    assignee_id: null,
    title: `t${seq}`,
    type: '文案',
    brief: '',
    status: TaskStatus.PENDING,
    result: '',
    review_note: '',
    reject_reason: '',
    reject_count: 0,
    blocked_reason: '',
    blocked_code: null,
    adjudicated: 0,
    idempotency_key: null,
    total_tokens: 0,
    total_cost_milli: 0,
    heartbeat_at: null,
    injected_kb_ids: '[]',
    created_at: new Date().toISOString(),
    claimed_at: null,
    finished_at: null,
    ...patch,
  };
  repos.insertTask(row);
  return repos.getTask(row.id)!;
}

describe('M5 状态机：已取消迁移合法性', () => {
  it('合法：待领取/被打回/待审核 → 已取消', () => {
    expect(canTransition(TaskStatus.PENDING, TaskStatus.CANCELLED)).toBe(true);
    expect(canTransition(TaskStatus.REJECTED, TaskStatus.CANCELLED)).toBe(true);
    expect(canTransition(TaskStatus.REVIEWING, TaskStatus.CANCELLED)).toBe(true);
  });

  it('非法：执行中/已完成/已取消 不能进已取消；已取消是终态', () => {
    expect(canTransition(TaskStatus.RUNNING, TaskStatus.CANCELLED)).toBe(false);
    expect(canTransition(TaskStatus.DONE, TaskStatus.CANCELLED)).toBe(false);
    expect(canTransition(TaskStatus.ADJUDICATION, TaskStatus.CANCELLED)).toBe(false);
    expect(canTransition(TaskStatus.CANCELLED, TaskStatus.PENDING)).toBe(false);
    expect(canTransition(TaskStatus.CANCELLED, TaskStatus.RUNNING)).toBe(false);
  });
});

describe('M5 cancelTask 口径', () => {
  it('待领取可取消：落终态、写 finished_at、清 blocked', () => {
    const repos = setup();
    const t = makeTask(repos, { blocked_code: 'NO_API_KEY', blocked_reason: '未填 Key' });
    const next = cancelTask(repos, t);
    expect(next.status).toBe(TaskStatus.CANCELLED);
    expect(next.finished_at).toBeTruthy();
    expect(next.blocked_code).toBeNull();
    expect(next.blocked_reason).toBe('');
  });

  it('被打回可取消', () => {
    const repos = setup();
    const t = makeTask(repos, { status: TaskStatus.REJECTED, reject_count: 1 });
    expect(cancelTask(repos, t).status).toBe(TaskStatus.CANCELLED);
  });

  it('待审核 + 停工可取消；待审核未停工拒绝', () => {
    const repos = setup();
    const blocked = makeTask(repos, {
      status: TaskStatus.REVIEWING,
      blocked_code: 'PROVIDER_ERROR',
      blocked_reason: '审核调用失败',
    });
    expect(cancelTask(repos, blocked).status).toBe(TaskStatus.CANCELLED);
    const reviewing = makeTask(repos, { status: TaskStatus.REVIEWING });
    expect(() => cancelTask(repos, reviewing)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
  });

  it('执行中/已完成/待裁决/已取消 均拒绝', () => {
    const repos = setup();
    for (const status of [TaskStatus.RUNNING, TaskStatus.DONE, TaskStatus.ADJUDICATION, TaskStatus.CANCELLED]) {
      const t = makeTask(repos, { status });
      expect(() => cancelTask(repos, t)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TRANSITION' }),
      );
    }
  });
});

describe('M5 retryTask 口径', () => {
  it('停工任务：清 blocked_code/reason，状态不变', () => {
    const repos = setup();
    const t = makeTask(repos, { blocked_code: 'INSUFFICIENT_BALANCE', blocked_reason: '余额不足' });
    const next = retryTask(repos, t);
    expect(next.blocked_code).toBeNull();
    expect(next.blocked_reason).toBe('');
    expect(next.status).toBe(TaskStatus.PENDING);
  });

  it('已取消不可重试（INVALID_TRANSITION）', () => {
    const repos = setup();
    const t = makeTask(repos, { status: TaskStatus.CANCELLED });
    expect(() => retryTask(repos, t)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
  });

  it('未停工任务不可重试（VALIDATION）：待领取无 blocked / 已完成 / 执行中', () => {
    const repos = setup();
    for (const status of [TaskStatus.PENDING, TaskStatus.DONE, TaskStatus.RUNNING]) {
      const t = makeTask(repos, { status });
      expect(() => retryTask(repos, t)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    }
  });
});

describe('M5 deleteTask 口径（删任务不删账）', () => {
  it('已完成可删：任务行消失，ledger 行保留', () => {
    const repos = setup();
    const t = makeTask(repos, { status: TaskStatus.DONE });
    repos.insertLedger({
      task_id: t.id,
      team_id: 'team_1',
      api_id: 'api_1',
      stage: '执行',
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cost_milli: 2,
      estimated: 0,
      created_at: new Date().toISOString(),
    });
    deleteTask(repos, t);
    expect(repos.getTask(t.id)).toBeUndefined();
    expect(repos.listLedger().filter((l) => l.task_id === t.id).length).toBe(1);
    expect(repos.ledgerSumByTask(t.id).totalTokens).toBe(150);
  });

  it('已取消可删；未完成状态拒绝（VALIDATION）', () => {
    const repos = setup();
    const c = makeTask(repos, { status: TaskStatus.CANCELLED });
    deleteTask(repos, c);
    expect(repos.getTask(c.id)).toBeUndefined();
    for (const status of [TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.ADJUDICATION]) {
      const t = makeTask(repos, { status });
      expect(() => deleteTask(repos, t)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
      expect(repos.getTask(t.id)).toBeDefined();
    }
  });
});

describe('M5 项目聚合：已取消不阻塞交付', () => {
  function setupProject(repos: Repos): string {
    repos.insertProject({
      id: 'proj_1',
      name: 'p',
      brief: '',
      team_id: 'team_1',
      client_name: '',
      status: '进行中',
      created_at: new Date().toISOString(),
    });
    return 'proj_1';
  }

  it('子任务 [已完成, 已取消] → 已交付', () => {
    const repos = setup();
    const pid = setupProject(repos);
    makeTask(repos, { project_id: pid, status: TaskStatus.DONE });
    makeTask(repos, { project_id: pid, status: TaskStatus.CANCELLED });
    refreshProjectStatus(repos, pid);
    expect(repos.getProject(pid)!.status).toBe('已交付');
  });

  it('子任务全部已取消 → 保持进行中（无可交付内容）', () => {
    const repos = setup();
    const pid = setupProject(repos);
    makeTask(repos, { project_id: pid, status: TaskStatus.CANCELLED });
    refreshProjectStatus(repos, pid);
    expect(repos.getProject(pid)!.status).toBe('进行中');
  });

  it('取消最后一个未完成子任务后，项目随之变已交付（cancelTask 内含聚合刷新）', () => {
    const repos = setup();
    const pid = setupProject(repos);
    makeTask(repos, { project_id: pid, status: TaskStatus.DONE });
    const pending = makeTask(repos, { project_id: pid, status: TaskStatus.PENDING });
    cancelTask(repos, pending);
    expect(repos.getProject(pid)!.status).toBe('已交付');
  });

  it('DomainError 仍是统一错误载体', () => {
    const repos = setup();
    const t = makeTask(repos, { status: TaskStatus.RUNNING });
    try {
      cancelTask(repos, t);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
    }
  });
});
