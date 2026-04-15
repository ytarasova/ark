# ── Ark Makefile ─────────────────────────────────────────────────────────────
#
# Local development, testing, building, and packaging.
#
# Quick reference:
#   make install       Install deps + symlink ark CLI
#   make claude-tfy    Claude Code -> TrueFoundry (direct; --continue + skip-permissions on by default)
#   make dev           Hot-reload CLI + Web UI (two processes)
#   make test          Run all unit tests (sequential)
#   make test-e2e      Run Playwright E2E tests against Web UI
#   make build         Build native macOS binary + Electron app
#   make package       Package everything for distribution

.PHONY: help install dev dev-daemon dev-arkd dev-web claude-tfy web desktop \
        test test-file test-e2e test-e2e-fast test-e2e-web test-install test-watch lint lint-fix \
        format format-check \
        build build-cli build-web build-desktop \
        package package-cli package-desktop \
        vendor-tmux vendor-tensorzero vendor-codegraph \
        clean uninstall

BUN := bun
ARK_BIN := /usr/local/bin/ark
# Bedrock allowlist ids are pi-agentic/<slug> (two /-segments). Use that literal string for make claude-tfy.
TRUEFOUNDRY_ANTHROPIC_MODEL_DEFAULT := pi-agentic/global.anthropic.claude-opus-4-6-v1
# make claude-tfy passes --dangerously-skip-permissions unless CLAUDE_SKIP_PERMISSIONS=0 (unsafe; dev/sandbox only).
CLAUDE_SKIP_PERMISSIONS ?= 1
CLAUDE_DANGEROUSLY_SKIP_FLAGS := $(if $(filter 0,$(CLAUDE_SKIP_PERMISSIONS)),,--dangerously-skip-permissions)
# Resume latest session in this directory unless CLAUDE_CONTINUE=0.
CLAUDE_CONTINUE ?= 1
CLAUDE_CONTINUE_FLAGS := $(if $(filter 0,$(CLAUDE_CONTINUE)),,--continue)

help: ## Show available commands
	@echo ""
	@echo "  \033[1mDevelopment\033[0m"
	@grep -E '^(install|dev|dev-daemon|dev-arkd|dev-web|claude-tfy|web|desktop):' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  \033[1mTesting\033[0m"
	@grep -E '^(test|test-file|test-e2e|test-install|test-watch|lint|format):' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  \033[1mBuilding & Packaging\033[0m"
	@grep -E '^(build|build-cli|build-web|build-desktop|package|package-cli|package-desktop):' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  \033[1mOther\033[0m"
	@grep -E '^(clean|uninstall|lint):' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""

# ── Development ──────────────────────────────────────────────────────────────

install: ## Install deps and symlink `ark` to PATH
	@command -v bun >/dev/null 2>&1 || { echo "Bun not found. Install: curl -fsSL https://bun.sh/install | bash"; exit 1; }
	$(BUN) install
	@mkdir -p $(HOME)/.ark/bin
	@echo "Linking ark -> $(HOME)/.ark/bin/ark"
	@ln -sf "$(CURDIR)/ark" $(HOME)/.ark/bin/ark
	@ln -sf "$(CURDIR)/ark" $(ARK_BIN) 2>/dev/null || true
	@echo "Done."

dev: ## Hot-reload: ark web (:8420) + Vite dev server (:5173) with HMR
	@$(BUN) install --silent
	@echo "\033[1mArk dev mode\033[0m"
	@echo "  API:  http://localhost:8420  (bun --watch, auto-restarts on changes)"
	@echo "  Web:  http://localhost:5173  (Vite HMR, proxies /api to :8420)"
	@echo "  CLI:  ./ark <command>        (runs from source, no build)"
	@echo ""
	@trap 'kill 0' EXIT; \
	  $(BUN) --watch packages/cli/index.ts web --port 8420 --api-only 2>&1 | sed 's/^/[api] /' & \
	  sleep 1 && cd packages/web && npx vite --port 5173 2>&1 | sed 's/^/[web] /' & \
	  wait

dev-daemon: ## Hot-reload: server daemon (conductor :19100 + arkd :19300 + WS :19400)
	@echo "\033[1mArk server daemon (hot-reload)\033[0m"
	@echo "  WebSocket:  ws://localhost:19400"
	@echo "  Conductor:  http://localhost:19100"
	@echo "  ArkD:       http://localhost:19300"
	@echo ""
	$(BUN) --watch packages/cli/index.ts server daemon start

dev-arkd: ## Hot-reload: arkd agent daemon (:19300)
	@echo "\033[1mArkD agent daemon (hot-reload)\033[0m"
	@echo "  ArkD:  http://localhost:19300"
	@echo ""
	$(BUN) --watch packages/cli/index.ts arkd

dev-web: ## Hot-reload: API server (:8420) + Vite frontend (:5173)
	@echo "\033[1mArk Web (hot-reload)\033[0m"
	@echo "  API:  http://localhost:8420"
	@echo "  Web:  http://localhost:5173"
	@echo ""
	@trap 'kill 0' EXIT; \
	  $(BUN) --watch packages/cli/index.ts web --port 8420 --api-only 2>&1 | sed 's/^/[api] /' & \
	  sleep 1 && cd packages/web && npx vite --port 5173 2>&1 | sed 's/^/[web] /' & \
	  wait

# TrueFoundry: https://truefoundry.com/docs/ai-gateway/claude-code (ANTHROPIC_BASE_URL + Bearer in ANTHROPIC_CUSTOM_HEADERS).
# Claude Code gateway requirements: https://code.claude.com/docs/en/llm-gateway (Messages /v1/messages, forward anthropic-* headers).
claude-tfy: ## Claude Code -> TrueFoundry (direct; --continue unless CLAUDE_CONTINUE=0)
	@command -v claude >/dev/null 2>&1 || { echo "Claude Code not found. Install: https://docs.anthropic.com/en/docs/claude-code"; exit 1; }
	cd "$(CURDIR)" && \
	  if [ -f .env ]; then set -a && . ./.env && set +a; fi && \
	  test -n "$$TRUEFOUNDRY_API_KEY" || { echo "Set TRUEFOUNDRY_API_KEY in .env"; exit 1; } && \
	  tfy_anth_base="$$TRUEFOUNDRY_ANTHROPIC_BASE_URL"; \
	  if [ -z "$$tfy_anth_base" ]; then tfy_anth_base="$$TRUEFOUNDRY_API_BASE"; fi; \
	  if [ -z "$$tfy_anth_base" ]; then echo "Set TRUEFOUNDRY_ANTHROPIC_BASE_URL (preferred) or TRUEFOUNDRY_API_BASE in .env"; exit 1; fi; \
	  unset ANTHROPIC_AUTH_TOKEN 2>/dev/null || true; \
	  export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 && \
	  export ANTHROPIC_BASE_URL="$$tfy_anth_base" && \
	  export ANTHROPIC_API_KEY=dummy && \
	  export ANTHROPIC_CUSTOM_HEADERS="Authorization: Bearer $$TRUEFOUNDRY_API_KEY" && \
	  if [ -z "$(strip $(ARGS))" ]; then \
	    tfy_m="$$TRUEFOUNDRY_ANTHROPIC_MODEL"; \
	    if [ -z "$$tfy_m" ]; then tfy_m="$(TRUEFOUNDRY_ANTHROPIC_MODEL_DEFAULT)"; fi; \
	    export ANTHROPIC_MODEL="$$tfy_m" && \
	    exec claude $(CLAUDE_DANGEROUSLY_SKIP_FLAGS) $(CLAUDE_CONTINUE_FLAGS); \
	  else \
	    exec claude $(CLAUDE_DANGEROUSLY_SKIP_FLAGS) $(CLAUDE_CONTINUE_FLAGS) $(ARGS); \
	  fi

self: ## Dispatch full SDLC (plan->implement->review->PR) against THIS repo
	@test -n "$(TASK)" || (echo 'Usage: make self TASK="<description>"'; exit 1)
	./ark session start --recipe self-dogfood --summary "$(TASK)" --dispatch

self-quick: ## Dispatch single-agent quick fix against THIS repo
	@test -n "$(TASK)" || (echo 'Usage: make self-quick TASK="<description>"'; exit 1)
	./ark session start --recipe self-quick --summary "$(TASK)" --dispatch

web: ## Launch the web dashboard (production build)
	@$(MAKE) build-web --no-print-directory
	./ark web

desktop: build-web ## Launch the Electron desktop app
	@cd packages/desktop && npm install --silent 2>/dev/null && npx electron .

# ── Testing ──────────────────────────────────────────────────────────────────

test: build-web ## Run all unit tests (sequential -- never parallel)
	$(BUN) test packages/core packages/compute packages/server packages/protocol packages/arkd packages/web --concurrency 1

test-file: ## Run a single test: make test-file F=packages/core/__tests__/foo.test.ts
	$(BUN) test $(F) --concurrency 1

test-e2e: test-web-e2e ## Run all end-to-end tests (web Playwright)

test-web-e2e: build-web ## Run web end-to-end tests (Playwright against the web dashboard)
	@# `bunx --bun playwright test` runs Playwright under Bun, which is
	@# required: fixtures/web-server.ts uses Bun APIs (`import { spawn }
	@# from "bun"`, `import.meta.dir`, `Bun.sleep`) that Node can't parse.
	@# Using `npx playwright test` here produces a misleading
	@# "SyntaxError: Cannot use 'import.meta' outside a module" on every
	@# spec file.
	@cd packages/e2e && bun install --silent 2>/dev/null; \
	  bunx --bun playwright install chromium --with-deps 2>/dev/null; \
	  bunx --bun playwright test

test-install: ## Run install.sh regression tests (docs/install.sh)
	@./scripts/tests/install/test-symlink-preservation.sh
	@./scripts/tests/install/test-installed-binary-runs.sh
	@./scripts/tests/install/test-api-failure-path.sh
	@./scripts/tests/install/test-installed-builtin-flows.sh
	@./scripts/tests/install/test-web-proxy-serves.sh
	@./scripts/tests/install/test-channel-subprocess.sh

test-watch: ## Run unit tests in watch mode
	$(BUN) test --watch

lint: ## Lint the codebase (ESLint + TypeScript)
	npx eslint packages/ --max-warnings 0

lint-fix: ## Auto-fix lint issues
	npx eslint packages/ --fix

format: ## Format code with Prettier
	npx prettier --write "packages/**/*.{ts,tsx,js,jsx,json,css}"

format-check: ## Check code formatting (CI gate)
	npx prettier --check "packages/**/*.{ts,tsx,js,jsx,json,css}"

# ── Building ─────────────────────────────────────────────────────────────────

build: build-cli build-web ## Build CLI binary + web frontend

build-cli: ## Build native macOS CLI binary (current arch)
	@echo "Building native binary..."
	@mkdir -p node_modules/react-devtools-core 2>/dev/null; \
	  test -f shims/react-devtools-core.js && \
	  cp shims/react-devtools-core.js node_modules/react-devtools-core/index.js && \
	  echo '{"main":"index.js"}' > node_modules/react-devtools-core/package.json || true
	@$(BUN) run scripts/inject-version.ts
	$(BUN) build --compile packages/cli/index.ts --outfile ark-native
	@echo "Built: ark-native ($$(du -h ark-native | cut -f1))"

build-web: ## Build web frontend (Vite production)
	@cd packages/web && npx vite build --logLevel error 2>/dev/null || $(BUN) run packages/web/build.ts

build-desktop: build-web ## Build Electron app for current platform
	cd packages/desktop && npm install --silent 2>/dev/null && npx electron-builder

# ── Packaging (all platforms) ────────────────────────────────────────────────

package: package-cli package-desktop ## Package CLI + Electron for all platforms

package-cli: build-web ## Build self-contained CLI bundles for macOS + Linux (4 targets)
	@echo "Building Ark bundles for all platforms..."
	@mkdir -p dist node_modules/react-devtools-core 2>/dev/null; \
	  test -f shims/react-devtools-core.js && \
	  cp shims/react-devtools-core.js node_modules/react-devtools-core/index.js && \
	  echo '{"main":"index.js"}' > node_modules/react-devtools-core/package.json || true
	$(BUN) build --compile --target bun-darwin-arm64 packages/cli/index.ts --outfile dist/bin/ark-darwin-arm64
	$(BUN) build --compile --target bun-darwin-x64   packages/cli/index.ts --outfile dist/bin/ark-darwin-x64
	$(BUN) build --compile --target bun-linux-arm64  packages/cli/index.ts --outfile dist/bin/ark-linux-arm64
	$(BUN) build --compile --target bun-linux-x64    packages/cli/index.ts --outfile dist/bin/ark-linux-x64
	@echo ""
	@echo "Downloading vendored binaries..."
	@$(MAKE) vendor-tmux vendor-tensorzero vendor-codegraph vendor-goose vendor-codex --no-print-directory
	@echo ""
	@echo "Creating distribution tarballs..."
	@for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do \
	  mkdir -p dist/ark-$$plat/bin; \
	  cp dist/bin/ark-$$plat dist/ark-$$plat/bin/ark; \
	  cp -r agents runtimes flows skills recipes mcp-configs dist/ark-$$plat/; \
	  if [ -f dist/vendor/tmux-$$plat ]; then cp dist/vendor/tmux-$$plat dist/ark-$$plat/bin/tmux; fi; \
	  if [ -f dist/vendor/tensorzero-$$plat ]; then cp dist/vendor/tensorzero-$$plat dist/ark-$$plat/bin/tensorzero-gateway; fi; \
	  if [ -f dist/vendor/codegraph-$$plat ]; then cp dist/vendor/codegraph-$$plat dist/ark-$$plat/bin/codegraph; fi; \
	  if [ -f dist/vendor/goose-$$plat ]; then cp dist/vendor/goose-$$plat dist/ark-$$plat/bin/goose; fi; \
	  if [ -f dist/vendor/codex-$$plat ]; then cp dist/vendor/codex-$$plat dist/ark-$$plat/bin/codex; fi; \
	  cd dist && tar czf ark-$$plat.tar.gz ark-$$plat && cd ..; \
	  echo "  dist/ark-$$plat.tar.gz ($$(du -h dist/ark-$$plat.tar.gz | cut -f1))"; \
	done

vendor-tmux: ## Build static tmux binaries (native platform; cross-platform in CI)
	@mkdir -p dist/vendor
	@echo "  tmux: building static binaries..."
	@for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do \
	  ./scripts/vendor-tmux.sh $$plat || echo "  tmux-$$plat: skipped"; \
	done

vendor-codegraph: ## Extract codegraph native binaries from npm packages
	@mkdir -p dist/vendor
	@echo "  codegraph: extracting native binaries from npm..."
	@for pkg_plat in darwin-arm64 darwin-x64 linux-arm64-gnu linux-x64-gnu; do \
	  dist_plat=$$(echo $$pkg_plat | sed 's/-gnu//'); \
	  pkg="@optave/codegraph-$$pkg_plat"; \
	  pkg_dir="node_modules/@optave/codegraph-$$pkg_plat"; \
	  if [ -d "$$pkg_dir" ]; then \
	    bin=$$(find "$$pkg_dir" -name "codegraph*" -type f -perm +111 2>/dev/null | head -1); \
	    if [ -n "$$bin" ]; then \
	      cp "$$bin" "dist/vendor/codegraph-$$dist_plat"; \
	      echo "  codegraph-$$dist_plat: extracted"; \
	    else \
	      echo "  codegraph-$$dist_plat: binary not found in $$pkg_dir"; \
	    fi; \
	  else \
	    echo "  codegraph-$$dist_plat: npm package not installed (bun add $$pkg)"; \
	  fi; \
	done

vendor-goose: ## Download goose binaries from block/goose GitHub releases
	@mkdir -p dist/vendor
	@echo "  goose: downloading release binaries..."
	@for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do \
	  ./scripts/vendor-goose.sh $$plat || echo "  goose-$$plat: skipped"; \
	done

vendor-codex: ## Download codex binaries from openai/codex GitHub releases
	@mkdir -p dist/vendor
	@echo "  codex: downloading release binaries..."
	@for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do \
	  ./scripts/vendor-codex.sh $$plat || echo "  codex-$$plat: skipped"; \
	done

vendor-tensorzero: ## Build TensorZero gateway from source for all platforms
	@mkdir -p dist/vendor
	@echo "  tensorzero: checking for pre-built binaries..."
	@# Build from source if cargo is available, otherwise skip
	@if command -v cargo >/dev/null 2>&1; then \
	  echo "  tensorzero: building from source (this takes a few minutes)..."; \
	  cd /tmp && git clone --depth 1 https://github.com/tensorzero/tensorzero.git tz-build 2>/dev/null || true; \
	  cd /tmp/tz-build && cargo build --release --bin gateway 2>/dev/null && \
	  cp target/release/gateway $(CURDIR)/dist/vendor/tensorzero-$$(uname -s | tr A-Z a-z)-$$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') && \
	  echo "  tensorzero: built successfully" || \
	  echo "  tensorzero: build failed (install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh)"; \
	else \
	  echo "  tensorzero: skipped (install Rust to build, or use Docker for hosted mode)"; \
	fi

package-desktop: build-web ## Package Electron app (.dmg + .AppImage)
	cd packages/desktop && npm install --silent 2>/dev/null && npx electron-builder --mac --linux

# ── Other ────────────────────────────────────────────────────────────────────

clean: ## Remove all build artifacts
	rm -rf dist packages/web/dist packages/desktop/out node_modules/.cache
	rm -f ark-native ark-darwin-arm64 ark-darwin-x64 ark-linux-arm64 ark-linux-x64
	@echo "Cleaned."

uninstall: ## Remove the ark symlink from PATH
	rm -f $(ARK_BIN)
	@echo "Removed $(ARK_BIN)"
