/**
 * Firecracker VM lifecycle tests.
 *
 * We stub the two externally-observable sides of the VM: the `firecracker`
 * subprocess spawn (we fake a PID and a touch-file that `waitForSocket`
 * picks up) and the API socket (we record every request instead of
 * actually writing to a unix socket).
 *
 * A real VM never boots in these tests -- the validation target is the
 * `spec -> sequence of API calls` mapping plus the lifecycle state
 * transitions (start/stop/pause/resume/snapshot/restore).
 *
 * Real-VM behavior lives in a separate integration suite gated on a Linux
 * host with KVM. See `compute-runtime-vision.md`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ChildProcess } from "child_process";

import {
  __resetFirecrackerHooksForTesting,
  __setFirecrackerHooksForTesting,
  createVm,
  deriveMac,
  parseHttpResponse,
} from "../firecracker/vm.js";

let sandbox: string;
let kernelPath: string;
let rootfsPath: string;

/** Record of every API call in the order it was made. */
interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}
let calls: RecordedCall[] = [];

/**
 * Fake ChildProcess -- extends EventEmitter so listeners for "exit"/"close"
 * work. We implement just enough for the VM's stop() path: `kill(signal)`
 * emits exit after a configurable delay.
 */
class FakeChild extends EventEmitter {
  public pid: number;
  public killed = false;
  public exitCode: number | null = null;
  constructor(
    pid: number,
    private killDelayMs = 10,
  ) {
    super();
    this.pid = pid;
  }
  kill(signal?: string): boolean {
    if (this.killed) return true;
    this.killed = true;
    // Emit "exit" shortly after kill. For SIGKILL we pretend it's instant.
    const delay = signal === "SIGKILL" ? 0 : this.killDelayMs;
    setTimeout(() => {
      this.exitCode = signal === "SIGKILL" ? 137 : 143;
      this.emit("exit", this.exitCode, signal);
      this.emit("close", this.exitCode);
    }, delay);
    return true;
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "fc-vm-"));
  kernelPath = join(sandbox, "vmlinux");
  rootfsPath = join(sandbox, "rootfs.ext4");
  writeFileSync(kernelPath, "fake-kernel");
  writeFileSync(rootfsPath, "fake-rootfs");
  calls = [];

  __setFirecrackerHooksForTesting({
    spawnFirecracker: (_args, socketPath) => {
      // Touch the socket file so waitForSocket() resolves immediately.
      // Firecracker's real socket is a UDS, but the VM only checks for
      // file existence, so a plain file is indistinguishable here.
      mkdirSync(join(socketPath, ".."), { recursive: true });
      writeFileSync(socketPath, "");
      const child = new FakeChild(4242);
      return { pid: 4242, process: child as unknown as ChildProcess };
    },
    sendApiRequest: async (_socket, method, path, body) => {
      calls.push({ method, path, body });
      return { status: 204, body: "" };
    },
    readArpTable: async () =>
      [
        "IP address       HW type     Flags       HW address            Mask     Device",
        "192.168.127.2    0x1         0x2         aa:bb:cc:dd:ee:ff     *        fc-test",
        "10.0.0.1         0x1         0x0         00:00:00:00:00:00     *        fc-incomplete",
      ].join("\n"),
  });
});

afterEach(() => {
  __resetFirecrackerHooksForTesting();
  rmSync(sandbox, { recursive: true, force: true });
});

describe("createVm().start()", async () => {
  it("issues boot-source, rootfs, machine-config, network-iface, InstanceStart in order", async () => {
    const vm = createVm({
      id: "test",
      kernelPath,
      rootfsPath,
      vcpuCount: 4,
      memMib: 2048,
    });
    await vm.start();

    // Extract just (method, path) tuples for ordering.
    const sequence = calls.map((c) => `${c.method} ${c.path}`);
    expect(sequence).toEqual([
      "PUT /boot-source",
      "PUT /drives/rootfs",
      "PUT /machine-config",
      "PUT /network-interfaces/eth0",
      "PUT /actions",
    ]);
  });

  it("maps spec fields to API bodies correctly", async () => {
    const vm = createVm({
      id: "test",
      kernelPath,
      rootfsPath,
      readOnlyRootfs: true,
      vcpuCount: 8,
      memMib: 4096,
      bootArgs: "custom=1",
      networkTapName: "fc-custom",
    });
    await vm.start();

    const byPath = (p: string) => calls.find((c) => c.path === p);

    const boot = byPath("/boot-source")?.body as { kernel_image_path: string; boot_args: string };
    expect(boot.kernel_image_path).toBe(kernelPath);
    expect(boot.boot_args).toBe("custom=1");

    const root = byPath("/drives/rootfs")?.body as {
      is_read_only: boolean;
      is_root_device: boolean;
      path_on_host: string;
    };
    expect(root.is_read_only).toBe(true);
    expect(root.is_root_device).toBe(true);
    expect(root.path_on_host).toBe(rootfsPath);

    const mc = byPath("/machine-config")?.body as { vcpu_count: number; mem_size_mib: number };
    expect(mc.vcpu_count).toBe(8);
    expect(mc.mem_size_mib).toBe(4096);

    const net = byPath("/network-interfaces/eth0")?.body as {
      host_dev_name: string;
      iface_id: string;
      guest_mac: string;
    };
    expect(net.host_dev_name).toBe("fc-custom");
    expect(net.iface_id).toBe("eth0");
    expect(net.guest_mac).toMatch(/^aa(:[0-9a-f]{2}){5}$/);

    const action = byPath("/actions")?.body as { action_type: string };
    expect(action.action_type).toBe("InstanceStart");
  });

  it("applies defaults (2 vcpu, 1024 MiB, default bootArgs, default tap name) when unset", async () => {
    const vm = createVm({ id: "defaults", kernelPath, rootfsPath });
    await vm.start();
    const byPath = (p: string) => calls.find((c) => c.path === p);

    expect((byPath("/machine-config")?.body as { vcpu_count: number }).vcpu_count).toBe(2);
    expect((byPath("/machine-config")?.body as { mem_size_mib: number }).mem_size_mib).toBe(1024);
    expect((byPath("/boot-source")?.body as { boot_args: string }).boot_args).toBe(
      "console=ttyS0 reboot=k panic=1 pci=off",
    );
    expect((byPath("/network-interfaces/eth0")?.body as { host_dev_name: string }).host_dev_name).toBe("fc-defaults");
    expect((byPath("/drives/rootfs")?.body as { is_read_only: boolean }).is_read_only).toBe(false);
  });

  it("issues an additional drive PUT for each extraDrive", async () => {
    const extraPath = join(sandbox, "data.ext4");
    writeFileSync(extraPath, "");
    const vm = createVm({
      id: "with-extra",
      kernelPath,
      rootfsPath,
      extraDrives: [{ driveId: "data", path: extraPath, readOnly: false }],
    });
    await vm.start();

    const sequence = calls.map((c) => `${c.method} ${c.path}`);
    // rootfs drive still comes first; extra drive follows; then machine-config.
    const rootfsIdx = sequence.indexOf("PUT /drives/rootfs");
    const dataIdx = sequence.indexOf("PUT /drives/data");
    const mcIdx = sequence.indexOf("PUT /machine-config");
    expect(rootfsIdx).toBeGreaterThan(-1);
    expect(dataIdx).toBeGreaterThan(rootfsIdx);
    expect(mcIdx).toBeGreaterThan(dataIdx);

    const extra = calls.find((c) => c.path === "/drives/data")?.body as {
      drive_id: string;
      path_on_host: string;
      is_root_device: boolean;
      is_read_only: boolean;
    };
    expect(extra.drive_id).toBe("data");
    expect(extra.path_on_host).toBe(extraPath);
    expect(extra.is_root_device).toBe(false);
    expect(extra.is_read_only).toBe(false);
  });

  it("throws a readable error when the kernel file is missing", async () => {
    const vm = createVm({
      id: "bad-kernel",
      kernelPath: join(sandbox, "does-not-exist"),
      rootfsPath,
    });
    (await expect(vm.start())).rejects.toThrow(/kernel not found/i);
  });

  it("throws a readable error when the rootfs file is missing", async () => {
    const vm = createVm({
      id: "bad-rootfs",
      kernelPath,
      rootfsPath: join(sandbox, "does-not-exist"),
    });
    (await expect(vm.start())).rejects.toThrow(/rootfs not found/i);
  });

  it("throws when Firecracker returns a non-2xx response", async () => {
    __setFirecrackerHooksForTesting({
      spawnFirecracker: (_args, socketPath) => {
        writeFileSync(socketPath, "");
        return { pid: 1, process: new FakeChild(1) as unknown as ChildProcess };
      },
      sendApiRequest: async () => ({ status: 400, body: '{"fault_message":"boom"}' }),
      readArpTable: async () => "",
    });
    const vm = createVm({ id: "err", kernelPath, rootfsPath });
    (await expect(vm.start())).rejects.toThrow(/400.*boom/);
  });
});

describe("pause / resume", async () => {
  it("PATCHes /vm with the correct state", async () => {
    const vm = createVm({ id: "pr", kernelPath, rootfsPath });
    await vm.start();
    calls.length = 0;

    await vm.pause();
    await vm.resume();

    expect(calls).toEqual([
      { method: "PATCH", path: "/vm", body: { state: "Paused" } },
      { method: "PATCH", path: "/vm", body: { state: "Resumed" } },
    ]);
  });
});

describe("snapshot / restore", async () => {
  it("pauses the VM then issues /snapshot/create with the right paths", async () => {
    const vm = createVm({ id: "snap", kernelPath, rootfsPath });
    await vm.start();
    calls.length = 0;

    const memFile = join(sandbox, "mem");
    const stateFile = join(sandbox, "state");
    const artifacts = await vm.snapshot({ memFilePath: memFile, stateFilePath: stateFile });
    expect(artifacts).toEqual({ memFilePath: memFile, stateFilePath: stateFile });

    expect(calls[0]).toEqual({ method: "PATCH", path: "/vm", body: { state: "Paused" } });
    expect(calls[1]).toMatchObject({
      method: "PUT",
      path: "/snapshot/create",
      body: {
        snapshot_type: "Full",
        snapshot_path: stateFile,
        mem_file_path: memFile,
      },
    });
  });

  it("respects snapshotType=Diff", async () => {
    const vm = createVm({ id: "snap-diff", kernelPath, rootfsPath });
    await vm.start();
    calls.length = 0;

    await vm.snapshot({
      memFilePath: join(sandbox, "m"),
      stateFilePath: join(sandbox, "s"),
      snapshotType: "Diff",
    });
    const create = calls.find((c) => c.path === "/snapshot/create")?.body as { snapshot_type: string };
    expect(create.snapshot_type).toBe("Diff");
  });

  it("restore issues /snapshot/load and resumes", async () => {
    const memFile = join(sandbox, "mem");
    const stateFile = join(sandbox, "state");
    writeFileSync(memFile, "");
    writeFileSync(stateFile, "");

    const vm = createVm({ id: "restore", kernelPath, rootfsPath });
    await vm.restore({ memFilePath: memFile, stateFilePath: stateFile });

    const sequence = calls.map((c) => `${c.method} ${c.path}`);
    expect(sequence).toEqual(["PUT /snapshot/load", "PATCH /vm"]);
    const load = calls[0].body as {
      snapshot_path: string;
      mem_backend: { backend_type: string; backend_path: string };
    };
    expect(load.snapshot_path).toBe(stateFile);
    expect(load.mem_backend.backend_type).toBe("File");
    expect(load.mem_backend.backend_path).toBe(memFile);

    const resume = calls[1].body as { state: string };
    expect(resume.state).toBe("Resumed");
  });

  it("restore throws if the snapshot files are missing", async () => {
    const vm = createVm({ id: "restore-bad", kernelPath, rootfsPath });
    (
      await expect(vm.restore({ memFilePath: join(sandbox, "nope-mem"), stateFilePath: join(sandbox, "nope-state") }))
    ).rejects.toThrow(/snapshot memory file not found/);
  });
});

describe("stop", async () => {
  it("sends SIGTERM and waits for exit", async () => {
    const vm = createVm({ id: "stop", kernelPath, rootfsPath });
    await vm.start();
    // pid is reported from the fake spawn hook
    expect(vm.pid).toBe(4242);

    await vm.stop();
    // A second stop is a no-op (child cleared after first).
    await vm.stop();
  });

  it("escalates to SIGKILL if SIGTERM is ignored", async () => {
    const ignoredChild = new (class extends FakeChild {
      // Override kill to ignore SIGTERM so the VM has to escalate.
      override kill(signal?: string): boolean {
        if (signal === "SIGTERM") return true; // swallow
        return super.kill(signal);
      }
    })(9999, 0);

    __setFirecrackerHooksForTesting({
      spawnFirecracker: (_args, socketPath) => {
        writeFileSync(socketPath, "");
        return { pid: 9999, process: ignoredChild as unknown as ChildProcess };
      },
      sendApiRequest: async (_s, method, path, body) => {
        calls.push({ method, path, body });
        return { status: 204, body: "" };
      },
      readArpTable: async () => "",
    });

    const vm = createVm({ id: "kill", kernelPath, rootfsPath });
    await vm.start();

    // Override the waiter to avoid waiting the full 5s. The implementation
    // waits 5s before SIGKILL; that's too slow for unit tests. Instead we
    // fast-path here by letting the stop kick off and using Promise.race
    // against a timeout that asserts eventual SIGKILL.
    const start = Date.now();
    await vm.stop();
    const elapsed = Date.now() - start;
    // Must have waited the 5s SIGTERM grace before SIGKILL succeeded.
    expect(elapsed).toBeGreaterThanOrEqual(4000);
    expect(ignoredChild.exitCode).toBe(137);
  }, 10_000);
});

describe("getGuestIp", async () => {
  it("returns the ARP entry matching the tap name", async () => {
    const vm = createVm({ id: "test", kernelPath, rootfsPath, networkTapName: "fc-test" });
    // No need to start -- ARP lookup is independent of VM state.
    const ip = await vm.getGuestIp();
    expect(ip).toBe("192.168.127.2");
  });

  it("returns null when the tap has no ARP entry", async () => {
    const vm = createVm({ id: "unknown", kernelPath, rootfsPath, networkTapName: "fc-nothing" });
    const ip = await vm.getGuestIp();
    expect(ip).toBeNull();
  });

  it("skips incomplete ARP entries (flags=0x0)", async () => {
    __setFirecrackerHooksForTesting({
      readArpTable: async () =>
        [
          "IP address       HW type     Flags       HW address            Mask     Device",
          "10.0.0.99        0x1         0x0         00:00:00:00:00:00     *        fc-test",
        ].join("\n"),
      spawnFirecracker: (_args, socketPath) => {
        writeFileSync(socketPath, "");
        return { pid: 1, process: new FakeChild(1) as unknown as ChildProcess };
      },
      sendApiRequest: async () => ({ status: 204, body: "" }),
    });
    const vm = createVm({ id: "test", kernelPath, rootfsPath, networkTapName: "fc-test" });
    expect(await vm.getGuestIp()).toBeNull();
  });

  it("returns null if ARP table read fails", async () => {
    __setFirecrackerHooksForTesting({
      readArpTable: async () => {
        throw new Error("ENOENT");
      },
      spawnFirecracker: (_args, socketPath) => {
        writeFileSync(socketPath, "");
        return { pid: 1, process: new FakeChild(1) as unknown as ChildProcess };
      },
      sendApiRequest: async () => ({ status: 204, body: "" }),
    });
    const vm = createVm({ id: "test", kernelPath, rootfsPath });
    expect(await vm.getGuestIp()).toBeNull();
  });
});

describe("deriveMac", () => {
  it("returns a locally-administered unicast MAC (first byte aa)", () => {
    expect(deriveMac("fc-a")).toMatch(/^aa(:[0-9a-f]{2}){5}$/);
  });
  it("is deterministic", () => {
    expect(deriveMac("fc-stable")).toBe(deriveMac("fc-stable"));
  });
  it("differs for different inputs", () => {
    expect(deriveMac("fc-a")).not.toBe(deriveMac("fc-b"));
  });
});

describe("parseHttpResponse", () => {
  it("parses a 204 no-body response", () => {
    const res = parseHttpResponse("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
    expect(res).toEqual({ status: 204, body: "" });
  });

  it("parses a JSON body", () => {
    const res = parseHttpResponse(
      "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 22\r\n\r\n" +
        '{"fault_message":"x"}',
    );
    expect(res?.status).toBe(400);
    expect(res?.body).toBe('{"fault_message":"x"}');
  });

  it("returns null on malformed input", () => {
    expect(parseHttpResponse("not an http response")).toBeNull();
    expect(parseHttpResponse("")).toBeNull();
  });
});
