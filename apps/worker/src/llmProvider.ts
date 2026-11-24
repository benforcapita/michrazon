import type { LlmCompleteRequest, LlmCompleteResult, LlmProvider } from '@michrazon/core';

// OpenAI-compatible chat-completions provider. The fetch impl is injected —
// tests never touch the network; real calls only happen in the deployed
// worker with LLM_API_KEY set.

export type LlmFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface ChatCompletionsProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl: LlmFetch;
  id?: string;
}

export class ChatCompletionsProvider implements LlmProvider {
  readonly id: string;
  private readonly baseUrl: string;

  constructor(private readonly opts: ChatCompletionsProviderOptions) {
    this.id = opts.id ?? 'chat_completions';
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
    const res = await this.opts.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        temperature: req.temperature,
        max_tokens: req.maxOutputTokens,
        response_format: { type: 'json_schema', json_schema: { name: 'classification', schema: req.jsonSchema, strict: true } },
      }),
    });
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
      error?: { message?: string };
    };
    if (res.status >= 400) {
      throw new Error(`llm provider error (${res.status}): ${body.error?.message ?? 'unknown'}`);
    }
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      modelId: body.model ?? this.opts.model,
    };
  }
}
