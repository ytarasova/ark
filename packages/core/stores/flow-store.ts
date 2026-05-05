/**
 * FlowStore - interface + file-backed implementation for flow definitions.
 *
 * Replaces the free functions in flow.ts that read from the filesystem via
 * global state (ARK_DIR). Consumers receive a FlowStore from AppContext
 * and call store methods instead.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { FlowDefinition } from "../services/flow.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface FlowSummary {
  name: string;
  description: string;
  stages: string[];
  source: string;
}

export interface FlowStore {
  list(): FlowSummary[];
  get(name: string): FlowDefinition | null;
  save(name: string, flow: FlowDefinition, scope?: "global" | "project"): void;
  delete(name: string, scope?: "global" | "project"): boolean;
  /**
   * Register an ephemeral in-memory flow definition by name. Only implemented
   * by EphemeralFlowStore -- the file-backed store ignores this call (optional
   * so existing store implementations do not need to be updated). Used by the
   * for_each dispatcher to register inline flow objects before spawning child
   * sessions, so downstream stage-lookup paths (getStage, getStageAction) can
   * find the definition without any signature changes.
   */
  registerInline?(name: string, flow: FlowDefinition): void;
  /**
   * Remove a previously registered ephemeral flow. Called when the child
   * session that owns the inline flow terminates (cleanup). No-op if the name
   * is not registered or the store does not support ephemeral flows.
   */
  unregisterInline?(name: string): void;
}

// ── File-backed implementation ──────────────────────────────────────────────

export interface FileFlowStoreOpts {
  builtinDir: string;
  userDir: string;
  projectDir?: string;
}

function loadYaml(path: string): Record<string, unknown> {
  return YAML.parse(readFileSync(path, "utf-8")) ?? {};
}

export class FileFlowStore implements FlowStore {
  private builtinDir: string;
  private userDir: string;
  private projectDir?: string;

  constructor(opts: FileFlowStoreOpts) {
    this.builtinDir = opts.builtinDir;
    this.userDir = opts.userDir;
    this.projectDir = opts.projectDir;
  }

  get(name: string): FlowDefinition | null {
    // Resolution order: project > user > builtin
    const dirs = this.projectDir ? [this.projectDir, this.userDir, this.builtinDir] : [this.userDir, this.builtinDir];

    for (const dir of dirs) {
      const path = join(dir, `${name}.yaml`);
      if (existsSync(path)) return loadYaml(path) as unknown as FlowDefinition;
    }
    return null;
  }

  list(): FlowSummary[] {
    const result = new Map<string, FlowSummary>();

    const dirs: [string, string][] = [
      [this.builtinDir, "builtin"],
      [this.userDir, "user"],
    ];
    if (this.projectDir) dirs.push([this.projectDir, "project"]);

    for (const [dir, source] of dirs) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
        const p = loadYaml(join(dir, file));
        const name = (p.name as string) ?? file.replace(".yaml", "");
        const stages = (Array.isArray(p.stages) ? p.stages : []) as Array<{ name: string }>;
        result.set(name, {
          name,
          description: (p.description as string) ?? "",
          stages: stages.map((s) => s.name),
          source,
        });
      }
    }
    return [...result.values()];
  }

  save(name: string, flow: FlowDefinition, scope: "global" | "project" = "global"): void {
    const dir = scope === "project" && this.projectDir ? this.projectDir : this.userDir;
    mkdirSync(dir, { recursive: true });
    const { ...data } = flow;
    writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(data));
  }

  delete(name: string, scope: "global" | "project" = "global"): boolean {
    const dir = scope === "project" && this.projectDir ? this.projectDir : this.userDir;
    const path = join(dir, `${name}.yaml`);
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
    return false;
  }
}
