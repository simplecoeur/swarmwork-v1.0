import { LLM_GUARD, tokenCostMilli, type LedgerStage } from '@swarm/shared';
import { decryptKey } from '../store/crypto';
import type { ApiRow, Repos } from '../store/repositories';
import type { Logger } from '../logger';
import { AnthropicProvider } from './anthropic';
import { CircuitBreaker, CircuitOpenError } from './breaker';
import { OpenAiCompatibleProvider } from './openai';
import { isRetryable, type LlmProvider, type Usage } from './provider';

export function createProvider(api: ApiRow): LlmProvider {
  const key = decryptKey(api.api_key_enc);
  return api.provider === 'anthropic'
    ? new AnthropicProvider(api.base_url, key)
    : new OpenAiCompatibleProvider(api.base_url, key);
}

export interface GatewayCall<T> {
  taskId: string;
  teamId: string;
  api: ApiRow;
  stage: LedgerStage;
  /** 调用幂等键：同键已完成的调用直接复用结果且不重复记账（§8） */
  idempotencyKey: string;
  run: (provider: LlmProvider) => Promise<{ text: string; usage: Usage; payload: T }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * LLM 调用网关：熔断 → 幂等 → 重试（指数退避，仅网络/5xx/429，≤2 次）→
 * 成功后同事务写 ledger + 累计任务总耗（§8/§9）。
 */
export class LlmGateway {
  readonly breaker = new CircuitBreaker();

  constructor(
    private readonly repos: Repos,
    private readonly logger: Logger,
  ) {}

  async call<T>(params: GatewayCall<T>): Promise<{ text: string; usage: Usage; payload: T }> {
    const { repos } = this;
    const existing = repos.getLlmCall(params.idempotencyKey);
    if (existing && existing.status === 'done' && existing.result_text !== null) {
      // 已完成过的调用：复用结果，不再重复记账
      const stored = JSON.parse(existing.result_text) as { text: string; payload: T };
      return {
        text: stored.text,
        usage: {
          promptTokens: existing.prompt_tokens ?? 0,
          completionTokens: existing.completion_tokens ?? 0,
          estimated: existing.estimated === 1,
        },
        payload: stored.payload,
      };
    }

    const { probe } = this.breaker.beforeCall(params.api.id);
    repos.startLlmCall(params.idempotencyKey, params.api.id);
    const baseMs = Number(process.env.LLM_RETRY_BASE_MS || LLM_GUARD.RETRY_BASE_MS);
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= LLM_GUARD.MAX_RETRIES; attempt++) {
      try {
        const provider = createProvider(params.api);
        const out = await params.run(provider);
        const total = out.usage.promptTokens + out.usage.completionTokens;
        const costMilli = tokenCostMilli(total, params.api.price_per_m_milli);
        repos.tx(() => {
          repos.insertLedger({
            task_id: params.taskId,
            team_id: params.teamId,
            api_id: params.api.id,
            stage: params.stage,
            prompt_tokens: out.usage.promptTokens,
            completion_tokens: out.usage.completionTokens,
            total_tokens: total,
            cost_milli: costMilli,
            estimated: out.usage.estimated ? 1 : 0,
            created_at: new Date().toISOString(),
          });
          repos.finishLlmCall(
            params.idempotencyKey,
            JSON.stringify({ text: out.text, payload: out.payload }),
            out.usage.promptTokens,
            out.usage.completionTokens,
            out.usage.estimated ? 1 : 0,
          );
          repos.addTaskTotals(params.taskId, total, costMilli);
        });
        this.breaker.onSuccess(params.api.id);
        this.logger.info('llm', `调用成功 stage=${params.stage} tokens=${total}`, {
          taskId: params.taskId,
          apiId: params.api.id,
        });
        return out;
      } catch (e) {
        lastError = e;
        if (!isRetryable(e) || attempt === LLM_GUARD.MAX_RETRIES) break;
        const backoff = baseMs * Math.pow(2, attempt);
        this.logger.warn(
          'llm',
          `调用失败将重试 attempt=${attempt + 1} backoff=${backoff}ms：${e instanceof Error ? e.message : String(e)}`,
          { taskId: params.taskId, apiId: params.api.id },
        );
        await sleep(backoff);
      }
    }

    this.breaker.onFailure(params.api.id, probe);
    repos.failLlmCall(params.idempotencyKey);
    this.logger.error(
      'llm',
      `调用最终失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
      { taskId: params.taskId, apiId: params.api.id },
    );
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

export { CircuitOpenError };
