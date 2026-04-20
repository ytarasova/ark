/**
 * Trigger framework public barrel.
 *
 * Consumers:
 *   - server/handlers/webhooks.ts  : HTTP webhook endpoint
 *   - server/handlers/triggers.ts  : JSON-RPC CRUD
 *   - cli/commands/trigger.ts      : CLI entry point
 *   - core/integrations/registry.ts: unified integration lookup
 */

export type {
  TriggerKind,
  NormalizedEvent,
  TriggerConfig,
  TriggerSource,
  TriggerSourceStatus,
  TriggerMatcher,
  TriggerDispatcher,
  TriggerDispatchResult,
  TriggerStore,
  TriggerMatchFilter,
  TriggerInputMap,
  SourceReceiveResult,
} from "./types.js";

export { buildEvent, evalJsonPath, renderTemplate, parseJsonBody, timingSafeStringEqual } from "./normalizer.js";

export { DefaultTriggerMatcher, defaultMatcher } from "./matcher.js";
export { DefaultTriggerDispatcher } from "./dispatcher.js";
export { FileTriggerStore, createFileTriggerStore } from "./store.js";
export type { FileTriggerStoreOpts } from "./store.js";
export { TriggerSourceRegistry, createDefaultRegistry, builtinSources } from "./registry.js";
export { resolveSecret, secretEnvVar, loadSecretsFile } from "./secrets.js";

// Per-source exports for consumers that want a concrete connector handle.
export { githubSource } from "./sources/github.js";
export { bitbucketSource } from "./sources/bitbucket.js";
export { slackSource } from "./sources/slack.js";
export { genericHmacSource } from "./sources/generic-hmac.js";
export { linearSource } from "./sources/linear.js";
export { jiraSource } from "./sources/jira.js";
export { pagerdutySource } from "./sources/pagerduty.js";
export { prometheusSource } from "./sources/prometheus.js";
export { alertmanagerSource } from "./sources/alertmanager.js";
export { cloudwatchSource } from "./sources/cloudwatch.js";
export { piSageSource } from "./sources/pi-sage.js";
export { emailSource } from "./sources/email.js";
