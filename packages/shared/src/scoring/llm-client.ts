import type { LLMClient } from '../types.js';

export interface WorkersAiBindingLike {
  run(model: string, options: unknown): Promise<unknown>;
}

export type CloudflareAiBinding = WorkersAiBindingLike;

export class WorkersAiClient implements LLMClient {
  private readonly ai: WorkersAiBindingLike;
  private readonly model: string;

  constructor(ai: WorkersAiBindingLike, model: string = '@cf/meta/llama-3.1-8b-instruct') {
    this.ai = ai;
    this.model = model;
  }

  async generateText(prompt: string): Promise<string> {
    const response = (await this.ai.run(this.model, {
      messages: [
        {
          role: 'system',
          content:
            'You are a strict, analytical job applicant fit evaluator. Output strictly JSON with no surrounding markdown or explanation.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
    })) as { response?: string } | string;

    if (typeof response === 'string') {
      return response;
    }
    return response?.response ?? JSON.stringify(response);
  }
}

export class TransientLlmError extends Error {
  public readonly status: number;
  public readonly retryAfterMs: number | undefined;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'TransientLlmError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface GeminiClientOptions {
  delayFn?: ((ms: number) => Promise<void>) | undefined;
  maxRetries?: number | undefined;
}

function parseRetryAfterMs(headerVal: string | null, attempt: number): number {
  const defaultBackoff = Math.min(5000, 500 * (attempt + 1));
  if (!headerVal) return defaultBackoff;
  const seconds = Number.parseInt(headerVal.trim(), 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(5000, seconds * 1000);
  }
  return defaultBackoff;
}

export class GeminiClient implements LLMClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchFn: typeof fetch;
  private readonly delayFn: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(
    apiKey: string,
    model: string = 'gemini-2.0-flash',
    fetchFn: typeof fetch = fetch,
    options?: GeminiClientOptions,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchFn = (input, init) => fetchFn(input, init);
    this.delayFn =
      options?.delayFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options?.maxRetries ?? 2;
  }

  async generateText(prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    });

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
        };
        return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      }

      const isTransient = res.status === 429 || res.status >= 500;
      if (isTransient) {
        const waitMs = parseRetryAfterMs(res.headers.get('Retry-After'), attempt);
        if (attempt < this.maxRetries) {
          await res.body?.cancel?.();
          await this.delayFn(waitMs);
          continue;
        }
        const errText = await res.text();
        throw new TransientLlmError(
          `Gemini API error (${res.status}): ${errText}`,
          res.status,
          waitMs,
        );
      }

      const errText = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${errText}`);
    }

    throw new TransientLlmError('Gemini API error: retries exhausted', 503);
  }
}

export class MockLLMClient implements LLMClient {
  private responses: string[];
  public calls: string[] = [];

  constructor(responses?: string | string[]) {
    if (!responses) {
      this.responses = [];
    } else {
      this.responses = Array.isArray(responses) ? [...responses] : [responses];
    }
  }

  setResponses(responses: string | string[]): void {
    this.responses = Array.isArray(responses) ? [...responses] : [responses];
    this.calls = [];
  }

  async generateText(prompt: string): Promise<string> {
    this.calls.push(prompt);
    const nextResp =
      this.responses.shift() ??
      JSON.stringify({
        score: 85,
        matched_skills: ['TypeScript', 'SQL'],
        missing_skills: [],
        red_flags: [],
        reasons: 'Strong technical fit with profile skills and experience.',
      });
    return nextResp;
  }
}

export function createLLMClient(config: {
  provider?: string | undefined;
  ai?: WorkersAiBindingLike | undefined;
  aiBinding?: WorkersAiBindingLike | undefined;
  geminiApiKey?: string | undefined;
  mockClient?: LLMClient | undefined;
  model?: string | undefined;
}): LLMClient {
  if (config.mockClient) {
    return config.mockClient;
  }
  if (config.provider === 'gemini' && config.geminiApiKey) {
    return new GeminiClient(config.geminiApiKey, config.model ?? 'gemini-2.0-flash');
  }
  const ai = config.ai ?? config.aiBinding;
  if (ai) {
    return new WorkersAiClient(ai, config.model ?? '@cf/meta/llama-3.1-8b-instruct');
  }
  throw new Error(
    `Cannot create LLMClient: provider is '${config.provider}', but missing binding or API key.`,
  );
}
