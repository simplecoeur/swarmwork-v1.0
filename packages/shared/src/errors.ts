/** 统一错误结构（设计 §7）：{ ok:false, error:{ code, message } } */
export const ErrorCode = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  NO_API: 'NO_API',
  NO_API_KEY: 'NO_API_KEY',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  INTERNAL: 'INTERNAL',
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
