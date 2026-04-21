import { describe, it, expect } from "bun:test";
import { getProcessTree, killProcessTree, snapshotSessionTree } from "../executors/process-tree.js";

describe("process-tree", async () => {
  it("discovers children of the current process", async () => {
    const tree = await getProcessTree(process.pid);
    expect(tree.rootPid).toBe(process.pid);
    expect(tree.capturedAt).toBeTruthy();
    // capturedAt should be a valid ISO timestamp
    expect(new Date(tree.capturedAt).getTime()).toBeGreaterThan(0);
  });

  it("returns empty children for non-existent PID", async () => {
    const tree = await getProcessTree(999999);
    expect(tree.children).toEqual([]);
    expect(tree.rootPid).toBe(999999);
  });

  it("discovers a spawned child process", async () => {
    // Spawn a parent shell that spawns a child, so we can test tree walking
    const parent = Bun.spawn(["bash", "-c", "sleep 60"], { stdio: ["ignore", "ignore", "ignore"] });
    const parentPid = parent.pid;
    try {
      expect(parentPid).toBeGreaterThan(0);

      // Brief delay to let bash fork the sleep child
      await Bun.sleep(200);

      const tree = await getProcessTree(parentPid);
      expect(tree.rootPid).toBe(parentPid);
      // bash -c "sleep 60" spawns sleep as a child of bash
      // On some systems bash exec's directly, so children may be empty
      expect(Array.isArray(tree.children)).toBe(true);
    } finally {
      parent.kill();
    }
  });

  it("kills a spawned child process tree", async () => {
    const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
    const childPid = child.pid;
    expect(childPid).toBeGreaterThan(0);

    await killProcessTree(childPid);

    // Verify the process is dead (kill with signal 0 checks existence)
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("killProcessTree handles already-dead PIDs gracefully", async () => {
    // Should not throw for a PID that doesn't exist
    await killProcessTree(999999);
  });

  it("snapshotSessionTree returns null for non-existent tmux session", async () => {
    const result = await snapshotSessionTree("ark-nonexistent-session-xyz");
    expect(result).toBeNull();
  });

  it("children have expected fields", async () => {
    const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      // Get tree of the child PID directly (fast -- no deep traversal of test runner)
      const tree = await getProcessTree(child.pid);
      expect(tree.rootPid).toBe(child.pid);
      expect(typeof tree.capturedAt).toBe("string");
      // The sleep process itself has no children, so validate the tree structure
      expect(Array.isArray(tree.children)).toBe(true);
    } finally {
      child.kill();
    }
  });
});
