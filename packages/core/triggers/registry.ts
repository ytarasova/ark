/**
 * Source registry -- maps trigger `source` field to a concrete TriggerSource.
 *
 * Implemented as a class so it can be instantiated per AppContext (avoids
 * the module-level singleton pattern that PR #251 removed). A shared
 * `defaultTriggerSources()` helper seeds a registry with every built-in
 * source for callers that want the canonical set.
 *
 * Unknown sources return null from `get`; callers (webhook handler) convert
 * that into a 404 response.
 */

import type { TriggerSource } from "./types.js";
import { githubSource } from "./sources/github.js";
import { bitbucketSource } from "./sources/bitbucket.js";
import { slackSource } from "./sources/slack.js";
import { genericHmacSource } from "./sources/generic-hmac.js";
import { linearSource } from "./sources/linear.js";
import { pagerdutySource } from "./sources/pagerduty.js";
import { prometheusSource } from "./sources/prometheus.js";
import { jiraSource } from "./sources/jira.js";
import { alertmanagerSource } from "./sources/alertmanager.js";
import { cloudwatchSource } from "./sources/cloudwatch.js";
import { emailSource } from "./sources/email.js";

/**
 * In-memory trigger source registry. One instance lives per AppContext --
 * `createDefaultRegistry()` is the convenience factory.
 */
export class TriggerSourceRegistry {
  private readonly sources = new Map<string, TriggerSource>();

  /** Register or replace a source. */
  register(source: TriggerSource): void {
    this.sources.set(source.name, source);
  }

  /** Look up a source. Returns null when the name is unknown. */
  get(name: string): TriggerSource | null {
    return this.sources.get(name) ?? null;
  }

  list(): TriggerSource[] {
    return [...this.sources.values()];
  }

  clear(): void {
    this.sources.clear();
  }
}

/** Create a registry pre-populated with every shipped source connector. */
export function createDefaultRegistry(): TriggerSourceRegistry {
  const reg = new TriggerSourceRegistry();
  for (const src of builtinSources()) reg.register(src);
  return reg;
}

/** Canonical list of shipped sources -- also exported for tests + CLI. */
export function builtinSources(): TriggerSource[] {
  return [
    githubSource,
    bitbucketSource,
    slackSource,
    genericHmacSource,
    linearSource,
    pagerdutySource,
    prometheusSource,
    jiraSource,
    alertmanagerSource,
    cloudwatchSource,
    emailSource,
  ];
}
