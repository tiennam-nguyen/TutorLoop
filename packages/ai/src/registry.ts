export type AIModelConfig = {
  provider: "GEMINI" | "OPENROUTER" | "GROQ" | "NVIDIA_NIM";
  model: string;
  transport: "GEMINI_NATIVE" | "OPENAI_COMPATIBLE";
  structuredOutputMode: "NATIVE_JSON_SCHEMA" | "STRICT_JSON_SCHEMA" | "JSON_MODE" | "PROMPT_JSON";
  timeoutMs: number;
  maxRetries: number;
};

export const AI_MODEL_REGISTRY = [
  { provider: "GEMINI", model: "gemini-3.8-flash", transport: "GEMINI_NATIVE",
    structuredOutputMode: "NATIVE_JSON_SCHEMA", timeoutMs: 30_000, maxRetries: 1 },
  { provider: "OPENROUTER", model: "z-ai/glm-5.3-flash:free", transport: "OPENAI_COMPATIBLE",
    structuredOutputMode: "PROMPT_JSON", timeoutMs: 30_000, maxRetries: 1 },
  { provider: "GROQ", model: "openai/gpt-oss-120b", transport: "OPENAI_COMPATIBLE",
    structuredOutputMode: "STRICT_JSON_SCHEMA", timeoutMs: 30_000, maxRetries: 1 },
  { provider: "NVIDIA_NIM", model: "nvidia/nemotron-3-ultra-550b-a55b", transport: "OPENAI_COMPATIBLE",
    structuredOutputMode: "PROMPT_JSON", timeoutMs: 45_000, maxRetries: 1 },
] as const satisfies readonly AIModelConfig[];
