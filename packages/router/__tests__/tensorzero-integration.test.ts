/**
 * TensorZero integration test.
 *
 * Requires Docker running and at least ANTHROPIC_API_KEY set.
 * Skips gracefully if prerequisites are not available.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { TensorZeroManager } from "../../core/router/tensorzero.js";

// Check prerequisites
let hasDocker = false;
try {
  execFileSync("docker", ["info"], { stdio: "pipe" });
  hasDocker = true;
} catch {
  /* Docker not available */
}

const hasKey = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!hasDocker || !hasKey)("TensorZero integration", async () => {
  let manager: TensorZeroManager;

  afterAll(async () => {
    if (manager) {
      await manager.stop();
    }
  });

  test("generates valid config", async () => {
    const { generateTensorZeroConfig } = await import("../../core/router/tensorzero-config.js");

    const config = generateTensorZeroConfig({
      anthropicKey: "test-key",
      openaiKey: "test-key",
    });

    expect(config).toContain("[gateway]");
    expect(config).toContain("[models.claude-opus]");
    expect(config).toContain("[models.claude-sonnet]");
    expect(config).toContain("[models.claude-haiku]");
    expect(config).toContain("[models.gpt-4-1]");
    expect(config).toContain("[functions.chat]");
    expect(config).not.toContain("[models.gemini-pro]"); // no gemini key
  });

  test("real API call through TensorZero", async () => {
    manager = new TensorZeroManager({
      configDir: "/tmp/ark-tz-integration-test",
      anthropicKey: process.env.ANTHROPIC_API_KEY,
    });

    await manager.start();

    expect(await manager.isHealthy()).toBe(true);

    const resp = await fetch(`${manager.openaiUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku",
        messages: [{ role: "user", content: "Say hello in exactly 3 words" }],
      }),
    });

    expect(resp.ok).toBe(true);
    const data = (await resp.json()) as any;
    expect(data.choices).toBeDefined();
    expect(data.choices[0].message.content).toBeTruthy();
  }, 60_000); // 60s timeout for Docker pull + API call
});
