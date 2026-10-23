import { LLM_GUARD } from '@swarm/shared';

export interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** 任一字段为估算时为 true（厂商未返回 usage，§15.1） */
  estimated: boolean;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: Msg[];
  temperature: number;
  /** 输出 token 上限（缺省：OpenAI 兼容侧不下发、Anthropic 侧用 4096）；测试连接用 1 做最小探活（M5） */
  maxTokens?: number;
  /** 本次调用超时覆盖（缺省 LLM_GUARD.TIMEOUT_MS）；测试连接用短超时快速失败（M5） */
  timeoutMs?: number;
}

export interface ReviewRequest {
  model: string;
  /** 审核员人设（成员 persona） */
  persona: string;
  standards: { points: string; clientNeeds: string };
  draft: string;
  taskTitle: string;
  taskBrief: string;
  temperature: number;
}

export interface ReviewResult {
  pass: boolean;
  reason: string;
  usage: Usage;
}

/** 统一 Provider 接口（设计 §8）：业务代码不感知厂商差异 */
export interface LlmProvider {
  chat(req: ChatRequest): Promise<{ text: string; usage: Usage }>;
  review(req: ReviewRequest): Promise<ReviewResult>;
}

/** 带 HTTP 状态的错误，供重试分类（网络错误无 status） */
export class HttpError extends Error {
  constructor(
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** 仅网络错误 / 429 / 5xx 可重试（§15.1），4xx 业务错误不重试 */
export function isRetryable(e: unknown): boolean {
  if (e instanceof HttpError) {
    return e.status === null || e.status === 429 || e.status >= 500;
  }
  return true; // 非 HttpError 多为网络层异常（AbortError/fetch TypeError）
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number = LLM_GUARD.TIMEOUT_MS,
): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    throw new HttpError(null, `网络错误：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(res.status, '响应不是合法 JSON');
  }
}
