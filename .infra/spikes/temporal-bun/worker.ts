/**
 * Ark Temporal Phase 0 spike -- can @temporalio/worker load under Bun?
 *
 * This does NOT require a running Temporal server. It only tries to:
 *   1. Dynamically import the Temporal Worker SDK.
 *   2. Bundle a trivial workflow file.
 *   3. Construct (but NOT run) a `Worker` with a made-up task queue.
 *
 * If any of the steps above throws under Bun we print the error and exit 1.
 * The surrounding shell script in scripts/spike-temporal-bun.sh captures the
 * output for the design-doc "Bun compat verified" / "Must run under Node"
 * decision.
 *
 * The failures we expect in a Bun-hostile world:
 *   - `@temporalio/core-bridge` (Rust addon via node-gyp) that references
 *     Node-specific N-API symbols Bun has not yet stubbed.
 *   - Worker's workflow bundler (webpack-based) that assumes node-specific
 *     file resolution.
 *
 * If the spike passes we still need a runtime test against a live server --
 * see .infra/docker-compose.temporal.yaml + docs/temporal-local-dev.md.
 */

/* eslint-disable no-console */

type SpikeResult = {
  step: string;
  ok: boolean;
  detail?: string;
  errorName?: string;
  errorMessage?: string;
  errorStack?: string;
};

const results: SpikeResult[] = [];

function record(step: string, ok: boolean, extras: Partial<SpikeResult> = {}): void {
  results.push({ step, ok, ...extras });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${step}${extras.detail ? ` -- ${extras.detail}` : ""}`);
  if (!ok && extras.errorMessage) {
    console.log(`       ${extras.errorName ?? "Error"}: ${extras.errorMessage}`);
  }
}

async function main(): Promise<number> {
  // Step 1: dynamic import of @temporalio/worker.
  let workerModule: typeof import("@temporalio/worker") | null = null;
  try {
    workerModule = await import("@temporalio/worker");
    record("import @temporalio/worker", true, {
      detail: `exports: ${Object.keys(workerModule).slice(0, 8).join(", ")}...`,
    });
  } catch (err: any) {
    record("import @temporalio/worker", false, {
      errorName: err?.name,
      errorMessage: err?.message,
      errorStack: err?.stack,
    });
    return 1;
  }

  // Step 2: dynamic import of @temporalio/workflow + activity + client.
  for (const pkg of ["@temporalio/workflow", "@temporalio/activity", "@temporalio/client"]) {
    try {
      await import(pkg);
      record(`import ${pkg}`, true);
    } catch (err: any) {
      record(`import ${pkg}`, false, {
        errorName: err?.name,
        errorMessage: err?.message,
        errorStack: err?.stack,
      });
    }
  }

  // Step 3: bundle a workflow file. This is the hottest path for Bun
  // incompatibility because Worker internally runs webpack.
  try {
    const { bundleWorkflowCode } = workerModule;
    const bundle = await bundleWorkflowCode({
      workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
    });
    record("bundleWorkflowCode(workflows.ts)", true, {
      detail: `bundled ${bundle.code.length} bytes`,
    });
  } catch (err: any) {
    record("bundleWorkflowCode(workflows.ts)", false, {
      errorName: err?.name,
      errorMessage: err?.message,
      errorStack: err?.stack,
    });
  }

  // Step 4: construct a Worker instance. This exercises the native core-bridge
  // NAPI addon load under Bun -- the most likely failure surface.
  //
  // Temporal's Worker.create() ALWAYS tries to open a connection (defaults to
  // localhost:7233 when `connection` is undefined). We expect that call to
  // fail with a transport error if no server is running. That's fine for the
  // spike -- it still proves the native bridge loaded. We classify the
  // outcome into three buckets:
  //
  //   a) success  -> SDK works under Bun end-to-end.
  //   b) TransportError / ConnectionRefused -> native bridge LOADED, but no
  //      server. This is still a Bun-compat PASS for Phase 0: we proved we
  //      can reach the network layer.
  //   c) Any other error (native module crash, symbol missing, etc.) -> FAIL.
  try {
    const { Worker } = workerModule;
    const worker = await Worker.create({
      workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
      activities: {
        ping: async () => "pong",
      },
      taskQueue: "ark-phase0-spike",
    });
    record("Worker.create (with connect)", true, {
      detail: `worker ready, task queue=ark-phase0-spike`,
    });
    worker.shutdown();
  } catch (err: any) {
    const msg = String(err?.message ?? "");
    const isTransport =
      err?.name === "TransportError" ||
      msg.includes("ConnectionRefused") ||
      msg.includes("Connection refused") ||
      msg.includes("tcp connect error");
    if (isTransport) {
      // Native bridge loaded; we hit the network. Treat as PASS for Bun compat,
      // but annotate so the reader knows we didn't do a full end-to-end run.
      record("Worker.create (with connect)", true, {
        detail: "native bridge LOADED; transport error (expected -- no local Temporal server)",
      });
    } else {
      record("Worker.create (with connect)", false, {
        errorName: err?.name,
        errorMessage: err?.message,
        errorStack: err?.stack,
      });
    }
  }

  // Runtime banner so the surrounding shell can tell what JS engine ran us.
  const runtime =
    typeof (globalThis as any).Bun !== "undefined"
      ? `Bun ${(globalThis as any).Bun.version}`
      : `Node ${process.version}`;
  console.log("");
  console.log(`Runtime: ${runtime}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log("");

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`SPIKE RESULT: FAIL (${failed.length}/${results.length} steps failed)`);
    console.log("Recommendation: run worker under Node. Keep conductor/arkd under Bun.");
    return 1;
  }
  console.log(`SPIKE RESULT: PASS (${results.length} steps passed)`);
  console.log("Recommendation: Bun-native worker is viable; revisit if upstream regresses.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("unhandled spike error:", err);
    process.exit(2);
  });
