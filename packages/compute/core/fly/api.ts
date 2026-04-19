/**
 * Fly.io Machines API client.
 *
 * Thin HTTP wrapper around https://api.machines.dev/v1. Exposes one method
 * per endpoint the FlyMachinesCompute touches -- no caching, no retry, no
 * reconnect. Returns the parsed JSON body on 2xx, throws `FlyApiError` on
 * anything else.
 *
 * Why a separate module: the Compute shouldn't care whether the HTTP client
 * is `fetch`, `undici`, or a stubbed DI surface. Keeping the endpoint shapes
 * in one file means the tests can stub a single `fetchFn` and still cover
 * every code path the Compute drives. The API reference is at
 * https://fly.io/docs/machines/api/; endpoint schemas checked 2026-04.
 *
 * All methods take a `FlyApiClient` that carries the token + fetch impl.
 * The Compute lazily constructs one per call so a token rotation between
 * calls is picked up on the next request without restarting the process.
 */

export const FLY_API_BASE = "https://api.machines.dev/v1";
export const FLY_DEFAULT_TIMEOUT_MS = 60_000;

/** Minimal `fetch` signature the client needs. Used so tests can stub it. */
export type FlyFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface FlyApiClient {
  token: string;
  fetchFn: FlyFetchFn;
  timeoutMs: number;
}

/** Runtime-level failure. Carries the HTTP status + body for diagnostics. */
export class FlyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly body: string,
  ) {
    super(`Fly API ${endpoint} failed: HTTP ${status}: ${body}`);
    this.name = "FlyApiError";
  }
}

// ── Public payload types ───────────────────────────────────────────────────

export interface FlyMachineService {
  internal_port: number;
  protocol: "tcp" | "udp";
  ports: Array<{ port: number; handlers?: string[] }>;
}

export interface FlyMachineConfig {
  image: string;
  env?: Record<string, string>;
  mounts?: Array<{ name?: string; path: string; volume?: string; size_gb?: number }>;
  services?: FlyMachineService[];
  guest?: { cpu_kind?: string; cpus?: number; memory_mb?: number };
  size?: string;
}

export interface FlyCreateMachineRequest {
  name?: string;
  region?: string;
  config: FlyMachineConfig;
}

export interface FlyMachine {
  id: string;
  name?: string;
  state: string;
  region: string;
  private_ip?: string;
  config?: FlyMachineConfig;
  image_ref?: { registry?: string; repository?: string; tag?: string };
}

// ── Client construction ────────────────────────────────────────────────────

/**
 * Build a client from the token + fetch impl the caller wants to use.
 * Throws if no token is present -- the caller must check `FLY_API_TOKEN`
 * before reaching here (the Compute does this upfront so no network call
 * leaks when the token is absent).
 */
export function makeFlyClient(
  token: string,
  fetchFn: FlyFetchFn = fetch,
  timeoutMs: number = FLY_DEFAULT_TIMEOUT_MS,
): FlyApiClient {
  if (!token) throw new Error("FlyApiClient: token is required");
  return { token, fetchFn, timeoutMs };
}

// ── Endpoint wrappers ──────────────────────────────────────────────────────

/** `POST /v1/apps` -- idempotent: 422 from Fly = already exists. */
export async function createApp(
  client: FlyApiClient,
  appName: string,
  orgSlug: string = "personal",
): Promise<{ created: boolean }> {
  const res = await request(client, "POST", "/apps", { app_name: appName, org_slug: orgSlug });
  if (res.ok) return { created: true };
  // 422 = "App already exists". We treat that as success so the caller
  // can call createApp unconditionally before every provision without
  // needing a round-trip to check first.
  if (res.status === 422) return { created: false };
  await throwFromResponse(res, `POST /apps (${appName})`);
  return { created: false }; // unreachable; throwFromResponse always throws
}

/** `DELETE /v1/apps/<app>` -- tears down the app + all its machines. */
export async function deleteApp(client: FlyApiClient, appName: string): Promise<void> {
  const res = await request(client, "DELETE", `/apps/${encodeURIComponent(appName)}`);
  if (res.ok || res.status === 404) return;
  await throwFromResponse(res, `DELETE /apps/${appName}`);
}

/** `POST /v1/apps/<app>/machines` -- create (and implicitly start) a machine. */
export async function createMachine(
  client: FlyApiClient,
  appName: string,
  body: FlyCreateMachineRequest,
): Promise<FlyMachine> {
  const res = await request(client, "POST", `/apps/${encodeURIComponent(appName)}/machines`, body);
  if (!res.ok) await throwFromResponse(res, `POST /apps/${appName}/machines`);
  return (await res.json()) as FlyMachine;
}

/** `GET /v1/apps/<app>/machines/<id>` -- fetch current state. */
export async function getMachine(client: FlyApiClient, appName: string, machineId: string): Promise<FlyMachine> {
  const res = await request(
    client,
    "GET",
    `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
  );
  if (!res.ok) await throwFromResponse(res, `GET /apps/${appName}/machines/${machineId}`);
  return (await res.json()) as FlyMachine;
}

/** `POST /v1/apps/<app>/machines/<id>/start`. Fly auto-resumes suspended machines. */
export async function startMachine(client: FlyApiClient, appName: string, machineId: string): Promise<void> {
  const res = await request(
    client,
    "POST",
    `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/start`,
  );
  if (!res.ok) await throwFromResponse(res, `POST /apps/${appName}/machines/${machineId}/start`);
}

/** `POST /v1/apps/<app>/machines/<id>/stop`. Does not release the volume. */
export async function stopMachine(client: FlyApiClient, appName: string, machineId: string): Promise<void> {
  const res = await request(
    client,
    "POST",
    `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/stop`,
  );
  if (!res.ok) await throwFromResponse(res, `POST /apps/${appName}/machines/${machineId}/stop`);
}

/** `DELETE /v1/apps/<app>/machines/<id>?force=true` -- full teardown. */
export async function destroyMachine(client: FlyApiClient, appName: string, machineId: string): Promise<void> {
  const res = await request(
    client,
    "DELETE",
    `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}?force=true`,
  );
  if (!res.ok && res.status !== 404) {
    await throwFromResponse(res, `DELETE /apps/${appName}/machines/${machineId}`);
  }
}

/**
 * `POST /v1/apps/<app>/machines/<id>/suspend` -- persist memory state + stop
 * the vCPU. Calling `startMachine` later resumes from the suspended state.
 * This is Fly's answer to a VM snapshot primitive; see
 * https://fly.io/docs/machines/api/machines-resource/#suspend-a-machine.
 */
export async function suspendMachine(client: FlyApiClient, appName: string, machineId: string): Promise<void> {
  const res = await request(
    client,
    "POST",
    `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/suspend`,
  );
  if (!res.ok) await throwFromResponse(res, `POST /apps/${appName}/machines/${machineId}/suspend`);
}

// ── Internals ──────────────────────────────────────────────────────────────

async function request(
  client: FlyApiClient,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `${FLY_API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), client.timeoutMs);
  try {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${client.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: controller.signal,
    };
    if (body !== undefined) {
      (init as { body?: string }).body = JSON.stringify(body);
    }
    return await client.fetchFn(url, init);
  } finally {
    clearTimeout(timer);
  }
}

async function throwFromResponse(res: Response, endpoint: string): Promise<never> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* ignore; fall through with empty body */
  }
  throw new FlyApiError(res.status, endpoint, text);
}
