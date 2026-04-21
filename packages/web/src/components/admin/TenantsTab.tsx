import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button.js";
import { adminApi } from "./adminApi.js";
import type { Tenant, Team } from "./types.js";

interface TenantsTabProps {
  onToast?: (msg: string, type: string) => void;
}

/**
 * Tenants tab -- split pane: list on the left, detail on the right.
 * Plain table; confirm dialogs on destructive actions.
 */
export function TenantsTab({ onToast }: TenantsTabProps) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selected, setSelected] = useState<Tenant | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");

  const refresh = useCallback(async () => {
    try {
      setTenants(await adminApi.listTenants());
    } catch (e: any) {
      onToast?.(`Failed to load tenants: ${e?.message}`, "error");
    }
  }, [onToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectedId = selected?.id;
  useEffect(() => {
    if (!selectedId) {
      setTeams([]);
      return;
    }
    adminApi
      .listTeams(selectedId)
      .then(setTeams)
      .catch(() => setTeams([]));
  }, [selectedId]);

  async function handleCreate() {
    if (!newSlug.trim() || !newName.trim()) return;
    try {
      const t = await adminApi.createTenant({ slug: newSlug.trim(), name: newName.trim() });
      onToast?.(`Tenant '${t.slug}' created`, "success");
      setShowNew(false);
      setNewSlug("");
      setNewName("");
      await refresh();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  async function handleStatus(t: Tenant, status: Tenant["status"]) {
    try {
      await adminApi.setTenantStatus(t.id, status);
      onToast?.(`Tenant '${t.slug}' ${status}`, "success");
      await refresh();
      setSelected({ ...t, status });
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  async function handleDelete(t: Tenant) {
    if (!confirm(`Delete tenant '${t.slug}'? This cascades teams + memberships (sessions + computes are kept).`)) {
      return;
    }
    try {
      await adminApi.deleteTenant(t.id);
      onToast?.(`Tenant '${t.slug}' deleted`, "success");
      setSelected(null);
      await refresh();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  return (
    <div className="flex h-full">
      {/* List */}
      <div className="w-80 border-r border-[var(--border)] overflow-y-auto">
        <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Tenants ({tenants.length})</div>
          <Button size="xs" onClick={() => setShowNew(true)}>
            + New
          </Button>
        </div>
        {showNew && (
          <div className="p-3 border-b border-[var(--border)] space-y-2 bg-[var(--bg-subtle)]">
            <input
              className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
              placeholder="slug (e.g. acme)"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
            />
            <input
              className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
              placeholder="name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="xs" onClick={handleCreate}>
                Create
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setShowNew(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        <div>
          {tenants.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t)}
              className={
                "w-full text-left p-3 border-b border-[var(--border)] hover:bg-[var(--bg-subtle)]" +
                (selected?.id === t.id ? " bg-[var(--bg-subtle)]" : "")
              }
            >
              <div className="text-sm font-medium">{t.name}</div>
              <div className="text-[11px] text-[var(--fg-muted)] flex gap-2 mt-0.5">
                <span>{t.slug}</span>
                <span className="capitalize">{t.status}</span>
              </div>
            </button>
          ))}
          {!tenants.length && <div className="p-4 text-[12px] text-[var(--fg-muted)]">No tenants yet.</div>}
        </div>
      </div>
      {/* Detail */}
      <div className="flex-1 overflow-y-auto p-6">
        {!selected ? (
          <div className="text-[var(--fg-muted)] text-sm">Select a tenant to view details.</div>
        ) : (
          <div className="space-y-6">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Tenant</div>
              <h2 className="text-xl font-semibold mt-1">{selected.name}</h2>
              <div className="text-sm text-[var(--fg-muted)]">slug: {selected.slug}</div>
              <div className="text-sm text-[var(--fg-muted)]">id: {selected.id}</div>
              <div className="text-sm text-[var(--fg-muted)]">status: {selected.status}</div>
              <div className="text-sm text-[var(--fg-muted)]">created: {selected.created_at}</div>
            </div>
            <div className="flex gap-2">
              {selected.status !== "suspended" && (
                <Button size="sm" variant="warning" onClick={() => handleStatus(selected, "suspended")}>
                  Suspend
                </Button>
              )}
              {selected.status !== "active" && (
                <Button size="sm" variant="success" onClick={() => handleStatus(selected, "active")}>
                  Activate
                </Button>
              )}
              {selected.status !== "archived" && (
                <Button size="sm" variant="outline" onClick={() => handleStatus(selected, "archived")}>
                  Archive
                </Button>
              )}
              <Button size="sm" variant="destructive" onClick={() => handleDelete(selected)}>
                Delete
              </Button>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)] mb-2">
                Teams in this tenant ({teams.length})
              </div>
              {teams.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-[var(--fg-muted)] text-left">
                      <th className="py-1">Slug</th>
                      <th className="py-1">Name</th>
                      <th className="py-1">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teams.map((t) => (
                      <tr key={t.id} className="border-t border-[var(--border)]">
                        <td className="py-2">{t.slug}</td>
                        <td className="py-2">{t.name}</td>
                        <td className="py-2 text-[var(--fg-muted)]">{t.description ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-[12px] text-[var(--fg-muted)]">No teams yet.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
