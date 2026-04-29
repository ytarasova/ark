export { findSessionByPR, formatReviewPrompt, extractComments } from "./github-pr.js";
export { handleIssueWebhook, type IssueWebhookPayload, type IssueWebhookConfig } from "./github-webhook.js";
export { Bridge, loadBridgeConfig, createBridge, type BridgeConfig, type BridgeMessage } from "./bridge.js";
export { pollPRReviews } from "./pr-poller.js";
export { pollPRMerges, fetchPRState, checkSessionMerge } from "./pr-merge-poller.js";
export {
  pollIssues,
  startIssuePoller,
  fetchLabeledIssues,
  createSessionFromIssue,
  type IssuePollerOptions,
  type GhIssue,
} from "./issue-poller.js";
export {
  watchMergedPR,
  shouldRollback,
  allCompleted,
  createRevertPayload,
  pollCheckSuites,
  type RollbackConfig,
  type CheckSuiteResult,
  type RevertPayload,
} from "./rollback.js";
// ── Unified registry ────────────────────────────────────────────────────────
// `Integration` pairs a trigger source + connector under one name. Callers
// asking "does Ark talk to github?" land here.
export {
  buildIntegrationCatalog,
  getIntegration,
  listIntegrations,
  type Integration,
  type IntegrationStatus,
} from "./registry.js";
