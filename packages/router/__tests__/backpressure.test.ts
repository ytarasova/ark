/**
 * Back-pressure test for pull()-based streaming.
 *
 * The router's streaming handlers in server.ts switched from an eager
 * `start()` loop (unbounded enqueue) to a `pull()` pattern. This test
 * exercises that pattern directly: a fast producer async iterator is wrapped
 * in a pull()-driven ReadableStream; a slow consumer reads chunks with a
 * delay. The number of unread chunks pending in the controller must stay
 * bounded while the consumer lags -- that is the definition of back-pressure.
 */

import { describe, test, expect } from "bun:test";

describe("Pull-based streaming back-pressure", () => {
  test("slow consumer does not race ahead of producer", async () => {
    let produced = 0;
    const total = 100;

    // Producer: fast async iterator yielding JSON-serialisable chunks.
    async function* producer(): AsyncGenerator<{ i: number }> {
      for (let i = 0; i < total; i++) {
        produced++;
        yield { i };
      }
    }

    const iterator = producer()[Symbol.asyncIterator]();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      },
      async cancel() {
        await iterator.return?.();
      },
    });

    const reader = stream.getReader();
    let consumed = 0;
    // Take a few chunks slowly and assert producer never races far ahead.
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      expect(value).toBeDefined();
      consumed++;
      // Simulate a slow consumer.
      await new Promise((r) => setTimeout(r, 20));
      // With the default highWaterMark=1, produced should stay within a
      // small bounded window ahead of consumed. If the stream were eagerly
      // draining the producer (the bug), we'd see produced === total here.
      expect(produced - consumed).toBeLessThanOrEqual(5);
    }
    await reader.cancel();
  });

  test("pull is only called when the reader asks for more", async () => {
    let pullCount = 0;
    const stream = new ReadableStream<string>({
      async pull(controller) {
        pullCount++;
        controller.enqueue("chunk");
      },
    });

    // Without reading, pull should only fire once (to fill the initial
    // highWaterMark slot of 1). Give the runtime a tick to maybe schedule
    // the first pull.
    await new Promise((r) => setTimeout(r, 10));
    expect(pullCount).toBeLessThanOrEqual(1);

    const reader = stream.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    // After 3 reads, at most 4 pulls should have happened (one per read + 1
    // pre-filled). Certainly not hundreds.
    expect(pullCount).toBeLessThanOrEqual(4);
    await reader.cancel();
  });

  test("cancel() propagates to the underlying iterator", async () => {
    let finished = false;
    async function* producer(): AsyncGenerator<number> {
      try {
        for (let i = 0; i < 1000; i++) yield i;
      } finally {
        finished = true;
      }
    }
    const iterator = producer()[Symbol.asyncIterator]();

    const stream = new ReadableStream<number>({
      async pull(controller) {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });

    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    // Give the cancellation a tick to settle.
    await new Promise((r) => setTimeout(r, 5));
    expect(finished).toBe(true);
  });
});
