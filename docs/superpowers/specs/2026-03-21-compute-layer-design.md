# Ark Compute Layer -- Design Spec

## Goal

Integrate compute provisioning, host management, environment sync, and full observability into Ark -- absorbing key capabilities from the original Arc (Python/Pulumi) and BigBox (Python/boto3) into Ark's TypeScript/Bun stack. This makes Ark a complete autonomous agent platform that can dispatch agents to local machines, Docker containers, and remote EC2 instances.

## Context

Three codebases contribute to this design:

- **Ark** (`/Users/yana/Projects/ark`) -- TypeScript/Bun. The conductor, pipeline orchestration, agent management, channels, TUI. This is the target and keeps its existing architecture intact.
- **Original Arc** (`ytarasova/arc` on GitHub) -- Python. Pulumi EC2 provisioning, multi-compute pools, instance size tiers, devcontainer support, remote session execution. The compute layer that was lost in the TypeScript rewrite.
- **BigBox** (`/Users/yana/Projects/bigbox`) -- Python. SSH-based host metrics, environment sync, idle shutdown, cost tracking, clipboard sync, port forwarding. Operational tooling for managing remote dev boxes.

After this integration, both Python codebases can be retired.

---

## Architecture

### Package structure

```
packages/
  core/              # existing -- orchestration (unchanged interface, extended internals)
    store.ts          # adds: hosts table, port records on sessions
    session.ts        # adds: calls compute.launch() at dispatch time
    conductor.ts      # adds: host health polling, port probing, clipboard routing

  compute/            # NEW -- everything about getting code running on a machine
    index.ts          # public API, provider registry
    types.ts          # ComputeProvider interface, Host, HostSnapshot, PortDecl, etc.
    arc-json.ts       # parse arc.json (ports, sync files, compose/devcontainer flags)

    providers/
      local/
        index.ts      # LocalProvider -- no provisioning, local tmux, shell metrics
        metrics.ts    # local metrics via shell commands

      docker/
        index.ts      # DockerProvider -- Pulumi @pulumi/docker
        metrics.ts    # docker stats, container inspection
        devcontainer.ts  # detect, build, mount creds, resolve ports

      ec2/
        index.ts      # EC2Provider -- Pulumi @pulumi/aws
        provision.ts  # Pulumi Automation API (stacks, resources)
        metrics.ts    # SSH-based metrics collection + parsing
        cloud-init.ts # user-data script builder
        idle.ts       # idle shutdown cron script generation
        sync.ts       # environment sync (creds, Claude sessions, arc.json files)
        ssh.ts        # SSH exec, rsync push/pull primitives
        ports.ts      # SSH tunnel management (setup/teardown/probe)
        clipboard.ts  # Mac clipboard -> remote session
        cost.ts       # pricing tables + Cost Explorer queries
```

### Provider interface

```typescript
interface ComputeProvider {
  // Lifecycle
  provision(host: Host, opts: ProvisionOpts): Promise<void>;
  destroy(host: Host): Promise<void>;
  start(host: Host): Promise<void>;
  stop(host: Host): Promise<void>;

  // Session execution
  launch(host: Host, session: Session, opts: LaunchOpts): Promise<string>;
  attach(host: Host, session: Session): Promise<void>;

  // Observability
  getMetrics(host: Host): Promise<HostSnapshot>;
  probePorts(host: Host, ports: PortDecl[]): Promise<PortStatus[]>;

  // Environment
  syncEnvironment(host: Host, opts: SyncOpts): Promise<void>;
}
```

Each provider implements what makes sense for its compute type. Local provider has no-op `provision`/`destroy`. Docker provider uses `@pulumi/docker`. EC2 provider uses `@pulumi/aws`. Each provider implements its own metrics collection internally.

### Pulumi usage by provider

| Provider | Pulumi package | What it manages |
|----------|---------------|-----------------|
| local | None | Machine already exists |
| docker | `@pulumi/docker` | Containers, images, networks, volumes |
| ec2 | `@pulumi/aws` | EC2 instance, security group, key pair |
| k8s (future) | `@pulumi/kubernetes` | Pods, services |

Pulumi Automation API (programmatic, not CLI). Local backend at `~/.ark/pulumi/`. One stack per host: `ark-compute-{name}`.

---

## Host model

Stored in SQLite (`hosts` table in `store.ts`):

```typescript
interface Host {
  name: string;           // unique identifier: "dev", "local", "big-gpu"
  provider: string;       // "local" | "docker" | "ec2"
  status: string;         // "stopped" | "running" | "provisioning" | "destroyed"
  config: ProviderConfig; // provider-specific, stored as JSON
  created_at: string;
  updated_at: string;
}
```

### EC2 provider config

```typescript
{
  size: "m",              // xs | s | m | l | xl | xxl | xxxl
  arch: "x64",            // x64 | arm
  region: "us-east-1",
  aws_profile: "yt",
  subnet_id: "subnet-abc", // required for VPC placement
  disk_gb: 256,
  tags: { PAITenant: "risk", PAIProject: "ark" },
  ingress_cidrs: ["0.0.0.0/0"],  // security group SSH ingress (can restrict to VPN/office)
  // Runtime state (set after provision):
  instance_id: "i-abc123",
  ip: "1.2.3.4",         // public or private depending on subnet
  sg_id: "sg-xyz",
  key_name: "ark-dev",
  stack_name: "ark-compute-dev"
}
```

### Instance size tiers (from original Arc)

| Size | vCPU | RAM | x64 type | ARM type |
|------|------|-----|----------|----------|
| xs | 2 | 8 GB | m6i.large | m6g.large |
| s | 4 | 16 GB | m6i.xlarge | m6g.xlarge |
| m | 8 | 32 GB | m6i.2xlarge | m6g.2xlarge |
| l | 16 | 64 GB | m6i.4xlarge | m6g.4xlarge |
| xl | 32 | 128 GB | m6i.8xlarge | m6g.8xlarge |
| xxl | 48 | 192 GB | m6i.12xlarge | m6g.12xlarge |
| xxxl | 64 | 256 GB | m6i.16xlarge | m6g.16xlarge |

### Docker provider config

```typescript
{
  image: "node:22",       // base image, or derived from devcontainer.json
  // Runtime state:
  container_id: "abc123"
}
```

### Local provider config

```typescript
{}  // empty -- the machine is already there
```

### Default compute

A default compute can be set. Sessions with null `compute_name` dispatch to the default. If no default is set and `compute_name` is null, dispatch uses local.

---

## Session dispatch flow

When `session.dispatch()` is called:

```
1. Resolve host via session.compute_name (or default)
2. Resolve provider from host.provider
3. Auto-start if host is stopped (but don't auto-provision destroyed/nonexistent)
4. Project setup:
   a. Clone/checkout repo on compute target
   b. Push arc.json sync files to working directory
   c. Detect docker-compose.yml → docker compose up -d
   d. Detect devcontainer.json → build container
   e. Resolve ports from arc.json + devcontainer.json + docker-compose.yml
   f. Store resolved ports on session record
5. Launch Claude:
   a. Provider.launch() → tmux session with Claude + channel MCP
   b. If devcontainer: exec Claude inside the container
   c. If bare metal: exec Claude directly
6. Establish port tunnels (EC2: SSH -L, Docker: port mapping)
7. Sync Claude sessions bidirectionally
8. Update session record (status=running, ports, tmux name)
9. Channel task delivery (existing conductor mechanism)
```

### Attach flow (user comes back later)

```
1. Look up session → host → provider
2. Re-establish port tunnels from session's stored port list
3. Attach to tmux session (remote: via SSH, local: direct)
4. On detach: tunnels stay up (autossh background)
```

### Session end flow

```
1. Conductor receives completion report via channel
2. Sync Claude sessions remote → local
3. Optionally: docker compose down
4. Advance pipeline (existing conductor logic)
```

### Auto-start behavior

| Host state | Dispatch behavior |
|------------|-------------------|
| running | Proceed |
| stopped | Auto-start, wait for ready, proceed |
| destroyed | Error: "re-provision with `ark host provision`" |
| doesn't exist | Error: "create host first" |

---

## Environment sync

### Global sync (per host, one-way push: local → remote)

| What | Source | Destination |
|------|--------|-------------|
| SSH keys | `~/.ssh/` | `~/.ssh/` |
| AWS credentials | `~/.aws/` | `~/.aws/` |
| Git config | `~/.gitconfig` | `~/.gitconfig` |
| GitHub CLI | `gh auth token` | `gh auth login --with-token` |
| Claude config | `~/.claude/` | `~/.claude/` (with path rewriting) |

**Path rewriting**: Claude config files contain absolute paths. On push, rewrite `/Users/{user}` → `/home/ubuntu`. Done via string replacement during rsync post-processing.

### Bidirectional sync: Claude sessions

Claude sessions need to sync both ways:
- Push: so remote Claude can `--resume` local sessions
- Pull: so local knows about sessions created/updated on remote

### Project sync (per session, at dispatch time)

Files declared in `arc.json` `"sync"` array are pushed from the local repo directory to the remote session working directory. These are project-specific files that aren't committed to git (`.env`, `terraform.tfvars`, etc.).

### Provider-specific implementation

- **EC2**: rsync over SSH
- **Docker**: volume mounts
- **Local**: not needed (same filesystem)

---

## Port management

### Port declaration sources

1. `arc.json` `"ports"` -- explicit project-level declaration
2. `devcontainer.json` `"forwardPorts"` -- auto-detected
3. `docker-compose.yml` exposed ports -- auto-detected

### Port lifecycle

1. **At dispatch**: resolve ports from all sources, store on session record
2. **At dispatch**: establish tunnels (SSH -L for EC2, port mapping for Docker)
3. **Conductor polling**: probe remote ports via SSH (`ss -tln`) to check if services are actually listening
4. **At attach**: re-establish tunnels from session record
5. **At session end**: tear down tunnels

### Session record

```typescript
session.config.ports = [
  { port: 3000, name: "web", source: "arc.json", listening: true },
  { port: 5432, name: "postgres", source: "docker-compose.yml", listening: true },
  { port: 8080, name: "api", source: "devcontainer.json", listening: false }
]
```

### TUI display

Ports tab or section in the host detail pane showing declared ports with live status (listening vs not).

---

## Host observability

### HostSnapshot type

```typescript
interface HostSnapshot {
  metrics: HostMetrics;        // CPU, MEM, DISK, NET, uptime, idle ticks
  sessions: HostSession[];     // tmux sessions with Claude process info
  processes: HostProcess[];    // top processes by CPU
  docker: DockerContainer[];   // container stats
}

interface HostMetrics {
  cpu: number;                 // percentage
  memUsedGb: number;
  memTotalGb: number;
  memPct: number;
  diskPct: number;
  netRxMb: number;
  netTxMb: number;
  uptime: string;
  idleTicks: number;
}

interface HostSession {
  name: string;                // tmux session name
  status: string;              // "working" (CPU > 1%) | "idle"
  mode: string;                // "interactive" | "agentic"
  projectPath: string;
  cpu: number;
  mem: number;
}
```

### Collection per provider

- **EC2**: single SSH command with section-delimited output (`=== CPU ===`, etc.), parsed into typed models. Fast path (< 2s) for core metrics, slow path (3-5s) for Docker stats.
- **Local**: equivalent shell commands executed directly
- **Docker**: `docker stats` + `docker inspect`

### Conductor polling

The conductor polls metrics for all running hosts every 10 seconds. Results are cached and displayed in the TUI. The conductor can use metrics for smart dispatch decisions (don't overload a host).

### TUI Hosts tab (tab 5)

- **Left pane**: host list with status indicator and IP
- **Right pane** for selected host:
  - Metric bars (CPU/MEM/DISK) with color thresholds (green < 50%, yellow < 80%, red > 80%)
  - Network RX/TX
  - Uptime + idle ticks
  - Sessions table (name, status, mode, CPU%, project path)
  - Processes table (pid, CPU%, MEM%, command, working dir)
  - Docker containers table (name, CPU, memory, image)
  - Port status (declared + listening state)
  - Cost estimate (hourly rate from pricing table)

---

## Docker Compose integration

At dispatch time, if the project has a `docker-compose.yml` (or `arc.json` has `"compose": true`):

1. Push compose file + any referenced configs to remote
2. Run `docker compose up -d` in the session working directory
3. Extract exposed ports from compose config, add to session port list
4. On session end: optionally `docker compose down`

This is not a provider concern -- it's part of the dispatch layer's project setup, and works on any provider that has Docker installed (EC2 with cloud-init, Docker provider natively, local if Docker is installed).

---

## Devcontainer support

At dispatch time, if the project has `.devcontainer/devcontainer.json` (or `arc.json` has `"devcontainer": true`):

1. Build the devcontainer: `devcontainer up --workspace-folder <dir>`
2. Mount credentials into container (AWS, Claude, SSH, git)
3. Forward env vars via `--remote-env`
4. Resolve `forwardPorts` from devcontainer.json, add to session port list
5. Launch Claude inside: `devcontainer exec --workspace-folder <dir> claude ...`

The `compute/providers/docker/devcontainer.ts` module handles detection, build, credential mounting, and port resolution. It's used by both the Docker provider and the EC2 provider (when an EC2 session uses a devcontainer).

---

## Clipboard sync

- Watches macOS clipboard for image content
- On screenshot copy: pushes to the active/attached session's working directory on the remote host
- The conductor routes to the correct session (multiple sessions may run on one host)
- Useful for sharing UI context with Claude agents

Implementation lives in `compute/providers/ec2/clipboard.ts` since it only applies to remote hosts.

---

## Idle shutdown (EC2)

Cloud-init installs a cron job that runs every 10 minutes:

1. Check for SSH connections → reset counter
2. Check for Claude processes with active sockets (ESTAB) → reset counter
3. Otherwise increment idle counter
4. At threshold (configurable, default 6 ticks = 60 min): `shutdown -h now` (stop, not terminate)

The instance can be restarted via `ark host start` or auto-started on next dispatch.

Script generated by `compute/providers/ec2/idle.ts`, configurable timeout via host config.

---

## Cost tracking (EC2)

### Hardcoded pricing tables

On-demand hourly rates for all instance types in the size tier table. Used for instant cost estimates in TUI.

### AWS Cost Explorer

Queries via `@aws-sdk/client-cost-explorer` for actual month-to-date cost, filtered by `Name` tag (`ark-{hostName}`). Cached for 4 hours (API costs $0.01/call).

### Display

TUI shows estimated hourly rate + actual MTD cost for each EC2 host.

---

## arc.json

Per-repo config file, committed to the repository:

```json
{
  "ports": [
    { "port": 3000, "name": "web" },
    { "port": 5432, "name": "postgres" }
  ],
  "sync": [".env", "terraform.tfvars", "config/local.yml"],
  "compose": true,
  "devcontainer": true
}
```

- `ports`: what to forward between local machine and compute target
- `sync`: project-specific files to push from local repo to remote working directory (not secrets themselves -- the files like `.env` that contain them and are gitignored locally)
- `compose`: opt in/out of Docker Compose lifecycle (default: auto-detect)
- `devcontainer`: opt in/out of devcontainer usage (default: auto-detect)

No sensitive information in this file. Credentials are synced from user home directory. Project-specific secrets are in the files listed in `sync` (which are gitignored in the repo).

---

## CLI additions

### Host commands (`ark host`)

```
ark host create <name> --provider ec2 --size m --arch x64 --region us-east-1
ark host provision <name>          # Pulumi up
ark host start <name>              # Start stopped instance
ark host stop <name>               # Stop (preserve data)
ark host destroy <name>            # Pulumi destroy + stack rm
ark host list                      # All hosts with status
ark host status <name>             # Details + live metrics
ark host sync <name>               # Push environment to host
ark host metrics <name>            # One-shot metrics snapshot
ark host default <name>            # Set default compute
ark host ssh <name>                # Interactive SSH
```

### Session command extensions

```
ark session start ... --compute <name>   # existing flag, now wired to real hosts
ark session attach <id>                  # re-establishes tunnels automatically
```

---

## What comes from where

| Feature | Source | Notes |
|---------|--------|-------|
| Conductor, pipelines, channels, agents | Ark | Keep as-is |
| TUI (Blessed) | Ark | Extend with Hosts tab |
| SQLite store, event audit trail | Ark | Add hosts table, port records |
| Pulumi EC2 provisioning | Original Arc | Port Python → TypeScript SDK |
| Multi-compute pools, default compute | Original Arc | Port the model |
| Instance sizing (xs→xxxl, ARM+x64) | Original Arc | Direct port |
| Devcontainer support | Original Arc | Detection, build, mount, port resolution |
| Provider abstraction | New | Designed fresh for local/docker/ec2 |
| SSH metrics collection + parsing | BigBox | Port Python → TypeScript |
| Idle shutdown (smart cron) | BigBox | Port to cloud-init |
| Cost tracking (pricing + Cost Explorer) | BigBox | Port to EC2 provider |
| Clipboard sync | BigBox | Port, conductor routes to session |
| Environment sync (creds, path rewriting) | BigBox | One-way push, Claude sessions bidirectional |
| arc.json (ports, sync files) | BigBox (bigbox.json) | Renamed, committed to repo |
| Port forwarding + probing | Both | Combined approach |
| Docker Compose integration | New | Auto-detect, lifecycle at dispatch |
| Docker provider via Pulumi | New | `@pulumi/docker` |

## Dropped

- **Runner.sh** -- conductor replaces it
- **Local mode / MCP-over-SSE** -- Claude always runs on compute target
- **VCS integration** -- agents handle their own PRs
- **Kubernetes** -- parked, provider interface ready for it
- **Bitbucket CLI** -- not needed (GitHub now)

## Dependencies

```
@pulumi/pulumi
@pulumi/aws
@pulumi/docker
@aws-sdk/client-cost-explorer
```
