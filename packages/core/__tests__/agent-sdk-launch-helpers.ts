/**
 * Shared fixtures for the split agent-sdk launch test suites.
 *
 * The original `agent-sdk-launch.test.ts` grew past 1k LOC and fanned out
 * three independent topics (transcript writing, error/abort paths, hook
 * streaming) onto the same beforeEach-less file. This module is the small
 * helper surface they all share -- per the round-3 audit cleanup, helpers
 * stay here so the three sibling test files can import them without
 * duplicating tmp-dir + fake-fetch wiring.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-sdk-launch-"));
}

export interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export function makeFakeFetch(calls: FetchCall[]): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  };
}
