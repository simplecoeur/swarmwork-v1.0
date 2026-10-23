/**
 * 任务状态机（设计 §6 + §15.2）。
 * 线缆状态值与 M1 前端契约保持一致（中文），常量名用英文便于代码引用。
 *
 * 说明：设计中的 blocked（停工）在本实现中建模为「覆盖层」而非独立状态值——
 * 任务 status 保持 待领取/被打回/待审核，并附 blockedCode/blockedReason，
 * 守卫恢复后由引擎自动重新领取（§15.2）。理由：M1 前端状态枚举不含「停工」，
 * 且 blocked 的语义是「当前不可领取」而非生命周期阶段。
 */
export const TaskStatus = {
  PENDING: '待领取',
  RUNNING: '执行中',
  REVIEWING: '待审核',
  REJECTED: '被打回',
  ADJUDICATION: '待裁决',
  DONE: '已完成',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const ProjectStatus = {
  IN_PROGRESS: '进行中',
  ADJUDICATION: '待裁决',
  DONE: '已交付',
} as const;

export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

/** 合法迁移表（§6）：from → to[]。守卫条件在 domain 层 transitionTask 中校验。 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  [TaskStatus.PENDING]: [TaskStatus.RUNNING],
  // RUNNING → PENDING/REJECTED 为基础设施失败时的系统回滚（回滚到的阶段可续跑，不重复已回账阶段）
  [TaskStatus.RUNNING]: [
    TaskStatus.REVIEWING,
    TaskStatus.ADJUDICATION,
    TaskStatus.PENDING,
    TaskStatus.REJECTED,
  ],
  [TaskStatus.REVIEWING]: [
    TaskStatus.DONE,
    TaskStatus.REJECTED,
    TaskStatus.ADJUDICATION,
    TaskStatus.PENDING,
  ],
  [TaskStatus.REJECTED]: [TaskStatus.RUNNING, TaskStatus.ADJUDICATION],
  [TaskStatus.ADJUDICATION]: [TaskStatus.DONE],
  [TaskStatus.DONE]: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}

/** 停工原因枚举（§6 守卫 + §15.2：保留最近一次原因直至成功领取） */
export const BlockedCode = {
  NO_API: 'NO_API', // 未配置可用 API（组未分配且无默认）
  NO_API_KEY: 'NO_API_KEY', // API 未填 Key
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE', // 余额 ≤ 0
  MISSING_MEMBER: 'MISSING_MEMBER', // 小组缺对应工种/审核成员
  PROVIDER_ERROR: 'PROVIDER_ERROR', // 调用失败（网络/厂商错误）
  CIRCUIT_OPEN: 'CIRCUIT_OPEN', // 熔断中
} as const;

export type BlockedCode = (typeof BlockedCode)[keyof typeof BlockedCode];

/** 打回满此次数自动转待裁决（§6） */
export const MAX_REJECTS_BEFORE_ADJUDICATION = 2;
