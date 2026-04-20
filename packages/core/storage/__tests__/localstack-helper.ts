/**
 * LocalStack test helper -- boots a disposable LocalStack container so
 * `S3BlobStore` can be exercised against a live (local) S3 API without
 * reaching out to real AWS.
 *
 * Usage:
 *
 *   let ls: Awaited<ReturnType<typeof startLocalStack>>;
 *   beforeAll(async () => { ls = await startLocalStack(); });
 *   afterAll(async () => { await ls?.stop(); });
 *
 * If Docker is unavailable the helper throws `DockerUnavailableError` so
 * the caller can gate `describe.skip(...)`.
 */

import { randomBytes } from "crypto";

/** Thrown when `docker ps` fails, meaning the daemon isn't reachable. */
export class DockerUnavailableError extends Error {
  constructor(cause?: string) {
    super(`docker is not available on this host${cause ? `: ${cause}` : ""}`);
    this.name = "DockerUnavailableError";
  }
}

export interface LocalStackHandle {
  /** HTTP endpoint URL for pointing the S3 client at (e.g. http://127.0.0.1:12345). */
  endpoint: string;
  /** Pre-created bucket name. */
  bucket: string;
  /** Container name (for debugging). */
  container: string;
  /** Stop + remove the container, best-effort cleanup. */
  stop: () => Promise<void>;
}

/** LocalStack image tag. Pinned so CI doesn't drift underneath us. */
export const LOCALSTACK_IMAGE = "localstack/localstack:3.8";

/** Max time to wait for LocalStack's S3 service to report healthy. */
const HEALTH_TIMEOUT_MS = 30_000;
/** Poll interval while waiting on health. */
const HEALTH_POLL_MS = 200;

/** Check whether the Docker daemon is reachable. */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn({
      cmd: ["docker", "ps"],
      stdout: "pipe",
      stderr: "pipe",
    });
    // Guard against a stuck docker daemon -- bail after 5s, treat as
    // unavailable. `docker ps` normally returns in <100ms; a multi-second
    // hang means something is wrong with the daemon and the tests must
    // skip rather than block the suite.
    const code = await Promise.race<number | "timeout">([
      proc.exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);
    if (code === "timeout") {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      return false;
    }
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Start a LocalStack container with SERVICES=s3 bound to a host-assigned
 * ephemeral port, wait for the S3 service to report `running`, create a
 * test bucket via the AWS SDK, and return a handle.
 */
export async function startLocalStack(): Promise<LocalStackHandle> {
  if (!(await isDockerAvailable())) {
    throw new DockerUnavailableError();
  }

  // Unique container name so parallel test files + stale containers from
  // previous runs don't collide.
  const container = `ark-localstack-test-${randomBytes(4).toString("hex")}`;

  // Let Docker pick the host port (-p 4566) so parallel workers never
  // collide -- we read the mapped port back via `docker inspect`.
  const runProc = Bun.spawn({
    cmd: [
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "-p",
      "4566",
      "-e",
      "SERVICES=s3",
      "-e",
      "DEBUG=0",
      LOCALSTACK_IMAGE,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const runStdout = await new Response(runProc.stdout).text();
  const runStderr = await new Response(runProc.stderr).text();
  const runCode = await runProc.exited;
  if (runCode !== 0) {
    throw new Error(`failed to start LocalStack: exit ${runCode}\nstdout: ${runStdout}\nstderr: ${runStderr}`);
  }

  // From here on, any failure must stop the container.
  const stop = async (): Promise<void> => {
    try {
      const killProc = Bun.spawn({
        cmd: ["docker", "rm", "-f", container],
        stdout: "pipe",
        stderr: "pipe",
      });
      await killProc.exited;
    } catch {
      // Best-effort; the container may have already exited.
    }
  };

  try {
    const hostPort = await resolveMappedPort(container, 4566);
    const endpoint = `http://127.0.0.1:${hostPort}`;
    await waitForS3Ready(endpoint);
    const bucket = `ark-blob-test-${randomBytes(4).toString("hex")}`;
    await createBucket(endpoint, bucket);
    return { endpoint, bucket, container, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Read the host port Docker mapped for a container's exposed port. */
async function resolveMappedPort(container: string, containerPort: number): Promise<number> {
  // `docker inspect --format='{{ (index (index .NetworkSettings.Ports "4566/tcp") 0).HostPort }}'`
  // is racy on slow hosts -- the port block may not be populated the moment
  // `docker run -d` returns. Poll with a small budget.
  const deadline = Date.now() + 10_000;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const proc = Bun.spawn({
        cmd: [
          "docker",
          "inspect",
          "--format",
          `{{ (index (index .NetworkSettings.Ports "${containerPort}/tcp") 0).HostPort }}`,
          container,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = (await new Response(proc.stdout).text()).trim();
      const stderr = (await new Response(proc.stderr).text()).trim();
      const code = await proc.exited;
      if (code === 0 && stdout && stdout !== "<no value>") {
        const port = Number(stdout);
        if (Number.isFinite(port) && port > 0) return port;
      }
      lastErr = new Error(`docker inspect rc=${code} stdout=${stdout} stderr=${stderr}`);
    } catch (err) {
      lastErr = err as Error;
    }
    await Bun.sleep(HEALTH_POLL_MS);
  }
  throw new Error(`could not resolve host port for container ${container}: ${lastErr?.message ?? "timeout"}`);
}

/** Poll LocalStack's health endpoint until S3 reports `running` or timeout. */
async function waitForS3Ready(endpoint: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint}/_localstack/health`);
      if (res.ok) {
        const body = (await res.json()) as { services?: Record<string, string> };
        const s3 = body.services?.s3;
        if (s3 === "running" || s3 === "available") return;
      }
      lastErr = new Error(`health status ${res.status}`);
    } catch (err) {
      lastErr = err as Error;
    }
    await Bun.sleep(HEALTH_POLL_MS);
  }
  throw new Error(`LocalStack S3 did not report healthy within ${HEALTH_TIMEOUT_MS}ms: ${lastErr?.message ?? ""}`);
}

/** Create a test bucket via the AWS SDK pointed at LocalStack. */
async function createBucket(endpoint: string, bucket: string): Promise<void> {
  const sdk = await import("@aws-sdk/client-s3");
  const client = new sdk.S3Client({
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  try {
    await client.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
  } finally {
    client.destroy();
  }
}

/**
 * Ensure the AWS SDK, when lazy-loaded by `S3BlobStore` without an explicit
 * client, picks up dummy credentials. LocalStack accepts anything.
 */
export function setLocalStackCredentials(): { restore: () => void } {
  const prev = {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: process.env.AWS_REGION,
  };
  process.env.AWS_ACCESS_KEY_ID = "test";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
  process.env.AWS_REGION = "us-east-1";
  return {
    restore: () => {
      if (prev.AWS_ACCESS_KEY_ID === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = prev.AWS_ACCESS_KEY_ID;
      if (prev.AWS_SECRET_ACCESS_KEY === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = prev.AWS_SECRET_ACCESS_KEY;
      if (prev.AWS_REGION === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = prev.AWS_REGION;
    },
  };
}
