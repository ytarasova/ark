/**
 * Unit tests for TensorZero config generator.
 *
 * These tests run without Docker or API keys.
 */

import { describe, test, expect } from "bun:test";
import { generateTensorZeroConfig } from "../tensorzero-config.js";

describe("generateTensorZeroConfig", () => {
  test("generates gateway section with default port", () => {
    const config = generateTensorZeroConfig({});
    expect(config).toContain(`[gateway]`);
    expect(config).toContain(`bind_address = "0.0.0.0:3000"`);
  });

  test("uses custom port", () => {
    const config = generateTensorZeroConfig({ port: 4000 });
    expect(config).toContain(`bind_address = "0.0.0.0:4000"`);
  });

  test("includes postgres when URL provided", () => {
    const config = generateTensorZeroConfig({ postgresUrl: "postgres://user:pass@host:5432/db" });
    expect(config).toContain(`[postgres]`);
    expect(config).toContain(`connection_string = "postgres://user:pass@host:5432/db"`);
  });

  test("omits postgres when no URL", () => {
    const config = generateTensorZeroConfig({});
    expect(config).not.toContain(`[postgres]`);
  });

  test("generates Anthropic models when key provided", () => {
    const config = generateTensorZeroConfig({ anthropicKey: "sk-ant-test" });
    expect(config).toContain(`[models.claude-opus]`);
    expect(config).toContain(`model_name = "claude-opus-4-6"`);
    expect(config).toContain(`[models.claude-sonnet]`);
    expect(config).toContain(`model_name = "claude-sonnet-4-6"`);
    expect(config).toContain(`[models.claude-haiku]`);
    expect(config).toContain(`model_name = "claude-haiku-4-5"`);
    expect(config).toContain(`type = "anthropic"`);
    expect(config).toContain(`api_key_location = "env::ANTHROPIC_API_KEY"`);
  });

  test("omits Anthropic models when no key", () => {
    const config = generateTensorZeroConfig({});
    expect(config).not.toContain(`[models.claude-opus]`);
    expect(config).not.toContain(`[models.claude-sonnet]`);
  });

  test("generates OpenAI models when key provided", () => {
    const config = generateTensorZeroConfig({ openaiKey: "sk-test" });
    expect(config).toContain(`[models.gpt-4-1]`);
    expect(config).toContain(`model_name = "gpt-4.1"`);
    expect(config).toContain(`[models.gpt-4-1-mini]`);
    expect(config).toContain(`model_name = "gpt-4.1-mini"`);
    expect(config).toContain(`[models.gpt-4-1-nano]`);
    expect(config).toContain(`model_name = "gpt-4.1-nano"`);
    expect(config).toContain(`type = "openai"`);
    expect(config).toContain(`api_key_location = "env::OPENAI_API_KEY"`);
  });

  test("generates Google models when key provided", () => {
    const config = generateTensorZeroConfig({ geminiKey: "AIza-test" });
    expect(config).toContain(`[models.gemini-pro]`);
    expect(config).toContain(`model_name = "gemini-2.5-pro"`);
    expect(config).toContain(`[models.gemini-flash]`);
    expect(config).toContain(`model_name = "gemini-2.5-flash"`);
    expect(config).toContain(`type = "google_ai_studio_gemini"`);
    expect(config).toContain(`api_key_location = "env::GEMINI_API_KEY"`);
  });

  test("always includes default chat function", () => {
    const config = generateTensorZeroConfig({});
    expect(config).toContain(`[functions.chat]`);
    expect(config).toContain(`type = "chat"`);
    expect(config).toContain(`[functions.chat.variants.default]`);
    expect(config).toContain(`type = "chat_completion"`);
    expect(config).toContain(`model = "claude-sonnet"`);
  });

  test("generates all providers together", () => {
    const config = generateTensorZeroConfig({
      anthropicKey: "sk-ant-test",
      openaiKey: "sk-test",
      geminiKey: "AIza-test",
      postgresUrl: "postgres://localhost/db",
      port: 5000,
    });

    // All sections present
    expect(config).toContain(`[models.claude-opus]`);
    expect(config).toContain(`[models.gpt-4-1]`);
    expect(config).toContain(`[models.gemini-pro]`);
    expect(config).toContain(`[postgres]`);
    expect(config).toContain(`bind_address = "0.0.0.0:5000"`);
  });
});
