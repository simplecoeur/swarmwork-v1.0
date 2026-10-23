import { fetchJson, type ChatRequest, type LlmProvider, type ReviewRequest, type ReviewResult, type Usage } from './provider';
import { buildReviewSystem, buildReviewUser, normalizeUsage, parseVerdict } from './parse';

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Anthropic 实现（/v1/messages，system 独立字段，x-api-key 鉴权） */
export class AnthropicProvider implements LlmProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async chat(req: ChatRequest): Promise<{ text: string; usage: Usage }> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const j = (await fetchJson(
      base + '/v1/messages',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 4096,
          temperature: req.temperature,
          system: req.system,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      },
      req.timeoutMs,
    )) as AnthropicResponse;
    const text = (j.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    const promptText = req.system + req.messages.map((m) => m.content).join('');
    return {
      text,
      usage: normalizeUsage(
        { promptTokens: j.usage?.input_tokens, completionTokens: j.usage?.output_tokens },
        promptText,
        text,
      ),
    };
  }

  async review(req: ReviewRequest): Promise<ReviewResult> {
    const system = buildReviewSystem(req.persona, req.standards);
    const user = buildReviewUser(req.taskTitle, req.taskBrief, req.draft);
    const { text, usage } = await this.chat({
      model: req.model,
      system,
      messages: [{ role: 'user', content: user }],
      temperature: req.temperature,
    });
    const verdict = parseVerdict(text);
    return { pass: verdict.pass, reason: verdict.reason, usage };
  }
}
