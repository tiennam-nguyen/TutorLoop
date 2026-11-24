# TutorLoop

TutorLoop helps a teacher turn quick classroom observations into reviewed student and class histories, plan group practice, and follow up with reassessments.

## Verify locally

Install Node.js 26.13.0, pnpm 11.25.0, and Docker with Compose. Run these commands from the repository root while Docker is running. The integration and browser suites each provision real PostgreSQL 18 through Testcontainers. The browser suite starts its own app and uses deterministic Fake AI. The suites need no external AI or Google credentials.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration --maxWorkers 2
pnpm exec playwright install chromium
pnpm test:e2e --workers 1
```

Run `pnpm test:e2e --grep '@mvp|AI outage' --workers 1` to exercise the full classroom loop and outage recovery. GitHub Actions runs the full checks on pushes and pull requests. On Linux, use `pnpm exec playwright install --with-deps chromium` to install browser system dependencies as well.

## Run the application

The application runs as three processes or images for web, API, and worker, with PostgreSQL 18. Build the images from the repository root with `docker compose build`. To run the stack, follow the environment setup, migration, startup, and restore instructions in the [operations runbook](docs/operations/runbook.md).

The live AI benchmark runs separately by manual command with provider credentials. See the [AI benchmark guide](docs/testing/ai-benchmark.md). For a classroom walkthrough with a teacher, use the [representative user check](docs/testing/representative-user-check.md).
