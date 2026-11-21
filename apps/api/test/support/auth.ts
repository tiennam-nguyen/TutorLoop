import type { AuthVerifier } from "../../src/auth/principal.ts";

export const anonymousAuthVerifier: AuthVerifier = async () => null;

export function fixedUserAuthVerifier(userId: string): AuthVerifier {
  return async () => ({ userId });
}
