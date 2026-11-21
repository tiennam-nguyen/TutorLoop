import type { FastifyRequest } from "fastify";

export type AuthPrincipal = {
  userId: string;
  email?: string;
};

export type AuthVerifier = (
  request: FastifyRequest,
) => Promise<AuthPrincipal | null>;
