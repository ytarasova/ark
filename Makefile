.PHONY: install dev tui web test test-watch lint clean uninstall build-web desktop desktop-install desktop-test help

BUN := bun
ARK_BIN := /usr/local/bin/ark

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install deps and symlink `ark` onto PATH
	@command -v bun >/dev/null 2>&1 || { echo "Bun not found. Install it: curl -fsSL https://bun.sh/install | bash"; exit 1; }
	$(BUN) install
	@echo "Linking ark → $(ARK_BIN)"
	ln -sf "$(CURDIR)/ark" $(ARK_BIN)
	@echo "Done. Run 'ark' from anywhere."

dev: ## Install deps and start TypeScript watcher
	$(BUN) install
	$(BUN) run dev

tui: ## Launch the terminal UI
	./ark tui

test: build-web ## Run all tests sequentially (never parallel — ports collide)
	$(BUN) test packages/core packages/compute packages/server packages/protocol packages/tui packages/arkd packages/web --concurrency 1

test-file: ## Run a single test file: make test-file F=packages/core/__tests__/session.test.ts
	$(BUN) test $(F)

test-watch: ## Run tests in watch mode
	$(BUN) run test:watch

lint: ## Lint the codebase
	$(BUN) run lint

web: ## Launch the web dashboard
	./ark web

build-web: ## Build the web frontend
	$(BUN) run packages/web/build.ts

desktop-install: ## Install Electron dependencies for desktop app
	cd packages/desktop && npm install

desktop: build-web desktop-install ## Build and launch the Electron desktop app
	cd packages/desktop && npx electron .

desktop-test: build-web desktop-install ## Run Electron E2E tests via Playwright
	cd packages/desktop && npx playwright test

desktop-build: build-web desktop-install ## Package the Electron app for distribution
	cd packages/desktop && npx electron-builder

clean: ## Remove build artifacts
	rm -rf dist packages/web/dist packages/desktop/out node_modules/.cache

uninstall: ## Remove the ark symlink
	rm -f $(ARK_BIN)
	@echo "Removed $(ARK_BIN)"
