"use client";

import { createAuthClient } from "better-auth/client";
import { useState } from "react";

export default function LoginPage() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setPending(true);
    setFailed(false);
    try {
      const auth = createAuthClient({ baseURL: window.location.origin, basePath: "/api/auth" });
      const { data, error } = await auth.signIn.social({ provider: "google", callbackURL: "/classes" });
      if (error || !data?.redirect) throw new Error("Google sign-in could not start.");
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <main className="login">
      <section className="panel">
        <h1>Sign in to TutorLoop</h1>
        <button className="primary" type="button" onClick={signIn} disabled={pending}>
          {pending ? "Opening Google…" : "Continue with Google"}
        </button>
        {failed && <p role="alert">Couldn't start Google sign-in. Try again.</p>}
      </section>
    </main>
  );
}
