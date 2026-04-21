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
export const sessionInputsSchema = z.object({
  files: z.record(z.string(), z.string()).optional(),
  params: z.record(z.string(), z.string()).optional(),
});
export type SessionInputs = z.infer<typeof sessionInputsSchema>;

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
  "compute/list": { request: computeListRequest, response: computeListResponse },
  "compute/create": { request: computeCreateRequest, response: computeCreateResponse },
  "compute/read": { request: computeReadRequest, response: computeReadResponse },
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
  "knowledge/stats": { request: knowledgeStatsRequest, response: knowledgeStatsResponse },
};

/** List of method names covered by Zod validation. */
export const COVERED_METHODS = Object.keys(rpcMethodSchemas) as ReadonlyArray<string>;
