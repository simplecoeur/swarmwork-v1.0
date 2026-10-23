/** 统一错误结构（设计 §7）：{ ok:false, error:{ code, message } } */
export const ErrorCode = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  NO_API: 'NO_API',
  NO_API_KEY: 'NO_API_KEY',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  /** 成员删除守卫：名下仍有未完成任务（M5） */
  MEMBER_HAS_ACTIVE_TASKS: 'MEMBER_HAS_ACTIVE_TASKS',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  INTERNAL: 'INTERNAL',
  /** 未登录或会话失效（M6） */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** 已登录但无权（非管理员/须先改密等，M6） */
  FORBIDDEN: 'FORBIDDEN',
  /** 登录失败次数过多，账号临时锁定（M6） */
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
}

export interface Ok<T> {
  ok: true;
  data?: T;
}

export interface Err {
  ok: false;
  error: ApiErrorBody;
}

export type ApiResult<T> = Ok<T> | Err;
