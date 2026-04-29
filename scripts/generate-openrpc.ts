/**
 * generate-openrpc.ts -- emit docs/openrpc.json from packages/protocol/rpc-schemas.ts.
 *
 * Uses Zod v4's built-in z.toJsonSchema() to convert every registered request/response
 * schema pair into an OpenRPC 1.3 method descriptor.  Run from the repo root:
 *
 *   bun run scripts/generate-openrpc.ts
 *
 * Writes: docs/openrpc.json
 */

import { join } from "path";
import { z } from "zod";
import { rpcMethodSchemas } from "../packages/protocol/rpc-schemas.js";
import { ARK_VERSION } from "../packages/protocol/types.js";

const REPO_ROOT = join(import.meta.dir, "..");
const OUT_PATH = join(REPO_ROOT, "docs", "openrpc.json");

// Human-readable descriptions for known method groups.
const DESCRIPTIONS: Record<string, string> = {
  "initialize": "Initialize a client connection. Must be the first call on every transport.",
  "session/start": "Create a new session with an optional flow, agent, compute target, and input bag.",
  "session/read": "Read full session details. Pass `include: [\"events\", \"messages\"]` to embed related records.",
  "session/list": "List sessions with optional filters (status, repo, group, parent).",
  "session/delete": "Soft-delete a session.",
  "session/undelete": "Restore a soft-deleted session.",
  "session/stop": "Stop a running session (kills the agent process but keeps the tmux pane).",
  "session/advance": "Approve a pending gate and advance to the next flow stage.",
  "session/archive": "Archive a completed session (hidden from default list).",
  "session/restore": "Restore an archived session.",
  "session/fork": "Fork a session into a child that shares the base worktree.",
  "session/clone": "Clone a session with a new name.",
  "session/spawn": "Spawn a child session with a specific task, optionally overriding the agent.",
  "session/pause": "Pause a running session (snapshot-based pause where the runtime supports it).",
  "session/resume": "Resume a paused session from a snapshot.",
  "session/interrupt": "Send Ctrl-C to the agent and inject a correction message.",
  "session/kill": "Forcefully terminate a session and clean up its tmux pane.",
  "session/complete": "Mark a session as completed.",
  "session/unread-counts": "Return per-session counts of unread messages.",
  "session/output": "Capture recent output from the agent's terminal pane.",
  "session/recording": "Return the full recording of a session's terminal output.",
  "session/stdio": "Return content of the session's stdio log file.",
  "session/transcript": "Return the raw JSON transcript produced by the agent.",
  "session/events": "Return events (status changes, stage transitions, errors) for a session.",
  "session/messages": "Return messages exchanged between the human and the agent.",
  "session/conversation": "Return conversation turns (role+content pairs) for a session.",
  "session/export-data": "Export a session's metadata and events as a portable snapshot.",
  "session/import": "Import a previously exported session snapshot.",
  "session/attach-command": "Return the tmux attach command for a session's pane.",
  "message/send": "Send a steering message to a running agent.",
  "message/markRead": "Mark all messages for a session as read.",
  "gate/approve": "Approve a pending gate to advance the flow.",
  "gate/reject": "Reject a pending gate (sends feedback to the agent via on-reject prompt).",
  "input/upload": "Upload a file through the blob store. Returns an opaque locator.",
  "input/read": "Fetch previously uploaded bytes by locator.",
  "compute/list": "List compute targets. Pass `include` to filter concrete vs template rows.",
  "compute/read": "Read compute target details by name.",
  "compute/create": "Create a new compute target.",
  "compute/capabilities": "Return capability flags for a compute provider.",
  "compute/provision": "Provision a compute target (boot VM, container, etc.).",
  "compute/start-instance": "Start a stopped compute instance.",
  "compute/stop-instance": "Stop a running compute instance.",
  "compute/destroy": "Destroy a compute target and release its resources.",
  "compute/kill-process": "Kill a process on a compute target by PID.",
  "compute/docker-logs": "Fetch logs from a Docker container on a compute target.",
  "compute/docker-action": "Stop or restart a Docker container on a compute target.",
  "compute/template/list": "List compute templates.",
  "flow/list": "List all available flow definitions.",
  "flow/read": "Read a flow definition by name.",
  "flow/create": "Create a new flow definition.",
  "flow/delete": "Delete a flow definition.",
  "agent/list": "List all available agent definitions.",
  "agent/create": "Create or upsert an agent definition (YAML or structured).",
  "agent/update": "Update an existing agent definition.",
  "agent/delete": "Delete an agent definition.",
  "skill/list": "List all available skills.",
  "skill/save": "Create or update a skill.",
  "skill/delete": "Delete a skill.",
  "recipe/list": "List all available recipes.",
  "recipe/delete": "Delete a recipe.",
  "runtime/list": "List all available runtime definitions.",
  "runtime/read": "Read a runtime definition by name.",
  "model/list": "List all available model definitions.",
  "schedule/list": "List scheduled sessions.",
  "schedule/create": "Create a scheduled or recurring session.",
  "schedule/delete": "Delete a schedule.",
  "schedule/enable": "Enable a disabled schedule.",
  "schedule/disable": "Disable an active schedule.",
  "costs/read": "Read usage records with filters.",
  "costs/session": "Return cost breakdown for a specific session.",
  "cost/export": "Export usage records.",
  "dashboard/summary": "Return dashboard summary (session counts, costs, compute health).",
  "metrics/snapshot": "Return current system metrics.",
  "status/get": "Return server status (total sessions by status).",
  "daemon/status": "Return daemon component health (conductor, arkd, router).",
  "config/get": "Read the current UI configuration (hotkeys, theme, mode).",
  "group/list": "List all session group names.",
  "profile/list": "List configuration profiles.",
  "profile/create": "Create a new configuration profile.",
  "profile/delete": "Delete a configuration profile.",
  "knowledge/stats": "Return knowledge graph statistics.",
  "knowledge/ingest": "Ingest files into the knowledge graph.",
  "knowledge/search": "Search the knowledge graph.",
  "knowledge/index": "Index a codebase into the knowledge graph.",
  "knowledge/export": "Export the knowledge graph to disk.",
  "knowledge/import": "Import the knowledge graph from disk.",
  "memory/list": "List memories.",
  "memory/add": "Add a memory.",
  "memory/recall": "Recall memories matching a query.",
  "memory/forget": "Delete a specific memory.",
  "history/list": "List imported session history.",
  "history/refresh-and-index": "Refresh and index the session history.",
  "history/rebuild-fts": "Rebuild the FTS5 full-text search index.",
  "search/sessions": "Full-text search across sessions.",
  "search/global": "Global full-text search across all Claude project directories.",
  "tools/list": "List configured MCP tools, commands, and skills.",
  "mcp/attach-by-dir": "Attach an MCP server to sessions in a project directory.",
  "mcp/detach-by-dir": "Detach an MCP server from a project directory.",
  "todo/add": "Add a todo item to a session.",
  "todo/toggle": "Toggle a todo item's done state.",
  "todo/list": "List todos for a session.",
  "todo/delete": "Delete a todo item.",
  "verify/run": "Run verification scripts for a session.",
  "worktree/list": "List active worktrees (sessions with a branch checked out).",
  "worktree/diff": "Return git diff stat for a session's worktree.",
  "worktree/create-pr": "Push and open a GitHub pull request from a worktree.",
  "worktree/finish": "Merge a worktree back to its base branch.",
  "worktree/cleanup": "Clean up stale worktrees.",
  "learning/list": "List learned patterns observed across sessions.",
  "learning/add": "Record a new learning.",
  "repo-map/get": "Return the structured repository map for a directory.",
  "fs/list-dir": "List entries in a filesystem directory.",
};

function methodGroup(method: string): string {
  const slash = method.indexOf("/");
  return slash >= 0 ? method.slice(0, slash) : method;
}

interface OpenRpcMethod {
  name: string;
  description?: string;
  tags?: { name: string }[];
  params: { name: string; required: boolean; schema: unknown }[];
  result: { name: string; schema: unknown };
}

interface OpenRpcDoc {
  openrpc: string;
  info: { title: string; version: string; description: string };
  methods: OpenRpcMethod[];
}

const methods: OpenRpcMethod[] = [];

for (const [method, { request, response }] of Object.entries(rpcMethodSchemas)) {
  const reqSchema = z.toJSONSchema(request, { reused: "inline" });
  const resSchema = z.toJSONSchema(response, { reused: "inline" });

  // OpenRPC uses an array of named params. Ark always sends a single object,
  // so we expose the schema as one param named "params" (matching JSON-RPC usage).
  const reqIsEmptyObject =
    typeof reqSchema === "object" &&
    reqSchema !== null &&
    (reqSchema as Record<string, unknown>).type === "object" &&
    Object.keys((reqSchema as Record<string, unknown>).properties ?? {}).length === 0;

  methods.push({
    name: method,
    description: DESCRIPTIONS[method],
    tags: [{ name: methodGroup(method) }],
    params: reqIsEmptyObject
      ? []
      : [
          {
            name: "params",
            required: true,
            schema: reqSchema,
          },
        ],
    result: {
      name: "result",
      schema: resSchema,
    },
  });
}

// Sort methods alphabetically for stable output.
methods.sort((a, b) => a.name.localeCompare(b.name));

const doc: OpenRpcDoc = {
  openrpc: "1.3.2",
  info: {
    title: "Ark JSON-RPC API",
    version: ARK_VERSION,
    description:
      "Ark exposes a JSON-RPC 2.0 API over stdio and WebSocket transports. " +
      "All CLI, Web dashboard, Desktop app, and remote client operations use this API. " +
      "Authentication in hosted mode uses Bearer tokens (API key format: ark_<tenantId>_<secret>).",
  },
  methods,
};

const json = JSON.stringify(doc, null, 2);
await Bun.write(OUT_PATH, json);
console.log(`generate-openrpc: wrote ${OUT_PATH} (${methods.length} methods)`);
