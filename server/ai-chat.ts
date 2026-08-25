/**
 * Unified AI chat completions helper. Works with any configured provider
 * (NVIDIA, DeepSeek) using their OpenAI-compatible /chat/completions API.
 */
import { readAIKey, AI_PROVIDERS, type AIProvider } from "./ai-key";

export interface AIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIChatOptions {
  provider?:  AIProvider;
  model?:     string;
  messages:   AIChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface AIChatResult {
  content:    string;
  provider:   AIProvider;
  model:      string;
  usage?:     { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * Send a chat completion request to the AI provider.
 * Falls back to next provider if the primary fails.
 */
export async function aiChat(opts: AIChatOptions): Promise<AIChatResult> {
  const providers: AIProvider[] = opts.provider
    ? [opts.provider, ...((["nvidia", "deepseek"] as AIProvider[]).filter(p => p !== opts.provider))]
    : (["nvidia", "deepseek"] as AIProvider[]);

  let lastError: Error | null = null;

  for (const provider of providers) {
    const apiKey = readAIKey(provider);
    if (!apiKey) continue;

    const cfg = AI_PROVIDERS[provider];
    const model = opts.model || cfg.defaultModel;

    try {
      const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: opts.messages,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: opts.temperature ?? 0.7,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`${provider} API ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json() as any;
      const choice = data.choices?.[0];
      if (!choice?.message?.content) throw new Error(`${provider}: empty response`);

      return {
        content:    choice.message.content,
        provider,
        model,
        usage:      data.usage ? {
          promptTokens:     data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens:      data.usage.total_tokens ?? 0,
        } : undefined,
      };
    } catch (err: any) {
      lastError = err;
      continue;
    }
  }

  throw lastError || new Error("No AI provider configured. Set NVIDIA_API_KEY or DEEPSEEK_API_KEY.");
}
