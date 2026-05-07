export interface TenantContext {
  tenantId: string;
  userId: string | null;
  role: "admin" | "member" | "viewer" | "worker";
}

export interface ApiKey {
  id: string;
  tenantId: string;
  keyHash: string;
  name: string;
  role: "admin" | "member" | "viewer" | "worker";
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** Soft-delete timestamp (migration 006). Null for live keys. */
  deletedAt?: string | null;
  /** Acting user id recorded at revoke time (migration 006). Null if the
   *  key was revoked by the system / an unauthenticated caller. */
  deletedBy?: string | null;
}
