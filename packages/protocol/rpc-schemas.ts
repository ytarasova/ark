/**
 * Zod schemas for the JSON-RPC boundary.
 *
 * Each exported pair (`<method>Request` / `<method>Response`) defines the
 * request and response shape for a single RPC method. The server imports
 * these to validate params at entry; the web client imports the inferred
 * TypeScript types to replace `rpc<any>` calls with typed round-trips.
 *
 * Only the highest-traffic methods are covered today (see P3-9 in the
 * consolidation plan). Uncovered methods continue to flow through
 * `extract<T>` and keep their ad-hoc types on the client.
 */

import { z } from "zod";

// ── Shared primitives ───────────────────────────────────────────────────────

const sessionIdParams = z.object({ sessionId: z.string().min(1) });

const sessionStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "waiting",
  "stopped",
  "blocked",
  "completed",
  "failed",
  "deleting",
  "archived",
]);

/** Permissive Session schema -- reflects the record emitted by the repo layer. */
const sessionSchema = z
  .object({
    id: z.string(),
    ticket: z.string().nullable(),
    summary: z.string().nullable(),
    repo: z.string().nullable(),
    branch: z.string().nullable(),
    compute_name: z.string().nullable(),
    session_id: z.string().nullable(),
    claude_session_id: z.string().nullable(),
    stage: z.string().nullable(),
    status: sessionStatusSchema,
    flow: z.string(),
    agent: z.string().nullable(),
    workdir: z.string().nullable(),
    pr_url: z.string().nullable(),
    pr_id: z.string().nullable(),
    error: z.string().nullable(),
    parent_id: z.string().nullable(),
    fork_group: z.string().nullable(),
    group_name: z.string().nullable(),
    breakpoint_reason: z.string().nullable(),
    attached_by: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
    user_id: z.string().nullable(),
    tenant_id: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .loose();

const eventSchema = z
  .object({
    id: z.number(),
    track_id: z.string(),
    type: z.string(),
    stage: z.string().nullable(),
    actor: z.string().nullable(),
    data: z.record(z.string(), z.unknown()).nullable(),
    created_at: z.string(),
  })
  .loose();

const messageSchema = z
  .object({
    id: z.number(),
    session_id: z.string(),
    role: z.enum(["user", "agent", "system"]),
    content: z.string(),
    type: z.enum(["text", "progress", "question", "completed", "error"]),
    read: z.boolean(),
    created_at: z.string(),
  })
  .loose();

const sessionOpResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  sessionId: z.string().optional(),
});

const computeProviderSchema = z.enum(["local", "docker", "ec2", "remote-arkd"]);
const computeStatusSchema = z.enum(["stopped", "running", "provisioning", "destroyed"]);

const computeSchema = z
  .object({
    name: z.string(),
    provider: computeProviderSchema,
    // Two-axis kinds. Optional on the wire so responses from a server that
    // hasn't shipped the schema change yet still parse.
    compute_kind: z.string().optional(),
    runtime_kind: z.string().optional(),
    status: computeStatusSchema,
    config: z.record(z.string(), z.unknown()),
    // Unified-model fields -- `is_template` distinguishes template rows
    // from concrete targets, `cloned_from` marks ephemeral clones. Both
    // optional on the wire for back-compat with older server builds.
    is_template: z.boolean().optional(),
    cloned_from: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .loose();

// ── session/start ───────────────────────────────────────────────────────────

// Generic session inputs bag. Files are role-keyed absolute paths; params
// are a dotted-key-safe k=v map. Both end up at `session.config.inputs` and
// are reachable via `{inputs.files.<role>}` / `{inputs.params.<key>}`
// through the shared template substitution pipeline.
//
// Shape validation only -- the "is this required key present?" contract is
// flow-specific and lives in `validateSessionInputsAgainstFlow()` below,
// called from the session/start handler after reading the flow definition.
export const sessionInputsSchema = z.object({
  files: z.record(z.string().min(1), z.string().min(1)).optional(),
  params: z.record(z.string().min(1), z.string()).optional(),
});
export type SessionInputs = z.infer<typeof sessionInputsSchema>;

/**
 * Structural description of a declared flow input contract. Mirrors
 * `types/flow.ts:FlowInputsSchema` but lives here so server handlers can
 * validate without taking a dependency on the core flow store types.
 */
export interface DeclaredFlowInputs {
  files?: Record<string, { required?: boolean; default?: string } | undefined>;
  params?: Record<string, { required?: boolean; default?: string; pattern?: string } | undefined>;
}

/**
 * Validate a session/start payload's `inputs` against a flow's declared
 * contract. Applies declared defaults in place, checks required roles +
 * keys, and validates regex patterns. Returns the list of human-readable
 * problems (empty = success). Used server-side from the session/start
 * handler; the CLI defers the "is this required?" question to the server.
 */
export function validateSessionInputsAgainstFlow(
  payload: { inputs?: SessionInputs },
  declared: DeclaredFlowInputs | null | undefined,
): string[] {
  const problems: string[] = [];
  if (!declared) return problems;

  const files: Record<string, string> = { ...(payload.inputs?.files ?? {}) };
  const params: Record<string, string> = { ...(payload.inputs?.params ?? {}) };

  for (const [role, def] of Object.entries(declared.files ?? {})) {
    if (def?.required && !files[role]) problems.push(`missing required file input: ${role}`);
  }
  for (const [key, def] of Object.entries(declared.params ?? {})) {
    if (params[key] === undefined) {
      if (def?.default !== undefined) {
        params[key] = def.default;
      } else if (def?.required) {
        problems.push(`missing required param input: ${key}`);
        continue;
      }
    }
    if (def?.pattern && params[key] !== undefined) {
      let re: RegExp;
      try {
        re = new RegExp(def.pattern);
      } catch {
        problems.push(`param ${key} declared pattern is not a valid regex: ${def.pattern}`);
        continue;
      }
      if (!re.test(params[key])) {
        problems.push(`param ${key}=${params[key]} does not match pattern ${def.pattern}`);
      }
    }
  }

  // Apply defaults in place so the caller sees the fully-resolved inputs.
  payload.inputs = {
    ...(Object.keys(files).length ? { files } : {}),
    ...(Object.keys(params).length ? { params } : {}),
  };

  return problems;
}

// ── input/upload ────────────────────────────────────────────────────────────
// Persists bytes through the configured BlobStore (local disk or S3) and
// returns an opaque locator. Callers stash the locator in
// `sessionStart.inputs.files[role]`; templating resolves it through the
// blob store on dispatch. Breaking change vs the old `{ path }` response.

export const inputUploadRequest = z.object({
  name: z.string(),
  role: z.string(),
  content: z.string(),
  contentEncoding: z.enum(["base64", "utf-8"]).optional(),
});
export type InputUploadRequest = z.infer<typeof inputUploadRequest>;

export const inputUploadResponse = z.object({ locator: z.string() });
export type InputUploadResponse = z.infer<typeof inputUploadResponse>;

// ── input/read ──────────────────────────────────────────────────────────────
// Fetch uploaded bytes by locator. Tenant is enforced by the BlobStore:
// the locator carries the owning tenant id and the handler passes the
// caller's tenant through, so a mismatch throws rather than leaks bytes.

export const inputReadRequest = z.object({ locator: z.string() });
export type InputReadRequest = z.infer<typeof inputReadRequest>;

export const inputReadResponse = z.object({
  filename: z.string(),
  contentType: z.string(),
  content: z.string(),
  contentEncoding: z.literal("base64"),
  size: z.number(),
});
export type InputReadResponse = z.infer<typeof inputReadResponse>;

export const sessionStartRequest = z
  .object({
    ticket: z.string().optional(),
    summary: z.string().optional(),
    repo: z.string().optional(),
    flow: z.string().optional(),
    agent: z.string().nullable().optional(),
    compute_name: z.string().optional(),
    workdir: z.string().optional(),
    group_name: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    user_id: z.string().optional(),
    inputs: sessionInputsSchema.optional(),
    attachments: z
      .array(
        z.object({
          name: z.string(),
          content: z.string(),
          type: z.string(),
        }),
      )
      .optional(),
  })
  .loose();
export type SessionStartRequest = z.infer<typeof sessionStartRequest>;

export const sessionStartResponse = z.object({ session: sessionSchema });
export type SessionStartResponse = z.infer<typeof sessionStartResponse>;

// ── session/read ────────────────────────────────────────────────────────────

export const sessionReadRequest = z.object({
  sessionId: z.string().min(1),
  include: z.array(z.string()).optional(),
});
export type SessionReadRequest = z.infer<typeof sessionReadRequest>;

export const sessionReadResponse = z
  .object({
    session: sessionSchema,
    events: z.array(eventSchema).optional(),
    messages: z.array(messageSchema).optional(),
  })
  .loose();
export type SessionReadResponse = z.infer<typeof sessionReadResponse>;

// ── session/list ────────────────────────────────────────────────────────────

export const sessionListRequest = z
  .object({
    status: sessionStatusSchema.optional(),
    repo: z.string().optional(),
    group_name: z.string().optional(),
    groupPrefix: z.string().optional(),
    parent_id: z.string().optional(),
    flow: z.string().optional(),
    limit: z.number().optional(),
  })
  .loose();
export type SessionListRequest = z.infer<typeof sessionListRequest>;

export const sessionListResponse = z.object({ sessions: z.array(sessionSchema) });
export type SessionListResponse = z.infer<typeof sessionListResponse>;

// ── session/delete ──────────────────────────────────────────────────────────

export const sessionDeleteRequest = sessionIdParams;
export type SessionDeleteRequest = z.infer<typeof sessionDeleteRequest>;

export const sessionDeleteResponse = z.object({ ok: z.boolean() });
export type SessionDeleteResponse = z.infer<typeof sessionDeleteResponse>;

// ── session/undelete ────────────────────────────────────────────────────────

export const sessionUndeleteRequest = sessionIdParams;
export type SessionUndeleteRequest = z.infer<typeof sessionUndeleteRequest>;

export const sessionUndeleteResponse = sessionOpResult;
export type SessionUndeleteResponse = z.infer<typeof sessionUndeleteResponse>;

// ── session/fork ────────────────────────────────────────────────────────────

export const sessionForkRequest = z.object({
  sessionId: z.string().min(1),
  name: z.string().optional(),
  group_name: z.string().optional(),
});
export type SessionForkRequest = z.infer<typeof sessionForkRequest>;

export const sessionForkResponse = z.object({ session: sessionSchema.nullable() });
export type SessionForkResponse = z.infer<typeof sessionForkResponse>;

// ── session/stop ────────────────────────────────────────────────────────────

export const sessionStopRequest = sessionIdParams;
export type SessionStopRequest = z.infer<typeof sessionStopRequest>;

export const sessionStopResponse = sessionOpResult;
export type SessionStopResponse = z.infer<typeof sessionStopResponse>;

// ── session/advance ─────────────────────────────────────────────────────────

export const sessionAdvanceRequest = z.object({
  sessionId: z.string().min(1),
  force: z.boolean().optional(),
});
export type SessionAdvanceRequest = z.infer<typeof sessionAdvanceRequest>;

export const sessionAdvanceResponse = sessionOpResult;
export type SessionAdvanceResponse = z.infer<typeof sessionAdvanceResponse>;

// ── session/archive ─────────────────────────────────────────────────────────

export const sessionArchiveRequest = sessionIdParams;
export type SessionArchiveRequest = z.infer<typeof sessionArchiveRequest>;

export const sessionArchiveResponse = sessionOpResult;
export type SessionArchiveResponse = z.infer<typeof sessionArchiveResponse>;

// ── session/restore ─────────────────────────────────────────────────────────

export const sessionRestoreRequest = sessionIdParams;
export type SessionRestoreRequest = z.infer<typeof sessionRestoreRequest>;

export const sessionRestoreResponse = sessionOpResult;
export type SessionRestoreResponse = z.infer<typeof sessionRestoreResponse>;

// ── session/attach-command ──────────────────────────────────────────────────

/**
 * Returns the CLI command a user should run to attach to a session's tmux
 * pane. Also flags whether the session is actually attachable: completed,
 * failed, and not-yet-dispatched sessions have no tmux pane to attach to.
 */
export const sessionAttachCommandRequest = sessionIdParams;
export type SessionAttachCommandRequest = z.infer<typeof sessionAttachCommandRequest>;

export const sessionAttachCommandResponse = z.object({
  command: z.string(),
  displayHint: z.string(),
  attachable: z.boolean(),
  reason: z.string().optional(),
});
export type SessionAttachCommandResponse = z.infer<typeof sessionAttachCommandResponse>;

// ── compute/list ────────────────────────────────────────────────────────────

export const computeListRequest = z
  .object({
    include: z.enum(["all", "concrete", "template"]).optional(),
  })
  .loose();
export type ComputeListRequest = z.infer<typeof computeListRequest>;

export const computeListResponse = z.object({ targets: z.array(computeSchema) });
export type ComputeListResponse = z.infer<typeof computeListResponse>;

// ── compute/create ──────────────────────────────────────────────────────────

export const computeCreateRequest = z.object({
  name: z.string().min(1),
  // `provider` is legacy; new callers pass `compute` + `runtime`.
  provider: computeProviderSchema.optional(),
  compute: z.string().optional(),
  runtime: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  template: z.string().optional(),
  // Unified-model fields: templates vs concrete rows in the same table.
  is_template: z.boolean().optional(),
  cloned_from: z.string().optional(),
});
export type ComputeCreateRequest = z.infer<typeof computeCreateRequest>;

export const computeCreateResponse = z.object({ compute: computeSchema });
export type ComputeCreateResponse = z.infer<typeof computeCreateResponse>;

// ── compute/read ────────────────────────────────────────────────────────────

export const computeReadRequest = z.object({ name: z.string().min(1) });
export type ComputeReadRequest = z.infer<typeof computeReadRequest>;

export const computeReadResponse = z.object({ compute: computeSchema });
export type ComputeReadResponse = z.infer<typeof computeReadResponse>;

// ── compute/capabilities ────────────────────────────────────────────────────

export const computeCapabilitiesRequest = z.object({ name: z.string().min(1) });
export type ComputeCapabilitiesRequest = z.infer<typeof computeCapabilitiesRequest>;

const computeIsolationModeSchema = z.object({
  value: z.string(),
  label: z.string(),
});

const computeCapabilitiesSchema = z.object({
  provider: z.string(),
  singleton: z.boolean(),
  canReboot: z.boolean(),
  canDelete: z.boolean(),
  needsAuth: z.boolean(),
  supportsWorktree: z.boolean(),
  initialStatus: z.string(),
  isolationModes: z.array(computeIsolationModeSchema),
});

export const computeCapabilitiesResponse = z.object({ capabilities: computeCapabilitiesSchema });
export type ComputeCapabilitiesResponse = z.infer<typeof computeCapabilitiesResponse>;

// ── flow/list ───────────────────────────────────────────────────────────────

export const flowListRequest = z.object({}).loose();
export type FlowListRequest = z.infer<typeof flowListRequest>;

const flowSummarySchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    source: z.string().optional(),
  })
  .loose();

export const flowListResponse = z.object({ flows: z.array(flowSummarySchema) });
export type FlowListResponse = z.infer<typeof flowListResponse>;

// ── flow/read ───────────────────────────────────────────────────────────────

export const flowReadRequest = z.object({ name: z.string().min(1) });
export type FlowReadRequest = z.infer<typeof flowReadRequest>;

const stageDefinitionSchema = z
  .object({
    name: z.string(),
    type: z.enum(["agent", "action", "fork"]).optional(),
    agent: z.string().optional(),
    action: z.string().optional(),
    task: z.string().optional(),
    gate: z.string().optional(),
    autonomy: z.string().optional(),
    on_failure: z.string().optional(),
    on_outcome: z.record(z.string(), z.string()).optional(),
    optional: z.boolean().optional(),
    model: z.string().optional(),
    verify: z.array(z.string()).optional(),
    isolation: z.enum(["fresh", "continue"]).optional(),
    strategy: z.string().optional(),
    max_parallel: z.number().optional(),
    subtasks: z.array(z.object({ name: z.string(), task: z.string() })).optional(),
    depends_on: z.array(z.string()).optional(),
  })
  .loose();

const flowDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    stages: z.array(stageDefinitionSchema),
    edges: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          condition: z.string().optional(),
          label: z.string().optional(),
        }),
      )
      .optional(),
    source: z.string().optional(),
  })
  .loose();

export const flowReadResponse = z.object({ flow: flowDefinitionSchema });
export type FlowReadResponse = z.infer<typeof flowReadResponse>;

// ── agent/list ──────────────────────────────────────────────────────────────

export const agentListRequest = z.object({}).loose();
export type AgentListRequest = z.infer<typeof agentListRequest>;

const agentDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    model: z.string(),
    max_turns: z.number(),
    system_prompt: z.string(),
    tools: z.array(z.string()),
    mcp_servers: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
    skills: z.array(z.string()),
    memories: z.array(z.string()),
    context: z.array(z.string()),
    permission_mode: z.string(),
    env: z.record(z.string(), z.string()),
    runtime: z.string().optional(),
    command: z.array(z.string()).optional(),
    task_delivery: z.enum(["stdin", "file", "arg"]).optional(),
    recipe: z.string().optional(),
    sub_recipes: z.array(z.string()).optional(),
    _source: z.enum(["builtin", "global", "project"]).optional(),
    _path: z.string().optional(),
  })
  .loose();

export const agentListResponse = z.object({ agents: z.array(agentDefinitionSchema) });
export type AgentListResponse = z.infer<typeof agentListResponse>;

// ── skill/list ──────────────────────────────────────────────────────────────

export const skillListRequest = z.object({}).loose();
export type SkillListRequest = z.infer<typeof skillListRequest>;

const skillDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    prompt: z.string(),
    tags: z.array(z.string()).optional(),
    _source: z.enum(["builtin", "project", "global"]).optional(),
  })
  .loose();

export const skillListResponse = z.object({ skills: z.array(skillDefinitionSchema) });
export type SkillListResponse = z.infer<typeof skillListResponse>;

// ── schedule/list ───────────────────────────────────────────────────────────

export const scheduleListRequest = z.object({}).loose();
export type ScheduleListRequest = z.infer<typeof scheduleListRequest>;

const scheduleSchema = z
  .object({
    id: z.string(),
    cron: z.string(),
    flow: z.string(),
    repo: z.string().optional(),
    workdir: z.string().optional(),
    summary: z.string().optional(),
    compute_name: z.string().optional(),
    group_name: z.string().optional(),
    enabled: z.boolean(),
    last_run: z.string().optional(),
    created_at: z.string(),
  })
  .loose();

export const scheduleListResponse = z.object({ schedules: z.array(scheduleSchema) });
export type ScheduleListResponse = z.infer<typeof scheduleListResponse>;

// ── schedule/create ─────────────────────────────────────────────────────────

export const scheduleCreateRequest = z
  .object({
    cron: z.string().min(1),
    flow: z.string().optional(),
    repo: z.string().optional(),
    workdir: z.string().optional(),
    summary: z.string().optional(),
    compute_name: z.string().optional(),
    group_name: z.string().optional(),
  })
  .loose();
export type ScheduleCreateRequest = z.infer<typeof scheduleCreateRequest>;

export const scheduleCreateResponse = z.object({ schedule: scheduleSchema });
export type ScheduleCreateResponse = z.infer<typeof scheduleCreateResponse>;

// ── costs/read ──────────────────────────────────────────────────────────────

export const costsReadRequest = z.object({}).loose();
export type CostsReadRequest = z.infer<typeof costsReadRequest>;

const sessionCostSchema = z
  .object({
    sessionId: z.string(),
    summary: z.string().nullable(),
    model: z.string().nullable(),
    usage: z
      .object({
        input_tokens: z.number(),
        output_tokens: z.number(),
        cache_read_input_tokens: z.number(),
        cache_creation_input_tokens: z.number(),
        total_tokens: z.number(),
      })
      .nullable(),
    cost: z.number(),
  })
  .loose();

export const costsReadResponse = z.object({
  costs: z.array(sessionCostSchema),
  total: z.number(),
});
export type CostsReadResponse = z.infer<typeof costsReadResponse>;

// ── dashboard/summary ───────────────────────────────────────────────────────

export const dashboardSummaryRequest = z.object({}).loose();
export type DashboardSummaryRequest = z.infer<typeof dashboardSummaryRequest>;

export const dashboardSummaryResponse = z
  .object({
    counts: z.record(z.string(), z.number()),
    costs: z
      .object({
        total: z.number(),
        today: z.number(),
        week: z.number(),
        month: z.number(),
        byModel: z.record(z.string(), z.number()),
        budget: z.unknown(),
      })
      .loose(),
    recentEvents: z.array(z.unknown()),
    topCostSessions: z.array(z.unknown()),
    system: z.object({ conductor: z.boolean(), router: z.boolean() }).loose(),
    activeCompute: z.number(),
  })
  .loose();
export type DashboardSummaryResponse = z.infer<typeof dashboardSummaryResponse>;

// ── todo/add ────────────────────────────────────────────────────────────────

export const todoAddRequest = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1),
});
export type TodoAddRequest = z.infer<typeof todoAddRequest>;

const todoSchema = z
  .object({
    id: z.number(),
    session_id: z.string(),
    content: z.string(),
    done: z.boolean(),
    created_at: z.string(),
  })
  .loose();

export const todoAddResponse = z.object({ todo: todoSchema });
export type TodoAddResponse = z.infer<typeof todoAddResponse>;

// ── todo/toggle ─────────────────────────────────────────────────────────────

export const todoToggleRequest = z.object({ id: z.number() });
export type TodoToggleRequest = z.infer<typeof todoToggleRequest>;

export const todoToggleResponse = z.object({ todo: todoSchema.nullable() });
export type TodoToggleResponse = z.infer<typeof todoToggleResponse>;

// ── knowledge/stats ─────────────────────────────────────────────────────────

export const knowledgeStatsRequest = z.object({}).loose();
export type KnowledgeStatsRequest = z.infer<typeof knowledgeStatsRequest>;

export const knowledgeStatsResponse = z.object({
  nodes: z.number(),
  edges: z.number(),
  by_node_type: z.record(z.string(), z.number()),
  by_edge_type: z.record(z.string(), z.number()),
});
export type KnowledgeStatsResponse = z.infer<typeof knowledgeStatsResponse>;

// ── session/output ──────────────────────────────────────────────────────────

export const sessionOutputRequest = z.object({
  sessionId: z.string().min(1),
  lines: z.number().optional(),
});
export type SessionOutputRequest = z.infer<typeof sessionOutputRequest>;

export const sessionOutputResponse = z.object({ output: z.string() }).loose();
export type SessionOutputResponse = z.infer<typeof sessionOutputResponse>;

// ── session/recording ───────────────────────────────────────────────────────

export const sessionRecordingRequest = sessionIdParams;
export type SessionRecordingRequest = z.infer<typeof sessionRecordingRequest>;

export const sessionRecordingResponse = z
  .object({
    ok: z.boolean(),
    output: z.string().nullable(),
  })
  .loose();
export type SessionRecordingResponse = z.infer<typeof sessionRecordingResponse>;

// ── session/events ──────────────────────────────────────────────────────────

export const sessionEventsRequest = z.object({
  sessionId: z.string().min(1),
  limit: z.number().optional(),
});
export type SessionEventsRequest = z.infer<typeof sessionEventsRequest>;

export const sessionEventsResponse = z.object({ events: z.array(eventSchema) }).loose();
export type SessionEventsResponse = z.infer<typeof sessionEventsResponse>;

// ── session/messages ────────────────────────────────────────────────────────

export const sessionMessagesRequest = z.object({
  sessionId: z.string().min(1),
  limit: z.number().optional(),
});
export type SessionMessagesRequest = z.infer<typeof sessionMessagesRequest>;

export const sessionMessagesResponse = z.object({ messages: z.array(messageSchema) }).loose();
export type SessionMessagesResponse = z.infer<typeof sessionMessagesResponse>;

// ── session/export-data ─────────────────────────────────────────────────────

const sessionExportShape = z
  .object({
    version: z.literal(1),
    exportedAt: z.string(),
    session: z.record(z.string(), z.unknown()),
    events: z.array(eventSchema),
  })
  .loose();

export const sessionExportDataRequest = sessionIdParams;
export type SessionExportDataRequest = z.infer<typeof sessionExportDataRequest>;

export const sessionExportDataResponse = sessionExportShape;
export type SessionExportDataResponse = z.infer<typeof sessionExportDataResponse>;

// ── session/import ──────────────────────────────────────────────────────────

export const sessionImportRequest = z
  .object({
    version: z.number(),
    session: z
      .object({
        ticket: z.string().optional(),
        summary: z.string().optional(),
        repo: z.string().optional(),
        flow: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        group_name: z.string().optional(),
        agent: z.string().optional(),
      })
      .loose(),
  })
  .loose();
export type SessionImportRequest = z.infer<typeof sessionImportRequest>;

export const sessionImportResponse = z
  .object({
    ok: z.boolean(),
    sessionId: z.string(),
    message: z.string().optional(),
  })
  .loose();
export type SessionImportResponse = z.infer<typeof sessionImportResponse>;

// ── session/resume ──────────────────────────────────────────────────────────

export const sessionResumeRequest = z.object({
  sessionId: z.string().min(1),
  snapshotId: z.string().optional(),
});
export type SessionResumeRequest = z.infer<typeof sessionResumeRequest>;

export const sessionResumeResponse = z
  .object({
    ok: z.boolean(),
    message: z.string().optional(),
    snapshotId: z.string().optional(),
  })
  .loose();
export type SessionResumeResponse = z.infer<typeof sessionResumeResponse>;

// ── session/clone ───────────────────────────────────────────────────────────

export const sessionCloneRequest = z.object({
  sessionId: z.string().min(1),
  name: z.string().optional(),
});
export type SessionCloneRequest = z.infer<typeof sessionCloneRequest>;

export const sessionCloneResponse = z.object({ session: sessionSchema.nullable() });
export type SessionCloneResponse = z.infer<typeof sessionCloneResponse>;

// ── session/pause ───────────────────────────────────────────────────────────

export const sessionPauseRequest = z.object({
  sessionId: z.string().min(1),
  reason: z.string().optional(),
});
export type SessionPauseRequest = z.infer<typeof sessionPauseRequest>;

export const sessionPauseResponse = z
  .object({
    ok: z.boolean(),
    message: z.string().optional(),
    snapshot: z.unknown().nullable().optional(),
    notSupported: z.boolean().optional(),
  })
  .loose();
export type SessionPauseResponse = z.infer<typeof sessionPauseResponse>;

// ── session/interrupt ───────────────────────────────────────────────────────

export const sessionInterruptRequest = z
  .object({
    sessionId: z.string().min(1),
    /** Correction message to inject as the next user turn after aborting. */
    content: z.string(),
  })
  .loose();
export type SessionInterruptRequest = z.infer<typeof sessionInterruptRequest>;

export const sessionInterruptResponse = z
  .object({
    ok: z.boolean(),
    message: z.string().optional(),
  })
  .loose();
export type SessionInterruptResponse = z.infer<typeof sessionInterruptResponse>;

// ── session/kill ─────────────────────────────────────────────────────────────

export const sessionKillRequest = sessionIdParams;
export type SessionKillRequest = z.infer<typeof sessionKillRequest>;

export const sessionKillResponse = z
  .object({
    ok: z.boolean(),
    message: z.string().optional(),
    terminated_at: z.number().optional(),
    cleaned_up: z.boolean().optional(),
  })
  .loose();
export type SessionKillResponse = z.infer<typeof sessionKillResponse>;

// ── session/complete ────────────────────────────────────────────────────────

export const sessionCompleteRequest = sessionIdParams;
export type SessionCompleteRequest = z.infer<typeof sessionCompleteRequest>;

export const sessionCompleteResponse = sessionOpResult;
export type SessionCompleteResponse = z.infer<typeof sessionCompleteResponse>;

// ── session/spawn ───────────────────────────────────────────────────────────

export const sessionSpawnRequest = z
  .object({
    sessionId: z.string().min(1),
    task: z.string(),
    agent: z.string().optional(),
    model: z.string().optional(),
    group_name: z.string().optional(),
  })
  .loose();
export type SessionSpawnRequest = z.infer<typeof sessionSpawnRequest>;

export const sessionSpawnResponse = z
  .object({
    ok: z.boolean(),
    message: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .loose();
export type SessionSpawnResponse = z.infer<typeof sessionSpawnResponse>;

// ── session/unread-counts ───────────────────────────────────────────────────

export const sessionUnreadCountsRequest = z.object({}).loose();
export type SessionUnreadCountsRequest = z.infer<typeof sessionUnreadCountsRequest>;

export const sessionUnreadCountsResponse = z.object({ counts: z.record(z.string(), z.number()) });
export type SessionUnreadCountsResponse = z.infer<typeof sessionUnreadCountsResponse>;

// ── session/conversation ────────────────────────────────────────────────────

const conversationTurnSchema = z
  .object({
    role: z.string(),
    content: z.string(),
    timestamp: z.string(),
  })
  .loose();

export const sessionConversationRequest = z.object({
  sessionId: z.string().min(1),
  limit: z.number().optional(),
});
export type SessionConversationRequest = z.infer<typeof sessionConversationRequest>;

export const sessionConversationResponse = z.object({ turns: z.array(conversationTurnSchema) }).loose();
export type SessionConversationResponse = z.infer<typeof sessionConversationResponse>;

// ── message/send ────────────────────────────────────────────────────────────

export const messageSendRequest = z.object({
  sessionId: z.string().min(1),
  content: z.string(),
});
export type MessageSendRequest = z.infer<typeof messageSendRequest>;

export const messageSendResponse = sessionOpResult;
export type MessageSendResponse = z.infer<typeof messageSendResponse>;

// ── message/markRead ────────────────────────────────────────────────────────

export const messageMarkReadRequest = sessionIdParams;
export type MessageMarkReadRequest = z.infer<typeof messageMarkReadRequest>;

export const messageMarkReadResponse = z.object({ ok: z.boolean() });
export type MessageMarkReadResponse = z.infer<typeof messageMarkReadResponse>;

// ── gate/approve ────────────────────────────────────────────────────────────

export const gateApproveRequest = sessionIdParams;
export type GateApproveRequest = z.infer<typeof gateApproveRequest>;

export const gateApproveResponse = z
  .object({
    ok: z.boolean(),
    message: z.string().optional(),
  })
  .loose();
export type GateApproveResponse = z.infer<typeof gateApproveResponse>;

// ── gate/reject ─────────────────────────────────────────────────────────────

export const gateRejectRequest = z.object({
  sessionId: z.string().min(1),
  reason: z.string(),
});
export type GateRejectRequest = z.infer<typeof gateRejectRequest>;

export const gateRejectResponse = z
  .object({
    ok: z.boolean(),
    message: z.string().optional(),
  })
  .loose();
export type GateRejectResponse = z.infer<typeof gateRejectResponse>;

// ── todo/list ───────────────────────────────────────────────────────────────

export const todoListRequest = sessionIdParams;
export type TodoListRequest = z.infer<typeof todoListRequest>;

export const todoListResponse = z.object({ todos: z.array(todoSchema) });
export type TodoListResponse = z.infer<typeof todoListResponse>;

// ── todo/delete ─────────────────────────────────────────────────────────────

export const todoDeleteRequest = z.object({ id: z.number() });
export type TodoDeleteRequest = z.infer<typeof todoDeleteRequest>;

export const todoDeleteResponse = z.object({ ok: z.boolean() });
export type TodoDeleteResponse = z.infer<typeof todoDeleteResponse>;

// ── verify/run ──────────────────────────────────────────────────────────────

export const verifyRunRequest = sessionIdParams;
export type VerifyRunRequest = z.infer<typeof verifyRunRequest>;

export const verifyRunResponse = z
  .object({
    ok: z.boolean(),
    todosResolved: z.boolean(),
    pendingTodos: z.array(z.unknown()),
    scriptResults: z.array(
      z
        .object({
          script: z.string(),
          passed: z.boolean(),
          output: z.string(),
        })
        .loose(),
    ),
    message: z.string().optional(),
  })
  .loose();
export type VerifyRunResponse = z.infer<typeof verifyRunResponse>;

// ── costs/session ───────────────────────────────────────────────────────────

export const costsSessionRequest = sessionIdParams;
export type CostsSessionRequest = z.infer<typeof costsSessionRequest>;

export const costsSessionResponse = z
  .object({
    cost: z.number(),
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_tokens: z.number(),
    cache_write_tokens: z.number(),
    total_tokens: z.number(),
  })
  .loose();
export type CostsSessionResponse = z.infer<typeof costsSessionResponse>;

// ── cost/export ─────────────────────────────────────────────────────────────

export const costExportRequest = z.object({ format: z.string().optional() }).loose();
export type CostExportRequest = z.infer<typeof costExportRequest>;

export const costExportResponse = z
  .object({
    csv: z.string().optional(),
    sessions: z.array(sessionCostSchema).optional(),
    total: z.number().optional(),
  })
  .loose();
export type CostExportResponse = z.infer<typeof costExportResponse>;

// ── search/sessions ─────────────────────────────────────────────────────────

const searchResultSchema = z
  .object({
    sessionId: z.string(),
    source: z.enum(["metadata", "event", "message", "transcript"]),
    match: z.string(),
    timestamp: z.string().optional(),
  })
  .loose();

export const searchSessionsRequest = z.object({
  query: z.string(),
  limit: z.number().optional(),
});
export type SearchSessionsRequest = z.infer<typeof searchSessionsRequest>;

export const searchSessionsResponse = z
  .object({
    sessions: z.array(searchResultSchema),
    transcripts: z.array(searchResultSchema),
  })
  .loose();
export type SearchSessionsResponse = z.infer<typeof searchSessionsResponse>;

// ── search/global ───────────────────────────────────────────────────────────

const globalSearchResultSchema = z
  .object({
    projectPath: z.string(),
    projectName: z.string(),
    fileName: z.string(),
    matchLine: z.string(),
    lineNumber: z.number(),
    modifiedAt: z.unknown(),
  })
  .loose();

export const searchGlobalRequest = z.object({ query: z.string() });
export type SearchGlobalRequest = z.infer<typeof searchGlobalRequest>;

// `searchAllConversations` returns a bare array; the handler forwards it verbatim.
export const searchGlobalResponse = z.array(globalSearchResultSchema);
export type SearchGlobalResponse = z.infer<typeof searchGlobalResponse>;

// ── history/list ────────────────────────────────────────────────────────────

const claudeSessionSchema = z
  .object({
    sessionId: z.string(),
    project: z.string(),
    projectDir: z.string(),
    transcriptPath: z.string(),
    summary: z.string(),
    messageCount: z.number(),
    timestamp: z.string(),
    lastActivity: z.string(),
  })
  .loose();

export const historyListRequest = z.object({ limit: z.number().optional() }).loose();
export type HistoryListRequest = z.infer<typeof historyListRequest>;

export const historyListResponse = z.object({ items: z.array(claudeSessionSchema) });
export type HistoryListResponse = z.infer<typeof historyListResponse>;

// ── history/refresh-and-index ───────────────────────────────────────────────

export const historyRefreshAndIndexRequest = z.object({}).loose();
export type HistoryRefreshAndIndexRequest = z.infer<typeof historyRefreshAndIndexRequest>;

export const historyRefreshAndIndexResponse = z
  .object({
    ok: z.boolean(),
    sessionCount: z.number(),
    indexCount: z.number(),
    items: z.array(claudeSessionSchema),
  })
  .loose();
export type HistoryRefreshAndIndexResponse = z.infer<typeof historyRefreshAndIndexResponse>;

// ── history/rebuild-fts ─────────────────────────────────────────────────────

export const historyRebuildFtsRequest = z.object({}).loose();
export type HistoryRebuildFtsRequest = z.infer<typeof historyRebuildFtsRequest>;

export const historyRebuildFtsResponse = z.object({ ok: z.boolean() }).loose();
export type HistoryRebuildFtsResponse = z.infer<typeof historyRebuildFtsResponse>;

// ── status/get ──────────────────────────────────────────────────────────────

export const statusGetRequest = z.object({}).loose();
export type StatusGetRequest = z.infer<typeof statusGetRequest>;

export const statusGetResponse = z
  .object({
    total: z.number(),
    byStatus: z.record(z.string(), z.number()),
  })
  .loose();
export type StatusGetResponse = z.infer<typeof statusGetResponse>;

// ── daemon/status ───────────────────────────────────────────────────────────

export const daemonStatusRequest = z.object({}).loose();
export type DaemonStatusRequest = z.infer<typeof daemonStatusRequest>;

export const daemonStatusResponse = z
  .object({
    conductor: z.object({ online: z.boolean(), url: z.string() }).loose(),
    arkd: z.object({ online: z.boolean(), url: z.string() }).loose(),
    router: z.object({ online: z.boolean() }).loose(),
  })
  .loose();
export type DaemonStatusResponse = z.infer<typeof daemonStatusResponse>;

// ── group/list ──────────────────────────────────────────────────────────────

const groupSchema = z.object({ name: z.string() }).loose();

export const groupListRequest = z.object({}).loose();
export type GroupListRequest = z.infer<typeof groupListRequest>;

export const groupListResponse = z.object({ groups: z.array(groupSchema) }).loose();
export type GroupListResponse = z.infer<typeof groupListResponse>;

// ── config/get ──────────────────────────────────────────────────────────────

export const configGetRequest = z.object({}).loose();
export type ConfigGetRequest = z.infer<typeof configGetRequest>;

export const configGetResponse = z
  .object({
    hotkeys: z.unknown(),
    theme: z.unknown(),
    profile: z.unknown(),
    mode: z.string(),
    hosted: z.boolean(),
  })
  .loose();
export type ConfigGetResponse = z.infer<typeof configGetResponse>;

// ── profile/list ────────────────────────────────────────────────────────────

const profileSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string().optional(),
  })
  .loose();

export const profileListRequest = z.object({}).loose();
export type ProfileListRequest = z.infer<typeof profileListRequest>;

export const profileListResponse = z
  .object({
    profiles: z.array(profileSchema),
    active: z.string().nullable().optional(),
  })
  .loose();
export type ProfileListResponse = z.infer<typeof profileListResponse>;

// ── profile/create ──────────────────────────────────────────────────────────

export const profileCreateRequest = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});
export type ProfileCreateRequest = z.infer<typeof profileCreateRequest>;

export const profileCreateResponse = z.object({ profile: profileSchema });
export type ProfileCreateResponse = z.infer<typeof profileCreateResponse>;

// ── profile/delete ──────────────────────────────────────────────────────────

export const profileDeleteRequest = z.object({ name: z.string().min(1) });
export type ProfileDeleteRequest = z.infer<typeof profileDeleteRequest>;

export const profileDeleteResponse = z.object({ ok: z.boolean() });
export type ProfileDeleteResponse = z.infer<typeof profileDeleteResponse>;

// ── tools/list ──────────────────────────────────────────────────────────────

const toolEntrySchema = z
  .object({
    kind: z.enum(["mcp-server", "command", "claude-skill", "ark-skill", "ark-recipe", "context"]),
    name: z.string(),
    description: z.string(),
    source: z.string(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export const toolsListRequest = z.object({ projectRoot: z.string().optional() }).loose();
export type ToolsListRequest = z.infer<typeof toolsListRequest>;

export const toolsListResponse = z.object({ tools: z.array(toolEntrySchema) });
export type ToolsListResponse = z.infer<typeof toolsListResponse>;

// ── mcp/attach-by-dir ───────────────────────────────────────────────────────

export const mcpAttachByDirRequest = z.object({
  dir: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});
export type McpAttachByDirRequest = z.infer<typeof mcpAttachByDirRequest>;

export const mcpAttachByDirResponse = z.object({ ok: z.boolean() });
export type McpAttachByDirResponse = z.infer<typeof mcpAttachByDirResponse>;

// ── mcp/detach-by-dir ───────────────────────────────────────────────────────

export const mcpDetachByDirRequest = z.object({
  dir: z.string().min(1),
  name: z.string().min(1),
});
export type McpDetachByDirRequest = z.infer<typeof mcpDetachByDirRequest>;

export const mcpDetachByDirResponse = z.object({ ok: z.boolean() });
export type McpDetachByDirResponse = z.infer<typeof mcpDetachByDirResponse>;

// ── skill/save ──────────────────────────────────────────────────────────────

export const skillSaveRequest = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    prompt: z.string().optional(),
    tags: z.array(z.string()).optional(),
    scope: z.enum(["builtin", "global", "project"]).optional(),
    yaml: z.string().optional(),
  })
  .loose();
export type SkillSaveRequest = z.infer<typeof skillSaveRequest>;

export const skillSaveResponse = z
  .object({
    ok: z.boolean(),
    name: z.string(),
    scope: z.string().optional(),
  })
  .loose();
export type SkillSaveResponse = z.infer<typeof skillSaveResponse>;

// ── skill/delete ────────────────────────────────────────────────────────────

export const skillDeleteRequest = z.object({
  name: z.string().min(1),
  scope: z.string().optional(),
});
export type SkillDeleteRequest = z.infer<typeof skillDeleteRequest>;

export const skillDeleteResponse = z.object({ ok: z.boolean() });
export type SkillDeleteResponse = z.infer<typeof skillDeleteResponse>;

// ── recipe/list ─────────────────────────────────────────────────────────────

const recipeDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    repo: z.string().optional(),
    flow: z.string(),
    agent: z.string().optional(),
    compute: z.string().optional(),
    group: z.string().optional(),
    variables: z.array(z.unknown()),
    parameters: z.array(z.unknown()).optional(),
    defaults: z.record(z.string(), z.string()).optional(),
    sub_recipes: z.array(z.unknown()).optional(),
    _source: z.enum(["builtin", "project", "global"]).optional(),
  })
  .loose();

export const recipeListRequest = z.object({}).loose();
export type RecipeListRequest = z.infer<typeof recipeListRequest>;

export const recipeListResponse = z.object({ recipes: z.array(recipeDefinitionSchema) });
export type RecipeListResponse = z.infer<typeof recipeListResponse>;

// ── recipe/delete ───────────────────────────────────────────────────────────

export const recipeDeleteRequest = z.object({
  name: z.string().min(1),
  scope: z.string().optional(),
});
export type RecipeDeleteRequest = z.infer<typeof recipeDeleteRequest>;

export const recipeDeleteResponse = z.object({ ok: z.boolean() });
export type RecipeDeleteResponse = z.infer<typeof recipeDeleteResponse>;

// ── runtime/list ────────────────────────────────────────────────────────────

const runtimeDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    type: z.string(),
    command: z.array(z.string()).optional(),
    task_delivery: z.enum(["stdin", "file", "arg"]).optional(),
    models: z.array(z.object({ id: z.string(), label: z.string() }).loose()).optional(),
    default_model: z.string().optional(),
    permission_mode: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    mcp_servers: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
    billing: z.record(z.string(), z.unknown()).optional(),
    secrets: z.array(z.string()).optional(),
    _source: z.enum(["builtin", "global", "project"]).optional(),
    _path: z.string().optional(),
  })
  .loose();

export const runtimeListRequest = z.object({}).loose();
export type RuntimeListRequest = z.infer<typeof runtimeListRequest>;

export const runtimeListResponse = z.object({ runtimes: z.array(runtimeDefinitionSchema) });
export type RuntimeListResponse = z.infer<typeof runtimeListResponse>;

// ── runtime/read ────────────────────────────────────────────────────────────

export const runtimeReadRequest = z.object({ name: z.string().min(1) });
export type RuntimeReadRequest = z.infer<typeof runtimeReadRequest>;

export const runtimeReadResponse = z.object({ runtime: runtimeDefinitionSchema });
export type RuntimeReadResponse = z.infer<typeof runtimeReadResponse>;

// ── agent/create ────────────────────────────────────────────────────────────

export const agentCreateRequest = z
  .object({
    name: z.string().min(1),
    yaml: z.string().optional(),
    scope: z.enum(["builtin", "global", "project"]).optional(),
  })
  .loose();
export type AgentCreateRequest = z.infer<typeof agentCreateRequest>;

export const agentCreateResponse = z
  .object({
    ok: z.boolean(),
    name: z.string(),
    scope: z.string().optional(),
  })
  .loose();
export type AgentCreateResponse = z.infer<typeof agentCreateResponse>;

// ── agent/update ────────────────────────────────────────────────────────────

export const agentUpdateRequest = agentCreateRequest;
export type AgentUpdateRequest = z.infer<typeof agentUpdateRequest>;

export const agentUpdateResponse = agentCreateResponse;
export type AgentUpdateResponse = z.infer<typeof agentUpdateResponse>;

// ── agent/delete ────────────────────────────────────────────────────────────

export const agentDeleteRequest = z.object({
  name: z.string().min(1),
  scope: z.string().optional(),
});
export type AgentDeleteRequest = z.infer<typeof agentDeleteRequest>;

export const agentDeleteResponse = z.object({ ok: z.boolean() });
export type AgentDeleteResponse = z.infer<typeof agentDeleteResponse>;

// ── flow/create ─────────────────────────────────────────────────────────────

export const flowCreateRequest = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    stages: z.array(stageDefinitionSchema),
    scope: z.enum(["global", "project"]).optional(),
  })
  .loose();
export type FlowCreateRequest = z.infer<typeof flowCreateRequest>;

export const flowCreateResponse = z.object({ ok: z.boolean(), name: z.string() });
export type FlowCreateResponse = z.infer<typeof flowCreateResponse>;

// ── flow/delete ─────────────────────────────────────────────────────────────

export const flowDeleteRequest = z.object({
  name: z.string().min(1),
  scope: z.string().optional(),
});
export type FlowDeleteRequest = z.infer<typeof flowDeleteRequest>;

export const flowDeleteResponse = z.object({ ok: z.boolean() });
export type FlowDeleteResponse = z.infer<typeof flowDeleteResponse>;

// ── worktree/list ───────────────────────────────────────────────────────────

export const worktreeListRequest = z.object({}).loose();
export type WorktreeListRequest = z.infer<typeof worktreeListRequest>;

// The handler returns a filtered slice of sessions (those with workdir+branch).
export const worktreeListResponse = z.object({ worktrees: z.array(sessionSchema) });
export type WorktreeListResponse = z.infer<typeof worktreeListResponse>;

// ── worktree/diff ───────────────────────────────────────────────────────────

export const worktreeDiffRequest = z.object({
  sessionId: z.string().min(1),
  base: z.string().optional(),
});
export type WorktreeDiffRequest = z.infer<typeof worktreeDiffRequest>;

// Shape of worktreeDiff varies across backends; accept any object.
export const worktreeDiffResponse = z.record(z.string(), z.unknown());
export type WorktreeDiffResponse = z.infer<typeof worktreeDiffResponse>;

// ── worktree/finish ─────────────────────────────────────────────────────────

export const worktreeFinishRequest = z
  .object({
    sessionId: z.string().min(1),
    noMerge: z.boolean().optional(),
    createPR: z.boolean().optional(),
    into: z.string().optional(),
    keepBranch: z.boolean().optional(),
  })
  .loose();
export type WorktreeFinishRequest = z.infer<typeof worktreeFinishRequest>;

export const worktreeFinishResponse = sessionOpResult;
export type WorktreeFinishResponse = z.infer<typeof worktreeFinishResponse>;

// ── worktree/create-pr ──────────────────────────────────────────────────────

export const worktreeCreatePrRequest = z
  .object({
    sessionId: z.string().min(1),
    title: z.string().optional(),
    body: z.string().optional(),
    base: z.string().optional(),
    draft: z.boolean().optional(),
  })
  .loose();
export type WorktreeCreatePrRequest = z.infer<typeof worktreeCreatePrRequest>;

export const worktreeCreatePrResponse = z
  .object({
    ok: z.boolean(),
    message: z.string().optional(),
    sessionId: z.string().optional(),
    pr_url: z.string().optional(),
  })
  .loose();
export type WorktreeCreatePrResponse = z.infer<typeof worktreeCreatePrResponse>;

// ── worktree/cleanup ────────────────────────────────────────────────────────

export const worktreeCleanupRequest = z.object({}).loose();
export type WorktreeCleanupRequest = z.infer<typeof worktreeCleanupRequest>;

export const worktreeCleanupResponse = z.object({ ok: z.boolean() }).loose();
export type WorktreeCleanupResponse = z.infer<typeof worktreeCleanupResponse>;

// ── learning/list ───────────────────────────────────────────────────────────

const learningEntrySchema = z
  .object({
    title: z.string(),
    description: z.string(),
    recurrence: z.number(),
    lastSeen: z.string(),
  })
  .loose();

export const learningListRequest = z.object({}).loose();
export type LearningListRequest = z.infer<typeof learningListRequest>;

export const learningListResponse = z.object({ learnings: z.array(learningEntrySchema) });
export type LearningListResponse = z.infer<typeof learningListResponse>;

// ── learning/add ────────────────────────────────────────────────────────────

export const learningAddRequest = z.object({
  title: z.string().min(1),
  description: z.string(),
});
export type LearningAddRequest = z.infer<typeof learningAddRequest>;

export const learningAddResponse = z
  .object({
    ok: z.boolean(),
    learning: learningEntrySchema,
    promoted: z.boolean(),
  })
  .loose();
export type LearningAddResponse = z.infer<typeof learningAddResponse>;

// ── memory/list ─────────────────────────────────────────────────────────────

const memoryEntrySchema = z
  .object({
    id: z.string(),
    content: z.string(),
    tags: z.array(z.string()),
    scope: z.string(),
    importance: z.number(),
    createdAt: z.string(),
    accessedAt: z.string(),
    accessCount: z.number(),
  })
  .loose();

export const memoryListRequest = z.object({ scope: z.string().optional() }).loose();
export type MemoryListRequest = z.infer<typeof memoryListRequest>;

export const memoryListResponse = z.object({ memories: z.array(memoryEntrySchema) });
export type MemoryListResponse = z.infer<typeof memoryListResponse>;

// ── memory/recall ───────────────────────────────────────────────────────────

export const memoryRecallRequest = z.object({
  query: z.string(),
  scope: z.string().optional(),
  limit: z.number().optional(),
});
export type MemoryRecallRequest = z.infer<typeof memoryRecallRequest>;

export const memoryRecallResponse = z.object({ results: z.array(memoryEntrySchema) });
export type MemoryRecallResponse = z.infer<typeof memoryRecallResponse>;

// ── memory/add ──────────────────────────────────────────────────────────────

export const memoryAddRequest = z
  .object({
    content: z.string(),
    tags: z.array(z.string()).optional(),
    scope: z.string().optional(),
    importance: z.number().optional(),
  })
  .loose();
export type MemoryAddRequest = z.infer<typeof memoryAddRequest>;

export const memoryAddResponse = z.object({ memory: memoryEntrySchema });
export type MemoryAddResponse = z.infer<typeof memoryAddResponse>;

// ── memory/forget ───────────────────────────────────────────────────────────

export const memoryForgetRequest = z.object({ id: z.string().min(1) });
export type MemoryForgetRequest = z.infer<typeof memoryForgetRequest>;

export const memoryForgetResponse = z.object({ ok: z.boolean() });
export type MemoryForgetResponse = z.infer<typeof memoryForgetResponse>;

// ── knowledge/ingest ────────────────────────────────────────────────────────

export const knowledgeIngestRequest = z
  .object({
    path: z.string().min(1),
    directory: z.boolean().optional(),
    scope: z.string().optional(),
    tags: z.array(z.string()).optional(),
    recursive: z.boolean().optional(),
  })
  .loose();
export type KnowledgeIngestRequest = z.infer<typeof knowledgeIngestRequest>;

export const knowledgeIngestResponse = z
  .object({
    ok: z.boolean(),
    files: z.number().optional(),
    chunks: z.number().optional(),
    error: z.string().optional(),
  })
  .loose();
export type KnowledgeIngestResponse = z.infer<typeof knowledgeIngestResponse>;

// ── knowledge/search ────────────────────────────────────────────────────────

const knowledgeNodeSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    label: z.string(),
    content: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .loose();

export const knowledgeSearchRequest = z
  .object({
    query: z.string(),
    types: z.array(z.string()).optional(),
    limit: z.number().optional(),
  })
  .loose();
export type KnowledgeSearchRequest = z.infer<typeof knowledgeSearchRequest>;

export const knowledgeSearchResponse = z.object({ results: z.array(knowledgeNodeSchema) });
export type KnowledgeSearchResponse = z.infer<typeof knowledgeSearchResponse>;

// ── knowledge/index ─────────────────────────────────────────────────────────

export const knowledgeIndexRequest = z.object({ repo: z.string().optional() }).loose();
export type KnowledgeIndexRequest = z.infer<typeof knowledgeIndexRequest>;

export const knowledgeIndexResponse = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
  })
  .loose();
export type KnowledgeIndexResponse = z.infer<typeof knowledgeIndexResponse>;

// ── knowledge/export ────────────────────────────────────────────────────────

export const knowledgeExportRequest = z.object({ dir: z.string().optional() }).loose();
export type KnowledgeExportRequest = z.infer<typeof knowledgeExportRequest>;

export const knowledgeExportResponse = z.object({ ok: z.boolean() }).loose();
export type KnowledgeExportResponse = z.infer<typeof knowledgeExportResponse>;

// ── knowledge/import ────────────────────────────────────────────────────────

export const knowledgeImportRequest = z.object({ dir: z.string().optional() }).loose();
export type KnowledgeImportRequest = z.infer<typeof knowledgeImportRequest>;

export const knowledgeImportResponse = z.object({ ok: z.boolean() }).loose();
export type KnowledgeImportResponse = z.infer<typeof knowledgeImportResponse>;

// ── schedule/delete ─────────────────────────────────────────────────────────

export const scheduleDeleteRequest = z.object({ id: z.string().min(1) });
export type ScheduleDeleteRequest = z.infer<typeof scheduleDeleteRequest>;

export const scheduleDeleteResponse = z.object({ ok: z.boolean() });
export type ScheduleDeleteResponse = z.infer<typeof scheduleDeleteResponse>;

// ── schedule/enable ─────────────────────────────────────────────────────────

export const scheduleEnableRequest = z.object({ id: z.string().min(1) });
export type ScheduleEnableRequest = z.infer<typeof scheduleEnableRequest>;

export const scheduleEnableResponse = z.object({ ok: z.boolean() });
export type ScheduleEnableResponse = z.infer<typeof scheduleEnableResponse>;

// ── schedule/disable ────────────────────────────────────────────────────────

export const scheduleDisableRequest = z.object({ id: z.string().min(1) });
export type ScheduleDisableRequest = z.infer<typeof scheduleDisableRequest>;

export const scheduleDisableResponse = z.object({ ok: z.boolean() });
export type ScheduleDisableResponse = z.infer<typeof scheduleDisableResponse>;

// ── compute/provision ───────────────────────────────────────────────────────

export const computeProvisionRequest = z.object({ name: z.string().min(1) });
export type ComputeProvisionRequest = z.infer<typeof computeProvisionRequest>;

export const computeProvisionResponse = z
  .object({
    ok: z.boolean(),
    name: z.string().optional(),
    cloned_from: z.string().optional(),
    status: z.string().optional(),
  })
  .loose();
export type ComputeProvisionResponse = z.infer<typeof computeProvisionResponse>;

// ── compute/start-instance ──────────────────────────────────────────────────

export const computeStartInstanceRequest = z.object({ name: z.string().min(1) });
export type ComputeStartInstanceRequest = z.infer<typeof computeStartInstanceRequest>;

export const computeStartInstanceResponse = z.object({ ok: z.boolean() }).loose();
export type ComputeStartInstanceResponse = z.infer<typeof computeStartInstanceResponse>;

// ── compute/stop-instance ───────────────────────────────────────────────────

export const computeStopInstanceRequest = z.object({ name: z.string().min(1) });
export type ComputeStopInstanceRequest = z.infer<typeof computeStopInstanceRequest>;

export const computeStopInstanceResponse = z.object({ ok: z.boolean(), status: z.string().optional() }).loose();
export type ComputeStopInstanceResponse = z.infer<typeof computeStopInstanceResponse>;

// ── compute/destroy ─────────────────────────────────────────────────────────

export const computeDestroyRequest = z.object({ name: z.string().min(1) });
export type ComputeDestroyRequest = z.infer<typeof computeDestroyRequest>;

export const computeDestroyResponse = z.object({ ok: z.boolean() }).loose();
export type ComputeDestroyResponse = z.infer<typeof computeDestroyResponse>;

// ── metrics/snapshot ────────────────────────────────────────────────────────

export const metricsSnapshotRequest = z.object({ computeName: z.string().optional() }).loose();
export type MetricsSnapshotRequest = z.infer<typeof metricsSnapshotRequest>;

export const metricsSnapshotResponse = z.object({ snapshot: z.unknown().nullable() });
export type MetricsSnapshotResponse = z.infer<typeof metricsSnapshotResponse>;

// ── compute/kill-process ────────────────────────────────────────────────────

export const computeKillProcessRequest = z.object({ pid: z.union([z.string(), z.number()]) });
export type ComputeKillProcessRequest = z.infer<typeof computeKillProcessRequest>;

export const computeKillProcessResponse = z.object({ ok: z.boolean() });
export type ComputeKillProcessResponse = z.infer<typeof computeKillProcessResponse>;

// ── compute/docker-logs ─────────────────────────────────────────────────────

export const computeDockerLogsRequest = z.object({
  container: z.string().min(1),
  tail: z.number().optional(),
});
export type ComputeDockerLogsRequest = z.infer<typeof computeDockerLogsRequest>;

export const computeDockerLogsResponse = z.object({ logs: z.string() });
export type ComputeDockerLogsResponse = z.infer<typeof computeDockerLogsResponse>;

// ── compute/docker-action ───────────────────────────────────────────────────

export const computeDockerActionRequest = z.object({
  container: z.string().min(1),
  action: z.enum(["stop", "restart"]),
});
export type ComputeDockerActionRequest = z.infer<typeof computeDockerActionRequest>;

export const computeDockerActionResponse = z.object({ ok: z.boolean() });
export type ComputeDockerActionResponse = z.infer<typeof computeDockerActionResponse>;

// ── compute/template/list ───────────────────────────────────────────────────

const computeTemplateSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable().optional(),
    provider: z.string(),
    /** New two-axis (compute, runtime) pair derived from `provider`. */
    compute: z.string().optional(),
    runtime: z.string().optional(),
    config: z.unknown().optional(),
  })
  .loose();

export const computeTemplateListRequest = z.object({}).loose();
export type ComputeTemplateListRequest = z.infer<typeof computeTemplateListRequest>;

export const computeTemplateListResponse = z.object({ templates: z.array(computeTemplateSchema) });
export type ComputeTemplateListResponse = z.infer<typeof computeTemplateListResponse>;

// ── repo-map/get ────────────────────────────────────────────────────────────

export const repoMapGetRequest = z.object({ dir: z.string().optional() }).loose();
export type RepoMapGetRequest = z.infer<typeof repoMapGetRequest>;

// repoMap.generate returns an opaque shape -- accept any object.
export const repoMapGetResponse = z.record(z.string(), z.unknown());
export type RepoMapGetResponse = z.infer<typeof repoMapGetResponse>;

// ── fs/list-dir ─────────────────────────────────────────────────────────────

const fsEntrySchema = z
  .object({
    name: z.string(),
    path: z.string(),
    isGitRepo: z.boolean().optional(),
  })
  .loose();

export const fsListDirRequest = z.object({ path: z.string().optional() }).loose();
export type FsListDirRequest = z.infer<typeof fsListDirRequest>;

export const fsListDirResponse = z
  .object({
    cwd: z.string(),
    parent: z.string().nullable(),
    home: z.string(),
    entries: z.array(fsEntrySchema),
  })
  .loose();
export type FsListDirResponse = z.infer<typeof fsListDirResponse>;

// ── Registry ────────────────────────────────────────────────────────────────

/**
 * Method name -> (requestSchema, responseSchema) lookup.
 *
 * The server's validation middleware uses this to parse `params` on inbound
 * requests. Methods not present here fall through to the legacy `extract<T>`
 * path and are not validated.
 */
export interface RpcMethodSchemas {
  request: z.ZodType<unknown>;
  response: z.ZodType<unknown>;
}

export const rpcMethodSchemas: Record<string, RpcMethodSchemas> = {
  "session/start": { request: sessionStartRequest, response: sessionStartResponse },
  "input/upload": { request: inputUploadRequest, response: inputUploadResponse },
  "input/read": { request: inputReadRequest, response: inputReadResponse },
  "session/read": { request: sessionReadRequest, response: sessionReadResponse },
  "session/list": { request: sessionListRequest, response: sessionListResponse },
  "session/delete": { request: sessionDeleteRequest, response: sessionDeleteResponse },
  "session/undelete": { request: sessionUndeleteRequest, response: sessionUndeleteResponse },
  "session/fork": { request: sessionForkRequest, response: sessionForkResponse },
  "session/stop": { request: sessionStopRequest, response: sessionStopResponse },
  "session/advance": { request: sessionAdvanceRequest, response: sessionAdvanceResponse },
  "session/archive": { request: sessionArchiveRequest, response: sessionArchiveResponse },
  "session/restore": { request: sessionRestoreRequest, response: sessionRestoreResponse },
  "session/attach-command": { request: sessionAttachCommandRequest, response: sessionAttachCommandResponse },
  "compute/list": { request: computeListRequest, response: computeListResponse },
  "compute/create": { request: computeCreateRequest, response: computeCreateResponse },
  "compute/read": { request: computeReadRequest, response: computeReadResponse },
  "compute/capabilities": { request: computeCapabilitiesRequest, response: computeCapabilitiesResponse },
  "flow/list": { request: flowListRequest, response: flowListResponse },
  "flow/read": { request: flowReadRequest, response: flowReadResponse },
  "agent/list": { request: agentListRequest, response: agentListResponse },
  "skill/list": { request: skillListRequest, response: skillListResponse },
  "schedule/list": { request: scheduleListRequest, response: scheduleListResponse },
  "schedule/create": { request: scheduleCreateRequest, response: scheduleCreateResponse },
  "costs/read": { request: costsReadRequest, response: costsReadResponse },
  "dashboard/summary": { request: dashboardSummaryRequest, response: dashboardSummaryResponse },
  "todo/add": { request: todoAddRequest, response: todoAddResponse },
  "todo/toggle": { request: todoToggleRequest, response: todoToggleResponse },
  "todo/list": { request: todoListRequest, response: todoListResponse },
  "todo/delete": { request: todoDeleteRequest, response: todoDeleteResponse },
  "verify/run": { request: verifyRunRequest, response: verifyRunResponse },
  "knowledge/stats": { request: knowledgeStatsRequest, response: knowledgeStatsResponse },
  "session/output": { request: sessionOutputRequest, response: sessionOutputResponse },
  "session/recording": { request: sessionRecordingRequest, response: sessionRecordingResponse },
  "session/events": { request: sessionEventsRequest, response: sessionEventsResponse },
  "session/messages": { request: sessionMessagesRequest, response: sessionMessagesResponse },
  "session/export-data": { request: sessionExportDataRequest, response: sessionExportDataResponse },
  "session/import": { request: sessionImportRequest, response: sessionImportResponse },
  "session/resume": { request: sessionResumeRequest, response: sessionResumeResponse },
  "session/clone": { request: sessionCloneRequest, response: sessionCloneResponse },
  "session/pause": { request: sessionPauseRequest, response: sessionPauseResponse },
  "session/interrupt": { request: sessionInterruptRequest, response: sessionInterruptResponse },
  "session/kill": { request: sessionKillRequest, response: sessionKillResponse },
  "session/complete": { request: sessionCompleteRequest, response: sessionCompleteResponse },
  "session/spawn": { request: sessionSpawnRequest, response: sessionSpawnResponse },
  "session/unread-counts": { request: sessionUnreadCountsRequest, response: sessionUnreadCountsResponse },
  "session/conversation": { request: sessionConversationRequest, response: sessionConversationResponse },
  "message/send": { request: messageSendRequest, response: messageSendResponse },
  "message/markRead": { request: messageMarkReadRequest, response: messageMarkReadResponse },
  "gate/approve": { request: gateApproveRequest, response: gateApproveResponse },
  "gate/reject": { request: gateRejectRequest, response: gateRejectResponse },
  "costs/session": { request: costsSessionRequest, response: costsSessionResponse },
  "cost/export": { request: costExportRequest, response: costExportResponse },
  "search/sessions": { request: searchSessionsRequest, response: searchSessionsResponse },
  "search/global": { request: searchGlobalRequest, response: searchGlobalResponse },
  "history/list": { request: historyListRequest, response: historyListResponse },
  "history/refresh-and-index": { request: historyRefreshAndIndexRequest, response: historyRefreshAndIndexResponse },
  "history/rebuild-fts": { request: historyRebuildFtsRequest, response: historyRebuildFtsResponse },
  "status/get": { request: statusGetRequest, response: statusGetResponse },
  "daemon/status": { request: daemonStatusRequest, response: daemonStatusResponse },
  "group/list": { request: groupListRequest, response: groupListResponse },
  "config/get": { request: configGetRequest, response: configGetResponse },
  "profile/list": { request: profileListRequest, response: profileListResponse },
  "profile/create": { request: profileCreateRequest, response: profileCreateResponse },
  "profile/delete": { request: profileDeleteRequest, response: profileDeleteResponse },
  "tools/list": { request: toolsListRequest, response: toolsListResponse },
  "mcp/attach-by-dir": { request: mcpAttachByDirRequest, response: mcpAttachByDirResponse },
  "mcp/detach-by-dir": { request: mcpDetachByDirRequest, response: mcpDetachByDirResponse },
  "skill/save": { request: skillSaveRequest, response: skillSaveResponse },
  "skill/delete": { request: skillDeleteRequest, response: skillDeleteResponse },
  "recipe/list": { request: recipeListRequest, response: recipeListResponse },
  "recipe/delete": { request: recipeDeleteRequest, response: recipeDeleteResponse },
  "runtime/list": { request: runtimeListRequest, response: runtimeListResponse },
  "runtime/read": { request: runtimeReadRequest, response: runtimeReadResponse },
  "agent/create": { request: agentCreateRequest, response: agentCreateResponse },
  "agent/update": { request: agentUpdateRequest, response: agentUpdateResponse },
  "agent/delete": { request: agentDeleteRequest, response: agentDeleteResponse },
  "flow/create": { request: flowCreateRequest, response: flowCreateResponse },
  "flow/delete": { request: flowDeleteRequest, response: flowDeleteResponse },
  "worktree/list": { request: worktreeListRequest, response: worktreeListResponse },
  "worktree/diff": { request: worktreeDiffRequest, response: worktreeDiffResponse },
  "worktree/finish": { request: worktreeFinishRequest, response: worktreeFinishResponse },
  "worktree/create-pr": { request: worktreeCreatePrRequest, response: worktreeCreatePrResponse },
  "worktree/cleanup": { request: worktreeCleanupRequest, response: worktreeCleanupResponse },
  "learning/list": { request: learningListRequest, response: learningListResponse },
  "learning/add": { request: learningAddRequest, response: learningAddResponse },
  "memory/list": { request: memoryListRequest, response: memoryListResponse },
  "memory/recall": { request: memoryRecallRequest, response: memoryRecallResponse },
  "memory/add": { request: memoryAddRequest, response: memoryAddResponse },
  "memory/forget": { request: memoryForgetRequest, response: memoryForgetResponse },
  "knowledge/ingest": { request: knowledgeIngestRequest, response: knowledgeIngestResponse },
  "knowledge/search": { request: knowledgeSearchRequest, response: knowledgeSearchResponse },
  "knowledge/index": { request: knowledgeIndexRequest, response: knowledgeIndexResponse },
  "knowledge/export": { request: knowledgeExportRequest, response: knowledgeExportResponse },
  "knowledge/import": { request: knowledgeImportRequest, response: knowledgeImportResponse },
  "schedule/delete": { request: scheduleDeleteRequest, response: scheduleDeleteResponse },
  "schedule/enable": { request: scheduleEnableRequest, response: scheduleEnableResponse },
  "schedule/disable": { request: scheduleDisableRequest, response: scheduleDisableResponse },
  "compute/provision": { request: computeProvisionRequest, response: computeProvisionResponse },
  "compute/start-instance": { request: computeStartInstanceRequest, response: computeStartInstanceResponse },
  "compute/stop-instance": { request: computeStopInstanceRequest, response: computeStopInstanceResponse },
  "compute/destroy": { request: computeDestroyRequest, response: computeDestroyResponse },
  "metrics/snapshot": { request: metricsSnapshotRequest, response: metricsSnapshotResponse },
  "compute/kill-process": { request: computeKillProcessRequest, response: computeKillProcessResponse },
  "compute/docker-logs": { request: computeDockerLogsRequest, response: computeDockerLogsResponse },
  "compute/docker-action": { request: computeDockerActionRequest, response: computeDockerActionResponse },
  "compute/template/list": { request: computeTemplateListRequest, response: computeTemplateListResponse },
  "repo-map/get": { request: repoMapGetRequest, response: repoMapGetResponse },
  "fs/list-dir": { request: fsListDirRequest, response: fsListDirResponse },
};

/** List of method names covered by Zod validation. */
export const COVERED_METHODS = Object.keys(rpcMethodSchemas) as ReadonlyArray<string>;
