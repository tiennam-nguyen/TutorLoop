import { createApp } from "./app.ts";

const app = await createApp({ authVerifier: async () => null });

await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3001),
});
