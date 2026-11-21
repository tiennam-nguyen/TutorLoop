import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { ApiError, getMe } from "./api";

export async function getSession(signal: AbortSignal) {
  try {
    return await getMe(signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function useWorkspaceError() {
  const router = useRouter();
  return useCallback((error: unknown): string | null => {
    if (!(error instanceof ApiError)) return "Couldn't reach TutorLoop. Try again.";
    if (error.status === 401) {
      router.replace("/login");
      return null;
    }
    if (error.code === "STALE_VERSION") return "This item changed. Reload the page and try again.";
    return error.message;
  }, [router]);
}
