import { ProviderError, providerHttpError } from "../provider-errors.ts";

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function first(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? asObject(value[0]) : undefined;
}

export function parseProviderJson(text: unknown): unknown {
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      // JSON.parse errors may include fragments of the model response.
    }
  }
  throw new ProviderError("INVALID_STRUCTURED_OUTPUT");
}

export async function postProviderJson(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  payload: object,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body, signal, redirect: "error",
    });
  } catch {
    throw new ProviderError(signal.aborted ? "TIMEOUT" : "NETWORK_ERROR");
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw providerHttpError(response.status);
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ProviderError(signal.aborted ? "TIMEOUT" : "NETWORK_ERROR");
  }
  const result = asObject(parseProviderJson(text));
  if (!result) throw new ProviderError("INVALID_STRUCTURED_OUTPUT");
  return result;
}
