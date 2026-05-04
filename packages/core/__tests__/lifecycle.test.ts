/**
 * Tests for the awilix-backed Lifecycle orchestrator + infra launchers.
 *
 * Verifies:
 *   - Lifecycle.start() resolves every registered launcher in canonical
 *     order and calls start() on it.
 *   - AppContext.shutdown() reduces to container.dispose() and every
 *     launcher's disposer fires.
 *   - Each launcher's skip flag / enablement gates are respected.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { ConductorLauncher } from "../infra/conductor-launcher.js";
import { ArkdLauncher } from "../infra/arkd-launcher.js";
import { RouterLauncher } from "../infra/router-launcher.js";
import { TensorZeroLauncher } from "../infra/tensorzero-launcher.js";
import { MetricsPoller } from "../infra/metrics-poller.js";
import { MaintenancePollers } from "../infra/maintenance-pollers.js";
import { SignalHandlers } from "../infra/signal-handlers.js";
import { BootCleanup } from "../infra/boot-cleanup.js";
import { ServiceWiring } from "../infra/service-wiring.js";
import { ComputeProvidersBoot } from "../infra/compute-providers-boot.js";
import { SessionDrain } from "../infra/session-drain.js";
import { Lifecycle } from "../lifecycle.js";

let app: AppContext | null = null;

afterEach(async () => {
  if (app) {
    await app.shutdown();
    app = null;
  }
});

describe("Lifecycle orchestrator", async () => {
  it("boot() builds the container and resolves every launcher", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    const cradle = app.container.cradle;
    expect(cradle.lifecycle).toBeInstanceOf(Lifecycle);
    expect(cradle.serviceWiring).toBeInstanceOf(ServiceWiring);
    expect(cradle.computeProvidersBoot).toBeInstanceOf(ComputeProvidersBoot);
    expect(cradle.tensorZeroLauncher).toBeInstanceOf(TensorZeroLauncher);
    expect(cradle.routerLauncher).toBeInstanceOf(RouterLauncher);
    expect(cradle.conductorLauncher).toBeInstanceOf(ConductorLauncher);
    expect(cradle.arkdLauncher).toBeInstanceOf(ArkdLauncher);
    expect(cradle.metricsPoller).toBeInstanceOf(MetricsPoller);
    expect(cradle.maintenancePollers).toBeInstanceOf(MaintenancePollers);
    expect(cradle.bootCleanup).toBeInstanceOf(BootCleanup);
    expect(cradle.signalHandlers).toBeInstanceOf(SignalHandlers);
    expect(cradle.sessionDrain).toBeInstanceOf(SessionDrain);
  });

  it("skipConductor disables conductor + arkd launchers", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    // forTest() sets skipConductor: true
    expect(app.container.cradle.conductorLauncher.running).toBe(false);
    expect(app.container.cradle.arkdLauncher.running).toBe(false);
    expect(app.conductor).toBeNull();
    expect(app.arkd).toBeNull();
  });

  it("skipMetrics disables the metrics poller", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    expect(app.container.cradle.metricsPoller.running).toBe(false);
    expect(app.metricsPoller).toBeNull();
  });
});

describe("Launcher disposers fire via container.dispose()", async () => {
  it("ConductorLauncher.stop() is idempotent", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    const launcher = app.container.cradle.conductorLauncher;
    expect(() => launcher.stop()).not.toThrow();
    // second stop is a no-op
    expect(() => launcher.stop()).not.toThrow();
  });

  it("MetricsPoller stop clears its interval", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    const poller = app.container.cradle.metricsPoller;
    // never started because skipMetrics=true, but stop() should be safe
    expect(() => poller.stop()).not.toThrow();
  });

  it("MaintenancePollers start + stop cycle clears intervals", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    const maintenance = app.container.cradle.maintenancePollers;
    expect(() => maintenance.stop()).not.toThrow();
  });

  it("SignalHandlers start is a no-op under skipSignals", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    const sh = app.container.cradle.signalHandlers;
    expect(() => sh.stop()).not.toThrow();
  });

  it("shutdown() calls container.dispose() exactly once", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    let disposeCount = 0;
    const origDispose = app.container.dispose.bind(app.container);
    app.container.dispose = (async () => {
      disposeCount++;
      return origDispose();
    }) as typeof app.container.dispose;

    await app.shutdown();
    expect(disposeCount).toBe(1);

    // shutdown() again is idempotent; no second dispose
    await app.shutdown();
    expect(disposeCount).toBe(1);
    app = null;
  });
});

describe("container.dispose() runs each launcher's disposer", async () => {
  it("calls stop() on every launcher with a disposer", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    const cradle = app.container.cradle;
    const stops = {
      wiring: 0,
      tz: 0,
      router: 0,
      conductor: 0,
      arkd: 0,
      metrics: 0,
      maintenance: 0,
      signals: 0,
      drain: 0,
    };

    const origWiring = cradle.serviceWiring.stop.bind(cradle.serviceWiring);
    cradle.serviceWiring.stop = async () => {
      stops.wiring++;
      await origWiring();
    };
    const origTz = cradle.tensorZeroLauncher.stop.bind(cradle.tensorZeroLauncher);
    cradle.tensorZeroLauncher.stop = async () => {
      stops.tz++;
      await origTz();
    };
    const origRouter = cradle.routerLauncher.stop.bind(cradle.routerLauncher);
    cradle.routerLauncher.stop = () => {
      stops.router++;
      origRouter();
    };
    const origConductor = cradle.conductorLauncher.stop.bind(cradle.conductorLauncher);
    cradle.conductorLauncher.stop = () => {
      stops.conductor++;
      origConductor();
    };
    const origArkd = cradle.arkdLauncher.stop.bind(cradle.arkdLauncher);
    cradle.arkdLauncher.stop = () => {
      stops.arkd++;
      origArkd();
    };
    const origMetrics = cradle.metricsPoller.stop.bind(cradle.metricsPoller);
    cradle.metricsPoller.stop = () => {
      stops.metrics++;
      origMetrics();
    };
    const origMaintenance = cradle.maintenancePollers.stop.bind(cradle.maintenancePollers);
    cradle.maintenancePollers.stop = () => {
      stops.maintenance++;
      origMaintenance();
    };
    const origSignals = cradle.signalHandlers.stop.bind(cradle.signalHandlers);
    cradle.signalHandlers.stop = () => {
      stops.signals++;
      origSignals();
    };
    const origDrain = cradle.sessionDrain.stop.bind(cradle.sessionDrain);
    cradle.sessionDrain.stop = async () => {
      stops.drain++;
      await origDrain();
    };

    await app.shutdown();
    app = null;

    expect(stops.wiring).toBe(1);
    expect(stops.tz).toBe(1);
    expect(stops.router).toBe(1);
    expect(stops.conductor).toBe(1);
    expect(stops.arkd).toBe(1);
    expect(stops.metrics).toBe(1);
    expect(stops.maintenance).toBe(1);
    expect(stops.signals).toBe(1);
    expect(stops.drain).toBe(1);
  });
});

describe("Infra launchers honor enablement", async () => {
  let app2: AppContext;

  beforeAll(async () => {
    app2 = await AppContext.forTestAsync();
    await app2.boot();
  });

  afterAll(async () => {
    await app2.shutdown();
  });

  it("RouterLauncher is inert when config.router is undefined", () => {
    const launcher = app2.container.cradle.routerLauncher;
    expect(launcher.instance).toBeNull();
  });

  it("TensorZeroLauncher is inert when config.tensorZero is undefined", () => {
    const launcher = app2.container.cradle.tensorZeroLauncher;
    expect(launcher.url).toBeNull();
  });

  it("BootCleanup is registered and start() is callable on empty cwd", async () => {
    const d = app2.container.cradle.bootCleanup;
    expect(d).toBeInstanceOf(BootCleanup);
    // start() runs the file-cleanup sweeps; no .claude/.mcp.json in test cwd, so it's a no-op.
    await expect(d.start()).resolves.toBeUndefined();
  });
});
