FROM node:26.13.0-bookworm-slim
RUN npm install --global pnpm@11.25.0
WORKDIR /app
COPY . .
RUN pnpm --filter @tutorloop/worker... install --prod --frozen-lockfile
ENV NODE_ENV=production
USER node
CMD ["node", "apps/worker/src/server.ts"]
