# ── Ark Makefile ─────────────────────────────────────────────────────────────
#
# Local development, testing, building, and packaging.
#
# Quick reference:
#   make install       Install deps + symlink ark CLI
#   make dev           Hot-reload CLI + Web UI (two processes)
#   make test          Run all unit tests (sequential)
#   make test-e2e      Run Playwright E2E tests against Web UI
#   make build         Build native macOS binary + Electron app
#   make package       Package everything for distribution

.PHONY: help install dev dev-web tui web desktop \
        test test-file test-e2e test-e2e-fast test-e2e-web test-e2e-tui test-watch lint \
        build build-cli build-web build-desktop \
        package package-cli package-desktop \
        clean uninstall

BUN := bun
ARK_BIN := /usr/local/bin/ark

help: ## Show available commands
	@echo ""
	@echo "  \033[1mDevelopment\033[0m"
	@grep -E '^(install|dev|dev-web|tui|web|desktop):' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  \033[1mTesting\033[0m"
	@grep -E '^(test|test-file|test-e2e|test-watch):' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[36m%-18s\033[0m %s\n", $$1, $$2}'
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
	@echo "  TUI:  ./ark tui             (runs from source, no build)"
	@echo ""
	@trap 'kill 0' EXIT; \
	  $(BUN) --watch packages/cli/index.ts web --port 8420 --api-only 2>&1 | sed 's/^/[api] /' & \
	  sleep 1 && cd packages/web && npx vite --port 5173 2>&1 | sed 's/^/[web] /' & \
	  wait

dev-web: ## Start only the Vite dev server (needs `ark web` on :8420 separately)
	cd packages/web && npx vite --port 5173

tui: ## Launch the terminal UI (from source)
	./ark tui

web: ## Launch the web dashboard (production build)
	@$(MAKE) build-web --no-print-directory
	./ark web

desktop: build-web ## Launch the Electron desktop app
	@cd packages/desktop && npm install --silent 2>/dev/null && npx electron .

# ── Testing ──────────────────────────────────────────────────────────────────

test: build-web ## Run all unit tests (sequential -- never parallel)
	$(BUN) test packages/core packages/compute packages/server packages/protocol packages/tui packages/arkd packages/web --concurrency 1

test-file: ## Run a single test: make test-file F=packages/core/__tests__/foo.test.ts
	$(BUN) test $(F)

test-e2e: build-web ## Run all E2E tests (web + TUI, sequential)
	cd packages/e2e && npx playwright install chromium --with-deps 2>/dev/null; npx playwright test
	$(BUN) test packages/e2e/tui --concurrency 1

test-e2e-fast: build-web ## Run fast-tier E2E only (CI-safe, no tmux dispatch)
	cd packages/e2e && npx playwright test --grep-invert "dispatch"
	$(BUN) test packages/e2e/tui/tabs.test.ts packages/e2e/tui/sessions.test.ts packages/e2e/tui/session-crud.test.ts packages/e2e/tui/talk.test.ts --concurrency 1

test-e2e-web: build-web ## Run web E2E tests only (Playwright)
	cd packages/e2e && npx playwright install chromium --with-deps 2>/dev/null; npx playwright test

test-e2e-tui: ## Run TUI E2E tests only (tmux)
	$(BUN) test packages/e2e/tui --concurrency 1

test-watch: ## Run unit tests in watch mode
	$(BUN) test --watch

lint: ## Lint the codebase
	$(BUN) run lint

# ── Building ─────────────────────────────────────────────────────────────────

build: build-cli build-web ## Build CLI binary + web frontend

build-cli: ## Build native macOS CLI+TUI binary (current arch)
	@echo "Building native binary..."
	@mkdir -p node_modules/react-devtools-core 2>/dev/null; \
	  test -f shims/react-devtools-core.js && \
	  cp shims/react-devtools-core.js node_modules/react-devtools-core/index.js && \
	  echo '{"main":"index.js"}' > node_modules/react-devtools-core/package.json || true
	$(BUN) build --compile packages/cli/index.ts --outfile ark-native
	@echo "Built: ark-native ($$(du -h ark-native | cut -f1))"

build-web: ## Build web frontend (Vite production)
	@cd packages/web && npx vite build --logLevel error 2>/dev/null || $(BUN) run packages/web/build.ts

build-desktop: build-web ## Build Electron app for current platform
	cd packages/desktop && npm install --silent 2>/dev/null && npx electron-builder

# ── Packaging (all platforms) ────────────────────────────────────────────────

package: package-cli package-desktop ## Package CLI + Electron for all platforms

package-cli: ## Build CLI binaries for macOS + Linux (4 targets)
	@echo "Building CLI for all platforms..."
	@mkdir -p dist node_modules/react-devtools-core 2>/dev/null; \
	  test -f shims/react-devtools-core.js && \
	  cp shims/react-devtools-core.js node_modules/react-devtools-core/index.js && \
	  echo '{"main":"index.js"}' > node_modules/react-devtools-core/package.json || true
	$(BUN) build --compile --target bun-darwin-arm64 packages/cli/index.ts --outfile dist/ark-darwin-arm64
	$(BUN) build --compile --target bun-darwin-x64   packages/cli/index.ts --outfile dist/ark-darwin-x64
	$(BUN) build --compile --target bun-linux-arm64  packages/cli/index.ts --outfile dist/ark-linux-arm64
	$(BUN) build --compile --target bun-linux-x64    packages/cli/index.ts --outfile dist/ark-linux-x64
	@echo ""
	@ls -lh dist/ark-*

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
