# Ark -- multi-stage Dockerfile for hosted deployment
#
# Builds the Ark server with web UI, conductor, and all dependencies.
# Uses Bun runtime (required -- bun:sqlite, Bun.serve, etc.).

# ── Stage 1: Install dependencies ────────────────────────────────────────────

FROM oven/bun:1.3 AS deps
WORKDIR /app

# Build tools for transitive native modules (better-sqlite3 etc.). Only
# present in the deps stage; stripped from the final production image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── Stage 2: Build ───────────────────────────────────────────────────────────
#
# Bun runs TypeScript directly at runtime; no `tsc` compile required for
# the server itself. The build stage exists to:
#   1. produce the web UI bundle (packages/web/dist) via Vite
#   2. snapshot the source tree we copy into the runtime image
# Skipping `bun run build` (tsc) avoids fighting accumulated type drift
# in code paths we are not running.

FROM oven/bun:1.3 AS build
WORKDIR /app

# Native build tools for transitive deps (better-sqlite3 etc.) and Vite.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY agents/ agents/
COPY flows/ flows/
COPY skills/ skills/
COPY recipes/ recipes/
COPY ark ./ark

# Build web UI (Vite). Server code stays as .ts -- Bun runs it directly.
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

# Production node_modules come from the deps stage (no devDeps) --
# keeps the final image slim. Source comes from the build stage.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/bun.lock ./
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/packages ./packages
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

# Default: start Ark control plane (server --hosted). Bun runs the .ts
# entry point directly, no compile step required.
CMD ["bun", "packages/cli/index.ts", "server", "start", "--hosted", "--port", "8420"]
