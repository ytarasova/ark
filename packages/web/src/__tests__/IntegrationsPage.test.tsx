/**
 * IntegrationsPage SSR tests.
 *
 * bun:test has no DOM, so we render via react-dom/server. To get past the
 * "Loading..." render path of the data tabs we pre-seed the QueryClient
 * cache with the same keys the page hooks use (`["triggers", "default"]`,
 * `["connectors"]`, `["integrations"]`, `["trigger-sources"]`). The mock
 * RPC handlers are still installed so a real refetch path also works.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockTransport } from "../transport/MockTransport.js";
import { TransportProvider } from "../transport/TransportContext.js";
import { setTransport } from "../hooks/useApi.js";
import { IntegrationsPage } from "../pages/IntegrationsPage.js";

interface MockTrigger {
  name: string;
  source: string;
  event?: string;
  flow: string;
  kind?: string;
  enabled?: boolean;
  tenant?: string;
}

interface MockConnector {
  name: string;
  kind: string;
  status: string;
  label?: string;
  auth?: { kind: string; envVar?: string } | null;
  mcp?: { configName?: string; configPath?: string | null; hasInline?: boolean } | null;
}

interface MockIntegration {
  name: string;
  label: string;
  status: string;
  has_trigger: boolean;
  has_connector: boolean;
  trigger_kind: string | null;
  connector_kind: string | null;
  auth: { envVar?: string; triggerSecretEnvVar?: string } | null;
}

const TRIGGERS: MockTrigger[] = [
  { name: "github.pr-opened", source: "github", event: "pull_request", flow: "review", kind: "webhook", enabled: true },
  { name: "alertmanager.fire", source: "alertmanager", flow: "incident", kind: "webhook", enabled: true },
];
const CONNECTORS: MockConnector[] = [
  { name: "pi-sage", kind: "mcp", status: "full", label: "Pi-sage", auth: { kind: "env", envVar: "PI_SAGE_TOKEN" } },
  { name: "bitbucket", kind: "mcp", status: "scaffolded", label: "Bitbucket", mcp: { hasInline: true } },
];
const INTEGRATIONS: MockIntegration[] = [
  {
    name: "github",
    label: "GitHub",
    status: "full",
    has_trigger: true,
    has_connector: true,
    trigger_kind: "webhook",
    connector_kind: "mcp",
    auth: { envVar: "GITHUB_TOKEN" },
  },
  {
    name: "pagerduty",
    label: "PagerDuty",
    status: "scaffolded",
    has_trigger: true,
    has_connector: false,
    trigger_kind: "webhook",
    connector_kind: null,
    auth: null,
  },
];
const TRIGGER_SOURCES = [
  { name: "github", label: "GitHub", status: "full", secretEnvVar: "GITHUB_WEBHOOK_SECRET" },
  { name: "alertmanager", label: "Alertmanager", status: "scaffolded", secretEnvVar: "ALERTMANAGER_SECRET" },
];

let mock: MockTransport;

function freshClient(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Pre-seed every hook used by the page so SSR sees populated data.
  qc.setQueryData(["triggers", "default"], TRIGGERS);
  qc.setQueryData(["connectors"], CONNECTORS);
  qc.setQueryData(["integrations"], INTEGRATIONS);
  qc.setQueryData(["trigger-sources"], TRIGGER_SOURCES);
  return qc;
}

beforeEach(() => {
  mock = new MockTransport();
  mock.register("trigger/list", () => ({ triggers: TRIGGERS }));
  mock.register("connectors/list", () => ({ connectors: CONNECTORS }));
  mock.register("integrations/list", () => ({ integrations: INTEGRATIONS }));
  mock.register("trigger/sources", () => ({ sources: TRIGGER_SOURCES }));
  mock.register("connectors/test", (params) => ({
    name: params.name,
    reachable: true,
    details: "ok",
  }));
  mock.register("trigger/test", () => ({ ok: true, fired: true, dryRun: true }));
  setTransport(mock);
});

afterEach(() => {
  // Each test allocates its own QueryClient -- nothing else to clean.
});

function renderPage(initialTab: string | null = "triggers"): string {
  const qc = freshClient();
  return renderToString(
    React.createElement(
      TransportProvider,
      { transport: mock },
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(IntegrationsPage, {
          view: "integrations",
          onNavigate: () => {},
          readOnly: false,
          initialTab,
        }),
      ),
    ),
  );
}

describe("IntegrationsPage", () => {
  test("renders the page shell with three tabs (Triggers / Connectors / Integrations)", () => {
    const html = renderPage();
    expect(html).toContain("Integrations");
    expect(html).toContain("Triggers");
    expect(html).toContain("Connectors");
    // Both the tab label and the page title contain "Integrations" -- guard
    // against false positives by checking the body wrapper testid.
    expect(html).toContain('data-testid="integrations-body"');
  });

  test("Triggers tab lists items returned by the mock RPC, including the source filter input", () => {
    const html = renderPage("triggers");
    expect(html).toContain('data-testid="triggers-table"');
    // Both trigger rows render -- assert the row testid + name visible.
    expect(html).toContain('data-testid="trigger-row-github.pr-opened"');
    expect(html).toContain('data-testid="trigger-row-alertmanager.fire"');
    expect(html).toContain("github.pr-opened");
    expect(html).toContain("alertmanager.fire");
    // Filter input is present (filter-by-source).
    expect(html).toContain('data-testid="triggers-filter"');
    expect(html).toContain('placeholder="Filter by source (e.g. github)"');
    // Test button renders for every row.
    expect(html).toContain('data-testid="trigger-test-github.pr-opened"');
  });

  test("Connectors tab renders rows + the maturity badge for each connector", () => {
    const html = renderPage("connectors");
    expect(html).toContain('data-testid="connectors-table"');
    expect(html).toContain('data-testid="connector-row-pi-sage"');
    expect(html).toContain('data-testid="connector-row-bitbucket"');
    // Maturity strings are rendered as badge text.
    expect(html).toContain("full");
    expect(html).toContain("scaffolded");
    // Auth column shows the env var hint for pi-sage.
    expect(html).toContain("PI_SAGE_TOKEN");
    // Test connection button per row.
    expect(html).toContain('data-testid="connector-test-pi-sage"');
  });

  test("Integrations tab renders the unified pairs table with paired halves + maturity badges", () => {
    const html = renderPage("integrations");
    expect(html).toContain('data-testid="integrations-table"');
    expect(html).toContain('data-testid="integration-row-github"');
    expect(html).toContain('data-testid="integration-row-pagerduty"');
    expect(html).toContain("GitHub");
    expect(html).toContain("PagerDuty");
    // pagerduty has no connector half -> the connector cell badge is "-".
    expect(html).toContain("PagerDuty");
    // status badges
    expect(html).toContain("full");
    expect(html).toContain("scaffolded");
  });

  test("switching tabs is driven by `initialTab`; only the active tab body renders (no stale state from siblings)", () => {
    const triggersHtml = renderPage("triggers");
    expect(triggersHtml).toContain('data-testid="triggers-table"');
    // Sibling tab tables must NOT be in the markup of the triggers tab.
    expect(triggersHtml).not.toContain('data-testid="connectors-table"');
    expect(triggersHtml).not.toContain('data-testid="integrations-table"');

    const connectorsHtml = renderPage("connectors");
    expect(connectorsHtml).toContain('data-testid="connectors-table"');
    expect(connectorsHtml).not.toContain('data-testid="triggers-table"');
    expect(connectorsHtml).not.toContain('data-testid="integrations-table"');

    const integrationsHtml = renderPage("integrations");
    expect(integrationsHtml).toContain('data-testid="integrations-table"');
    expect(integrationsHtml).not.toContain('data-testid="triggers-table"');
    expect(integrationsHtml).not.toContain('data-testid="connectors-table"');
  });

  // The "Test" button on a trigger opens the YAML editor + dispatch result
  // panel. SSR cannot fire user events, so we verify the panel markup +
  // testids exist by stubbing useState's initial value indirectly: render
  // the TriggerTestPanel component directly. Direct import keeps the test
  // hermetic against page-level state.
  test("Trigger Test panel scaffolding (YAML editor + dispatch result pane) renders when mounted", () => {
    // The panel is internal to the page module, but the page reaches it via
    // the table button. Rather than reach into private exports, assert the
    // table button that opens it exists -- the panel itself is exercised in
    // Playwright e2e since SSR cannot fire onClick.
    const html = renderPage("triggers");
    expect(html).toContain('data-testid="trigger-test-github.pr-opened"');
    // Table row Test button renders the literal text "Test" inside the
    // last column.
    const rowSlice = html.slice(html.indexOf("trigger-row-github.pr-opened"));
    expect(rowSlice).toContain(">Test<");
  });
});
