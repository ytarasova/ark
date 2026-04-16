# Context Compaction Observability -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log context compaction events in the audit trail and handle compaction-related failures, giving Ark visibility into when agents compact and why they fail.

**Architecture:** Add `PreCompact` and `PostCompact` to the existing hook config in `claude.ts`. Extend the conductor's `/hooks/status` handler to log compaction events (without changing session status). Handle `StopFailure` with `max_output_tokens` by logging a specific event. Optionally set compaction-tuning env vars in the launcher.

**Tech Stack:** Existing hooks infrastructure (claude.ts, conductor.ts), no new dependencies.

---

## File Structure

| File | Change |
|------|--------|
| `packages/core/claude.ts:buildHooksConfig` | **Modify:** Add `PreCompact` and `PostCompact` events |
| `packages/core/conductor.ts` | **Modify:** Log compaction events in `/hooks/status` handler, enrich `StopFailure` logging for `max_output_tokens` |
| `packages/core/__tests__/claude-hooks.test.ts` | **Modify:** Add tests for new hook events |
| `packages/core/__tests__/conductor-hooks.test.ts` | **Modify:** Add tests for compaction logging and max_output_tokens |

---

### Task 1: Add PreCompact/PostCompact hooks + compaction logging

**Files:**
- Modify: `packages/core/claude.ts:152-163` (buildHooksConfig)
- Modify: `packages/core/conductor.ts:99-146` (/hooks/status handler)
- Modify: `packages/core/__tests__/claude-hooks.test.ts`
- Modify: `packages/core/__tests__/conductor-hooks.test.ts`

- [ ] **Step 1: Add tests for new hook events in claude-hooks.test.ts**

Add to the `writeHooksConfig` describe block:

```ts
  it("contains PreCompact and PostCompact hooks", () => {
    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.PreCompact).toBeDefined();
    expect(settings.hooks.PostCompact).toBeDefined();
  });

  it("PreCompact/PostCompact hooks match both auto and manual triggers", () => {
    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    // No matcher = matches all triggers (auto + manual)
    expect(settings.hooks.PreCompact[0].matcher).toBeUndefined();
    expect(settings.hooks.PostCompact[0].matcher).toBeUndefined();
  });
```

Update the existing "contains hooks for all 6 status events" test to expect 8 events:

```ts
  it("contains hooks for all 8 events", () => {
    writeHooksConfig("s-test123", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    const events = Object.keys(settings.hooks);
    expect(events).toContain("SessionStart");
    expect(events).toContain("UserPromptSubmit");
    expect(events).toContain("Stop");
    expect(events).toContain("StopFailure");
    expect(events).toContain("SessionEnd");
    expect(events).toContain("Notification");
    expect(events).toContain("PreCompact");
    expect(events).toContain("PostCompact");
    expect(events.length).toBe(8);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/__tests__/claude-hooks.test.ts`
Expected: FAIL -- PreCompact/PostCompact not in hook config yet.

- [ ] **Step 3: Add PreCompact/PostCompact to buildHooksConfig in claude.ts**

In `buildHooksConfig()` (~line 152-163), add two entries to the returned object:

```ts
    PreCompact: [{ hooks: [hook] }],
    PostCompact: [{ hooks: [hook] }],
```

These have no `matcher` field -- they fire for both `auto` and `manual` compaction triggers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/__tests__/claude-hooks.test.ts`

- [ ] **Step 5: Add conductor tests for compaction events**

Add to `conductor-hooks.test.ts`:

```ts
  it("PreCompact is logged but does not change status", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    const resp = await postHookStatus(session.id, {
      hook_event_name: "PreCompact",
      trigger: "auto",
    });
    expect(resp.status).toBe(200);

    // Status unchanged
    expect(getSession(session.id)!.status).toBe("running");

    // Event logged
    const events = getEvents(session.id);
    const compactEvent = events.find((e: any) => e.type === "hook_status" && JSON.parse(e.data).event === "PreCompact");
    expect(compactEvent).toBeDefined();
  });

  it("PostCompact is logged with compact_summary", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    await postHookStatus(session.id, {
      hook_event_name: "PostCompact",
      trigger: "auto",
      compact_summary: "Conversation summarized: working on auth module...",
    });

    const events = getEvents(session.id);
    const compactEvent = events.find((e: any) => e.type === "hook_status" && JSON.parse(e.data).event === "PostCompact");
    expect(compactEvent).toBeDefined();
    expect(JSON.parse(compactEvent.data).compact_summary).toContain("auth module");
  });

  it("StopFailure with max_output_tokens logs specific error", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    await postHookStatus(session.id, {
      hook_event_name: "StopFailure",
      error: "max_output_tokens",
      error_details: "Output token limit exceeded",
    });

    const updated = getSession(session.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.error).toContain("max_output_tokens");
  });
```

- [ ] **Step 6: Run all hook tests**

Run: `bun test packages/core/__tests__/claude-hooks.test.ts packages/core/__tests__/conductor-hooks.test.ts`

The conductor tests should already pass -- PreCompact/PostCompact are "unknown events" that get logged but don't change status (the existing no-op path). The `StopFailure` with `max_output_tokens` uses the existing `StopFailure` → `failed` mapping.

If `getEvents` returns events with `data` as a string (JSON), parse it in the assertions. If it returns objects, access directly.

- [ ] **Step 7: Commit**

```bash
git add packages/core/claude.ts packages/core/conductor.ts packages/core/__tests__/claude-hooks.test.ts packages/core/__tests__/conductor-hooks.test.ts
git commit -m "feat: add compaction observability -- PreCompact/PostCompact hooks + max_output_tokens handling"
```

---

### Task 2: Add compaction env vars to launcher (optional tuning)

**Files:**
- Modify: `packages/core/claude.ts:buildLauncher` (~line 240)
- Modify: `packages/core/__tests__/claude.test.ts` (buildLauncher tests)

- [ ] **Step 1: Add test for compaction env vars in launcher**

Add to the `buildLauncher` describe block in `claude.test.ts`:

```ts
  it("includes compaction env vars when provided", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" },
    });
    expect(content).toContain("export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='80'");
  });

  it("does not include env vars when not provided", () => {
    const { content } = buildLauncher(baseOpts);
    expect(content).not.toContain("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/__tests__/claude.test.ts`
Expected: FAIL -- `env` not in LauncherOpts, no env var export in launcher.

- [ ] **Step 3: Add env support to LauncherOpts and buildLauncher**

In `LauncherOpts` interface, add:

```ts
  /** Environment variables to export before launching Claude */
  env?: Record<string, string>;
```

In `buildLauncher()`, after the `cd` line in the bash script, add:

```ts
  // Build env exports
  const envExports = Object.entries(opts.env ?? {})
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("\n");
  const envBlock = envExports ? `${envExports}\n` : "";
```

Then include `envBlock` in the launcher content after `cd`:

```bash
cd ${shellQuote(opts.workdir)}
${envBlock}${claudeCmd} ...
```

- [ ] **Step 4: Wire env vars from agent definition**

In `session.ts:launchAgentTmux()`, when calling `buildLauncher()`, pass agent env vars:

```ts
  const { content: launchContent, claudeSessionId } = claude.buildLauncher({
    workdir: effectiveWorkdir,
    claudeArgs,
    mcpConfigPath,
    prevClaudeSessionId: session.claude_session_id,
    sessionName: session.summary ?? session.id,
    env: agent.env,  // AgentDefinition already has env: Record<string, string>
  });
```

This means agent YAML definitions can now set compaction tuning:

```yaml
name: long-running-agent
model: opus
env:
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80"
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000"
```

- [ ] **Step 5: Run all tests**

Run: `bun test packages/core/__tests__/claude.test.ts packages/core/__tests__/claude-hooks.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/core/claude.ts packages/core/session.ts packages/core/__tests__/claude.test.ts
git commit -m "feat: support env vars in launcher for compaction tuning"
```
