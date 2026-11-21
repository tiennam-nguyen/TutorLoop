import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";
import { authBasePath } from "./better-auth.ts";

export function registerAuthRoutes(
  app: FastifyInstance,
  origin: string,
  handler: (request: Request) => Promise<Response>,
): void {
  app.register(async (auth) => {
    // Better Auth parses these payloads. Keep Fastify's domain parsers outside this plugin.
    auth.removeContentTypeParser(["application/json", "text/plain"]);
    auth.addContentTypeParser(
      ["application/json", "text/plain", "application/x-www-form-urlencoded"],
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    auth.route<{ Body: Buffer }>({
      method: ["GET", "POST"],
      url: `${authBasePath}/*`,
      async handler(request, reply) {
        // Next.js proxies this path from the browser's origin.
        const url = new URL(`${origin}${request.url}`);
        const headers = fromNodeHeaders(request.headers);
        const body = request.body?.length ? new Uint8Array(request.body) : undefined;
        const response = await handler(new Request(url, { method: request.method, headers, body }));

        reply.code(response.status);
        response.headers.forEach((value, name) => {
          if (name !== "set-cookie") reply.header(name, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header("set-cookie", cookies);
        return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
      },
    });
  });
}
