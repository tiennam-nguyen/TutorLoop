"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { getSession } from "../lib/session";

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    getSession(signal).then((session) => {
      if (signal.aborted) return;
      if (session) setStatus("ready");
      else router.replace("/login");
    }).catch(() => {
      if (!signal.aborted) setStatus("error");
    });
    return () => controller.abort();
  }, [attempt, router]);

  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">TutorLoop</Link>
          {status === "ready" && (
            <nav aria-label="Main navigation"><Link href="/classes">Classes</Link></nav>
          )}
        </div>
      </header>
      <main className="workspace">
        {status === "loading" && <p role="status">Checking your session…</p>}
        {status === "error" && (
          <>
            <p role="alert">Couldn't check your session.</p>
            <button type="button" onClick={() => {
              setStatus("loading");
              setAttempt((previous) => previous + 1);
            }}>Try again</button>
          </>
        )}
        {status === "ready" && children}
      </main>
    </>
  );
}
