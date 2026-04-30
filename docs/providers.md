# Providers Reference

Ark has three kinds of providers, all polymorphic and resolved at runtime via the Awilix DI container on `AppContext`:

- **Compute providers** -- where agents run. 11 implementations across 4 isolation modes.
- **LLM providers** -- which API answers agent requests. 3 adapters (Anthropic, OpenAI, Google) inside `packages/router/`, plus an optional TensorZero gateway backend.
- **Transcript parsers** -- how usage data is extracted per runtime tool. 3 implementations (`claude`, `codex`, `gemini`) behind a polymorphic registry.

Each category has its own registry and is wired at boot. New providers are added by implementing the interface, registering at boot, and referencing the name from a YAML config.

---

## 1. Overview

| Kind | Registry | Interface | Where |
|------|----------|-----------|-------|
| Compute | `AppContext.providers` (map by name) | `ComputeProvider` | `packages/compute/providers/` |
| LLM | Router config (per-provider `Provider`) | `Provider` class | `packages/router/providers.ts` |
| Transcript parser | `AppContext.transcriptParsers` (`TranscriptParserRegistry`) | `TranscriptParser` | `packages/core/runtimes/<name>/parser.ts` |

Compute providers are resolved for a session via `session.compute` (a compute name), which points to a row in the `compute` table, which carries a `provider` field. LLM providers are resolved per-request inside the router based on model name and routing policy. Transcript parsers are resolved per-session by the `billing.transcript_parser` field on the runtime YAML.

---

## 2. Compute Providers

Ark ships 11 compute provider implementations. They split into 4 categories by where and how the agent process runs.

All providers implement the `ComputeProvider` interface in `packages/compute/types.ts`, which has these key methods:

- `provision(compute, opts)` -- stand up the compute (no-op for local)
- `destroy(compute)` -- tear it down
- `start(compute)` / `stop(compute)` -- lifecycle for stoppable providers
- `launch(compute, session, opts)` -- start an agent inside the compute
- `killAgent(compute, session)` -- kill the agent process
- `cleanupSession(compute, session)` -- remove worktree/container after session ends
- `getMetrics(compute)` -- cpu/mem/disk snapshot
- `syncEnvironment(compute, opts)` -- push `.claude/commands/`, `.claude/skills/`, `CLAUDE.md` to remote
- `buildChannelConfig(sessionId, stage, channelPort, opts)` -- MCP channel config for this provider

Providers that use arkd extend `ArkdBackedProvider` (in `packages/compute/providers/arkd-backed.ts`), which gives them shared HTTP-to-arkd plumbing and makes `getClient(compute)` return an `ArkdClient`.

### 2.1 Local Worktree Only

#### `local`

- **Class:** `LocalProvider` (legacy, `packages/compute/providers/local/index.ts`) and `LocalWorktreeProvider` (arkd-backed, `packages/compute/providers/local-arkd.ts`)
- **Isolation:** none -- git worktree on the host filesystem
- **Startup:** instant (no provisioning)
- **Use case:** fast iteration on your own machine, quick fixes, local development
- **Prerequisites:** bun, tmux, git
- **ArkD involvement:** `LocalWorktreeProvider` talks to arkd on `http://localhost:19300`. `LocalProvider` is the original direct-tmux variant that still ships for backward compat.
- **Workdir:** `~/.ark/worktrees/<sessionId>/` (git worktree created from the repo's current branch)

Config:
```yaml
# ~/.ark/ or .ark/ compute YAML
name: my-local
provider: local
config:
  isolation: worktree   # or "inplace" to use the repo dir directly
```

CLI:
```bash
ark compute create --name my-local --provider local
ark session start --compute my-local --summary "Fix the bug" --dispatch
```

---

### 2.2 Local Isolated

These run on the host machine but isolate the agent in a container or VM. All extend `LocalArkdBase` and talk to arkd on `http://localhost:19300`.

#### `docker` (local)

- **Class:** `LocalDockerProvider` (arkd-backed, `packages/compute/providers/local-arkd.ts`) and `DockerProvider` (legacy standalone, `packages/compute/providers/docker/index.ts`)
- **Isolation:** container (shared kernel)
- **Startup:** seconds (image pull first time)
- **Use case:** you want container isolation without leaving your machine
- **Prerequisites:** Docker daemon running, pull access to the image
- **ArkD involvement:** arkd on localhost writes the launcher to `/tmp`, copies it into the container with `docker cp`, and execs `docker exec -i ark-<name> bash <script>` in a tmux pane
- **Workdir:** inside the container, volumes mount `~/.ssh` and `~/.claude` read-only

Config:
```yaml
name: my-docker
provider: docker
config:
  image: "ubuntu:22.04"
  volumes:
    - "/Users/me/extra:/extra:ro"
```

#### `devcontainer`

- **Class:** `LocalDevcontainerProvider` (`packages/compute/providers/local-arkd.ts`)
- **Isolation:** container (defined by the repo's `devcontainer.json`)
- **Startup:** first-time build, then cached
- **Use case:** the repo has a devcontainer and you want agents to run inside it exactly as a human would
- **Prerequisites:** `devcontainer` CLI, Docker, the repo has `.devcontainer/devcontainer.json`
- **ArkD involvement:** calls `devcontainer up --workspace-folder <path>` at provision, then `devcontainer exec --workspace-folder <path> -- bash <script>` at launch
- **Workdir:** whatever the devcontainer defines

Config:
```yaml
name: my-devc
provider: devcontainer
config:
  workdir: "/Users/me/code/my-project"
```

#### `firecracker` (local)

- **Class:** `LocalFirecrackerProvider` (`packages/compute/providers/local-arkd.ts`)
- **Isolation:** hardware (Firecracker micro-VM, KVM-backed)
- **Startup:** sub-second VM boot after initial image download
- **Use case:** maximum isolation without any cloud dependency, e.g. running untrusted code or reproducible sandboxes
- **Prerequisites:** Linux with `/dev/kvm` (nested virt on macOS does not work), kernel at `/opt/firecracker/vmlinux`, rootfs at `/opt/firecracker/rootfs.ext4`
- **ArkD involvement:** arkd starts the firecracker process, configures the VM via unix socket API, then launches the agent via `scp` + `ssh` into the VM
- **Workdir:** inside the micro-VM rootfs

Config:
```yaml
name: my-fc
provider: firecracker
config:
  kernel: "/opt/firecracker/vmlinux"
  rootfs: "/opt/firecracker/rootfs.ext4"
  vcpus: 2
  memMib: 512
  ssh_port: 2222
```

---

### 2.3 Remote via ArkD (EC2-backed)

All four remote providers extend `RemoteArkdBase` (in `packages/compute/providers/remote-arkd.ts`). They share EC2 provisioning via direct AWS SDK calls + cloud-init. Cloud-init installs bun, the ark CLI, and systemd-registers `arkd.service` listening on port 19300.

**SSH transport runs over AWS SSM Session Manager.** The conductor connects with `ssh -o ProxyCommand="aws ssm start-session ..." ubuntu@<instance-id>` -- no public IP is allocated, no security-group ingress rule is required, and the only outbound traffic from the instance is HTTPS to the SSM endpoint. As a consequence:

- Provisioned instances have an IAM instance profile attached carrying `AmazonSSMManagedInstanceCore`. The default profile name is `ArkEC2SsmInstanceProfile`; override per-call via the `iamInstanceProfile` opt or globally via the `ARK_EC2_INSTANCE_PROFILE` env var. **Pre-create this profile in your AWS account before first use** (Ark does not create it for you).
- Security groups created by Ark have NO ingress rules.
- The instance address is the EC2 instance_id; `compute.config.instance_id` is the canonical field for the SSH transport. The `ip` field is retained only for back-compat reading (e.g. the optional codegraph HTTP path).

Common config:
```yaml
config:
  size: "m"                    # xs|s|m|l|xl|2xl
  arch: "x64"                  # x64 | arm64
  region: "us-east-1"
  aws_profile: "default"
  subnet_id: "subnet-abc123"   # optional
  sg_id: "sg-abc123"           # optional
  idle_minutes: 60             # auto-stop after idle
  tags:
    team: "platform"
  ingress_cidrs:
    - "203.0.113.0/24"
```

All four need AWS credentials in the environment or via `aws_profile`. Provisioning uses the AWS SDK directly -- no extra binaries are required.

#### `ec2`

- **Class:** `RemoteWorktreeProvider` (`packages/compute/providers/remote-arkd.ts`)
- **Isolation:** single EC2 instance, agent runs in a bare worktree on the instance
- **Use case:** beefier hardware than your laptop, long-running sessions, shared dev box
- **ArkD involvement:** cloud-init installs arkd as a systemd unit, conductor connects to `http://<instance-ip>:19300`. Launch `git clone`s the repo into `~/Projects/<repo>` and runs the launcher in a tmux session.
- **Workdir:** `/home/ubuntu/Projects/<repo>`

```yaml
name: my-ec2
provider: ec2
config:
  size: "l"
  region: "us-east-1"
```

#### `ec2-docker`

- **Class:** `RemoteDockerProvider`
- **Isolation:** Docker container on an EC2 instance (the instance runs arkd + Docker, each session runs in a container)
- **Use case:** shared EC2 fleet where many sessions share the host but each is containerized
- **Post-provision:** pulls the configured image and pre-creates the container
- **Workdir:** inside the container on EC2

```yaml
name: my-ec2-docker
provider: ec2-docker
config:
  size: "l"
  image: "ubuntu:22.04"
```

#### `ec2-devcontainer`

- **Class:** `RemoteDevcontainerProvider`
- **Isolation:** devcontainer on an EC2 instance
- **Post-provision:** runs `devcontainer up` on the remote host
- **Use case:** reproduce the repo's devcontainer on bigger hardware

```yaml
name: my-ec2-devc
provider: ec2-devcontainer
config:
  size: "l"
  devcontainer_workdir: "/home/ubuntu/Projects/workspace"
```

#### `ec2-firecracker`

- **Class:** `RemoteFirecrackerProvider`
- **Isolation:** firecracker micro-VM on an EC2 instance (hardware isolation per session)
- **Post-provision:** downloads the firecracker binary, kernel, and rootfs onto the host
- **Use case:** per-session hardware isolation with cloud elasticity
- **Workdir:** inside the per-session micro-VM

```yaml
name: my-ec2-fc
provider: ec2-firecracker
config:
  size: "xl"       # firecracker needs meaningful CPU/RAM
  arch: "x64"
```

---

### 2.4 Managed / Cluster

#### `e2b`

- **Class:** `E2BProvider` (`packages/compute/providers/e2b.ts`)
- **Isolation:** managed Firecracker micro-VM (E2B is a third-party sandbox service)
- **Startup:** sub-second (E2B's specialty)
- **Use case:** you want hardware isolation with zero infra to manage, or you already use E2B
- **Prerequisites:** `E2B_API_KEY` env var, `e2b` npm SDK installed
- **ArkD involvement:** none -- E2B's own sandbox protocol is used. Channel reports go directly to the conductor URL baked into the launcher.
- **Workdir:** inside the E2B sandbox

```yaml
name: my-e2b
provider: e2b
config:
  template: "base"        # E2B sandbox template
  timeout: 3600           # seconds
```

Set `E2B_API_KEY` in your environment or put it in `config.apiKey`.

#### `k8s`

- **Class:** `K8sProvider` (`packages/compute/providers/k8s.ts`)
- **Isolation:** Kubernetes pod (shared kernel)
- **Startup:** pod scheduling time
- **Use case:** you already run K8s and want agents as pods scheduled by the cluster
- **Prerequisites:** kubeconfig (in-cluster service account or `~/.kube/config`), `@kubernetes/client-node` npm package
- **ArkD involvement:** optional -- if arkd is baked into the image and runs as a sidecar container, the channel relay works the normal way. Otherwise the launcher uses the OpenAI-compatible endpoint baked into the env.
- **Workdir:** inside the pod

```yaml
name: my-k8s
provider: k8s
config:
  namespace: "ark"
  image: "ghcr.io/my-org/ark-agent:latest"
  kubeconfig: "/home/me/.kube/config"
  serviceAccount: "ark-agent"
  resources:
    cpu: "2"
    memory: "4Gi"
```

Attach command: `kubectl exec -it -n ark ark-<sessionId> -- /bin/bash`.

#### `k8s-kata`

- **Class:** `KataProvider extends K8sProvider`
- **Isolation:** Kata Containers with `runtimeClassName: kata-fc` (Firecracker VM per pod)
- **Use case:** K8s cluster where you want hardware isolation for agents (multi-tenant control plane)
- **Prerequisites:** Kata Containers installed on the cluster, `RuntimeClass` named `kata-fc` registered
- **Workdir:** inside the kata VM's pod

```yaml
name: my-kata
provider: k8s-kata
config:
  namespace: "ark"
  image: "ghcr.io/my-org/ark-agent:latest"
  runtimeClassName: "kata-fc"    # default
  resources:
    cpu: "2"
    memory: "4Gi"
```

---

### 2.5 Comparison Table

| Provider | Isolation | Startup | Cost | Use case |
|----------|-----------|---------|------|----------|
| `local` | none (worktree) | instant | free | Fastest iteration on your own machine |
| `docker` | container (shared kernel) | seconds | free | Local container isolation |
| `devcontainer` | container (repo-defined) | first build | free | Use the repo's devcontainer locally |
| `firecracker` | hardware VM | sub-second | free | Maximum local isolation, Linux only |
| `ec2` | EC2 instance only | minutes | EC2 hourly | Bigger hardware, shared dev box |
| `ec2-docker` | container on EC2 | minutes | EC2 hourly | Containerized sessions on shared EC2 |
| `ec2-devcontainer` | devcontainer on EC2 | minutes | EC2 hourly | Reproduce repo devcontainer remotely |
| `ec2-firecracker` | microVM on EC2 | minutes | EC2 hourly | Per-session hardware isolation with cloud elasticity |
| `e2b` | managed microVM | sub-second | per-run | Zero-infra sandbox |
| `k8s` | pod | seconds | cluster cost | Scale on an existing K8s cluster |
| `k8s-kata` | Kata microVM | seconds | cluster cost | K8s with hardware isolation (multi-tenant) |

---

## 3. LLM Providers (Router Adapters)

The LLM Router (`packages/router/`) is an OpenAI-compatible HTTP proxy that routes chat completion requests to one of several providers based on policy. Each provider adapts its native API format to an OpenAI-compatible envelope.

- **File:** `packages/router/providers.ts`
- **Class:** `Provider`
- **Dispatch:** switch on `config.name` (`anthropic`, `openai`, `google`) inside `complete()` and `stream()`
- **Circuit breakers:** per provider, 5 failures within the window opens the breaker for 30 seconds, then half-open on next attempt. Stateless inside the Router process.

### 3.1 Anthropic

- **API:** `POST {base_url}/v1/messages` (Messages API)
- **Headers:** `x-api-key`, `anthropic-version: 2023-06-01`, `content-type`
- **Default `base_url`:** `https://api.anthropic.com`
- **Auth:** `ANTHROPIC_API_KEY` env var (or `config.api_key`)
- **Default models exposed:**
  - `claude-opus-4-6`
  - `claude-sonnet-4-6`
  - `claude-haiku-4-5`
- **Request conversion:** OpenAI `messages[]` -> Anthropic `messages[]` + top-level `system`. `tool_calls` in assistant messages become `tool_use` blocks. `tool` role messages become `tool_result` blocks inside a user message.
- **Response conversion:** Anthropic `content[]` (text + tool_use blocks) -> OpenAI `choices[0].message.content` + `tool_calls`. `stop_reason` -> `finish_reason` (`end_turn` -> `stop`, `tool_use` -> `tool_calls`, `max_tokens` -> `length`).
- **Streaming:** Anthropic SSE events (`content_block_delta`, `message_delta`) converted to OpenAI `chat.completion.chunk` format.

Config in `~/.ark/config.yaml`:
```yaml
router:
  enabled: true
  url: "http://localhost:8430"
  policy: balanced
  auto_start: true
```

The router picks up `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` from env at startup.

### 3.2 OpenAI

- **API:** `POST {base_url}/v1/chat/completions` (passthrough, this is the canonical format)
- **Headers:** `Authorization: Bearer <api_key>`
- **Default `base_url`:** `https://api.openai.com`
- **Auth:** `OPENAI_API_KEY` env var
- **Default models exposed:**
  - `gpt-4.1`
  - `gpt-4.1-mini`
  - `gpt-4.1-nano`
- **Request conversion:** none (native format)
- **Streaming:** standard OpenAI SSE (`data: {json}\n\n`, `data: [DONE]`)

The OpenAI adapter is also used for any OpenAI-compatible provider (Ollama, vLLM, Together, Groq, etc.) -- just point `base_url` at them.

### 3.3 Google (Gemini)

- **API:** Gemini generate content API (under the hood Google AI Studio)
- **Auth:** `GEMINI_API_KEY` env var
- **Default models exposed:**
  - `gemini-2.5-pro`
  - `gemini-2.5-flash`
- **Request/response conversion:** handled inside `completeGoogle()` / `streamGoogle()` in `packages/router/providers.ts`
- **Streaming:** Google's chunked response format converted to OpenAI chunk shape

### 3.4 Routing Policies

| Policy | Behavior |
|--------|----------|
| `quality` | Prefer the best model for the request class (e.g. Opus / GPT-4.1 for complex tasks) |
| `balanced` | Optimize for cost vs. quality tradeoff (default) |
| `cost` | Minimize cost, prefer smaller/cheaper models |

Each request is classified by prompt complexity, then matched to a tier. If the primary provider is unhealthy (circuit breaker open), the router falls back to the next provider that exposes a model of the same tier.

### 3.5 Cost Tracking via `onUsage`

The router exposes an `onUsage` callback: every completion's usage envelope is forwarded to `UsageRecorder` (in `packages/core/observability/`), which writes to `usage_records` in the database. The session dispatcher wires this callback at boot so that any session routed through `http://localhost:8430` has per-request cost accounting.

---

## 4. TensorZero Gateway (Optional LLM Backend)

[TensorZero](https://github.com/tensorzero/tensorzero) is an open-source Rust gateway (Apache 2.0) that sits between Ark's router and the real LLM providers. When enabled, Ark's router dispatches to TensorZero's OpenAI-compatible endpoint instead of directly to Anthropic/OpenAI/Google.

### 4.1 Why TensorZero

- Format conversion across all major providers (OpenAI, Anthropic, Google, Mistral, xAI, Together, Groq, etc.)
- Retries and provider fallbacks at the gateway level
- Streaming
- Cost and latency tracking built-in
- A/B testing and feedback-driven optimization (reinforcement-learning style flows)
- Battle-tested at scale

### 4.2 Ark Integration

- **Manager:** `packages/core/router/tensorzero.ts` (`TensorZeroManager`)
- **Config generator:** `packages/core/router/tensorzero-config.ts` (`generateTensorZeroConfig`) -- takes your API keys and writes a `tensorzero.toml` into `~/.ark/tensorzero/`
- **Default port:** `3000`
- **Base URL:** `http://localhost:3000`
- **OpenAI endpoint:** `http://localhost:3000/openai/v1/chat/completions`

### 4.3 Start Modes (in order)

`TensorZeroManager.start()` tries these in order. Each step is skipped if the previous one succeeded.

1. **Sidecar detection.** Probe `GET http://localhost:3000/status`. If already running (e.g. started by docker-compose or as a hosted control plane sidecar), use it as-is and return. No config is written.
2. **Native binary.** Look for the vendored `tensorzero-gateway` binary next to the `ark` executable (resolved via `process.execPath` / `which ark`), then fall back to `tensorzero-gateway` in `PATH`. If found, spawn it as a child process with the generated config. Local mode prefers this path so there is no Docker dependency.
3. **Docker fallback.** Pull `tensorzero/gateway` and run it in a container named `ark-tensorzero` with the config mounted. Used only when the native binary is not available.

### 4.4 Lifecycle

- `TensorZeroManager.start()` -- start, according to the mode order above
- `TensorZeroManager.stop()` -- kill the spawned child process or remove the Docker container. Sidecars are left alone.
- `TensorZeroManager.isHealthy()` -- HTTP probe of `/status`
- `TensorZeroManager.url` -- `http://localhost:3000`
- `TensorZeroManager.openaiUrl` -- `http://localhost:3000/openai/v1`

### 4.5 Auto-Start

When `tensorZero.enabled: true` and `tensorZero.autoStart: true` in `~/.ark/config.yaml` (and `skipConductor` is false), `AppContext.boot()` instantiates `TensorZeroManager` and calls `start()` as part of boot.

```yaml
# ~/.ark/config.yaml
tensorzero:
  enabled: true
  port: 3000
  config_dir: "~/.ark/tensorzero"
  auto_start: true

router:
  enabled: true
  url: "http://localhost:8430"
  policy: balanced
  auto_start: true
```

When both are enabled, Ark's router still runs on 8430 but talks to TensorZero on 3000 for every upstream call.

### 4.6 Cost Feedback Loop

TensorZero returns usage data in its responses just like the native provider APIs. The router's `onUsage` callback receives the envelope and forwards it to `UsageRecorder`, which writes to the `usage_records` table with the appropriate `cost_mode`. Over time this data can be used for TensorZero's optimization flows.

---

## 5. Transcript Parsers

Every agent tool (Claude Code, Codex, Gemini CLI) writes its own transcript format to its own location on disk. Ark has a parser per tool, registered in the `TranscriptParserRegistry`, and resolved at session completion time via the runtime YAML's `billing.transcript_parser` field.

Every parser implements:

```ts
interface TranscriptParser {
  readonly kind: string;
  parse(transcriptPath: string): ParseResult;
  findForSession(opts: { workdir: string; startTime?: Date }): string | null;
}
```

The key insight is `findForSession`: instead of picking "the newest jsonl file in some directory" (which cross-contaminates concurrent sessions), every parser identifies its session deterministically.

### 5.1 ClaudeTranscriptParser

- **File:** `packages/core/runtimes/claude/parser.ts`
- **Transcript path:** `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`
- **Project slug:** `resolve(workdir).replace(/\//g, "-").replace(/\./g, "-")` (Claude's own encoding)
- **Identification:** exact path via `session.claude_session_id`. Ark launches Claude Code with `--session-id <uuid>` at dispatch, stores the uuid on the session, and looks it up via the `sessionIdLookup` callback passed to the constructor. Fallback: most recent file in the project dir filtered by `startTime`.
- **Fields extracted:** per assistant message (`entry.type === "assistant"`), sums:
  - `message.usage.input_tokens`
  - `message.usage.output_tokens`
  - `message.usage.cache_read_input_tokens` (mapped to `cache_read_tokens`)
  - `message.usage.cache_creation_input_tokens` (mapped to `cache_write_tokens`)

Registered at boot with a callback that resolves the Ark session's `claude_session_id` from the `workdir`:

```ts
registry.register(new ClaudeTranscriptParser(undefined, (workdir) => {
  // lookup Ark session by workdir, return session.claude_session_id
}));
```

### 5.2 CodexTranscriptParser

- **File:** `packages/core/runtimes/codex/parser.ts`
- **Transcript path:** `~/.codex/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDThh-mm-ss>-<conversation-uuid>.jsonl`
- **Identification:** walk the sessions directory, sort candidates by mtime, filter by `startTime`, then read the first line of each. The first line is a `session_meta` event whose `payload.cwd` is the directory the tool ran in. Match it against `normalizePath(opts.workdir)` (with `realpathSync`).
- **Fields extracted:** scan all lines, find the last `event_msg` with `payload.type === "token_count"`, read `info.total_token_usage` (which is cumulative):
  - `input_tokens` <- `total_token_usage.input_tokens`
  - `output_tokens` <- `total_token_usage.output_tokens + reasoning_output_tokens`
  - `cache_read_tokens` <- `total_token_usage.cached_input_tokens`
- **Model** is also extracted from the first `turn_context` event.

### 5.3 GeminiTranscriptParser

- **File:** `packages/core/runtimes/gemini/parser.ts`
- **Transcript path:** `~/.gemini/tmp/<project-slug>/chats/session-<timestamp>-<shortid>.jsonl`
- **Identification:** compute `projectHash = sha256(resolve(workdir)).hex`, walk the tmp dir, sort candidates by mtime, filter by `startTime`, then read the first line of each. The first line is initial metadata containing a `projectHash` field. Match exactly. This is the same hash function gemini-cli uses internally (`gemini-cli/src/utils/paths.ts#getProjectHash`).
- **Fields extracted:** sum across all messages with `type === "gemini"`:
  - `input_tokens` <- `tokens.input`
  - `output_tokens` <- `tokens.output + tokens.thoughts + tokens.tool` (candidates + reasoning + tool-use prompts)
  - `cache_read_tokens` <- `tokens.cached`
- **Model** is extracted from the first gemini message's `model` field.

---

## 6. TranscriptParserRegistry

The registry is a simple keyed map with a polymorphic `get`:

```ts
// Registry
class TranscriptParserRegistry {
  register(parser: TranscriptParser): void
  get(kind: string): TranscriptParser | undefined
  list(): TranscriptParser[]
  has(kind: string): boolean
}

// Usage
const parser = app.transcriptParsers.get(runtime.billing.transcript_parser);
if (!parser) throw new Error(`No parser for ${runtime.name}`);

const transcriptPath = parser.findForSession({
  workdir: session.workdir,
  startTime: new Date(session.created_at),
});
if (!transcriptPath) return;

const result = parser.parse(transcriptPath);
// result.usage.{input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}
// result.model (optional)
// result.transcript_path (the path it read)
```

### 6.1 Wire-up at Boot

In `AppContext.createTranscriptParserRegistry()` (`packages/core/app.ts`):

```ts
private createTranscriptParserRegistry(): TranscriptParserRegistry {
  const registry = new TranscriptParserRegistry();
  registry.register(new ClaudeTranscriptParser(undefined, (workdir) => {
    // look up session by workdir and return session.claude_session_id
  }));
  registry.register(new CodexTranscriptParser());
  registry.register(new GeminiTranscriptParser());
  return registry;
}
```

### 6.2 Adding a New Parser

1. Create `packages/core/runtimes/<name>/parser.ts` and export a class implementing `TranscriptParser`.
2. Pick a unique `kind` string (e.g. `"grok"`, `"qwen"`).
3. Implement `parse(path)` (never throws) and `findForSession({ workdir, startTime })`.
4. Register it in `AppContext.createTranscriptParserRegistry()`.
5. Set `billing.transcript_parser: <kind>` in the runtime YAML at `runtimes/<runtime>.yaml`.

No other wiring is needed -- the registry is looked up polymorphically everywhere it's used.

---

## 7. Adding a New Provider (How-To)

### 7.1 Adding a Compute Provider

1. Create `packages/compute/providers/<name>.ts` (or a subdirectory) and implement the `ComputeProvider` interface from `packages/compute/types.ts`.
2. If your provider runs on a remote host with arkd, extend `ArkdBackedProvider` to get shared HTTP plumbing and `getClient(compute)` for free.
3. Register the provider in `AppContext.boot()` inside `packages/core/app.ts`:
   ```ts
   const myProvider = new MyProvider();
   myProvider.setApp(this);
   this.registerProvider(myProvider);
   ```
4. If the provider needs an optional SDK (like `@kubernetes/client-node` or `e2b`), wrap the import in a try/catch so it's not required at install time.
5. Reference the provider by its `name` field in compute YAML or via `ark compute create --provider <name>`.

### 7.2 Adding an LLM Provider

Currently the Router's `Provider` class is a single file (`packages/router/providers.ts`) that switches on `config.name` inside `complete()` and `stream()`. To add a new LLM provider:

1. Add a `case "<name>":` branch to both `complete()` and `stream()` in `Provider`.
2. Implement `complete<Name>()` and `stream<Name>()` methods that convert the OpenAI-compatible request to the provider's native format and back.
3. Add request/response converters (`to<Name>Request`, `from<Name>Response`) and an SSE converter for streaming.
4. Add the provider to the router config loader in `packages/router/config.ts` so it picks up the API key from env.
5. (Code review note: this class is monolithic and is a known refactor target. New providers will be easier once it's split into per-provider adapter files.)

### 7.3 Adding a Transcript Parser

See section 6.2 above -- it's 5 steps and no other wiring.

---

## 8. Config Reference Summary

```yaml
# ~/.ark/config.yaml

# LLM Router
router:
  enabled: true
  url: "http://localhost:8430"
  policy: balanced          # quality | balanced | cost
  auto_start: true

# TensorZero gateway (optional, sits between router and real providers)
tensorzero:
  enabled: false
  port: 3000
  config_dir: "~/.ark/tensorzero"
  auto_start: false

# Default compute for new sessions
default_compute: "local"

# Named compute templates
compute_templates:
  fast:
    provider: local
    config:
      isolation: worktree
  sandbox:
    provider: docker
    config:
      image: "ubuntu:22.04"
  cloud:
    provider: ec2
    config:
      size: "l"
      region: "us-east-1"
```

Environment variables relevant to providers:

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic LLM provider auth (and TensorZero config generation) |
| `OPENAI_API_KEY` | OpenAI LLM provider auth (and TensorZero config generation) |
| `GEMINI_API_KEY` | Google LLM provider auth (and TensorZero config generation) |
| `E2B_API_KEY` | E2B compute provider auth |
| `ARK_ARKD_URL` | Override arkd URL for local arkd-backed providers |
| `ARK_ARKD_PORT` | Override arkd default port (19300) |
| `ARK_CONDUCTOR_URL` | Override conductor URL (default `http://localhost:19100`) |
| `AWS_PROFILE` / standard AWS env vars | EC2 family provider auth |
| `KUBECONFIG` | K8s provider default (if not set per-compute) |

---

## 9. See Also

- `docs/compute.html` -- high-level compute concepts and CLI flow
- `docs/configuration.md` -- full `~/.ark/config.yaml` reference
- `docs/concepts.html` -- Ark's architecture overview
- `packages/compute/types.ts` -- `ComputeProvider` interface
- `packages/core/runtimes/transcript-parser.ts` -- `TranscriptParser` interface and registry
- `packages/router/providers.ts` -- LLM provider adapters and circuit breakers
- `packages/core/router/tensorzero.ts` -- TensorZero lifecycle manager
- `packages/core/app.ts` -- `AppContext.boot()` where everything is wired
