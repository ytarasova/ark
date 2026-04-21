/**
 * SecretsPage -- tenant-scoped secrets admin.
 *
 * Surface:
 *   - Lists refs (name + description + updated_at) via `secret/list`.
 *   - "Add secret" form posts to `secret/set`.
 *   - Per-row "Delete" hits `secret/delete` behind a confirm dialog.
 *   - No Get / Reveal button. Values never leave the server via this UI.
 *
 * Sits under Integrations in the sidebar so the "where do I put my API
 * keys?" lookup maps to the same mental model as the triggers /
 * connectors the keys feed.
 */

import { useCallback, useEffect, useState } from "react";
import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { ConfirmDialog } from "../components/ui/ConfirmDialog.js";
import { NewSecretForm } from "../components/secrets/NewSecretForm.js";
import { SecretsList, type SecretRowData } from "../components/secrets/SecretsList.js";
import { api } from "../hooks/useApi.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface SecretsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
}

export function SecretsPage({ view, onNavigate, readOnly, daemonStatus }: SecretsPageProps) {
  const [secrets, setSecrets] = useState<SecretRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = (await api.listSecrets()) as SecretRowData[];
      setSecrets(rows);
    } catch (e: any) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(input: { name: string; value: string; description?: string }) {
    await api.setSecret(input.name, input.value, input.description);
    await refresh();
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteSecret(pendingDelete);
      setPendingDelete(null);
      await refresh();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus}>
      <PageShell title="Secrets">
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold text-[var(--fg)]">Add a secret</h2>
            <p className="text-[12px] text-[var(--fg-muted)] max-w-2xl">
              Secrets are tenant-scoped key/value pairs injected as environment variables into dispatched agent
              sessions. Names must match <code className="font-mono">[A-Z0-9_]+</code> because they land verbatim in the
              process env. Values are never rendered back in the UI -- if you forget one, re-set it.
            </p>
            <NewSecretForm onCreated={handleCreate} readOnly={readOnly} />
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold text-[var(--fg)]">Current secrets</h2>
            <SecretsList
              secrets={secrets}
              loading={loading}
              error={error}
              onDelete={(name) => setPendingDelete(name)}
              readOnly={readOnly}
            />
          </section>
        </div>

        <ConfirmDialog
          open={pendingDelete !== null}
          onClose={() => (deleting ? undefined : setPendingDelete(null))}
          onConfirm={confirmDelete}
          title="Delete secret?"
          message={
            pendingDelete
              ? `Delete '${pendingDelete}'? Any sessions that reference this name will fail on their next dispatch until you re-set it.`
              : ""
          }
          confirmLabel="Delete"
          danger
          loading={deleting}
        />
      </PageShell>
    </Layout>
  );
}
