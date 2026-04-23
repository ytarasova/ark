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
import { existsSync } from "fs";
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
  claudeSession?: string;
  recipe?: string;
  runtime?: string;
  model?: string;
  maxBudget?: number;
  file?: Record<string, string>;
  param?: Record<string, string>;
}

/** Collaborator the service calls into. Kept as an interface so unit tests can stub. */
export interface SessionStartClient {
  recipeRead(name: string): Promise<any>;
  flowRead(name: string): Promise<any>;
}

export interface SessionStartEnv {
  client: SessionStartClient;
  /** Looks up a Claude Code session on disk. Only invoked when `opts.claudeSession` is set. */
  getClaudeSession?: (id: string) => Promise<{ sessionId: string; summary?: string | null; project: string } | null>;
  /** Returns an AppContext for the rare lookups that still need one. */
  getApp?: () => Promise<AppContext>;
}

export type PlanNote = { kind: "info" | "warn"; message: string };

export interface SessionStartPlan {
  /** Fully-resolved RPC payload ready for `ark.sessionStart()`. */
  request: Record<string, unknown>;
  /** Post-hoc bind target for the session once created (claude import). */
  claudeSessionId: string | null;
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

    // ── Claude session import ────────────────────────────────────────
    let claudeSessionId: string | null = null;
    if (opts.claudeSession) {
      if (!this.env.getClaudeSession) {
        throw new SessionStartPlanError("Claude session import is not available in this context.");
      }
      const cs = await this.env.getClaudeSession(opts.claudeSession);
      if (!cs) {
        throw new SessionStartPlanError(
          `Claude session '${opts.claudeSession}' not found. Run 'ark claude list' to see available sessions.`,
        );
      }
      claudeSessionId = cs.sessionId;
      if (!opts.summary) opts.summary = cs.summary?.slice(0, 100) || `Imported from ${cs.sessionId.slice(0, 8)}`;
      if (!repo) repo = cs.project;
      if (!workdir) workdir = cs.project;
      notes.push({
        kind: "info",
        message: `Importing Claude session ${cs.sessionId.slice(0, 8)} from ${cs.project}`,
      });
    }

    // ── Recipe instantiation ────────────────────────────────────────
    let recipeAgent: string | undefined;
    if (opts.recipe) {
      let recipe: any;
      try {
        recipe = await this.env.client.recipeRead(opts.recipe);
      } catch {
        throw new SessionStartPlanError(`Recipe not found: ${opts.recipe}`);
      }
      const core = await import("../../core/index.js");
      const instance = core.instantiateRecipe(recipe, {
        ...(opts.summary ? { summary: opts.summary } : {}),
        ...(opts.repo ? { repo: opts.repo } : {}),
      });
      if (!opts.summary && instance.summary) opts.summary = instance.summary;
      if (!opts.summary) opts.summary = recipe.description;
      if (!opts.flow || opts.flow === "default") opts.flow = instance.flow;
      if (!opts.compute && instance.compute) opts.compute = instance.compute;
      if (!opts.group && instance.group) opts.group = instance.group;
      if (!repo && instance.repo) repo = instance.repo;
      recipeAgent = instance.agent;
      notes.push({ kind: "info", message: `Using recipe '${recipe.name}' (${recipe._source})` });
    }

    // ── Session config overrides ────────────────────────────────────
    let sessionConfig: Record<string, unknown> | undefined;
    if (opts.runtime) sessionConfig = { ...sessionConfig, runtime_override: opts.runtime };
    if (opts.model) sessionConfig = { ...sessionConfig, model_override: opts.model };
    if (typeof opts.maxBudget === "number" && Number.isFinite(opts.maxBudget)) {
      sessionConfig = { ...sessionConfig, max_budget_usd: opts.maxBudget };
    }

    // ── --remote-repo handling ──────────────────────────────────────
    if (opts.remoteRepo) {
      if (!repo) {
        const urlMatch = opts.remoteRepo.match(/\/([^/]+?)(?:\.git)?$/);
        repo = urlMatch?.[1] ?? opts.remoteRepo;
      }
      sessionConfig = { ...sessionConfig, remoteRepo: opts.remoteRepo };
      notes.push({ kind: "info", message: `Remote repo: ${opts.remoteRepo}` });
    }

    // ── Summary sanitization ───────────────────────────────────────
    const rawName = opts.summary ?? ticket ?? "";
    const summary = sanitizeSummary(rawName);
    if (summary !== rawName) {
      notes.push({ kind: "info", message: `Note: session name sanitized to "${summary}"` });
    }

    // ── CLI-side defaulting of declared flow params ────────────────
    // The server-side Zod schema enforces declared-required inputs;
    // here we just pre-apply declared defaults so the user does not
    // have to re-type `{param: default}` for every invocation.
    const fileInputs: Record<string, string> = { ...(opts.file ?? {}) };
    const paramInputs: Record<string, string> = { ...(opts.param ?? {}) };
    if (opts.flow) {
      try {
        const flowDef = await this.env.client.flowRead(opts.flow);
        const declared = flowDef?.inputs;
        if (declared?.params) {
          for (const [key, def] of Object.entries<any>(declared.params)) {
            if (paramInputs[key] === undefined && def?.default !== undefined) {
              paramInputs[key] = def.default;
            }
          }
        }
      } catch {
        // flow/read may 404 for ad-hoc flows -- server will still validate.
      }
    }

    const inputs =
      Object.keys(fileInputs).length || Object.keys(paramInputs).length
        ? {
            ...(Object.keys(fileInputs).length ? { files: fileInputs } : {}),
            ...(Object.keys(paramInputs).length ? { params: paramInputs } : {}),
          }
        : undefined;

    const request: Record<string, unknown> = {
      ticket,
      summary,
      repo,
      ...(opts.branch ? { branch: opts.branch } : {}),
      flow: opts.flow,
      compute_name: opts.compute,
      agent: recipeAgent,
      workdir,
      group_name: opts.group,
      ...(sessionConfig ? { config: sessionConfig } : {}),
      ...(inputs ? { inputs } : {}),
    };

    return {
      request,
      claudeSessionId,
      attach: Boolean(opts.attach),
      notes,
    };
  }
}
