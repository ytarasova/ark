/**
 * Claude CLI integration facade.
 *
 * Historically this module bundled every Claude concern -- argument building,
 * MCP config, permissions, settings, launcher generation, trust, and channel
 * delivery -- into one 1000+ LOC file. It has since been split by concern
 * into sibling modules; this file now re-exports the full public surface so
 * external imports (`import * as claude from "../claude/claude.js"`) keep
 * working unchanged.
 *
 * See:
 *   - model.ts             -- model short-name mapping
 *   - args.ts              -- CLI arg building + shell quoting
 *   - mcp-config.ts        -- .mcp.json channel/MCP writer
 *   - permissions.ts       -- permissions.allow + tool hints from agent spec
 *   - settings.ts          -- .claude/settings.local.json bundle writer
 *   - launcher.ts          -- bash launcher script generation
 *   - trust.ts             -- pre-accept Claude trust dialog
 *   - channel-delivery.ts  -- auto-accept channel prompt + task delivery
 */

export { MODEL_MAP, resolveModel } from "./model.js";
export { buildArgs, shellQuoteArgs, type ClaudeArgsOpts } from "./args.js";
export { channelMcpConfig, expandEnvPlaceholders, writeChannelConfig, removeChannelConfig } from "./mcp-config.js";
export { buildPermissionsAllow, buildToolHints, type AgentToolSpec } from "./permissions.js";
export {
  writeSettings,
  writeSettingsVerified,
  removeSettings,
  verifySettings,
  type ClaudeSettingsOpts,
  type WriteSettingsResult,
} from "./settings.js";
export { buildLauncher, type LauncherOpts } from "./launcher.js";
export { trustWorktree, trustDirectory } from "./trust.js";
export { autoAcceptChannelPrompt, deliverTask } from "./channel-delivery.js";
