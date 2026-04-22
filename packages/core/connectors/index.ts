/**
 * Connector framework public barrel.
 */

export type {
  Connector,
  ConnectorKind,
  ConnectorStatus,
  ConnectorMcpConfig,
  ConnectorRestConfig,
  ConnectorContextConfig,
  ConnectorMcpEntry,
  ApiFactory,
  WebhookSurface,
  McpSurface,
  AuthRef,
} from "./types.js";

export { ConnectorRegistry, createDefaultConnectorRegistry, builtinConnectors } from "./registry.js";
export { collectMcpEntries, flowConnectorsFor, getConnectorRegistry, setConnectorRegistry } from "./resolve.js";

export { piSageConnector } from "./definitions/pi-sage.js";
export { jiraConnector } from "./definitions/jira.js";
export { githubConnector } from "./definitions/github.js";
export { linearConnector } from "./definitions/linear.js";
export { bitbucketConnector } from "./definitions/bitbucket.js";
export { slackConnector } from "./definitions/slack.js";
