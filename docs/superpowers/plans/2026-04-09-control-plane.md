# Control Plane Implementation Plan

**Goal:** Run Ark as a hosted multi-tenant service with a control plane that schedules sessions across worker nodes.

**Architecture:**
```
Users → API Gateway (auth) → Control Plane → Workers (ArkD)
                                  ↓
                            Postgres (state)
                            Redis (SSE bus)
                            LLM Router (shared)
```

---

## What to build

### 1. Redis SSE Bus (`packages/core/sse-redis.ts`)

Implement `SSEBus` interface using Redis pub/sub:
```ts
import { createClient } from "redis";

export class RedisSSEBus implements SSEBus {
  private pub: RedisClient;
  private sub: RedisClient;
  
  publish(channel, event, data) { this.pub.publish(channel, JSON.stringify({ event, data })); }
  subscribe(channel, callback) { this.sub.subscribe(channel, ...); return unsubscribe; }
}
```

Install: `bun add redis`

### 2. Worker Registry (`packages/core/worker-registry.ts`)

Track available compute workers:
```ts
export interface WorkerNode {
  id: string;
  url: string;              // ArkD URL (http://host:19300)
  status: "online" | "offline" | "draining";
  capacity: number;         // max concurrent sessions
  activeSessions: number;
  lastHeartbeat: string;
  compute: string;          // compute name this worker belongs to
  tenantId?: string;        // if dedicated to a tenant
}

export class WorkerRegistry {
  register(worker: WorkerNode): void;
  heartbeat(workerId: string): void;
  deregister(workerId: string): void;
  getAvailable(opts?: { tenantId?: string }): WorkerNode[];
  getLeastLoaded(): WorkerNode | null;
}
```

Store in Postgres `workers` table. Workers call `/api/workers/heartbeat` every 30s.

### 3. Session Scheduler (`packages/core/scheduler.ts`)

Assigns sessions to workers:
```ts
export class SessionScheduler {
  constructor(
    private workers: WorkerRegistry,
    private pools: ComputePoolManager,
  );

  // Assign a session to a worker. Returns the worker URL.
  async schedule(session: Session): Promise<WorkerNode> {
    // 1. If session has a specific compute, find a worker for that compute
    // 2. If session has a compute pool, request from pool
    // 3. Otherwise, pick least-loaded worker
    // 4. If no workers available, auto-provision from pool
  }
}
```

### 4. Hosted Server Entry Point (`packages/core/hosted.ts`)

```ts
export async function startHostedServer(config: ArkConfig): Promise<void> {
  const app = new AppContext(config);
  await app.boot();
  
  // Start conductor (API + SSE)
  startConductor(app, config.conductorPort);
  
  // Start web server
  startWebServer(app, config.webPort);
  
  // Start LLM router
  startRouter(config.router);
  
  // Start worker health checker (prune offline workers)
  startHealthChecker(app);
  
  // Start session scheduler
  startScheduler(app);
}
```

### 5. CLI Command

```bash
ark server start --hosted              # Start the control plane
ark server start --hosted --port 8420  # Custom port
```

### 6. Worker Registration in ArkD

When ArkD starts, it registers with the control plane:
```ts
// In packages/arkd/server.ts boot:
if (process.env.ARK_CONTROL_PLANE_URL) {
  registerWithControlPlane(process.env.ARK_CONTROL_PLANE_URL);
  startHeartbeat(process.env.ARK_CONTROL_PLANE_URL, 30_000);
}
```

### 7. Docker Compose (hosted mode)

```yaml
services:
  control-plane:
    build: .
    command: ["bun", "packages/cli/index.ts", "server", "start", "--hosted"]
    environment:
      DATABASE_URL: postgres://ark:ark@postgres:5432/ark
      REDIS_URL: redis://redis:6379
      ARK_AUTH_ENABLED: "true"
    ports:
      - "8420:8420"
      - "8430:8430"
    depends_on: [postgres, redis]

  worker:
    build: .
    command: ["bun", "packages/cli/index.ts", "arkd", "--conductor-url", "http://control-plane:19100"]
    environment:
      ARK_CONTROL_PLANE_URL: http://control-plane:19100
    deploy:
      replicas: 3
```
