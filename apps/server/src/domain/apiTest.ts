import { createProvider } from '../llm/gateway';
import { encryptKey } from '../store/crypto';
import type { ApiRow } from '../store/repositories';
import { nowIso } from '../util';

/**
 * API 测试连接（M5 本体，v1.3.0 C2 抽出共用）：直连 Provider 发一次最小 chat
 * （max_tokens=1、15s 超时），不走网关——不记账、不扣余额、不触发熔断。
 * 既有 POST /api/apis/test（对已存/表单配置）与 POST /api/apis/test-connection（对裸配置）共用本函数，
 * 不许另写第二套测试逻辑。成败都以结果体返回（失败含厂商原文摘要）。
 */
export const API_TEST_TIMEOUT_MS = 15_000;

export interface ApiTestConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ApiTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

export async function testApiConnection(
  cfg: ApiTestConfig,
  opts: { workspaceId?: string; apiId?: string; name?: string; createdAt?: string } = {},
): Promise<ApiTestResult> {
  if (!cfg.apiKey) return { ok: false, latencyMs: 0, message: '未填写 API Key（先填 Key 再测连接）' };
  if (!cfg.baseUrl) return { ok: false, latencyMs: 0, message: '未填写 Base URL' };
  if (!cfg.model) return { ok: false, latencyMs: 0, message: '未填写模型名' };
  const probeRow: ApiRow = {
    id: opts.apiId ?? 'api_test_probe',
    name: opts.name ?? 'test',
    provider: cfg.provider,
    base_url: cfg.baseUrl,
    api_key_enc: encryptKey(cfg.apiKey),
    model: cfg.model,
    price_per_m_milli: 0,
    created_at: opts.createdAt ?? nowIso(),
    workspace_id: opts.workspaceId ?? '',
  };
  const t0 = Date.now();
  try {
    await createProvider(probeRow).chat({
      model: cfg.model,
      system: '',
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
      maxTokens: 1,
      timeoutMs: API_TEST_TIMEOUT_MS,
    });
    const latencyMs = Date.now() - t0;
    return { ok: true, latencyMs, message: `连接成功，模型「${cfg.model}」已响应` };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, latencyMs, message };
  }
}
