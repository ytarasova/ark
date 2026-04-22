/**
 * IntegrationsPage -- UI for the integrations framework.
 *
 * The page is three tabs over the same framework backend:
 *
 *  - Triggers    : `trigger/list` + `trigger/sources` -- inbound events that
 *                  dispatch a flow. Rows expose Enable/Disable (in-memory;
 *                  the CLI surfaces the same caveat) and a "Test" drawer
 *                  that pastes a YAML payload into `trigger/test` and shows
 *                  verify/match/dispatch output.
 *  - Connectors  : `connectors/list` + `connectors/test` -- outbound MCP /
 *                  REST / context integrations available to agents.
 *  - Integrations: `integrations/list` -- unified per-name pairs showing
 *                  which half (trigger / connector) each integration exposes
 *                  and the overall maturity badge.
 *
 * The page relies only on existing UI primitives (`Layout`, `PageShell`,
 * `ContentTabs`, `Button`, `Input`, `Badge`). Payload input is a plain
 * <textarea> since CLAUDE.md asks for YAML-authored input; we parse it
 * with the `yaml` package that already ships with the backend registry.
 */

import { useMemo, useState } from "react";
import { parse as parseYaml } from "yaml";
import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { ContentTabs, type TabDef } from "../components/ui/ContentTabs.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { api } from "../hooks/useApi.js";
import { useTriggers, useConnectors, useIntegrations, useTriggerSources } from "../hooks/useIntegrationQueries.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface IntegrationsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
  initialTab?: string | null;
  onTabChange?: (tab: string | null) => void;
}

type SubTab = "triggers" | "connectors" | "integrations";

function maturityVariant(status: string): "success" | "warning" | "secondary" {
  if (status === "full") return "success";
  if (status === "scaffolded") return "warning";
  return "secondary";
}

// ── Triggers tab ───────────────────────────────────────────────────────────

/**
 * Drawer for "Test trigger". YAML input is parsed client-side via the `yaml`
 * package (same parser the server store uses). The result pane shows whether
 * the payload was valid YAML, whether the trigger fired against the matcher,
 * and any session id returned by the dispatcher (when not dry-run).
 */
function TriggerTestPanel({ trigger, onClose }: { trigger: any; onClose: () => void }) {
  const [yamlText, setYamlText] = useState<string>(
    `# Paste a sample webhook payload here (YAML).\n# Fields under 'match:' in the trigger YAML are matched against dotted\n# paths on this object. Example for a github pull-request hook:\n#\n# action: opened\n# repo: paytmteam/foo\n# pull_request:\n#   number: 42\n#   title: Add feature\naction: opened\n`,
  );
  const [dryRun, setDryRun] = useState<boolean>(true);
  const [result, setResult] = useState<{
    ok: boolean;
    fired?: boolean;
    sessionId?: string;
    dryRun?: boolean;
    message?: string;
    error?: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  async function onRun() {
    setSubmitting(true);
    setResult(null);
    try {
      let payload: unknown;
      try {
        payload = parseYaml(yamlText);
      } catch (e: any) {
        setResult({ ok: false, error: `YAML parse error: ${e?.message ?? e}` });
        setSubmitting(false);
        return;
      }
      const res = await api.testTrigger({ name: trigger.name, payload, dryRun });
      setResult(res);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message ?? String(e) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
        <div className="flex flex-col">
          <span className="text-[13px] font-semibold text-[var(--fg)]">Test trigger: {trigger.name}</span>
          <span className="text-[11px] text-[var(--fg-muted)]">
            Paste a YAML payload. `trigger/test` verifies + matches + {dryRun ? "dry-runs" : "dispatches"}.
          </span>
        </div>
        <Button variant="outline" size="xs" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="p-4 grid grid-cols-[1fr_360px] gap-4">
        <textarea
          className="min-h-[220px] w-full resize-y bg-[var(--bg-code)] border border-[var(--border)] rounded-md px-3 py-2 text-[12px] font-mono leading-[1.5] text-[var(--fg)] placeholder:text-[var(--fg-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary)]"
          value={yamlText}
          onChange={(e) => setYamlText(e.target.value)}
          aria-label="Sample payload (YAML)"
          data-testid="trigger-test-yaml"
        />
        <div className="flex flex-col gap-3 text-[12px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            Dry-run (don't dispatch flow)
          </label>
          <Button size="sm" onClick={onRun} disabled={submitting} data-testid="trigger-test-run">
            {submitting ? "Running..." : "Run test"}
          </Button>
          <div className="flex-1 overflow-auto">
            {result == null ? (
              <p className="text-[var(--fg-muted)]">No result yet.</p>
            ) : result.error ? (
              <div className="border border-[var(--failed)]/40 rounded-md p-2 text-[var(--failed)]">{result.error}</div>
            ) : (
              <div className="space-y-2">
                <div>
                  <span className="text-[var(--fg-muted)]">fired:</span>{" "}
                  <Badge variant={result.fired ? "success" : "warning"}>{String(!!result.fired)}</Badge>
                </div>
                {result.sessionId && (
                  <div
                    className="text-[11px] text-[var(--fg)]"
                    style={{
                      fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace',
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    session: {result.sessionId}
                  </div>
                )}
                {result.dryRun && <Badge variant="secondary">dry-run</Badge>}
                {result.message && <div className="text-[var(--fg-muted)]">{result.message}</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TriggersTab({ readOnly }: { readOnly: boolean }) {
  const { data: triggers, loading: tLoading, error: tErr, refetch } = useTriggers();
  const { data: sources } = useTriggerSources();
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [testing, setTesting] = useState<any>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!sourceFilter) return triggers;
    return triggers.filter((t: any) => t.source === sourceFilter);
  }, [triggers, sourceFilter]);

  async function toggle(t: any) {
    try {
      if (t.enabled === false) await api.enableTrigger(t.name, t.tenant);
      else await api.disableTrigger(t.name, t.tenant);
      await refetch();
      setActionMsg(`${t.enabled === false ? "Enabled" : "Disabled"} ${t.name} (in-memory)`);
    } catch (e: any) {
      setActionMsg(e?.message ?? "Toggle failed");
    }
  }

  if (tLoading) return <div className="p-5 text-[var(--fg-muted)]">Loading triggers...</div>;
  if (tErr) return <div className="p-5 text-[var(--failed)]">{tErr.message}</div>;
  if (triggers.length === 0) {
    return (
      <div className="p-5 text-[var(--fg-muted)] text-sm">
        No triggers configured. Drop YAML files under <code>triggers/</code> or <code>~/.ark/triggers/</code>.
      </div>
    );
  }

  return (
    <div className="p-5 flex flex-col gap-3">
      <div className="flex gap-2 items-center" data-testid="triggers-filter">
        <Input
          placeholder="Filter by source (e.g. github)"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="w-60"
          list="trigger-source-options"
        />
        <datalist id="trigger-source-options">
          {sources.map((s: any) => (
            <option key={s.name} value={s.name}>
              {s.label}
            </option>
          ))}
        </datalist>
        {actionMsg && <span className="text-[12px] text-[var(--fg-muted)]">{actionMsg}</span>}
      </div>

      <table className="w-full text-[13px]" data-testid="triggers-table">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.04em] text-[var(--fg-muted)] border-b border-[var(--border)]">
            <th className="py-2 font-semibold">Name</th>
            <th className="py-2 font-semibold">Source</th>
            <th className="py-2 font-semibold">Event</th>
            <th className="py-2 font-semibold">Flow</th>
            <th className="py-2 font-semibold">Kind</th>
            <th className="py-2 font-semibold">Status</th>
            <th className="py-2 font-semibold text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((t: any) => (
            <tr
              key={t.name}
              className="border-b border-[var(--border)]/60 hover:bg-[var(--bg-hover)] transition-colors"
              data-testid={`trigger-row-${t.name}`}
            >
              <td
                className="py-2 text-[12px] text-[var(--fg)]"
                style={{ fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace' }}
              >
                {t.name}
              </td>
              <td className="py-2 text-[var(--fg)]">{t.source}</td>
              <td className="py-2 text-[var(--fg-muted)]">{t.event ?? "*"}</td>
              <td
                className="py-2 text-[12px] text-[var(--fg)]"
                style={{ fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace' }}
              >
                {t.flow}
              </td>
              <td className="py-2">
                <Badge variant="secondary">{t.kind ?? "webhook"}</Badge>
              </td>
              <td className="py-2">
                <Badge variant={t.enabled === false ? "secondary" : "success"}>
                  {t.enabled === false ? "disabled" : "enabled"}
                </Badge>
              </td>
              <td className="py-2 text-right space-x-2">
                {!readOnly && (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => toggle(t)}
                    data-testid={`trigger-toggle-${t.name}`}
                  >
                    {t.enabled === false ? "Enable" : "Disable"}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setTesting(t)}
                  data-testid={`trigger-test-${t.name}`}
                >
                  Test
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {testing && <TriggerTestPanel trigger={testing} onClose={() => setTesting(null)} />}
    </div>
  );
}

// ── Connectors tab ─────────────────────────────────────────────────────────

function ConnectorsTab() {
  const { data: connectors, loading, error, refetch: _refetch } = useConnectors();
  const [testResult, setTestResult] = useState<Record<string, { reachable: boolean; details: string }>>({});

  async function onTest(c: any) {
    try {
      const res = await api.testConnector(c.name);
      setTestResult((prev) => ({ ...prev, [c.name]: { reachable: res.reachable, details: res.details } }));
    } catch (e: any) {
      setTestResult((prev) => ({ ...prev, [c.name]: { reachable: false, details: e?.message ?? "Test failed" } }));
    }
  }

  if (loading) return <div className="p-5 text-[var(--fg-muted)]">Loading connectors...</div>;
  if (error) return <div className="p-5 text-[var(--failed)]">{error.message}</div>;
  if (connectors.length === 0) {
    return <div className="p-5 text-[var(--fg-muted)] text-sm">No connectors registered.</div>;
  }

  return (
    <div className="p-5">
      <table className="w-full text-[13px]" data-testid="connectors-table">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.04em] text-[var(--fg-muted)] border-b border-[var(--border)]">
            <th className="py-2 font-semibold">Name</th>
            <th className="py-2 font-semibold">Kind</th>
            <th className="py-2 font-semibold">Maturity</th>
            <th className="py-2 font-semibold">Auth</th>
            <th className="py-2 font-semibold">MCP config</th>
            <th className="py-2 font-semibold text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {connectors.map((c: any) => {
            const tr = testResult[c.name];
            return (
              <tr
                key={c.name}
                className="border-b border-[var(--border)]/60 hover:bg-[var(--bg-hover)] transition-colors"
                data-testid={`connector-row-${c.name}`}
              >
                <td
                  className="py-2 text-[12px] text-[var(--fg)]"
                  style={{ fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace' }}
                >
                  {c.name}
                </td>
                <td className="py-2">
                  <Badge variant="secondary">{c.kind}</Badge>
                </td>
                <td className="py-2">
                  <Badge variant={maturityVariant(c.status)}>{c.status}</Badge>
                </td>
                <td className="py-2 text-[12px] text-[var(--fg-muted)]">
                  {c.auth ? (c.auth.envVar ?? c.auth.secretsKey ?? c.auth.kind) : "none"}
                </td>
                <td
                  className="py-2 text-[11px] text-[var(--fg-muted)]"
                  style={{ fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace' }}
                >
                  {c.mcp?.configPath
                    ? c.mcp.configPath
                    : c.mcp?.hasInline
                      ? "inline"
                      : c.mcp?.configName
                        ? `(missing) ${c.mcp.configName}.json`
                        : "-"}
                </td>
                <td className="py-2 text-right">
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => onTest(c)}
                    data-testid={`connector-test-${c.name}`}
                  >
                    Test connection
                  </Button>
                  {tr && (
                    <div
                      className={`mt-1 text-[11px] ${tr.reachable ? "text-[var(--running)]" : "text-[var(--failed)]"}`}
                    >
                      {tr.reachable ? "OK" : "Unreachable"}: {tr.details}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Integrations tab ───────────────────────────────────────────────────────

function IntegrationsTab() {
  const { data: entries, loading, error } = useIntegrations();

  if (loading) return <div className="p-5 text-[var(--fg-muted)]">Loading integrations...</div>;
  if (error) return <div className="p-5 text-[var(--failed)]">{error.message}</div>;
  if (entries.length === 0) {
    return <div className="p-5 text-[var(--fg-muted)] text-sm">No integrations registered.</div>;
  }

  return (
    <div className="p-5">
      <table className="w-full text-[13px]" data-testid="integrations-table">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.04em] text-[var(--fg-muted)] border-b border-[var(--border)]">
            <th className="py-2 font-semibold">Name</th>
            <th className="py-2 font-semibold">Trigger</th>
            <th className="py-2 font-semibold">Connector</th>
            <th className="py-2 font-semibold">Auth</th>
            <th className="py-2 font-semibold">Maturity</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((i: any) => (
            <tr
              key={i.name}
              className="border-b border-[var(--border)]/60 hover:bg-[var(--bg-hover)] transition-colors"
              data-testid={`integration-row-${i.name}`}
            >
              <td
                className="py-2 text-[12px] text-[var(--fg)]"
                style={{ fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace' }}
              >
                {i.name}
                <div
                  className="text-[11px] text-[var(--fg-muted)] font-normal"
                  style={{ fontFamily: "var(--font-sans, inherit)" }}
                >
                  {i.label}
                </div>
              </td>
              <td className="py-2">
                {i.has_trigger ? (
                  <Badge variant="success">{i.trigger_kind ?? "yes"}</Badge>
                ) : (
                  <Badge variant="secondary">-</Badge>
                )}
              </td>
              <td className="py-2">
                {i.has_connector ? (
                  <Badge variant="success">{i.connector_kind ?? "yes"}</Badge>
                ) : (
                  <Badge variant="secondary">-</Badge>
                )}
              </td>
              <td className="py-2 text-[12px] text-[var(--fg-muted)]">
                {i.auth?.envVar ?? i.auth?.triggerSecretEnvVar ?? "-"}
              </td>
              <td className="py-2">
                <Badge variant={maturityVariant(i.status)}>{i.status}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Page shell ─────────────────────────────────────────────────────────────

export function IntegrationsPage({
  view,
  onNavigate,
  readOnly,
  daemonStatus,
  initialTab,
  onTabChange,
}: IntegrationsPageProps) {
  const [subTab, setSubTab] = useState<SubTab>((initialTab as SubTab) || "triggers");
  const { data: triggers } = useTriggers();
  const { data: connectors } = useConnectors();
  const { data: integrations } = useIntegrations();

  const tabs: TabDef[] = [
    { id: "triggers", label: "Triggers", badge: triggers.length || undefined },
    { id: "connectors", label: "Connectors", badge: connectors.length || undefined },
    { id: "integrations", label: "Integrations", badge: integrations.length || undefined },
  ];

  function changeTab(id: string) {
    setSubTab(id as SubTab);
    onTabChange?.(id);
  }

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus}>
      <PageShell title="Integrations" padded={false}>
        <ContentTabs tabs={tabs} activeTab={subTab} onTabChange={changeTab} ariaLabel="Integrations tabs" />
        <div className="flex-1 overflow-y-auto" data-testid="integrations-body">
          {subTab === "triggers" && <TriggersTab readOnly={readOnly} />}
          {subTab === "connectors" && <ConnectorsTab />}
          {subTab === "integrations" && <IntegrationsTab />}
        </div>
      </PageShell>
    </Layout>
  );
}
