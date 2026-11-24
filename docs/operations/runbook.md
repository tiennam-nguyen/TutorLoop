# TutorLoop operations runbook

## Configure the environment

Use Node.js 26.13.0, pnpm 11.25.0, and PostgreSQL 18. Keep runtime credentials in the host secret store or an ignored local environment file. Use a dedicated database and a restricted role for each environment. Give the migration identity the schema privileges it needs.

| Process | Variables |
| --- | --- |
| API | `DATABASE_URL`, `APP_ORIGIN`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. `HOST` and `PORT` control the bind address and port. The container defaults to `0.0.0.0:3001`. |
| Worker | `DATABASE_URL`, `AI_PRIMARY_PROVIDER`, `AI_PRIMARY_MODEL`, `AI_FALLBACK_PROVIDER`, `AI_FALLBACK_MODEL`, and the API key for each selected route. Supported key variables are `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, and `NVIDIA_NIM_API_KEY`. |
| Web | `API_INTERNAL_URL` points at the private API origin at runtime. The container listens on port 3000. |
| Migration | `DATABASE_URL` points at the target PostgreSQL database. |

Set `APP_ORIGIN` to the browser-facing web origin, including the scheme and any nondefault port. Use HTTPS for the pilot and register the exact Google OAuth callback at `<APP_ORIGIN>/api/auth/callback/google`. Use a randomly generated `BETTER_AUTH_SECRET` of at least 32 characters. Keep the API and PostgreSQL private in the pilot. The browser reaches the API through the web origin under `/api/`.

## Start the stack and apply migrations

For local Compose, create a separate ignored `.env.compose` file using `.env.example` as a list of variables. Set `DATABASE_URL=postgresql://tutorloop:tutorloop@postgres:5432/tutorloop` and `API_INTERNAL_URL=http://api:3001` for the local Compose network. Set `APP_ORIGIN=http://localhost:3000` to match the default web port, and provide the auth settings and approved worker route settings. `POSTGRES_PORT` and `WEB_PORT` override the default host loopback ports if needed. Update `APP_ORIGIN` and the registered Google callback together when changing the web port. The bundled PostgreSQL credentials are for local Compose.

```sh
docker compose --env-file .env.compose up -d --wait postgres
docker compose --env-file .env.compose build
docker compose --env-file .env.compose run --rm --no-deps api node packages/db/src/migrate.ts
docker compose --env-file .env.compose up -d api worker web
docker compose --env-file .env.compose ps
```

For host processes, install dependencies with `pnpm install --frozen-lockfile`. Export variables into each process environment. With local Compose PostgreSQL, host processes use `127.0.0.1` and the published PostgreSQL port in `DATABASE_URL`. Run `pnpm db:migrate` once before starting the API and worker. Start the API with `pnpm --filter @tutorloop/api dev`, the worker with `pnpm --filter @tutorloop/worker start`, and the web with `pnpm --filter @tutorloop/web dev` in separate terminals. The host web and API use ports 3000 and 3001 by default.

On a pilot host, provision PostgreSQL and run the migration command against that database before starting the application images. Use the same image revision for migration, API, worker, and web. Check the API internally with `GET /health` and `GET /ready`. Liveness reports whether the API can respond. Readiness runs a database query and returns HTTP 503 when it fails. A provider outage can leave both probes green. Confirm the web sign-in page and its same-origin API route separately, and confirm the worker stays up and handles a synthetic note before introducing classroom data.

## Respond to structuring failure

Teachers can continue saving notes while AI is unavailable. A saved note can show waiting, structuring, or failed. Check API readiness, worker process status, and sanitized job or provider error codes. Check provider access or rate limits using the operator account. If the worker exits during a database outage, start it again after the API reports ready. For Compose, run `docker compose --env-file .env.compose up -d worker`. After service recovers, open the failed note in Recent captures and use **Retry structuring**. Review the new proposal and apply the intended items. Use the same saved note to preserve provenance. Review the note status and existing history before recording another observation.

Keep application logs, reverse-proxy logs, error reports, and analytics limited to approved metadata such as request and entity IDs, operation, status, duration, provider/model, and error code. Keep note bodies, student labels, manifestations, prompt text, model output, cookies, keys, and database URLs out of logs. Restrict access to operational logs and apply the pilot's retention policy.

## Rehearse backup and restore before a pilot

Arrange encrypted, access-controlled backups and agree on who can restore them and how much data loss and downtime the pilot can tolerate. Back up the PostgreSQL database, including auth, jobs, and migration state. Preserve the application configuration and secret references separately in the approved secret store. Use a PostgreSQL 18 client with compatible server versions. A database operator can set up local `libpq` service entries for the source and for a newly created, isolated empty target database. Run the commands from a protected backup location outside the checkout.

```sh
pg_dump --format=custom --file=tutorloop.dump --dbname='service=tutorloop_backup'
pg_restore --exit-on-error --no-owner --no-privileges --dbname='service=tutorloop_restore' tutorloop.dump
```

Protect the dump from creation through retention. Restore to the isolated target with worker processing disabled. Check migrations, compare representative row counts, and verify teacher access, a saved note and its linked history, and the reassessment queue against the source snapshot. Verify ownership and grants for the target environment. Record the restored backup time, elapsed recovery time, and operator before accepting real classroom data. For actual recovery, stop writes and worker processing, rehearse on an isolated copy, and switch traffic to the verified restore through the host's recovery process.

## Review provider pins

Run `pnpm benchmark:ai` manually against the bundled synthetic cases with the provider credentials in the command environment. Record the revision, prompt, schema, redaction version, and candidate results before changing either pin. The existing live v1 artifact predates the v2 canonical merge prompt and provider schema. Repeat the live benchmark for the running v2 revision and assess merge proposals separately because the benchmark dataset has no merge case. Review the recommendation and operational limits, then set distinct registered primary and fallback provider/model pairs with their keys. Confirm the new route on synthetic work before accepting pilot notes. See the [AI benchmark guide](../testing/ai-benchmark.md).
