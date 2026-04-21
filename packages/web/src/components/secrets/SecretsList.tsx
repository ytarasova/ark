/**
 * SecretsList -- tabular refs-only view of tenant secrets.
 *
 * Deliberately has no "Reveal" / "Get" action. If the user has forgotten a
 * value, they re-set it. Values never appear in the UI; we only ever
 * fetch the refs via `secret/list`.
 */

import { Button } from "../ui/button.js";

export interface SecretRowData {
  tenant_id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

export function SecretsList({
  secrets,
  loading,
  error,
  onDelete,
  readOnly,
}: {
  secrets: SecretRowData[];
  loading: boolean;
  error: Error | null;
  onDelete: (name: string) => void;
  readOnly: boolean;
}) {
  if (loading) return <div className="text-[var(--fg-muted)]">Loading secrets...</div>;
  if (error) return <div className="text-[var(--failed)]">{error.message}</div>;
  if (secrets.length === 0) {
    return (
      <div className="text-[var(--fg-muted)] text-[13px]">
        No secrets yet. Add one with the form above -- names map 1:1 to env vars injected into sessions that declare
        them.
      </div>
    );
  }
  return (
    <table className="w-full text-[13px]" data-testid="secrets-table">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-[0.04em] text-[var(--fg-muted)] border-b border-[var(--border)]">
          <th className="py-2 font-semibold">Name</th>
          <th className="py-2 font-semibold">Description</th>
          <th className="py-2 font-semibold">Updated</th>
          <th className="py-2 font-semibold text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {secrets.map((s) => (
          <tr
            key={s.name}
            className="border-b border-[var(--border)]/60 hover:bg-[var(--bg-hover)] transition-colors"
            data-testid={`secret-row-${s.name}`}
          >
            <td className="py-2 font-mono text-[12px] text-[var(--fg)]">{s.name}</td>
            <td className="py-2 text-[var(--fg-muted)]">{s.description ?? ""}</td>
            <td className="py-2 text-[11px] text-[var(--fg-muted)] font-mono">{s.updated_at}</td>
            <td className="py-2 text-right">
              {!readOnly && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => onDelete(s.name)}
                  data-testid={`secret-delete-${s.name}`}
                >
                  Delete
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
