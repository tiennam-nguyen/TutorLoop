import type { FastifyRequest } from "fastify";
import { ApiError } from "../common/errors.ts";

export type AuthPrincipal = {
  userId: string;
  email?: string;
};

export type AuthVerifier = (
  request: FastifyRequest,
) => Promise<AuthPrincipal | null>;

export async function requirePrincipal(request: FastifyRequest): Promise<AuthPrincipal> {
  const verify = request.server.getDecorator<AuthVerifier>("authVerifier");
  const principal = await verify(request);
  if (!principal) {
    throw new ApiError("UNAUTHENTICATED", "Authentication is required.");
  }
  return principal;
}
