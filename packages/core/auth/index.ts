export { ApiKeyManager } from "./api-keys.js";
export {
  extractTenantContext,
  canWrite,
  isAdmin,
  DEFAULT_AUTH_CONFIG,
  DEFAULT_TENANT_CONTEXT,
  type AuthConfig,
} from "./middleware.js";
export { TenantPolicyManager, type TenantComputePolicy, type ComputePoolRef } from "./tenant-policy.js";
export { TenantManager, type Tenant, type TenantStatus } from "./tenants.js";
export { TeamManager, type Team, type MembershipRole, type MembershipRow, type MembershipWithUser } from "./teams.js";
export { UserManager, type User } from "./users.js";
// TenantContext plumbing for JSON-RPC handlers. See ./context.ts.
export {
  type TenantContext as HandlerTenantContext,
  isAdmin as isHandlerAdmin,
  requireAdmin,
  localAdminContext,
  anonymousContext,
  fromWire as tenantContextFromWire,
  materializeContext,
  type MaterializeOptions,
} from "./context.js";

// Soft-delete additions (migration 004). Kept at the bottom of this file so
// it composes cleanly with the TenantContext block above.
export type { ListOptions as TenantListOptions } from "./tenants.js";
