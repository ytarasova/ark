# Ticket framework

Generic, provider-agnostic issue-tracker integration. Ark talks to Jira,
GitHub Issues, Linear, and Bitbucket; each one ships as a `TicketProvider`
that normalises its native payloads into the shapes declared in
[`types.ts`](./types.ts). Additional providers can plug in by implementing
the interface — see "Adding a provider" below.

This directory is deliberately thin: **types + registry + rich-text
pipeline**. Per-provider adapters live outside this directory (one issue per
provider).

## Layout

```
tickets/
  types.ts            -- domain types (TicketProvider, NormalizedTicket, ...)
  registry.ts         -- per-tenant provider registry + binding repository
  richtext/
    mdx.ts            -- canonical rich-text form (mdast-based)
    markdown.ts       -- GFM <-> MDX (identity, via mdast-util-from/to-markdown)
    adf.ts            -- Atlassian Document Format <-> MDX (hand-rolled)
    prosemirror.ts    -- Linear ProseMirror JSON <-> MDX (hand-rolled)
  __tests__/          -- round-trip fixtures per dialect
```

## Adding a provider

### Step 1: implement `TicketProvider`

Create `packages/core/tickets/providers/<name>.ts` and implement every method
in the [`TicketProvider`](./types.ts) interface. All inputs and outputs travel
through the normalised shapes; **never** leak the provider-native payload
outside the adapter (use the `raw` escape hatch on `NormalizedTicket` /
`NormalizedUser` / etc. if you need to stash native data).

### Step 2: register a factory

Factories are zero-arg and MUST return a fresh provider instance on each call
-- the registry invokes the factory once per `get()` so per-tenant HTTP
clients and base-URL overrides cannot leak between tenants.

```ts
import { getTicketProviderRegistry } from "../registry.js";
import { JiraProvider } from "./providers/jira.js";

getTicketProviderRegistry().register("jira", () => new JiraProvider());
```

### Step 3: bind credentials per tenant

Credentials live in the secrets backend (`packages/core/secrets`) and are
keyed per tenant. The registry takes a `TicketProviderBinding` whose
`credentials` field is a `TicketCredentials` bundle loaded from secrets --
`token`, `username`/`password`, `baseUrl`, `webhookSecret`, and an `extra`
bag for anything provider-specific.

```ts
await getTicketProviderRegistry().bind({
  tenantId,
  provider: "jira",
  credentials: { token, baseUrl, webhookSecret },
  writeEnabled: false, // default off -- opt in per tenant
  createdAt: now,
  updatedAt: now,
});
```

Bindings persist via an injected `TicketProviderBindingRepository`. The
default `InMemoryTicketProviderBindingRepository` is fine for tests and
single-tenant boots; the hosted control-plane wires a durable
implementation (SQL, once the `ticket_provider_bindings` table migration
lands -- tracked as a follow-up).

### Step 4: resolve at request time

```ts
const resolved = await getTicketProviderRegistry().get(tenantId, "jira");
if (!resolved) return null; // no provider or no binding for this tenant
const { provider, ctx } = resolved;
const ticket = await provider.getIssue(id, ctx);
```

## Rich-text guidance

**Always emit MDX.** The canonical ticket body / comment body type is
`RichText = Mdx` (a `mdast` root). Every adapter:

- On **read** converts the provider-native markup into MDX via the matching
  converter (`adfToMdx`, `markdownToMdx`, `prosemirrorToMdx`).
- On **write** converts MDX back into the provider-native form (`mdxToAdf`,
  `mdxToMarkdown`, `mdxToProsemirror`).

The converters cover the high-frequency node set (paragraph, heading, lists,
code blocks with language, tables, blockquotes, links, inline marks, hard
breaks, thematic breaks). Anything outside that surface lands in an MDX
`html` escape-hatch block with `data-preserved="<kind>"` and `data-raw="..."`
carrying the original node serialized as JSON. On the reverse path the
adapter detects the escape hatch and re-materialises the original -- a
Jira macro authored in the web UI will round-trip verbatim through Ark.

## Write gating

Every `TicketProvider` write method (`postComment`, `updateIssue`,
`transitionStatus`, `addLabel`, `removeLabel`) MUST check `ctx.writeEnabled`
and throw `TicketWriteDisabledError` when it is `false`. This is the master
kill switch for a tenant -- Ark ships read-only by default and writes only
when an operator explicitly flips the flag. Skipping this check is a bug;
tests should cover both branches.

## Credentials

Credentials NEVER live in the registry or a provider instance. They live in
the secrets backend keyed per tenant, are loaded at `bind()` time, and are
handed to the provider via `TicketContext.credentials` for the duration of a
single call. A provider instance has no ambient credential state and is safe
to create per-request.

## Known lossy constructs

| Dialect     | Lossy construct                          | Preservation                                  |
| ----------- | ---------------------------------------- | --------------------------------------------- |
| ADF         | Macros, extensions, media embeds, dates  | `html` block with `data-preserved="adf-node"` |
| ProseMirror | Linear custom blocks, unknown node types | `html` block with `data-preserved="pm-node"`  |
| Markdown    | None (MDX is a GFM superset)             | n/a                                           |

## Follow-ups

- Drizzle migration `009_ticket_provider_bindings` to persist bindings in
  SQLite / Postgres.
- Threaded comment trees (today `NormalizedComment.parentId` is
  representable; not enforced).
- Split `NormalizedTicketEvent` into snapshot + diff flavours if hot paths
  emerge.
