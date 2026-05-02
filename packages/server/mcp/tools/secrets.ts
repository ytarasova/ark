/**
 * Secrets tools. Listing only -- the SecretsCapability is deliberately
 * single-tenant-scoped per call (it requires an explicit tenantId), and
 * the only safe MCP-surfaceable operation is the metadata projection.
 *
 * The shape is a deliberately narrow whitelist (name, type, description,
 * updated_at). Adding fields here is a security review: every key surfaced
 * is one more place a future change might leak secret material.
 */

import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";

const secretsList: ToolDef = {
  name: "secrets_list",
  description: "List secret names and metadata. NEVER returns raw values; this is by design.",
  inputSchema: z.object({}),
  handler: async (_input, { app, ctx }) => {
    // Match the JSON-RPC `secret/list` handler's tenant resolution exactly:
    // ctx.tenantId from the auth gate wins; else fall through to the app's
    // already-scoped tenantId; else the configured default; else "default".
    const tenantId = ctx.tenantId ?? app.tenantId ?? app.config.authSection.defaultTenant ?? "default";
    const secrets = await app.secrets.list(tenantId);
    return secrets.map((s) => ({
      name: s.name,
      type: s.type,
      description: s.description,
      updated_at: s.updated_at,
    }));
  },
};

sharedRegistry.register(secretsList);
