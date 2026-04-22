/**
 * Per-stage compute resolution + template cloning.
 *
 * After the unification of compute targets and templates into a single row
 * the resolution path is uniform regardless of which axis the stage used
 * (`stageDef.compute` or the legacy `stageDef.compute_template`).
 *
 * Behavior:
 *   - Named row not found -> fall through to the config-defined template
 *     catalog; still not found -> return null (session default).
 *   - Row is a template (is_template=true) -> CLONE into a per-session
 *     concrete row `<template>-<sessionId8>` with `cloned_from` set. GC
 *     prunes the clone when the session reaches a terminal state.
 *   - Row is concrete -> return its name directly.
 */

import type { DispatchDeps } from "./types.js";
import type { StageDefinition } from "../../state/flow.js";
import type { ComputeProviderName } from "../../../types/index.js";

export class ComputeResolver {
  constructor(private readonly deps: Pick<DispatchDeps, "computes" | "computeService" | "config" | "events">) {}

  async resolveForStage(
    stageDef: StageDefinition | null,
    sessionId: string,
    log: (msg: string) => void = () => {},
  ): Promise<string | null> {
    const ref = stageDef?.compute ?? stageDef?.compute_template;
    if (!ref) return null;

    const existing = await this.deps.computes.get(ref);

    if (!existing) {
      // Fallback: config-defined template catalog lets users declare
      // templates in ~/.ark/config.yaml without hitting the DB. Seed a
      // fresh template row from config, then clone it below.
      const cfgTmpl = (this.deps.config.computeTemplates ?? []).find((t) => t.name === ref);
      if (cfgTmpl) {
        log(`Seeding template '${ref}' from config`);
        await this.deps.computeService.create({
          name: cfgTmpl.name,
          provider: cfgTmpl.provider as ComputeProviderName,
          config: cfgTmpl.config,
          is_template: true,
        });
        return this.cloneTemplate(cfgTmpl.name, sessionId, log);
      }
      log(`Stage compute '${ref}' not found, falling back to session default`);
      return null;
    }

    if (existing.is_template) {
      return this.cloneTemplate(existing.name, sessionId, log);
    }

    // Concrete target -- use directly, no cloning.
    return existing.name;
  }

  /**
   * Clone a template row into a per-session concrete row. Inherits provider,
   * compute_kind, runtime_kind and a deep copy of the template's config so
   * per-session mutations (e.g. an assigned pod IP) don't leak back.
   */
  private async cloneTemplate(templateName: string, sessionId: string, log: (msg: string) => void): Promise<string> {
    const tmpl = await this.deps.computes.get(templateName);
    if (!tmpl) {
      // Shouldn't happen -- caller already checked -- but be defensive.
      log(`Template '${templateName}' disappeared before clone`);
      return templateName;
    }

    const cloneName = `${templateName}-${sessionId.slice(0, 8)}`;

    // Idempotent: if a prior dispatch for this session already cloned the
    // template (e.g. on resume), reuse the existing clone.
    const existingClone = await this.deps.computes.get(cloneName);
    if (existingClone) {
      log(`Reusing existing clone '${cloneName}' of template '${templateName}'`);
      return cloneName;
    }

    log(`Cloning template '${templateName}' into '${cloneName}' for session ${sessionId}`);
    await this.deps.computeService.create({
      name: cloneName,
      provider: tmpl.provider,
      compute: tmpl.compute_kind,
      runtime: tmpl.runtime_kind,
      // Deep-copy via JSON round-trip so later per-session mutations don't
      // leak back into the template row.
      config: JSON.parse(JSON.stringify(tmpl.config ?? {})),
      is_template: false,
      cloned_from: templateName,
    });
    await this.deps.events.log(sessionId, "compute_cloned_from_template", {
      actor: "system",
      data: { template: templateName, clone: cloneName, provider: tmpl.provider },
    });
    return cloneName;
  }
}
