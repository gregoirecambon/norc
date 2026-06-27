FROM node:22-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@9
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install
COPY src ./src
COPY tsconfig.json ./
RUN pnpm build
# Copy SQL migration files (tsc only compiles .ts, not .sql)
RUN cp -r src/db/migrations dist/db/migrations

FROM node:22-alpine
WORKDIR /app
RUN npm install -g pnpm@9
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile 2>/dev/null || pnpm install --prod
COPY --from=builder /app/dist ./dist
# The agent/connect skill markdown served at /api/skill & /api/agents/invite.
# Resolved at runtime as ../../skills from dist/lib & dist/routes (→ /app/skills).
COPY skills ./skills
# Chore process definitions, resolved at runtime as ../../chores (→ /app/chores).
COPY chores ./chores
# The bundled norc-claude-worker served at GET /api/worker (→ /app/assets).
COPY assets ./assets
RUN mkdir -p /data
ENV DATABASE_PATH=/data/norc.db
EXPOSE 3001
CMD ["node", "dist/index.js"]
