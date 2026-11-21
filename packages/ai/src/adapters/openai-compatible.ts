import { asObject, first, parseProviderJson, postProviderJson } from "./http.ts";
import { ProviderError, providerHttpError } from "../provider-errors.ts";
import type { AIProviderAdapter } from "../router.ts";

type Options = {
  endpoint: string;
  apiKey: string;
  structuredOutputMode: "STRICT_JSON_SCHEMA" | "JSON_MODE" | "PROMPT_JSON";
  timeoutMs: number;
  fetcher: typeof fetch;
};

export function openAICompatibleAdapter({
  endpoint, apiKey, fetcher, timeoutMs, structuredOutputMode,
}: Options): AIProviderAdapter {
  return {
    async generateStructured({ model, systemPrompt, userPayload, jsonSchema }) {
      const payload: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: structuredOutputMode === "STRICT_JSON_SCHEMA" ? systemPrompt
            : `${systemPrompt}\nReturn a JSON object following this JSON Schema: ${JSON.stringify(jsonSchema)}` },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      };
      if (structuredOutputMode === "STRICT_JSON_SCHEMA") {
        payload.response_format = {
          type: "json_schema", json_schema: { name: "proposal_draft_v1", strict: true, schema: jsonSchema },
        };
      }
      if (structuredOutputMode === "JSON_MODE") payload.response_format = { type: "json_object" };

      const response = await postProviderJson(fetcher, endpoint, { authorization: `Bearer ${apiKey}` }, payload, timeoutMs);
      const error = asObject(response.error);
      if (error) {
        throw typeof error.code === "number" ? providerHttpError(error.code) : new ProviderError("PROVIDER_ERROR");
      }
      const choice = first(response.choices);
      const message = asObject(choice?.message);
      if ((choice?.finish_reason !== undefined && choice.finish_reason !== "stop") || message?.refusal) {
        throw new ProviderError("INVALID_STRUCTURED_OUTPUT");
      }
      return parseProviderJson(message?.content);
    },
  };
}
