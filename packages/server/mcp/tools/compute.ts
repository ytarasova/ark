/**
 * Compute tools. list/show return a deliberately narrow projection so the
 * raw config blob (which may contain provider credentials, kubeconfig
 * fragments, AWS keys baked into EC2 user-data, etc.) never round-trips
 * through MCP. start/stop dispatch through the new ComputeTarget API
 * (`Compute.attachExistingHandle` -> `Compute.start/stop`) so the legacy
 * provider registry is no longer required for these endpoints.
 */

import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";

interface ComputeSummary {
  name: string;
  compute_kind: string;
  isolation_kind: string;
  status: string;
  ip: string | null;
}

function toSummary(c: {
  name: string;
  compute_kind: string;
  isolation_kind: string;
  status: string;
  config: unknown;
}): ComputeSummary {
  return {
    name: c.name,
    compute_kind: c.compute_kind,
    isolation_kind: c.isolation_kind,
    status: c.status,
    ip: (c.config as { ip?: string } | null)?.ip ?? null,
  };
}

const computeList: ToolDef = {
  name: "compute_list",
  description: "List computes visible to the tenant. Sensitive config fields are NOT returned.",
  inputSchema: z.object({}),
  handler: async (_input, { app }) => {
    const computes = await app.computes.list();
    return computes.map(toSummary);
  },
};

const computeShow: ToolDef = {
  name: "compute_show",
  description: "Get a compute by name (sensitive fields stripped).",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const parsed = input as { name: string };
    const compute = await app.computes.get(parsed.name);
    if (!compute) throw new Error(`Compute not found: ${parsed.name}`);
    return toSummary(compute);
  },
};

const computeStart: ToolDef = {
  name: "compute_start",
  description: "Start a stopped compute (kind-specific).",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const parsed = input as { name: string };
    const compute = await app.computes.get(parsed.name);
    if (!compute) throw new Error(`Compute not found: ${parsed.name}`);
    const computeImpl = app.getCompute(compute.compute_kind);
    if (!computeImpl) throw new Error(`Unknown compute kind: ${compute.compute_kind}`);
    const handle = computeImpl.attachExistingHandle?.({
      name: compute.name,
      status: compute.status,
      config: (compute.config ?? {}) as Record<string, unknown>,
    });
    if (handle) {
      await computeImpl.start(handle);
    }
    await app.computes.update(compute.name, { status: "running" });
    return { status: "running" };
  },
};

const computeStop: ToolDef = {
  name: "compute_stop",
  description: "Stop a running compute (kind-specific).",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const parsed = input as { name: string };
    const compute = await app.computes.get(parsed.name);
    if (!compute) throw new Error(`Compute not found: ${parsed.name}`);
    const computeImpl = app.getCompute(compute.compute_kind);
    if (!computeImpl) throw new Error(`Unknown compute kind: ${compute.compute_kind}`);
    const handle = computeImpl.attachExistingHandle?.({
      name: compute.name,
      status: compute.status,
      config: (compute.config ?? {}) as Record<string, unknown>,
    });
    if (handle) {
      await computeImpl.stop(handle);
    }
    await app.computes.update(compute.name, { status: "stopped" });
    return { status: "stopped" };
  },
};

sharedRegistry.register(computeList);
sharedRegistry.register(computeShow);
sharedRegistry.register(computeStart);
sharedRegistry.register(computeStop);
