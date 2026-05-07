/**
 * SessionStartService -- pure translation from CLI flags to a
 * `sessionStart` RPC payload. Extracted from the old 190-LOC
 * `commands/session/start.ts` action so the action handler stays thin
 * and the plan logic is unit-testable in isolation.
 *
 * The service talks to the daemon through a minimal interface (recipe
 * reads + flow reads + claude-session lookup) so tests can inject stubs
 * without booting a full AppContext.
 *
 * Flow-input validation has moved server-side (see the Zod schema in
 * `packages/protocol/rpc-schemas.ts`); this module still fills in declared
 * defaults + extracts CLI-specific hints (claude import, recipe
 * instantiation, remote-repo fallback).
 */

import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import YAML from "yaml";
import { sanitizeSummary } from "../helpers.js";
import type { AppContext } from "../../core/app.js";

// ── DTOs ──────────────────────────────────────────────────────────────────

/** Raw CLI option bag handed to the service. */
export interface SessionStartOpts {
  ticket?: string;
  repo?: string;
  remoteRepo?: string;
  branch?: string;
  summary?: string;
  flow?: string;
  compute?: string;
  group?: string;
  attach?: boolean;
  runtime?: string;
  model?: string;
  maxBudget?: number;
  file?: Record<string, string>;
  param?: Record<string, string>;
}

/** Collaborator the service calls into. Kept as an interface so unit tests can stub. */
export interface SessionStartClient {
  flowRead(name: string): Promise<any>;
}

export interface SessionStartEnv {
  client: SessionStartClient;
  /** Returns an AppContext for the rare lookups that still need one. */
  getApp?: () => Promise<AppContext>;
}

export type PlanNote = { kind: "info" | "warn"; message: string };

export interface SessionStartPlan {
  /** Fully-resolved RPC payload ready for `ark.sessionStart()`. */
  request: Record<string, unknown>;
  /** Whether the CLI should attach after dispatch. */
  attach: boolean;
  /** Echo lines the CLI surfaces to the user (non-blocking information). */
  notes: PlanNote[];
}

export class SessionStartPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStartPlanError";
  }
}

// ── Service ───────────────────────────────────────────────────────────────

export class SessionStartService {
  constructor(private readonly env: SessionStartEnv) {}

  /**
   * Translate the `opts` bag into a validated `SessionStartRequest` plus
   * CLI-side companion state. Throws `SessionStartPlanError` on anything
   * that should abort the CLI action (e.g. recipe not found, claude
   * session missing). Declared-input validation is deferred to the
   * server-side Zod schema.
   */
  async plan(ticket: string | undefined, opts: SessionStartOpts): Promise<SessionStartPlan> {
    const notes: PlanNote[] = [];

    // ── Repo derivation (may be overwritten by recipe / claude import) ─
    let workdir: string | undefined;
    let repo = opts.repo;
    if (repo) {
      const rp = resolve(repo);
      if (existsSync(rp)) {
        workdir = rp;
        repo = rp;
      }
    }

    // ── Session config overrides ────────────────────────────────────
    let sessionConfig: Record<string, unknown> | undefined;
    if (opts.runtime) sessionConfig = { ...sessionConfig, runtime_override: opts.runtime };
    if (opts.model) sessionConfig = { ...sessionConfig, model_override: opts.model };
    if (typeof opts.maxBudget === "number" && Number.isFinite(opts.maxBudget)) {
      sessionConfig = { ...sessionConfig, max_budget_usd: opts.maxBudget };
    }

    // ── --remote-repo handling ──────────────────────────────────────
    // Pass remoteRepo through in `config`. Server-side `session/start` now
    // synthesizes `session.repo` from the URL basename when `repo` is unset
    // (was previously done here in the CLI; moved up so non-CLI callers --
    // web form, MCP, raw RPC -- get the same DB row shape).
    if (opts.remoteRepo) {
      sessionConfig = { ...sessionConfig, remoteRepo: opts.remoteRepo };
      notes.push({ kind: "info", message: `Remote repo: ${opts.remoteRepo}` });
    }

    // ── Summary sanitization ───────────────────────────────────────
    const rawName = opts.summary ?? ticket ?? "";
    const summary = sanitizeSummary(rawName);
    if (summary !== rawName) {
      notes.push({ kind: "info", message: `Note: session name sanitized to "${summary}"` });
    }

    // ── Inline flow support ─────────────────────────────────────────
    // `--flow ./foo.yaml` (any path ending in .yaml/.yml that actually
    // exists on disk) is read + parsed and forwarded as an inline flow
    // object. Bare names still resolve via the FlowStore.
    let flowArg: string | Record<string, unknown> | undefined = opts.flow;
    if (typeof opts.flow === "string" && /\.(yaml|yml)$/i.test(opts.flow)) {
      const flowPath = resolve(opts.flow);
      if (existsSync(flowPath)) {
        try {
          flowArg = YAML.parse(readFileSync(flowPath, "utf-8")) as Record<string, unknown>;
          notes.push({ kind: "info", message: `Parsed inline flow from ${flowPath}` });
        } catch (e: any) {
          throw new SessionStartPlanError(`Failed to parse inline flow YAML at ${flowPath}: ${e?.message ?? e}`);
        }
      }
    }

    // ── Compose flow inputs ────────────────────────────────────────────
    // Flat shape: `inputs[key] = value`.
    //   - `--param k=value` writes `inputs[k] = parsedJSONorString`
    //   - `--file role=path` writes `inputs[role] = { $type: "file", path }`
    // Server also accepts the legacy `{files, params}` sub-bucket shape and
    // flattens it on ingest, so older dispatches still work.
    const paramInputs: Record<string, unknown> = { ...(opts.param ?? {}) };
    const fileInputs: Record<string, string> = { ...(opts.file ?? {}) };
    const topLevelInputs: Record<string, unknown> = { ...paramInputs };
    for (const [role, path] of Object.entries(fileInputs)) {
      topLevelInputs[role] = { $type: "file", path };
    }

    // Flow input validation. Two paths:
    //  - Named flow: hit the FlowStore for declared inputs.
    //  - Inline flow (parsed YAML object): use its `inputs` block directly.
    // Both apply declared defaults and fail fast on pattern mismatches so
    // the user gets a predictable error before the server round-trip.
    let declared: Record<string, any> | undefined;
    if (typeof opts.flow === "string" && !/\.(yaml|yml)$/i.test(opts.flow)) {
      try {
        const flowDef = await this.env.client.flowRead(opts.flow);
        declared = flowDef?.inputs as Record<string, any> | undefined;
      } catch {
        // flow/read may 404 for ad-hoc flows -- server validates server-side.
      }
    } else if (flowArg && typeof flowArg === "object") {
      declared = (flowArg as Record<string, any>).inputs as Record<string, any> | undefined;
    }
    if (declared) {
      const missing: string[] = [];
      for (const [key, def] of Object.entries<any>(declared)) {
        // Support both legacy nested shapes (declared.files / declared.params)
        // and the flat shape (one entry per input).
        if (key === "files" && def && typeof def === "object" && !def.type) {
          for (const [role, fdef] of Object.entries<any>(def)) {
            if (fdef?.required && !(role in topLevelInputs)) missing.push(`--file ${role}=<path>`);
          }
          continue;
        }
        if (key === "params" && def && typeof def === "object" && !def.type) {
          for (const [pkey, pdef] of Object.entries<any>(def)) {
            if (pdef?.required && topLevelInputs[pkey] === undefined) {
              if (pdef.default !== undefined) topLevelInputs[pkey] = pdef.default;
              else missing.push(`--param ${pkey}=<value>`);
            } else if (topLevelInputs[pkey] === undefined && pdef?.default !== undefined) {
              topLevelInputs[pkey] = pdef.default;
            }
          }
          continue;
        }
        // Flat shape: def is `{ type, required?, default?, pattern? }`.
        if (def?.required && topLevelInputs[key] === undefined) {
          if (def.default !== undefined) topLevelInputs[key] = def.default;
          else missing.push(`--param ${key}=<value>`);
        } else if (topLevelInputs[key] === undefined && def?.default !== undefined) {
          topLevelInputs[key] = def.default;
        }
        if (def?.pattern && typeof topLevelInputs[key] === "string") {
          const re = new RegExp(def.pattern);
          if (!re.test(topLevelInputs[key] as string)) {
            throw new SessionStartPlanError(
              `--param ${key}=${topLevelInputs[key]} does not match pattern ${def.pattern}`,
            );
          }
        }
      }
      if (missing.length) {
        throw new SessionStartPlanError(`Flow '${opts.flow}' is missing required inputs:\n  ${missing.join("\n  ")}`);
      }
    }

    const inputs = Object.keys(topLevelInputs).length ? topLevelInputs : undefined;

    const request: Record<string, unknown> = {
      ticket,
      summary,
      repo,
      ...(opts.branch ? { branch: opts.branch } : {}),
      flow: flowArg,
      compute_name: opts.compute,
      workdir,
      group_name: opts.group,
      ...(sessionConfig ? { config: sessionConfig } : {}),
      ...(inputs ? { inputs } : {}),
    };

    return {
      request,
      attach: Boolean(opts.attach),
      notes,
    };
  }
}
