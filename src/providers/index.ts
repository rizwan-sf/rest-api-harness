import { env } from "../config/env.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import type { Provider, ProviderId } from "./types.js";

export function createProvider(id: ProviderId, modelOverride?: string): Provider {
  switch (id) {
    case "anthropic": {
      if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
      return createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: modelOverride ?? env.ANTHROPIC_MODEL });
    }
    case "openai": {
      if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
      return createOpenAIProvider({ apiKey: env.OPENAI_API_KEY, model: modelOverride ?? env.OPENAI_MODEL });
    }
  }
}
