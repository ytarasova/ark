# Plan: Add hot-reload dev targets to Makefile

## Summary

Add `make dev-daemon` and `make dev-arkd` targets that run the server daemon and arkd with `bun --watch` for automatic restart on source changes. Currently `make dev` only covers the web API server + Vite frontend -- developers working on conductor, orchestration, or arkd code must manually restart processes after every edit.

## Files to modify/create

| File | Change |
|------|--------|
| `Makefile` | Add `dev-daemon` and `dev-arkd` targets using `bun --watch`, update `.PHONY` and `help` |

## Implementation steps

### 1. Add `dev-daemon` target (Makefile, after line 63)

Add a `make dev-daemon` target that starts the full server daemon stack (AppContext + conductor + arkd + WebSocket) with hot-reload:

```makefile
dev-daemon: ## Hot-reload: server daemon (conductor :19100 + arkd :19300 + WS :19400)
	@echo "\033[1mArk server daemon (hot-reload)\033[0m"
	@echo "  WebSocket:  ws://localhost:19400"
	@echo "  Conductor:  http://localhost:19100"
	@echo "  ArkD:       http://localhost:19300"
	@echo ""
	$(BUN) --watch packages/cli/index.ts server daemon start
```

This works because `bun --watch` monitors all imported files and restarts the process on change. The server daemon's foreground mode (`packages/cli/commands/server-daemon.ts` lines 131-165) boots AppContext, conductor, arkd, and WebSocket in-process -- so a single `bun --watch` covers the entire backend stack.

### 2. Add `dev-arkd` target (Makefile, after dev-daemon)

Add a standalone arkd target for cases where only the agent daemon needs hot-reload (e.g., working on arkd endpoints without the full server daemon):

```makefile
dev-arkd: ## Hot-reload: arkd agent daemon (:19300)
	@echo "\033[1mArkD agent daemon (hot-reload)\033[0m"
	@echo "  ArkD:  http://localhost:19300"
	@echo ""
	$(BUN) --watch packages/cli/index.ts arkd
```

This runs the standalone arkd command (`packages/cli/commands/misc.ts` line 155) which calls `startArkd()` directly.

### 3. Update `.PHONY` declaration (Makefile, line 13)

Add `dev-daemon dev-arkd` to the `.PHONY` list on line 13-18:

```makefile
.PHONY: help install dev dev-daemon dev-arkd dev-web tui web desktop \
```

### 4. Update `help` target (Makefile, line 26)

Update the grep pattern on line 26 to include the new targets:

```makefile
@grep -E '^(install|dev|dev-daemon|dev-arkd|dev-web|tui|web|desktop):' $(MAKEFILE_LIST) | ...
```

## Testing strategy

1. **`make dev-daemon` starts and auto-restarts:**
   - Run `make dev-daemon`, confirm it prints the banner and starts on ports 19100/19300/19400
   - Edit any file in `packages/core/` (e.g., add a comment to `conductor.ts`), confirm bun restarts the process
   - `curl http://localhost:19400/health` returns ok after restart

2. **`make dev-arkd` starts and auto-restarts:**
   - Run `make dev-arkd`, confirm it starts on port 19300
   - Edit a file in `packages/arkd/`, confirm bun restarts
   - `curl http://localhost:19300/health` returns ok

3. **`make help` shows new targets:**
   - Run `make help`, confirm `dev-daemon` and `dev-arkd` appear under Development

4. **Existing targets unaffected:**
   - `make dev` still works as before (web API + Vite)
   - `make dev-web` still works

## Risk assessment

- **Port collisions:** If `make dev` (port 8420) and `make dev-daemon` (ports 19100/19300/19400) run simultaneously, there are no port conflicts -- they use different ports. However, running `make dev-daemon` alongside `make tui` (which also starts conductor on 19100) would collide. This is the same limitation that exists today with `ark server daemon start` vs `ark tui` -- no new risk.
- **PID file stale on crash:** `bun --watch` kills and restarts the process. The server daemon writes a PID file (`~/.ark/server.pid`) in foreground mode. On restart, the old PID file points to a dead process. The existing `server daemon start` code (line 74-87) already handles stale PID files by checking `isProcessRunning()` and cleaning up, so this is safe.
- **No breaking changes:** These are purely additive Makefile targets. No existing targets or code are modified.

## Open questions

None -- this is a straightforward addition of two Makefile targets using the same `bun --watch` pattern already established by `make dev`.
