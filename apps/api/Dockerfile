FROM node:26.13.0-bookworm-slim
RUN npm install --global pnpm@11.25.0
WORKDIR /app
COPY . .
RUN pnpm --filter @tutorloop/api... install --prod --frozen-lockfile
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
USER node
EXPOSE 3001
CMD ["node", "apps/api/src/server.ts"]
