import { describe, expect, it } from 'vitest';
import { canTransition, TaskStatus } from '@swarm/shared';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb } from '../../src/store/db';
import { Repos, type TaskRow } from '../../src/store/repositories';
import { DomainError, transitionTask, type TaskGuards } from '../../src/domain/taskService';

function setup(): { repos: Repos; task: TaskRow } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-sm-'));
  const repos = new Repos(openDb(path.join(dir, 't.db')));
  repos.insertTeam({
    id: 'team_1',
    name: '第一小组',
    color: '#000',
    api_id: null,
    created_at: new Date().toISOString(),
    deleted_at: null,
  });
  const task: TaskRow = {
    id: 'task_1',
    project_id: null,
    team_id: 'team_1',
    assignee_id: null,
    title: 't',
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
    created_at: new Date().toISOString(),
    claimed_at: null,
    finished_at: null,
  };
  repos.insertTask(task);
  return { repos, task };
}

const okGuards: TaskGuards = {
  resolveApi: () => ({ id: 'api_1', apiKey: 'sk-test' }),
  balanceMilli: () => 1000,
  runningCount: () => 0,
  concurrencyLimit: () => 4,
  budgetTokens: () => 0,
};

describe('状态机合法/非法迁移', () => {
  it('合法迁移表', () => {
    expect(canTransition(TaskStatus.PENDING, TaskStatus.RUNNING)).toBe(true);
    expect(canTransition(TaskStatus.RUNNING, TaskStatus.REVIEWING)).toBe(true);
    expect(canTransition(TaskStatus.REVIEWING, TaskStatus.DONE)).toBe(true);
    expect(canTransition(TaskStatus.REVIEWING, TaskStatus.REJECTED)).toBe(true);
    expect(canTransition(TaskStatus.REJECTED, TaskStatus.RUNNING)).toBe(true);
    expect(canTransition(TaskStatus.REJECTED, TaskStatus.ADJUDICATION)).toBe(true);
    expect(canTransition(TaskStatus.ADJUDICATION, TaskStatus.DONE)).toBe(true);
  });

  it('非法迁移被拒', () => {
    expect(canTransition(TaskStatus.PENDING, TaskStatus.DONE)).toBe(false);
    expect(canTransition(TaskStatus.DONE, TaskStatus.RUNNING)).toBe(false);
    expect(canTransition(TaskStatus.PENDING, TaskStatus.REVIEWING)).toBe(false);
    const { repos, task } = setup();
    expect(() => transitionTask(repos, task, TaskStatus.DONE)).toThrow(DomainError);
    try {
      transitionTask(repos, task, TaskStatus.DONE);
    } catch (e) {
      expect((e as DomainError).code).toBe('INVALID_TRANSITION');
    }
  });
});

describe('状态机守卫（§6）', () => {
  it('守卫全过：pending → running 并写心跳', () => {
    const { repos, task } = setup();
    const next = transitionTask(repos, task, TaskStatus.RUNNING, {}, okGuards);
    expect(next.status).toBe(TaskStatus.RUNNING);
    expect(next.heartbeat_at).toBeTruthy();
    expect(next.claimed_at).toBeTruthy();
  });

  it('无 Key → NO_API_KEY', () => {
    const { repos, task } = setup();
    const guards = { ...okGuards, resolveApi: () => ({ id: 'a', apiKey: '' }) };
    expect(() => transitionTask(repos, task, TaskStatus.RUNNING, {}, guards)).toThrowError(
      expect.objectContaining({ code: 'NO_API_KEY' }),
    );
  });

  it('余额不足 → INSUFFICIENT_BALANCE', () => {
    const { repos, task } = setup();
    const guards = { ...okGuards, balanceMilli: () => 0 };
    expect(() => transitionTask(repos, task, TaskStatus.RUNNING, {}, guards)).toThrowError(
      expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }),
    );
  });

  it('预算已满 → BUDGET_EXCEEDED', () => {
    const { repos, task } = setup();
    repos.addTaskTotals(task.id, 100, 0);
    const fresh = repos.getTask(task.id)!;
    const guards = { ...okGuards, budgetTokens: () => 50 };
    expect(() => transitionTask(repos, fresh, TaskStatus.RUNNING, {}, guards)).toThrowError(
      expect.objectContaining({ code: 'BUDGET_EXCEEDED' }),
    );
  });

  it('裁决通过不受守卫拦截（§15.2 豁免预算闸门）', () => {
    const { repos, task } = setup();
    repos.updateTaskStatus(task.id, TaskStatus.ADJUDICATION, {});
    const adj = repos.getTask(task.id)!;
    const next = transitionTask(repos, adj, TaskStatus.DONE, { adjudicated: 1 });
    expect(next.status).toBe(TaskStatus.DONE);
    expect(next.adjudicated).toBe(1);
  });
});
