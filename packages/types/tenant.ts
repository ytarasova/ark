export interface TenantContext {
  tenantId: string;
  userId: string | null;
  role: "admin" | "member" | "viewer";
}

export interface ApiKey {
  id: string;
  tenantId: string;
  keyHash: string;
  name: string;
  role: "admin" | "member" | "viewer";
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}
