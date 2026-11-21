import { asObject, first, parseProviderJson, postProviderJson } from "./http.ts";
import { ProviderError } from "../provider-errors.ts";
import type { AIProviderAdapter } from "../router.ts";

export function geminiAdapter(apiKey: string, timeoutMs: number, fetcher: typeof fetch): AIProviderAdapter {
  return {
    async generateStructured({ model, systemPrompt, userPayload, jsonSchema }) {
      const response = await postProviderJson(
        fetcher,
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { "x-goog-api-key": apiKey },
        {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: JSON.stringify(userPayload) }] }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: jsonSchema },
        },
        timeoutMs,
      );
      const candidate = first(response.candidates);
      if (candidate?.finishReason !== undefined && candidate.finishReason !== "STOP") {
        throw new ProviderError("INVALID_STRUCTURED_OUTPUT");
      }
      const parts = asObject(candidate?.content)?.parts;
      const text = Array.isArray(parts)
        ? parts.map(asObject).map((part) => part?.thought === true ? "" : part?.text)
          .filter((part) => typeof part === "string").join("")
        : undefined;
      return parseProviderJson(text);
    },
  };
}
