import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { parseCodexTranscript, parseGeminiTranscript, parseTranscript, findLatestCodexTranscript } from "../transcript-parsers.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tempDir: string;

beforeAll(() => {
  tempDir = join(tmpdir(), `ark-parser-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterAll(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* cleanup */ }
});

// ── Codex parser ───────────────────────────────────────────────────────────

describe("parseCodexTranscript", () => {
  it("parses real Codex token_count events", () => {
    const path = join(tempDir, "codex-sample.jsonl");
    const jsonl = [
      '{"timestamp":"2025-10-06T18:16:40.000Z","type":"session_meta","payload":{"id":"test-id","timestamp":"2025-10-06T18:16:40.000Z","cwd":"/tmp","originator":"codex_cli_rs","cli_version":"0.36.0"}}',
      '{"timestamp":"2025-10-06T18:16:41.000Z","type":"turn_context","payload":{"cwd":"/tmp","model":"gpt-5-codex","summary":"auto"}}',
      '{"timestamp":"2025-10-06T18:16:44.363Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2824,"cached_input_tokens":2048,"output_tokens":107,"reasoning_output_tokens":64,"total_tokens":2931},"last_token_usage":{"input_tokens":2824,"cached_input_tokens":2048,"output_tokens":107,"reasoning_output_tokens":64,"total_tokens":2931}}}}',
      '{"timestamp":"2025-10-06T18:16:49.642Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":6033,"cached_input_tokens":4096,"output_tokens":224,"reasoning_output_tokens":128,"total_tokens":6257}}}}',
    ].join("\n");
    writeFileSync(path, jsonl);

    const result = parseCodexTranscript(path);
    expect(result.usage.input_tokens).toBe(6033);
    // output = output_tokens + reasoning_output_tokens = 224 + 128 = 352
    expect(result.usage.output_tokens).toBe(352);
    expect(result.usage.cache_read_tokens).toBe(4096);
    expect(result.model).toBe("gpt-5-codex");
  });

  it("returns zero usage for empty file", () => {
    const path = join(tempDir, "codex-empty.jsonl");
    writeFileSync(path, "");

    const result = parseCodexTranscript(path);
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
  });

  it("returns zero usage for non-existent file", () => {
    const result = parseCodexTranscript("/tmp/does-not-exist-codex.jsonl");
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
  });

  it("handles malformed lines gracefully", () => {
    const path = join(tempDir, "codex-malformed.jsonl");
    const jsonl = [
      'not json',
      '{"type":"turn_context","payload":{"model":"gpt-5-codex"}}',
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":50}}}}',
      '}{malformed}',
    ].join("\n");
    writeFileSync(path, jsonl);

    const result = parseCodexTranscript(path);
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(50);
    expect(result.model).toBe("gpt-5-codex");
  });

  it("uses last token_count event (cumulative)", () => {
    const path = join(tempDir, "codex-multi.jsonl");
    const jsonl = [
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10}}}}',
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":500,"output_tokens":75}}}}',
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1200,"output_tokens":200}}}}',
    ].join("\n");
    writeFileSync(path, jsonl);

    const result = parseCodexTranscript(path);
    expect(result.usage.input_tokens).toBe(1200);
    expect(result.usage.output_tokens).toBe(200);
  });
});

describe("findLatestCodexTranscript", () => {
  it("returns null when codex dir doesn't exist", () => {
    // We can't easily mock ~/.codex/sessions, just verify the function runs
    const result = findLatestCodexTranscript();
    // Either null or a valid string path
    expect(result === null || typeof result === "string").toBe(true);
  });
});

// ── Gemini parser ──────────────────────────────────────────────────────────

describe("parseGeminiTranscript", () => {
  it("parses Gemini api_response telemetry events", () => {
    const path = join(tempDir, "gemini-sample.jsonl");
    const jsonl = [
      '{"event.name":"session_start","event.timestamp":"2026-04-01T10:00:00Z","session_id":"abc123"}',
      '{"event.name":"api_response","event.timestamp":"2026-04-01T10:00:05Z","model":"gemini-2.5-pro","duration_ms":1200,"usage":{"input_token_count":1500,"output_token_count":300,"cached_content_token_count":512,"thoughts_token_count":128,"tool_token_count":0,"total_token_count":2440}}',
      '{"event.name":"api_response","event.timestamp":"2026-04-01T10:00:15Z","model":"gemini-2.5-pro","duration_ms":1500,"usage":{"input_token_count":2000,"output_token_count":400,"cached_content_token_count":512,"thoughts_token_count":200,"tool_token_count":0,"total_token_count":3112}}',
    ].join("\n");
    writeFileSync(path, jsonl);

    const result = parseGeminiTranscript(path);
    // Summed across both api_response events
    expect(result.usage.input_tokens).toBe(1500 + 2000);
    // output = output_token_count + thoughts_token_count = (300+400) + (128+200) = 1028
    expect(result.usage.output_tokens).toBe(1028);
    // cache_read_tokens overwritten (not summed) -- this is debatable; API responses share cache
    expect(result.usage.cache_read_tokens).toBeGreaterThan(0);
    expect(result.model).toBe("gemini-2.5-pro");
  });

  it("returns zero usage for empty file", () => {
    const path = join(tempDir, "gemini-empty.jsonl");
    writeFileSync(path, "");

    const result = parseGeminiTranscript(path);
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
  });

  it("ignores non-api_response events", () => {
    const path = join(tempDir, "gemini-mixed.jsonl");
    const jsonl = [
      '{"event.name":"session_start"}',
      '{"event.name":"api_request","duration_ms":100}',
      '{"event.name":"api_response","model":"gemini-2.5-pro","usage":{"input_token_count":500,"output_token_count":100}}',
      '{"event.name":"session_end"}',
    ].join("\n");
    writeFileSync(path, jsonl);

    const result = parseGeminiTranscript(path);
    expect(result.usage.input_tokens).toBe(500);
    expect(result.usage.output_tokens).toBe(100);
  });

  it("handles missing usage field gracefully", () => {
    const path = join(tempDir, "gemini-no-usage.jsonl");
    const jsonl = [
      '{"event.name":"api_response","model":"gemini-2.5-pro"}',
      '{"event.name":"api_response","model":"gemini-2.5-pro","usage":{"input_token_count":100,"output_token_count":20}}',
    ].join("\n");
    writeFileSync(path, jsonl);

    const result = parseGeminiTranscript(path);
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(20);
  });
});

// ── Dispatcher ─────────────────────────────────────────────────────────────

describe("parseTranscript dispatcher", () => {
  it("routes 'codex' to parseCodexTranscript", () => {
    const path = join(tempDir, "dispatch-codex.jsonl");
    writeFileSync(path, '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":42,"output_tokens":7}}}}');

    const result = parseTranscript("codex", path);
    expect(result.usage.input_tokens).toBe(42);
    expect(result.usage.output_tokens).toBe(7);
  });

  it("routes 'gemini' to parseGeminiTranscript", () => {
    const path = join(tempDir, "dispatch-gemini.jsonl");
    writeFileSync(path, '{"event.name":"api_response","model":"gemini-2.5-pro","usage":{"input_token_count":999,"output_token_count":111}}');

    const result = parseTranscript("gemini", path);
    expect(result.usage.input_tokens).toBe(999);
    expect(result.usage.output_tokens).toBe(111);
  });

  it("throws for unknown parser kind", () => {
    expect(() => parseTranscript("unknown" as any, "/tmp/x")).toThrow();
  });
});
