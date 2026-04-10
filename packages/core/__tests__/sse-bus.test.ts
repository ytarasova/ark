import { describe, it, expect } from "bun:test";
import { InMemorySSEBus, createSSEBus } from "../sse-bus.js";

describe("InMemorySSEBus", () => {
  it("publishes events to subscribers", () => {
    const bus = new InMemorySSEBus();
    const received: Array<{ event: string; data: unknown }> = [];

    bus.subscribe("test-channel", (event, data) => {
      received.push({ event, data });
    });

    bus.publish("test-channel", "update", { id: 1 });
    bus.publish("test-channel", "delete", { id: 2 });

    expect(received).toHaveLength(2);
    expect(received[0].event).toBe("update");
    expect(received[0].data).toEqual({ id: 1 });
    expect(received[1].event).toBe("delete");
    expect(received[1].data).toEqual({ id: 2 });
  });

  it("does not deliver to unsubscribed listeners", () => {
    const bus = new InMemorySSEBus();
    const received: string[] = [];

    const unsub = bus.subscribe("ch", (event) => {
      received.push(event);
    });

    bus.publish("ch", "before", null);
    unsub();
    bus.publish("ch", "after", null);

    expect(received).toEqual(["before"]);
  });

  it("supports multiple subscribers on the same channel", () => {
    const bus = new InMemorySSEBus();
    let count1 = 0;
    let count2 = 0;

    bus.subscribe("multi", () => { count1++; });
    bus.subscribe("multi", () => { count2++; });

    bus.publish("multi", "ping", null);

    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });

  it("isolates channels from each other", () => {
    const bus = new InMemorySSEBus();
    const received: string[] = [];

    bus.subscribe("channelA", (event) => { received.push(`A:${event}`); });
    bus.subscribe("channelB", (event) => { received.push(`B:${event}`); });

    bus.publish("channelA", "only-a", null);

    expect(received).toEqual(["A:only-a"]);
  });

  it("reports subscriber count", () => {
    const bus = new InMemorySSEBus();
    expect(bus.subscriberCount("empty")).toBe(0);

    const unsub1 = bus.subscribe("counted", () => {});
    const unsub2 = bus.subscribe("counted", () => {});
    expect(bus.subscriberCount("counted")).toBe(2);

    unsub1();
    expect(bus.subscriberCount("counted")).toBe(1);

    unsub2();
    expect(bus.subscriberCount("counted")).toBe(0);
  });

  it("clears all subscribers", () => {
    const bus = new InMemorySSEBus();
    bus.subscribe("a", () => {});
    bus.subscribe("b", () => {});
    expect(bus.subscriberCount("a")).toBe(1);
    expect(bus.subscriberCount("b")).toBe(1);

    bus.clear();
    expect(bus.subscriberCount("a")).toBe(0);
    expect(bus.subscriberCount("b")).toBe(0);
  });

  it("survives a throwing subscriber", () => {
    const bus = new InMemorySSEBus();
    const received: string[] = [];

    bus.subscribe("robust", () => { throw new Error("boom"); });
    bus.subscribe("robust", (event) => { received.push(event); });

    bus.publish("robust", "test", null);

    // Second subscriber should still receive despite first throwing
    expect(received).toEqual(["test"]);
  });

  it("publish to channel with no subscribers is a no-op", () => {
    const bus = new InMemorySSEBus();
    // Should not throw
    bus.publish("nobody", "event", { data: true });
  });
});

describe("createSSEBus", () => {
  it("returns InMemorySSEBus by default", () => {
    const bus = createSSEBus();
    expect(bus).toBeInstanceOf(InMemorySSEBus);
  });

  it("returns InMemorySSEBus for explicit memory type", () => {
    const bus = createSSEBus({ type: "memory" });
    expect(bus).toBeInstanceOf(InMemorySSEBus);
  });

  it("falls back to InMemorySSEBus for redis type (not yet implemented)", () => {
    // Suppress console.warn
    const orig = console.warn;
    console.warn = () => {};
    const bus = createSSEBus({ type: "redis", redisUrl: "redis://localhost:6379" });
    expect(bus).toBeInstanceOf(InMemorySSEBus);
    console.warn = orig;
  });
});
