export type ProviderErrorCode =
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_STRUCTURED_OUTPUT"
  | "PROVIDER_REJECTED_REQUEST"
  | "PROVIDER_ERROR";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: ProviderErrorCode) {
    super(code);
    this.code = code;
    this.retryable = code !== "PROVIDER_REJECTED_REQUEST" && code !== "PROVIDER_ERROR";
  }
}

export function providerHttpError(status: number): ProviderError {
  if (status === 429) return new ProviderError("RATE_LIMITED");
  if (status === 408) return new ProviderError("TIMEOUT");
  if (status >= 500 && status <= 599) return new ProviderError("PROVIDER_UNAVAILABLE");
  return new ProviderError("PROVIDER_REJECTED_REQUEST");
}
