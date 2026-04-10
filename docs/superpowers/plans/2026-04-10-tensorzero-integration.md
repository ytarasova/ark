# TensorZero Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Ark's hand-rolled LLM provider adapters with TensorZero (Rust gateway, <1ms P99, Apache 2.0). Keep Ark's routing intelligence. TensorZero handles dispatch, format conversion, retries, streaming, and feedback optimization. Works both locally and on control plane.

**Architecture:**
```
Agent → Ark Routing (classify, policy, context) → TensorZero (:3000) → LLM Provider
```

---

## What to build

### Task 1: TensorZero config generator

**Create:** `packages/core/router/tensorzero-config.ts`

Generate `tensorzero.toml` from Ark's config (runtimes, API keys, router policy):

```ts
export function generateTensorZeroConfig(opts: {
  anthropicKey?: string;
  openaiKey?: string;
  geminiKey?: string;
  postgresUrl?: string;     // for observability
}): string {
  // Returns TOML string
}
```

Output TOML:

```toml
[gateway]
bind_address = "0.0.0.0:3000"

[models.claude-opus]
routing = ["anthropic"]

[models.claude-opus.providers.anthropic]
type = "anthropic"
model_name = "claude-opus-4-6"
api_key_location = "env::ANTHROPIC_API_KEY"

[models.claude-sonnet]
routing = ["anthropic"]

[models.claude-sonnet.providers.anthropic]
type = "anthropic"
model_name = "claude-sonnet-4-6"
api_key_location = "env::ANTHROPIC_API_KEY"

[models.claude-haiku]
routing = ["anthropic"]

[models.claude-haiku.providers.anthropic]
type = "anthropic"
model_name = "claude-haiku-4-5"
api_key_location = "env::ANTHROPIC_API_KEY"

[models.gpt-4-1]
routing = ["openai"]

[models.gpt-4-1.providers.openai]
type = "openai"
model_name = "gpt-4.1"
api_key_location = "env::OPENAI_API_KEY"

[models.gpt-4-1-mini]
routing = ["openai"]

[models.gpt-4-1-mini.providers.openai]
type = "openai"
model_name = "gpt-4.1-mini"
api_key_location = "env::OPENAI_API_KEY"

[models.gemini-pro]
routing = ["google"]

[models.gemini-pro.providers.google]
type = "google_ai_studio_gemini"
model_name = "gemini-2.5-pro"
api_key_location = "env::GEMINI_API_KEY"

# Function for general chat (our agents)
[functions.chat]
type = "chat"

[functions.chat.variants.default]
type = "chat_completion"
model = "claude-sonnet"
```

### Task 2: TensorZero lifecycle manager

**Create:** `packages/core/router/tensorzero.ts`

Manages starting/stopping TensorZero as a subprocess (local) or expects it as a sidecar (hosted):

```ts
export class TensorZeroManager {
  private process: any = null;
  private configPath: string;
  private port: number = 3000;
  
  constructor(private config: ArkConfig) {}
  
  /** Start TensorZero as a Docker container or detect existing sidecar */
  async start(): Promise<void> {
    // 1. Generate tensorzero.toml
    // 2. Check if TensorZero already running (sidecar mode)
    //    - Try GET http://localhost:3000/status
    //    - If reachable, use it (control plane sidecar)
    // 3. If not running, start via Docker
    //    - docker run -d --name ark-tensorzero -v config:/app/config -p 3000:3000 tensorzero/gateway
    // 4. Wait for /status to return 200
  }
  
  /** Stop TensorZero (local mode only) */
  async stop(): Promise<void> {
    // docker stop ark-tensorzero
  }
  
  /** Get the base URL for API calls */
  get url(): string { return `http://localhost:${this.port}`; }
  
  /** Health check */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/status`);
      return res.ok;
    } catch { return false; }
  }
}
```

### Task 3: Ark routing layer → TensorZero dispatch

**Modify:** `packages/router/dispatch.ts`

Instead of calling our Provider adapters, dispatch through TensorZero's OpenAI-compatible endpoint:

```ts
// Old: const response = await provider.complete(request, model);
// New:
const response = await fetch(`${tensorZeroUrl}/openai/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: decision.selected_model,  // e.g. "claude-sonnet"
    messages: request.messages,
    stream: request.stream,
    // TensorZero-specific params
    "tensorzero::episode_id": request.routing?.sticky_session_id,
  }),
});
```

Our classifier + engine still decide WHICH model. TensorZero handles HOW to call it.

### Task 4: Wire into AppContext boot

**Modify:** `packages/core/app.ts`

During boot, if router is enabled:
1. Generate TensorZero config
2. Start TensorZero (or detect sidecar)
3. Set `app.tensorZeroUrl` for dispatch to use

### Task 5: Remove old provider adapters

**Delete or deprecate:**
- `packages/router/providers.ts` -- format adapters (TensorZero handles this)
- Simplify `packages/router/dispatch.ts` -- just HTTP call to TensorZero

**Keep:**
- `packages/router/classifier.ts` -- our task complexity scoring
- `packages/router/engine.ts` -- our routing policies
- `packages/router/server.ts` -- our HTTP server (wraps TensorZero)
- `packages/router/feedback.ts` -- our cost attribution to UsageRecorder

### Task 6: Update Helm chart + docker-compose

**docker-compose.yaml:** Add TensorZero service:
```yaml
tensorzero:
  image: tensorzero/gateway
  volumes:
    - ./config/tensorzero.toml:/app/config/tensorzero.toml
  ports:
    - "3000:3000"
  environment:
    - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    - OPENAI_API_KEY=${OPENAI_API_KEY}
    - GEMINI_API_KEY=${GEMINI_API_KEY}
```

**Helm chart:** Add TensorZero as sidecar container in control-plane deployment.

### Task 7: Integration test with real APIs

Test the full chain: Ark request → classify → route → TensorZero → real Anthropic/OpenAI/Google → response.

Use the API keys we found:
- ANTHROPIC_API_KEY from foundry_og/.env
- OPENAI_API_KEY from observability/.env
- GEMINI_API_KEY from screenshot

### Task 8: Feed TensorZero usage back to UsageRecorder

TensorZero returns `usage: { input_tokens, output_tokens, cost }` in responses. Parse this and call `app.usageRecorder.record()`.
