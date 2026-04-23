import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button.js";
import { useAdminApi } from "./adminApi.js";
import type { User } from "./types.js";

interface UsersTabProps {
  onToast?: (msg: string, type: string) => void;
}

export function UsersTab({ onToast }: UsersTabProps) {
  const adminApi = useAdminApi();
  const [users, setUsers] = useState<User[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");

  const refresh = useCallback(async () => {
    try {
      setUsers(await adminApi.listUsers());
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }, [adminApi, onToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleCreate() {
    if (!email.trim()) return;
    try {
      const u = await adminApi.createUser({ email: email.trim(), name: name.trim() || null });
      onToast?.(`User '${u.email}' created`, "success");
      setShowNew(false);
      setEmail("");
      setName("");
      await refresh();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  async function handleDelete(u: User) {
    if (!confirm(`Delete user '${u.email}'? This cascades their memberships.`)) return;
    try {
      await adminApi.deleteUser(u.id);
      onToast?.(`User '${u.email}' deleted`, "success");
      await refresh();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">Users</h2>
          <div className="text-[12px] text-[var(--fg-muted)]">Durable identities keyed by email.</div>
        </div>
        <Button size="sm" onClick={() => setShowNew(true)}>
          + New User
        </Button>
      </div>
      {showNew && (
        <div className="p-3 border border-[var(--border)] rounded mb-4 space-y-2 bg-[var(--bg-subtle)]">
          <input
            className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
            placeholder="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
            placeholder="name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
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
      {users.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-[var(--fg-muted)] text-left border-b border-[var(--border)]">
              <th className="py-2">ID</th>
              <th className="py-2">Email</th>
              <th className="py-2">Name</th>
              <th className="py-2">Created</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-[var(--border)]">
                <td className="py-2 text-[var(--fg-muted)]">{u.id}</td>
                <td className="py-2">{u.email}</td>
                <td className="py-2">{u.name ?? ""}</td>
                <td className="py-2 text-[var(--fg-muted)]">{u.created_at}</td>
                <td className="py-2 text-right">
                  <Button size="xs" variant="ghost" onClick={() => handleDelete(u)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="text-[12px] text-[var(--fg-muted)]">No users yet.</div>
      )}
    </div>
  );
}
