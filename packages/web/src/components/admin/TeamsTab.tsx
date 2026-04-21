import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button.js";
import { adminApi } from "./adminApi.js";
import type { Tenant, Team, Membership, MembershipRole } from "./types.js";

const ROLES: MembershipRole[] = ["owner", "admin", "member", "viewer"];

interface TeamsTabProps {
  onToast?: (msg: string, type: string) => void;
}

export function TeamsTab({ onToast }: TeamsTabProps) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string>("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [selected, setSelected] = useState<Team | null>(null);
  const [members, setMembers] = useState<Membership[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [addRole, setAddRole] = useState<MembershipRole>("member");

  useEffect(() => {
    adminApi
      .listTenants()
      .then((ts) => {
        setTenants(ts);
        setTenantId((prev) => (prev ? prev : (ts[0]?.id ?? "")));
      })
      .catch((e) => onToast?.(`Failed: ${e?.message}`, "error"));
  }, [onToast]);

  const refreshTeams = useCallback(
    async (tid: string) => {
      if (!tid) {
        setTeams([]);
        return;
      }
      try {
        const rows = await adminApi.listTeams(tid);
        setTeams(rows);
      } catch (e: any) {
        onToast?.(`Failed: ${e?.message}`, "error");
      }
    },
    [onToast],
  );

  useEffect(() => {
    refreshTeams(tenantId);
    setSelected(null);
  }, [tenantId, refreshTeams]);

  const selectedId = selected?.id;
  const refreshMembers = useCallback(async () => {
    if (!selectedId) {
      setMembers([]);
      return;
    }
    try {
      setMembers(await adminApi.listMembers(selectedId));
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }, [selectedId, onToast]);

  useEffect(() => {
    refreshMembers();
  }, [refreshMembers]);

  async function handleCreate() {
    if (!tenantId || !newSlug.trim() || !newName.trim()) return;
    try {
      const team = await adminApi.createTeam({
        tenant_id: tenantId,
        slug: newSlug.trim(),
        name: newName.trim(),
        description: newDesc.trim() || null,
      });
      onToast?.(`Team '${team.slug}' created`, "success");
      setShowNew(false);
      setNewSlug("");
      setNewName("");
      setNewDesc("");
      await refreshTeams(tenantId);
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  async function handleDelete(t: Team) {
    if (!confirm(`Delete team '${t.slug}'? This cascades memberships.`)) return;
    try {
      await adminApi.deleteTeam(t.id);
      onToast?.(`Team '${t.slug}' deleted`, "success");
      setSelected(null);
      await refreshTeams(tenantId);
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  async function handleAdd() {
    if (!selected || !addEmail.trim()) return;
    try {
      await adminApi.addMember(selected.id, addEmail.trim(), addRole);
      onToast?.(`Added ${addEmail} as ${addRole}`, "success");
      setAddEmail("");
      await refreshMembers();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  async function handleRemove(m: Membership) {
    if (!selected) return;
    if (!confirm(`Remove '${m.email}' from team '${selected.slug}'?`)) return;
    try {
      await adminApi.removeMember(selected.id, m.email);
      onToast?.(`Removed '${m.email}'`, "success");
      await refreshMembers();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  async function handleRoleChange(m: Membership, role: MembershipRole) {
    if (!selected) return;
    try {
      await adminApi.setMemberRole(selected.id, m.email, role);
      onToast?.(`Role updated`, "success");
      await refreshMembers();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  return (
    <div className="flex h-full">
      <div className="w-80 border-r border-[var(--border)] overflow-y-auto">
        <div className="p-3 border-b border-[var(--border)] space-y-2">
          <label className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Tenant</label>
          <select
            className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.slug})
              </option>
            ))}
          </select>
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Teams ({teams.length})</div>
            <Button size="xs" onClick={() => setShowNew(true)} disabled={!tenantId}>
              + New
            </Button>
          </div>
        </div>
        {showNew && (
          <div className="p-3 border-b border-[var(--border)] space-y-2 bg-[var(--bg-subtle)]">
            <input
              className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
              placeholder="slug"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
            />
            <input
              className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
              placeholder="name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <input
              className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
              placeholder="description (optional)"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
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
          {teams.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t)}
              className={
                "w-full text-left p-3 border-b border-[var(--border)] hover:bg-[var(--bg-subtle)]" +
                (selected?.id === t.id ? " bg-[var(--bg-subtle)]" : "")
              }
            >
              <div className="text-sm font-medium">{t.name}</div>
              <div className="text-[11px] text-[var(--fg-muted)]">{t.slug}</div>
            </button>
          ))}
          {!teams.length && <div className="p-4 text-[12px] text-[var(--fg-muted)]">No teams in this tenant.</div>}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {!selected ? (
          <div className="text-[var(--fg-muted)] text-sm">Select a team to manage members.</div>
        ) : (
          <div className="space-y-6">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Team</div>
              <h2 className="text-xl font-semibold mt-1">{selected.name}</h2>
              <div className="text-sm text-[var(--fg-muted)]">slug: {selected.slug}</div>
              <div className="text-sm text-[var(--fg-muted)]">id: {selected.id}</div>
              {selected.description && <div className="text-sm mt-1">{selected.description}</div>}
            </div>
            <div>
              <Button size="sm" variant="destructive" onClick={() => handleDelete(selected)}>
                Delete team
              </Button>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)] mb-2">
                Members ({members.length})
              </div>
              <div className="flex gap-2 mb-3">
                <input
                  className="flex-1 h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
                  placeholder="user@example.com"
                  value={addEmail}
                  onChange={(e) => setAddEmail(e.target.value)}
                />
                <select
                  className="h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
                  value={addRole}
                  onChange={(e) => setAddRole(e.target.value as MembershipRole)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <Button size="sm" onClick={handleAdd}>
                  Add
                </Button>
              </div>
              {members.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-[var(--fg-muted)] text-left">
                      <th className="py-1">Email</th>
                      <th className="py-1">Role</th>
                      <th className="py-1">Added</th>
                      <th className="py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.id} className="border-t border-[var(--border)]">
                        <td className="py-2">{m.email}</td>
                        <td className="py-2">
                          <select
                            className="h-7 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
                            value={m.role}
                            onChange={(e) => handleRoleChange(m, e.target.value as MembershipRole)}
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 text-[var(--fg-muted)]">{m.created_at}</td>
                        <td className="py-2 text-right">
                          <Button size="xs" variant="ghost" onClick={() => handleRemove(m)}>
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-[12px] text-[var(--fg-muted)]">No members.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
