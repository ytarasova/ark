import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(cliDir, "commands", "session.ts"), "utf-8");

describe("spawn command wiring", () => {
  test("spawn command calls sessionSpawn, not sessionFork", () => {
    // Extract the spawn command block (stop before spawn-subagent)
    const spawnBlockMatch = source.match(/session\s*\.command\("spawn"\)([\s\S]*?)session\s*\.command\("spawn-subagent"\)/);
    expect(spawnBlockMatch).toBeTruthy();
    const spawnBlock = spawnBlockMatch![1];

    expect(spawnBlock).toContain("sessionSpawn");
    expect(spawnBlock).not.toContain("sessionFork");
  });

  test("spawn command has --agent option", () => {
    const spawnBlockMatch = source.match(/session\s*\.command\("spawn"\)([\s\S]*?)session\s*\.command\("spawn-subagent"\)/);
    expect(spawnBlockMatch).toBeTruthy();
    const spawnBlock = spawnBlockMatch![1];

    expect(spawnBlock).toContain("--agent");
  });

  test("spawn command has --model option", () => {
    const spawnBlockMatch = source.match(/session\s*\.command\("spawn"\)([\s\S]*?)session\s*\.command\("spawn-subagent"\)/);
    expect(spawnBlockMatch).toBeTruthy();
    const spawnBlock = spawnBlockMatch![1];

    expect(spawnBlock).toContain("--model");
  });

  test("spawn command has --dispatch option", () => {
    const spawnBlockMatch = source.match(/session\s*\.command\("spawn"\)([\s\S]*?)session\s*\.command\("spawn-subagent"\)/);
    expect(spawnBlockMatch).toBeTruthy();
    const spawnBlock = spawnBlockMatch![1];

    expect(spawnBlock).toContain("--dispatch");
  });

  test("spawn command passes task, agent, and model to sessionSpawn", () => {
    const spawnBlockMatch = source.match(/session\s*\.command\("spawn"\)([\s\S]*?)session\s*\.command\("spawn-subagent"\)/);
    expect(spawnBlockMatch).toBeTruthy();
    const spawnBlock = spawnBlockMatch![1];

    expect(spawnBlock).toContain("task");
    expect(spawnBlock).toContain("opts.agent");
    expect(spawnBlock).toContain("opts.model");
  });

  test("spawn command handles dispatch after spawning", () => {
    const spawnBlockMatch = source.match(/session\s*\.command\("spawn"\)([\s\S]*?)session\s*\.command\("spawn-subagent"\)/);
    expect(spawnBlockMatch).toBeTruthy();
    const spawnBlock = spawnBlockMatch![1];

    expect(spawnBlock).toContain("opts.dispatch");
    expect(spawnBlock).toContain("sessionDispatch");
  });
});
