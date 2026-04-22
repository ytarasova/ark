# Connectors as a Product Feature — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Phase 1 has bite-sized TDD steps; Phases 2-5 are at wave-depth and each wave gets a follow-up sub-plan when it's about to dispatch.

**Goal:** Turn "connectors" from internal plumbing into a first-class product feature. Tenants browse a catalog of integrations (Jira, GitHub, Linear, Figma, Slack, Notion, Confluence, custom), configure credentials through a self-serve UI, test liveness, enable/disable per tenant — and any of Ark's four execution contexts (agent MCP tool calls, Ark-side REST automation, inbound webhooks, session-context prefill) transparently uses the configured connector.

**Architecture:** One `Connector<A>` definition exposes optional `api / mcp / webhook / context` surfaces, sharing one `auth` config. Credentials persist per-tenant in an encrypted `connector_bindings` table. A catalog of built-in connectors (from code) plus a user-authored extension path (`~/.ark/connectors/<name>.yaml`) feed one unified registry. The Web UI's Connectors page is the product surface; the underlying code change is the refactor.

**Tech Stack:** TypeScript + Bun, existing `Connector` type + `ConnectorRegistry`, drizzle migration for `connector_bindings`, existing secrets backend (envelope encryption via `@napi-rs/keyring` already available in package.json per the pi-sage parity plan), existing RPC router + Vite/React Web UI, no new large dependencies.

---

## Product vision

**For whom:** Paytm and future enterprise customers whose pilot teams work across a zoo of tools (issue tracker, chat, wiki, design, source control, monitoring) and need an agent platform that integrates with all of them without each agent stitching bespoke clients together.

**What the customer sees:**
1. Settings → Connectors → a catalog ("Available" + "Configured") with provider logos.
2. Click "Jira" → modal: base URL, API token, webhook secret, write-enabled toggle. Test button.
3. Green check → connector appears in "Configured" list.
4. Now any flow with `connectors: [jira]` has Jira MCP tools for the agent, the Web UI shows Jira ticket previews on session detail, and incoming Jira webhooks can fire flows — all from one configured connector.
5. Per-connector dashboard: usage in last 7 days, error rate, last test time.
6. (Phase 4) Customer authors a custom connector for their internal billing-system by dropping `~/.ark/connectors/billing.yaml` — it appears in the catalog.

**Why this earns product positioning:**
- **Extensibility wedge** vs. Cursor / Copilot / Devin (closed). "Bring your own connector" is a real enterprise sell.
- **Single integration story** — one credential set, four execution contexts. Replaces today's patchwork (MCP config here, secrets file there, webhook URL somewhere).
- **Marketplace narrative** — "Ark integrates with X, Y, Z" is a concrete bullet list that maps to the catalog.
- **Multi-tenant ready** — credentials scoped per tenant, encrypted, auditable.

---

## Scope

### IN (this plan)

- **Phase 1** — Unified `Connector<A>` framework + migrate all six existing connectors (jira, github, linear, bitbucket, slack, pi-sage) + add figma stub.
- **Phase 2** — Product MVP: `connector_bindings` schema + RPC surface + Web UI catalog/configure/test.
- **Phase 3** — Per-connector telemetry (calls, errors, last-test, cost attribution) + UI surfacing.
- **Phase 4** — Extensibility: user-authored connectors via `~/.ark/connectors/<name>.yaml` + documented schema.
- **Phase 5** — Marketplace polish: categories, search, usage-in-flows indicator.

### Separately tracked follow-ups filed during execution (not in this plan)

- **Figma REST client + Web UI preview** — one slot ships empty in Phase 1 Wave 3; the real client + UI preview is a follow-up issue.
- **Slack Web API client** — same shape as Figma; depends on #342.
- **Bitbucket MCP config** — connector's `api` surface is full in Phase 1 Wave 2; the MCP surface stays scaffolded until a vetted bitbucket MCP is picked.
- **Notion / Confluence / Wiki.js connectors** — #338 covers these; they'll land on the framework after Phase 2 ships.
- **OAuth flows** — Phase 2 ships API-token-based config; OAuth redirect flows (for Google / GitHub / Atlassian) are a Phase 3+ follow-up.

### Hard out-of-scope

- Monitoring-only sources (alertmanager, cloudwatch, prometheus, pagerduty, email, generic-hmac) stay as `triggers/sources/<name>.ts`. They have no API surface and no MCP surface — wrapping them as connectors would add noise.
- #312 (outbound webhooks), #328 (GitHub App), #342 (Slack bot deeper product integration).

---

## Current state (2026-04-21)

**Wave 0 landed** — commit `04705771` on branch `worktree-agent-a703faff`:
- `packages/core/connectors/types.ts` — added `ConnectorStatus`, `ApiFactory<T>`, `WebhookSurface`, `McpSurface` alias, made `Connector` generic `<A = unknown>`, added optional `api?` + `webhook?`, made `kind` optional.
- `packages/core/connectors/registry.ts` — added `api<T>(name)` and `webhook(name)` accessors.
- Tests green; no existing connector definition broke.

**What still exists in parallel:**
- `packages/core/connectors/definitions/<name>.ts` — 6 MCP-only defs.
- `packages/core/tickets/providers/<name>/` — 4 rich `TicketProvider` implementations (REST/GraphQL + webhook + health + normalize).
- `packages/core/triggers/sources/<name>.ts` — 12 webhook sources (6 monitoring-only, 6 connector-adjacent with webhook logic duplicated from tickets/providers).
- `mcp-configs/<name>.json` — 5 shipped MCP configs (atlassian, figma, github, linear, pi-sage).

**Cross-directory imports are low** (5 occurrences across 3 files — verified via grep). The moves in Phase 1 are mechanically safe.

---

## Target shape (recap from Wave 0)

```ts
export interface Connector<A = unknown> {
  name: string;
  label: string;
  status: "full" | "scaffolded" | "stub";
  auth?: AuthRef;
  api?: ApiFactory<A>;      // Ark-side REST/GraphQL client
  mcp?: McpSurface;          // agent-side tool access
  webhook?: WebhookSurface;  // inbound event normalizer
  context?: ContextSurface;  // session prefill
  // Phase 2 additions:
  catalog?: CatalogMetadata; // icon, description, category, docs URL
  configSchema?: ConfigSchema; // field schema for the Web UI configure modal
}

/** Phase 2: UI metadata for the connector catalog. */
export interface CatalogMetadata {
  icon?: string;              // public path or data URL
  description: string;        // short blurb for the catalog card
  category: "issue-tracker" | "chat" | "design" | "vcs" | "wiki" | "knowledge-base" | "monitoring" | "other";
  docsUrl?: string;
  homepage?: string;
}

/**
 * Phase 2: declarative schema for the configure modal. One entry per field
 * (baseUrl / token / webhook secret / custom settings). Web UI renders a
 * form from this; validation happens server-side via Zod built from the
 * same schema.
 */
export interface ConfigSchema {
  fields: ConfigField[];
}
export interface ConfigField {
  key: string;               // goes into auth_config / settings jsonb
  label: string;
  type: "string" | "secret" | "url" | "boolean" | "number";
  required: boolean;
  description?: string;
  placeholder?: string;
}
```

---

## Target layout

```
packages/core/connectors/
  types.ts                     — unified types (extended in Phase 2)
  registry.ts                  — ConnectorRegistry + tenant-binding lookups
  resolve.ts                   — MCP + context collectors (unchanged)
  bindings/
    schema.ts                  — drizzle schema for connector_bindings
    repository.ts              — CRUD + encryption
    __tests__/
  catalog.ts                   — built-in + user-authored aggregator
  user-loader.ts               — load ~/.ark/connectors/*.yaml
  definitions/
    jira/, github/, linear/, bitbucket/, slack/, pi-sage/, figma/
      index.ts                 — Connector def
      api.ts                   — REST/GraphQL client
      normalize.ts
      webhook.ts
      catalog.ts               — CatalogMetadata (Phase 2)
      config-schema.ts         — ConfigSchema (Phase 2)
      fixtures/, __tests__/
  index.ts                     — public barrel
```

---

## Phases

### Phase 1 — Framework refactor (Waves 0-4)

Migrate existing integrations to the unified shape. Prerequisite to the product feature — there's no point building a catalog UI on top of fragmented code.

- **Wave 0:** types + registry (**DONE** — commit `04705771`)
- **Wave 1:** jira pilot — full move into `connectors/definitions/jira/`
- **Wave 2:** fan out to github, linear, bitbucket
- **Wave 3:** slack, pi-sage, figma (slot-only api for figma/slack; file follow-ups)
- **Wave 4:** cleanup — remove `kind` discriminator, delete legacy shims, update barrels

### Phase 2 — Product MVP (Waves 5-7)

Ship the customer-facing catalog + configure + test UX.

- **Wave 5:** schema + repository — `connector_bindings` drizzle migration, CRUD repository, credential encryption
- **Wave 6:** RPC surface — `connectors/*` handlers for catalog, configure, test-live, enable/disable, remove
- **Wave 7:** Web UI — Settings → Connectors page, catalog card, configure modal (dynamic from `ConfigSchema`), test button

### Phase 3 — Observability (Waves 8-9)

Make connector usage visible so customers see value + debug issues.

- **Wave 8:** per-connector telemetry (calls, errors, latency, rate-limit hits) via existing `structured-log` + aggregation
- **Wave 9:** UI surfacing — per-connector dashboard tile with 7d sparkline, error feed, last-test state

### Phase 4 — Extensibility (Waves 10-11)

Let customers author their own connectors without forking Ark.

- **Wave 10:** user-connector loader — `~/.ark/connectors/<name>.yaml` convention, parse + validate + register at boot
- **Wave 11:** public docs — "how to write a connector" guide with a worked example (custom internal ticket tracker)

### Phase 5 — Marketplace polish (Wave 12)

- **Wave 12:** catalog UI improvements — categories, search, recently-used, "used in N flows" badges

---

## Phase 1 waves

### Wave 1: Jira pilot

**Files:**
- Move: `packages/core/tickets/providers/jira/*` → `packages/core/connectors/definitions/jira/`
- Fuse: `packages/core/triggers/sources/jira.ts` → `packages/core/connectors/definitions/jira/webhook.ts`
- Create: `packages/core/connectors/definitions/jira/index.ts` (unified Connector def)
- Delete: `packages/core/connectors/definitions/jira.ts` (old MCP-only def)
- Shim: `packages/core/tickets/providers/jira/index.ts` + `packages/core/triggers/sources/jira.ts` (back-compat re-exports)
- Update imports in: `packages/core/connectors/registry.ts`, `packages/core/connectors/index.ts`

- [ ] **Step 1.1: Create the new jira directory and move files**

```bash
mkdir -p packages/core/connectors/definitions/jira
git mv packages/core/tickets/providers/jira/client.ts      packages/core/connectors/definitions/jira/api.ts
git mv packages/core/tickets/providers/jira/normalize.ts   packages/core/connectors/definitions/jira/normalize.ts
git mv packages/core/tickets/providers/jira/jql.ts         packages/core/connectors/definitions/jira/jql.ts
git mv packages/core/tickets/providers/jira/webhook.ts     packages/core/connectors/definitions/jira/webhook.ts
git mv packages/core/tickets/providers/jira/fixtures       packages/core/connectors/definitions/jira/fixtures
git mv packages/core/tickets/providers/jira/__tests__      packages/core/connectors/definitions/jira/__tests__
```

- [ ] **Step 1.2: Merge `JiraProvider` class into `api.ts`**

`tickets/providers/jira/index.ts` (the old file, not yet moved) contains `class JiraProvider implements TicketProvider`. `connectors/definitions/jira/api.ts` (the moved client) contains `class JiraClient`. Merge:

- Keep both classes in `api.ts`. `JiraProvider` uses `JiraClient` internally — already the case, just one file now.
- Export both from `api.ts`.

- [ ] **Step 1.3: Fuse the trigger-source into `webhook.ts`**

`triggers/sources/jira.ts` exports a `TriggerSource` with its own `verify` + `normalize`. `connectors/definitions/jira/webhook.ts` (the moved file) exports `verifyWebhookSignature` + `normalizeWebhookPayload`.

Inline the 76 LOC of `triggers/sources/jira.ts` content into `webhook.ts`, and export a `WebhookSurface`:

```ts
// ... existing verifyWebhookSignature / normalizeWebhookPayload ...

import type { WebhookSurface } from "../../types.js";
import type { NormalizedEvent } from "../../../triggers/types.js";

export const jiraWebhook: WebhookSurface = {
  async verify(req, secret) {
    // inlined from triggers/sources/jira.ts
  },
  async normalize(req): Promise<NormalizedEvent> {
    // inlined from triggers/sources/jira.ts
  },
};

// Back-compat: old TriggerSource export
export { jiraWebhook as jiraSource }; // OR rewrap as old shape; pick the form that keeps existing trigger tests green.
```

- [ ] **Step 1.4: Create the unified connector definition**

Create `packages/core/connectors/definitions/jira/index.ts`:

```ts
/**
 * Jira connector — full. Surfaces:
 *   - api: JiraProvider (REST client, normalize, write-with-gate, health)
 *   - mcp: shipped mcp-configs/atlassian.json (serves both Jira + Confluence)
 *   - webhook: verify + normalize for Jira Cloud webhooks
 */

import type { Connector } from "../../types.js";
import { JiraProvider } from "./api.js";
import { jiraWebhook } from "./webhook.js";

export const jiraConnector: Connector<JiraProvider> = {
  name: "jira",
  label: "Jira",
  status: "full",
  auth: { kind: "env", envVar: "JIRA_API_TOKEN" },
  api: () => new JiraProvider(),
  mcp: { configName: "atlassian" },
  webhook: jiraWebhook,
};

export { JiraProvider } from "./api.js";
export type { JiraProviderOptions } from "./api.js";
```

- [ ] **Step 1.5: Delete old files + create shims**

```bash
rm packages/core/connectors/definitions/jira.ts
```

Replace `packages/core/tickets/providers/jira/index.ts` with:
```ts
/**
 * Back-compat shim — Jira provider moved to connectors/definitions/jira/ in
 * the connector-framework unification (2026-04-21). Will be deleted in Wave 4.
 */
export { JiraProvider, jiraConnector } from "../../connectors/definitions/jira/index.js";
export type { JiraProviderOptions } from "../../connectors/definitions/jira/index.js";
```

Replace `packages/core/triggers/sources/jira.ts` with:
```ts
export { jiraSource } from "../../connectors/definitions/jira/webhook.js";
```

- [ ] **Step 1.6: Update registry imports**

`packages/core/connectors/registry.ts`:
```ts
import { jiraConnector } from "./definitions/jira/index.js";
```

`packages/core/connectors/index.ts`:
```ts
export { jiraConnector } from "./definitions/jira/index.js";
```

- [ ] **Step 1.7: Fix moved-file imports**

```bash
bunx tsc --noEmit 2>&1 | grep -E "^packages/core/connectors/definitions/jira" | head -30
```

Fix each broken import. Typical: relative paths go up one more level (`../../types.js` → `../../../tickets/types.js` for `TicketProvider` types still in `tickets/types.ts`).

- [ ] **Step 1.8: Run tests**

```bash
make test-file F=packages/core/connectors/definitions/jira/__tests__/client.test.ts
make test-file F=packages/core/connectors/definitions/jira/__tests__/normalize.test.ts
make test-file F=packages/core/connectors/definitions/jira/__tests__/webhook.test.ts
make test-file F=packages/core/connectors/definitions/jira/__tests__/jql.test.ts
make test-file F=packages/core/connectors/__tests__/registry.test.ts
make test-file F=packages/core/triggers/__tests__/sources.test.ts
make test-file F=packages/core/tickets/__tests__/registry.test.ts
```
All expected GREEN — the moves preserve logic; shims keep old import paths working.

- [ ] **Step 1.9: Typecheck + lint**

```bash
bunx tsc --noEmit
make format
make lint
```
Zero errors, zero warnings.

- [ ] **Step 1.10: Commit**

```bash
git add -A
git commit -m "refactor(connectors): unify jira under connectors/definitions/jira (pilot)"
```

### Wave 2: Fan out — github + linear + bitbucket

Repeat Wave 1's pattern per connector. Per-connector differences:

| Connector | Old MCP config | Auth env | Provider class | Notes |
|---|---|---|---|---|
| github | `github.json` | `GITHUB_TOKEN` | `GitHubProvider` | REST |
| linear | `linear.json` | `LINEAR_API_KEY` | `LinearProvider` | GraphQL |
| bitbucket | (none — scaffolded) | `BITBUCKET_ACCESS_TOKEN` | `BitbucketProvider` | `status: "scaffolded"` (MCP pending); `api` is full |

One agent sequential is simplest. Three parallel worktrees is faster; the only shared-file churn is 2 import lines in `connectors/registry.ts` + `connectors/index.ts` — trivial to merge.

### Wave 3: slack + pi-sage + figma

Each of these has either no `tickets/providers/` tree today (slack, pi-sage) or no existing connector (figma). Short wave.

- **slack:** move `triggers/sources/slack.ts` → `connectors/definitions/slack/webhook.ts`; stub `api.ts` with `SlackApiClient` throwing "not implemented"; keep MCP inline stub. File follow-up issue for the real API client.
- **pi-sage:** move `triggers/sources/pi-sage.ts` → `connectors/definitions/pi-sage/webhook.ts`; keep MCP from existing definition; no `api` slot (pi-sage is MCP-only).
- **figma:** create `connectors/definitions/figma/` with stubbed `api.ts`; NO `mcp` slot yet (user rejected the existing `figma-remote-mcp` choice on 2026-04-21); file follow-up issue covering MCP pick + REST client + Web UI preview.

### Wave 4: Cleanup

- Audit every use of `Connector.kind` — if no consumer switches on it, delete the field and the `ConnectorKind` type.
- Delete `tickets/providers/<name>/index.ts` shims (Waves 1-2 providers) — update every importer to the new path.
- Delete `triggers/sources/<name>.ts` shims for migrated sources — update `triggers/index.ts` to re-export from `connectors/definitions/<name>/webhook.ts`.
- `packages/core/connectors/README.md` — document the surfaces + the per-provider directory convention.
- Decide: fuse `ConnectorRegistry` with `TicketProviderRegistry`? Default answer: **keep separate** — the ticket registry's per-tenant binding infra is still useful for ticket-specific flows; Phase 2's `connector_bindings` is broader. Document the choice.

---

## Phase 2 waves — Product MVP

### Wave 5: Schema + repository

**Goal:** persistent per-tenant connector configs, encrypted at rest.

**Files to create/modify:**
- `packages/core/drizzle/schema/{sqlite,postgres}.ts` — add `connector_bindings` table
- `packages/core/migrations/010_connector_bindings.ts` — new migration (Phase 2 cutover lives here)
- `packages/core/connectors/bindings/repository.ts` — CRUD + encryption
- `packages/core/connectors/bindings/__tests__/repository.test.ts` — dialect-parameterized tests
- `packages/core/app.ts` — wire repository into `AppContext`

**Schema:**
```sql
CREATE TABLE connector_bindings (
  id TEXT PRIMARY KEY,               -- nanoid
  tenant_id TEXT NOT NULL,
  connector_name TEXT NOT NULL,      -- matches Connector.name
  enabled INTEGER NOT NULL DEFAULT 1,
  auth_config TEXT NOT NULL,         -- encrypted jsonb (via envelope encryption)
  settings TEXT,                     -- jsonb for non-secret connector-specific settings
  last_tested_at TEXT,
  last_test_ok INTEGER,
  last_test_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, connector_name)
);
CREATE INDEX idx_cb_tenant ON connector_bindings(tenant_id);
```

**Encryption approach:** envelope-encrypt `auth_config` JSON with a tenant-scoped DEK, pull DEK from existing secrets backend (file provider or SSM per profile). Match the pattern from the earlier blob-encryption work (#269 follow-up). Reuse `@napi-rs/keyring` for OS-level key storage on local.

**Repository surface:**
```ts
interface ConnectorBindingRepository {
  upsert(binding: ConnectorBinding): Promise<void>;
  find(tenantId: string, connectorName: string): Promise<ConnectorBinding | null>;
  list(tenantId: string): Promise<ConnectorBinding[]>;
  delete(tenantId: string, connectorName: string): Promise<void>;
  markTested(tenantId: string, connectorName: string, ok: boolean, error?: string): Promise<void>;
}
```

**Tests:** both SQLite and Postgres dialects (follow `packages/core/repositories/` patterns for dialect-parameterized tests). Round-trip encryption (encrypt → persist → read → decrypt matches original). Tenant isolation (binding for tenant A invisible to tenant B).

**Dispatch guidance for this wave:** one agent, needs drizzle schema + migration + repository + tests. ~600 LOC. Follow the drizzle migration authoring workflow in `CLAUDE.md`:

```bash
bun x drizzle-kit generate --config drizzle.config.ts
DRIZZLE_DIALECT=postgres bun x drizzle-kit generate --config drizzle.config.ts
# wrap emitted SQL in 010_connector_bindings.ts
make drift
```

### Wave 6: RPC surface

**Goal:** expose the binding repository + connector catalog via JSON-RPC so the Web UI (and CLI) can drive configure / test / enable flows.

**RPC methods (all under `connectors/*`):**
- `connectors/catalog` — returns `{ connectors: CatalogEntry[] }` where `CatalogEntry = { name, label, status, category, description, icon, docsUrl, hasApi, hasMcp, hasWebhook, hasContext, configSchema }`. Aggregates built-in + user-loaded (Phase 4 fills this).
- `connectors/configure { name, auth_config, settings?, enabled? }` — upsert binding. Server validates against the connector's `configSchema` via Zod.
- `connectors/get-binding { name }` — returns binding WITHOUT the decrypted secrets (masked: `{ token: "***" }`). Used by the configure modal to show existing state.
- `connectors/test-live { name }` — invokes the connector's `api?.().testConnection?.(ctx)` (for ticket providers) or a connector-declared `probe()` method; returns `{ ok, error?, latencyMs }`; persists result via `markTested`.
- `connectors/enable { name, enabled }` — toggle flag.
- `connectors/remove { name }` — delete binding.
- `connectors/list-configured` — returns per-tenant bindings (without decrypted secrets).

**Files:**
- `packages/server/handlers/connectors.ts` — extend existing handler (today only has list / get / test-config-file)
- `packages/server/__tests__/connectors-handlers.test.ts` — extend
- `packages/protocol/types.ts` — add typed RPC schemas

**Things to get right:**
- **Credential masking** — never return `auth_config` decrypted from any list/get endpoint. `configure` sets; only the `api()` factory internals ever see the decrypted form (at call time, not at list time).
- **Tenant scoping** — every handler reads `ctx.tenantId` (not `app.tenantId`) per the unification push (#275).
- **Zod validation** — per #276; build from the connector's `configSchema`.
- **Probe contract** — each connector declares how to test itself. For ticket providers, reuse `TicketProvider.testConnection`. For MCP-only connectors (pi-sage), the probe verifies the MCP config file exists and optionally spawns the server briefly. For webhook-only connectors, probe is a no-op returning "not applicable."

### Wave 7: Web UI — Connectors page

**Goal:** the customer-facing feature. Settings sidebar → Connectors. Catalog cards → Configure modal → Test button → Enabled state.

**Files to create/modify:**
- `packages/web/src/pages/Connectors/index.tsx` — list page (catalog + configured)
- `packages/web/src/pages/Connectors/CatalogCard.tsx` — per-connector card
- `packages/web/src/pages/Connectors/ConfigureModal.tsx` — dynamic form from `ConfigSchema`
- `packages/web/src/pages/Connectors/TestButton.tsx` — live-probe UX with error display
- `packages/web/src/api/connectors.ts` — typed RPC client wrappers
- `packages/web/src/App.tsx` — add route
- `packages/web/src/Sidebar.tsx` — add nav link
- Playwright e2e: `packages/e2e/web/connectors.spec.ts`

**UX flow:**

1. **List page:** two sections — "Configured" (with enabled/disabled toggle, last-test state, edit / remove buttons) and "Available" (everything in the catalog not yet configured, grouped by category).

2. **Configure modal:** opens when user clicks "Add" on an Available card or "Edit" on a Configured one. Form is rendered from `configSchema.fields`. Secret fields are write-only (placeholder `••••••••` if already set; typing replaces). Submit → `connectors/configure`. Success → trigger Test automatically.

3. **Test button:** `connectors/test-live`. Loading spinner → green check + latency, OR red X + error message. Updates the card's last-test state.

4. **Enable/disable:** toggle directly from the Configured card.

5. **Remove:** confirm modal → `connectors/remove`.

**Design decisions to make at dispatch:**
- Icon/logo source — ship SVGs under `packages/web/public/connector-icons/<name>.svg` OR use an external service (Simple Icons CDN). Recommend: ship SVGs in-tree for the 6 built-ins, use a generic fallback for custom.
- Category labels — match `CatalogMetadata.category` enum.
- OAuth — NOT in MVP; token-based only. Config modal for providers that would benefit from OAuth (Google, Atlassian Cloud) shows an info banner: "OAuth flow coming soon — use a token for now."

**Test plan:**
- Unit tests per component (render with fake data, submit form, check API call payload).
- Playwright e2e: add a Jira connector (with fake credentials) → test fails with expected error → edit with valid fake secrets → test passes → disable → remove.

---

## Phase 3 waves — Observability

### Wave 8: Per-connector telemetry

- Emit a `connector.call` structured event on every `api()` invocation (wrap the factory to auto-instrument: `{ connector, tenant, method, duration_ms, ok, error? }`).
- Emit `connector.mcp.merged` on session-start MCP resolution so usage is attributable to sessions.
- Emit `connector.webhook.received` on inbound webhook.
- Aggregation: new materialized view or cron job populating `connector_usage_7d` (rollup per tenant × connector × day).
- Attribute cost if the connector call goes through the LLM router (e.g. pi-sage → Claude tool-use).

### Wave 9: UI surfacing

- Per-connector dashboard tile on the Configured card: 7d sparkline of call count, error-rate percentage, last-test time.
- Click a tile → drawer with recent calls (tail of the structured log filtered to this connector × tenant).
- "Used in N flows" badge — scan flow YAMLs for `connectors: [X]` references.

---

## Phase 4 waves — Extensibility

### Wave 10: User-authored connectors

- Loader: `packages/core/connectors/user-loader.ts` scans `<arkDir>/connectors/*.yaml` at boot.
- YAML schema (Zod-validated at load):

```yaml
name: internal-billing
label: Internal Billing
category: other
description: Paytm's internal billing API
status: full

auth:
  envVar: INTERNAL_BILLING_TOKEN

configSchema:
  fields:
    - key: baseUrl
      label: Base URL
      type: url
      required: true
    - key: token
      label: API Token
      type: secret
      required: true

api:
  kind: rest
  baseUrl: ${baseUrl}
  headers:
    Authorization: Bearer ${token}
  endpoints:
    listInvoices: GET /api/v1/invoices
    getInvoice: GET /api/v1/invoices/{id}
    # declarative — loader builds a minimal client from this

webhook:
  # optional — declarative JMESPath extractor (merges with the #364 work)
```

- Registration: user connectors go through the same `ConnectorRegistry` as built-ins; catalog endpoint reports `source: "user" | "builtin"`.
- Tenant-scoping: user connectors live under `<arkDir>/connectors/` (global) or `<arkDir>/<tenant>/connectors/` (tenant-scoped). Tenant overrides global by name.

### Wave 11: Docs

- `docs/connectors.md` — user-facing documentation: what a connector is, the four surfaces, the YAML schema, worked example, how to test locally.
- `docs/connectors-api.md` — developer-facing: the TypeScript `Connector<A>` interface, how to author a TypeScript (non-YAML) connector, when to choose which.
- Reference from `CLAUDE.md` (per #340).

---

## Phase 5 — Marketplace polish (Wave 12)

- Categories view — sidebar filter by `issue-tracker / chat / design / vcs / wiki / knowledge-base / monitoring / other`.
- Search — fuzzy match on name + label + description.
- Recently-used — sort Configured cards by last-used timestamp from telemetry.
- "Used in N flows" — click-through to the flow definitions using this connector.
- Deep-link — `/connectors/<name>` opens directly to that connector's configure modal.

---

## Dispatch guidance

**Stage sequentially. Each wave commits standalone.**

1. **Wave 1 (jira pilot)** — dispatch now that Wave 0 is in. Single agent, worktree, ~2-3 hours.
2. **Wave 2 (github/linear/bitbucket)** — after Wave 1 lands and is eyeballed. One agent back-to-back, OR three parallel worktrees.
3. **Wave 3 (slack/pi-sage/figma)** — one agent, file three follow-up issues during execution.
4. **Wave 4 (cleanup)** — one agent, small.
5. **Wave 5 (schema)** — one agent. Biggest prerequisite for Phase 2. Needs drizzle-kit + migration authoring.
6. **Waves 6-7 (RPC + Web UI)** — can parallel-dispatch IF Wave 5 is landed and the RPC surface is stable. But safer: Wave 6 first (RPC green with tests), then Wave 7 (UI binds to real endpoints).
7. **Phases 3-5** — re-plan at that point; scope these as separate plans when Phase 2 is in.

**The MVP ships at the end of Phase 2.** Phases 3-5 are polish + differentiation on top. If we ship Phase 2 and stop, the feature is already shippable as "Connectors in Ark" for pilot teams.

---

## Self-review

1. **Spec coverage:**
   - Unified framework ✓ Phase 1
   - Per-tenant configuration (persisted + encrypted) ✓ Wave 5
   - Catalog / configure / test UX ✓ Waves 6-7
   - Telemetry ✓ Waves 8-9
   - Extensibility ✓ Waves 10-11
   - Marketplace polish ✓ Wave 12
   - Figma follow-up filed ✓ Wave 3
   - Slack Web API follow-up ✓ Wave 3
   - Bitbucket MCP follow-up ✓ Wave 3

2. **Placeholder scan:** Phase 1 steps have concrete code. Phase 2+ waves are at design-depth — deliberate, not placeholder-rot. Each wave gets a sub-plan when dispatched.

3. **Type consistency:** `Connector<A>` consistent throughout. `ConfigSchema` + `CatalogMetadata` are Phase 2 additions — documented once in "Target shape" section, referenced everywhere else.

4. **MVP boundary clearly marked:** end of Phase 2 = shippable MVP. Phases 3-5 don't block.

5. **Open questions flagged:**
   - Encryption: `@napi-rs/keyring` vs. existing secrets backend — Wave 5 picks at dispatch.
   - OAuth: deferred from MVP. Revisit at Phase 3.
   - TicketProvider registry fusion with ConnectorRegistry — default answer: keep separate. Revisit if pain mounts.
