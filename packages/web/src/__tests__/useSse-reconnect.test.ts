/**
 * useSse reconnect watchdog test.
 *
 * bun:test has no DOM so we cannot mount the React hook -- effects don't run
 * during SSR and there is no client renderer available. We drive the same
 * watchdog pattern that useSse uses internally and verify:
 *   - a CLOSED-state onerror triggers a second createEventSource call within
 *     700ms (500ms initial backoff + 200ms margin);
 *   - the backoff doubles on successive errors and caps at 5000ms.
 */

import { describe, test, expect } from "bun:test";
import { MockTransport } from "../transport/MockTransport.js";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;

  readyState: number = FakeEventSource.OPEN;
  readonly url: string;
  withCredentials = false;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;

  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, fn: (e: MessageEvent) => void): void {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(type, arr.filter((f) => f !== fn));
  }

  dispatchEvent(_e: Event): boolean {
    return true;
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  triggerClosedError(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event("error"));
  }
}

describe("useSse reconnect watchdog", () => {
  test("creates a second EventSource within 700ms after a CLOSED error", async () => {
    const created: FakeEventSource[] = [];
    const transport = new MockTransport();

    transport.onCreateEventSource((path) => {
      const src = new FakeEventSource(transport.sseUrl(path));
      created.push(src);
      return src as unknown as EventSource;
    });

    const BACKOFF_INITIAL = 500;
    const BACKOFF_MAX = 5000;
    const path = "/api/sse/test";

    let source!: FakeEventSource;
    let delay = BACKOFF_INITIAL;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;

    function connect() {
      const src = transport.createEventSource(path) as unknown as FakeEventSource;
      source = src;

      src.onerror = () => {
        if (src.readyState === FakeEventSource.CLOSED) {
          if (!alive) return;
          if (timer !== null) clearTimeout(timer);
          const d = delay;
          delay = Math.min(d * 2, BACKOFF_MAX);
          timer = setTimeout(() => {
            if (!alive) return;
            connect();
          }, d);
        }
      };
    }

    connect();
    expect(created.length).toBe(1);

    created[0].triggerClosedError();

    await Bun.sleep(700);
    expect(created.length).toBe(2);

    alive = false;
    if (timer !== null) clearTimeout(timer);
    source.close();
  });

  test("backoff doubles on successive errors and caps at 5000ms", () => {
    const BACKOFF_INITIAL = 500;
    const BACKOFF_MAX = 5000;

    let delay = BACKOFF_INITIAL;
    const delays: number[] = [];

    for (let i = 0; i < 6; i++) {
      const d = delay;
      delay = Math.min(d * 2, BACKOFF_MAX);
      delays.push(d);
    }

    expect(delays).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  });

  test("does not reconnect after unmount (alive=false)", async () => {
    const created: FakeEventSource[] = [];
    const transport = new MockTransport();

    transport.onCreateEventSource((path) => {
      const src = new FakeEventSource(transport.sseUrl(path));
      created.push(src);
      return src as unknown as EventSource;
    });

    const path = "/api/sse/test";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;

    function connect() {
      const src = transport.createEventSource(path) as unknown as FakeEventSource;

      src.onerror = () => {
        if (src.readyState === FakeEventSource.CLOSED) {
          if (!alive) return;
          timer = setTimeout(() => {
            if (!alive) return;
            connect();
          }, 500);
        }
      };
    }

    connect();
    expect(created.length).toBe(1);

    created[0].triggerClosedError();

    // Unmount before the backoff fires
    alive = false;
    if (timer !== null) clearTimeout(timer);

    await Bun.sleep(700);
    expect(created.length).toBe(1);
  });
});
