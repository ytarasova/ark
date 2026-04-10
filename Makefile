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
        vendor-tmux vendor-tensorzero vendor-codegraph \
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
	$(BUN) test $(F) --concurrency 1

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

lint: ## Lint the codebase (ESLint + TypeScript)
	npx eslint packages/ --max-warnings 50

lint-fix: ## Auto-fix lint issues
	npx eslint packages/ --fix

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
	@$(MAKE) vendor-tmux vendor-tensorzero vendor-codegraph --no-print-directory
	@echo ""
	@echo "Creating distribution tarballs..."
	@for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do \
	  mkdir -p dist/ark-$$plat/bin; \
	  cp dist/bin/ark-$$plat dist/ark-$$plat/bin/ark; \
	  cp -r agents runtimes flows skills recipes mcp-configs dist/ark-$$plat/; \
	  if [ -f dist/vendor/tmux-$$plat ]; then cp dist/vendor/tmux-$$plat dist/ark-$$plat/bin/tmux; fi; \
	  if [ -f dist/vendor/tensorzero-$$plat ]; then cp dist/vendor/tensorzero-$$plat dist/ark-$$plat/bin/tensorzero-gateway; fi; \
	  if [ -f dist/vendor/codegraph-$$plat ]; then cp dist/vendor/codegraph-$$plat dist/ark-$$plat/bin/codegraph; fi; \
	  cd dist && tar czf ark-$$plat.tar.gz ark-$$plat && cd ..; \
	  echo "  dist/ark-$$plat.tar.gz ($$(du -h dist/ark-$$plat.tar.gz | cut -f1))"; \
	done

vendor-tmux: ## Download/compile tmux for all platforms
	@mkdir -p dist/vendor
	@echo "  tmux: checking for pre-built binaries..."
	@# For now, skip vendor -- users have tmux. Will add static builds in CI.
	@echo "  tmux: skipped (install separately: brew install tmux)"

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
