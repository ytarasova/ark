import { describe, it, expect } from "bun:test";
import {
  SSH_FAST_CMD,
  SSH_DOCKER_CMD,
  parseSnapshot,
  fetchMetrics,
  fetchDocker,
} from "../providers/ec2/metrics.js";

const SAMPLE_OUTPUT = `=== CPU ===
23.5
=== MEMORY ===
6144.0 16384.0
=== DISK ===
42
=== UPTIME ===
up 3 hours, 12 minutes
=== IDLE ===
2
=== TMUX ===
ark-s-abc123: 1 windows (created Fri Mar 21 14:00:00 2026)
dev-session: 1 windows (created Fri Mar 21 15:00:00 2026)
=== CLAUDE ===
ark-s-abc123\t45.2%\t8.1%\t/home/ubuntu/Projects/myapp\tagentic
dev-session\t0.3%\t2.1%\t/home/ubuntu/Projects/other\tinteractive
=== PROCESSES ===
1234\t45.2%\t8.1%\tclaude\tmyapp
5678\t12.0%\t3.2%\tnode\tother/server
=== NETWORK ===
150.3 42.1`;

describe("EC2 metrics", () => {
  // -----------------------------------------------------------------------
  // parseSnapshot - full sample
  // -----------------------------------------------------------------------
  describe("parseSnapshot", () => {
    const snap = parseSnapshot(SAMPLE_OUTPUT);

    it("parses CPU", () => {
      expect(snap.metrics.cpu).toBe(23.5);
    });

    it("parses memory", () => {
      expect(snap.metrics.memUsedGb).toBeCloseTo(6.0, 1);
      expect(snap.metrics.memTotalGb).toBeCloseTo(16.0, 1);
      expect(snap.metrics.memPct).toBeGreaterThan(0);
    });

    it("parses disk", () => {
      expect(snap.metrics.diskPct).toBe(42);
    });

    it("parses network", () => {
      expect(snap.metrics.netRxMb).toBeCloseTo(150.3, 1);
      expect(snap.metrics.netTxMb).toBeCloseTo(42.1, 1);
    });

    it("parses uptime", () => {
      expect(snap.metrics.uptime).toContain("3 hours");
    });

    it("parses idle ticks", () => {
      expect(snap.metrics.idleTicks).toBe(2);
    });

    it("parses sessions", () => {
      expect(snap.sessions).toHaveLength(2);
      const first = snap.sessions[0];
      expect(first.name).toBe("ark-s-abc123");
      expect(first.status).toBe("working");
      expect(first.mode).toBe("agentic");
      expect(first.cpu).toBe(45.2);
      expect(first.mem).toBe(8.1);

      const second = snap.sessions[1];
      expect(second.name).toBe("dev-session");
      expect(second.status).toBe("idle");
      expect(second.mode).toBe("interactive");
    });

    it("parses processes", () => {
      expect(snap.processes).toHaveLength(2);
      expect(snap.processes[0].pid).toBe("1234");
      expect(snap.processes[0].cpu).toBe("45.2%");
      expect(snap.processes[0].mem).toBe("8.1%");
      expect(snap.processes[0].command).toBe("claude");
      expect(snap.processes[0].workingDir).toBe("myapp");

      expect(snap.processes[1].pid).toBe("5678");
      expect(snap.processes[1].command).toBe("node");
      expect(snap.processes[1].workingDir).toBe("other/server");
    });
  });

  // -----------------------------------------------------------------------
  // parseSnapshot - empty / invalid input
  // -----------------------------------------------------------------------
  describe("empty input", () => {
    it("returns zero-valued snapshot for empty string", () => {
      const snap = parseSnapshot("");
      expect(snap.metrics.cpu).toBe(0);
      expect(snap.metrics.memUsedGb).toBe(0);
      expect(snap.metrics.memTotalGb).toBe(0);
      expect(snap.metrics.diskPct).toBe(0);
      expect(snap.metrics.netRxMb).toBe(0);
      expect(snap.metrics.netTxMb).toBe(0);
      expect(snap.metrics.idleTicks).toBe(0);
      expect(snap.sessions).toHaveLength(0);
      expect(snap.processes).toHaveLength(0);
      expect(snap.docker).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // parseSnapshot - ANSI sanitization
  // -----------------------------------------------------------------------
  describe("ANSI sanitization", () => {
    it("parseSnapshot strips ANSI from process command names", () => {
      const input = `=== CPU ===
10.0
=== MEMORY ===
4096.0 16384.0
=== DISK ===
20
=== UPTIME ===
up 1 hour
=== IDLE ===
0
=== TMUX ===
(none)
=== CLAUDE ===
=== PROCESSES ===
9999\t30.0%\t5.0%\t\x1b[32mclaude\x1b[0m\tmyapp
=== NETWORK ===
0.0 0.0`;

      const snap = parseSnapshot(input);
      expect(snap.processes).toHaveLength(1);
      expect(snap.processes[0].command).toBe("claude");
      expect(snap.processes[0].command).not.toContain("\x1b");
    });

    it("parseSnapshot skips processes with empty command", () => {
      const input = `=== CPU ===
10.0
=== MEMORY ===
4096.0 16384.0
=== DISK ===
20
=== UPTIME ===
up 1 hour
=== IDLE ===
0
=== TMUX ===
(none)
=== CLAUDE ===
=== PROCESSES ===
1111\t10.0%\t2.0%\t\t
2222\t20.0%\t3.0%\tnode\tserver
=== NETWORK ===
0.0 0.0`;

      const snap = parseSnapshot(input);
      expect(snap.processes).toHaveLength(1);
      expect(snap.processes[0].pid).toBe("2222");
      expect(snap.processes[0].command).toBe("node");
    });
  });

  // -----------------------------------------------------------------------
  // SSH command strings
  // -----------------------------------------------------------------------
  describe("SSH commands", () => {
    it("SSH_FAST_CMD is a non-empty string", () => {
      expect(typeof SSH_FAST_CMD).toBe("string");
      expect(SSH_FAST_CMD.length).toBeGreaterThan(0);
    });

    it("SSH_DOCKER_CMD is a non-empty string", () => {
      expect(typeof SSH_DOCKER_CMD).toBe("string");
      expect(SSH_DOCKER_CMD.length).toBeGreaterThan(0);
    });

    it("SSH_FAST_CMD includes top fallback for CPU", () => {
      expect(SSH_FAST_CMD).toContain("mpstat");
      expect(SSH_FAST_CMD).toContain("top");
    });
  });

  // -----------------------------------------------------------------------
  // Export checks
  // -----------------------------------------------------------------------
  describe("exports", () => {
    it("fetchMetrics is a function", () => {
      expect(typeof fetchMetrics).toBe("function");
    });

    it("fetchDocker is a function", () => {
      expect(typeof fetchDocker).toBe("function");
    });
  });
});
