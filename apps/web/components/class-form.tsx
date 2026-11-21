"use client";

import { createClassInputSchema, type ClassDto } from "@tutorloop/contracts";
import { useRef, useState, type FormEvent } from "react";
import { createClass } from "../lib/api";
import { useWorkspaceError } from "../lib/session";

export function ClassForm({ onCreated }: { onCreated: (classroom: ClassDto) => void }) {
  const workspaceError = useWorkspaceError();
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestId = useRef<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = createClassInputSchema.safeParse({
      name: name.trim(),
      timezone: timezone.trim(),
      clientRequestId: requestId.current ??= crypto.randomUUID(),
    });
    if (!input.success) {
      setError("Enter a class name and a valid timezone, such as UTC or Asia/Bangkok.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      onCreated(await createClass(input.data));
      requestId.current = null;
      setName("");
    } catch (failure) {
      setError(workspaceError(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="create-class">
      <h2 id="create-class">Create a class</h2>
      <form className="stack" onSubmit={submit}>
        <label>
          Class name
          <input required value={name} disabled={pending} onChange={(event) => {
            setName(event.target.value);
            requestId.current = null;
          }} />
        </label>
        <label>
          Timezone
          <input required value={timezone} disabled={pending} onChange={(event) => {
            setTimezone(event.target.value);
            requestId.current = null;
          }} />
        </label>
        <button className="primary" type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create class"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
