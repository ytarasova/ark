/**
 * Trigger dispatcher -- turns a (config, event) pair into a session.
 *
 * Uses the public flow-invocation API (`startSession` from
 * session-orchestration). Input mapping runs per `config.inputs`, with each
 * value treated as a JSONPath expression over the normalized event.
 * Resolved values are passed through as `inputs.params`.
 *
 * The webhook handler wraps this call in `queueMicrotask` so the HTTP
 * response is returned before session-start work begins (hard constraint:
 * webhook handler returns 2xx fast).
 */

import type { AppContext } from "../app.js";
import type { NormalizedEvent, TriggerConfig, TriggerDispatcher, TriggerDispatchResult } from "./types.js";
import { evalJsonPath, renderTemplate } from "./normalizer.js";
import { logError, logInfo } from "../observability/structured-log.js";

export class DefaultTriggerDispatcher implements TriggerDispatcher {
  constructor(private readonly app: AppContext) {}

  async dispatch(opts: { event: NormalizedEvent; config: TriggerConfig }): Promise<TriggerDispatchResult> {
    const { event, config } = opts;

    // 1. Resolve input map: { k: "$.foo.bar" } -> { k: value }
    const params: Record<string, string> = {};
    if (config.inputs) {
      for (const [key, expr] of Object.entries(config.inputs)) {
        const value = evalJsonPath(expr, event);
        if (value === undefined || value === null) continue;
        params[key] = typeof value === "string" ? value : JSON.stringify(value);
      }
    }
    // 2. Merge static params (literal values from YAML).
    if (config.params) {
      for (const [key, value] of Object.entries(config.params)) {
        params[key] = typeof value === "string" ? value : String(value);
      }
    }

    // 3. Template-expand summary + repo (if provided).
    const summary = config.summary
      ? renderTemplate(config.summary, event)
      : `${config.source} ${event.event}`.slice(0, 120);
    const repo = config.repo ? renderTemplate(config.repo, event) : undefined;

    const createOpts = {
      summary,
      flow: config.flow,
      repo: repo && repo.length > 0 ? repo : undefined,
      group_name: `trigger:${config.name}`,
      inputs: {
        params: {
          ...params,
          trigger_source: event.source,
          trigger_event: event.event,
        },
      },
      config: {
        trigger: {
          name: config.name,
          source: event.source,
          event: event.event,
          receivedAt: event.receivedAt,
        },
      },
    };

    try {
      // Late import to keep the module graph shallow.
      const { startSession } = await import("../services/session-lifecycle.js");
      const tenantApp = config.tenant ? this.app.forTenant(config.tenant) : this.app;
      const session = await startSession(tenantApp, createOpts);
      logInfo("triggers", `trigger ${config.name} -> session ${session.id}`);
      await this.app.events.log(session.id, "trigger_fired", {
        actor: event.source,
        data: {
          trigger: config.name,
          event: event.event,
          ref: event.ref ?? null,
        },
      });
      return { ok: true, sessionId: session.id };
    } catch (e: any) {
      logError("triggers", `trigger ${config.name} dispatch failed: ${e?.message ?? e}`);
      return { ok: false, message: e?.message ?? String(e) };
    }
  }
}
