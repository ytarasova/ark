# Ark -- multi-stage Dockerfile for hosted deployment
#
# Builds the Ark server with web UI, conductor, and all dependencies.
# Uses Bun runtime (required -- bun:sqlite, Bun.serve, etc.).

# ── Stage 1: Install dependencies ────────────────────────────────────────────

FROM oven/bun:1.3 AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── Stage 2: Build ───────────────────────────────────────────────────────────

FROM oven/bun:1.3 AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY packages/ packages/
COPY agents/ agents/
COPY flows/ flows/
COPY skills/ skills/
COPY recipes/ recipes/
COPY ark ./ark

# Build TypeScript
RUN bun run build

# Build web UI (if vite config exists)
RUN if [ -f packages/web/vite.config.ts ]; then \
      cd packages/web && bunx vite build --logLevel error; \
    fi

# ── Stage 3: Production image ────────────────────────────────────────────────

FROM oven/bun:1.3-slim AS production
WORKDIR /app

# Install runtime system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    tmux \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy built artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/ark ./ark

# Copy resource definitions (agents, flows, skills, recipes)
COPY --from=build /app/agents ./agents
COPY --from=build /app/flows ./flows
COPY --from=build /app/skills ./skills
COPY --from=build /app/recipes ./recipes

# Copy web UI build output (if it exists)
COPY --from=build /app/packages/web/dist ./packages/web/dist

# Create ark data directory
RUN mkdir -p /root/.ark

# Expose ports:
#   8420  - Web UI
#   19100 - Conductor (agent coordination)
#   8430  - LLM Router
EXPOSE 8420 19100 8430

# Health check via conductor
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:19100/health || exit 1

# Default: start Ark web server with conductor
CMD ["bun", "run", "dist/cli/index.js", "web", "--port", "8420"]
