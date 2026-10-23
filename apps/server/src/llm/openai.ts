import { fetchJson, type ChatRequest, type LlmProvider, type ReviewRequest, type ReviewResult } from './provider';
import { buildReviewSystem, buildReviewUser, normalizeUsage, parseVerdict } from './parse';

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** OpenAI 兼容实现（DeepSeek / OpenAI / 自定义，/chat/completions） */
export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async chat(req: ChatRequest): Promise<{ text: string; usage: ReviewResult['usage'] }> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const j = (await fetchJson(
      base + '/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
        body: JSON.stringify({
          model: req.model,
          temperature: req.temperature,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          messages: [
            { role: 'system', content: req.system },
            ...req.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        }),
      },
      req.timeoutMs,
    )) as OpenAiChatResponse;
    const text = j.choices?.[0]?.message?.content ?? '';
    const promptText = req.system + req.messages.map((m) => m.content).join('');
    return {
      text,
      usage: normalizeUsage(
        { promptTokens: j.usage?.prompt_tokens, completionTokens: j.usage?.completion_tokens },
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
