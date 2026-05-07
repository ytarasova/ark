/**
 * SessionService.saveInput + input/read round-trip against the wired
 * LocalDiskBlobStore. Verifies the breaking `{ locator }` contract + the
 * input/read handler can resolve the locator back to the original bytes.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../app.js";
import { decodeLocator, LOCAL_TENANT_ID } from "../blob-store.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("SessionService.saveInput -> blob store", async () => {
  it("returns { locator } and stores bytes retrievable via blobStore.get", async () => {
    const content = Buffer.from("recipe body").toString("base64");
    const { locator } = await app.sessionService.saveInput({
      name: "goose.yaml",
      role: "recipe",
      content,
      contentEncoding: "base64",
    });

    expect(locator).toBeTruthy();
    expect(typeof locator).toBe("string");
    // Opaque -- no leading slash / path.
    expect(locator).not.toInclude("/");

    // Tenant id defaults to _local when AppContext has no tenant.
    const key = decodeLocator(locator);
    expect(key.tenantId).toBe(LOCAL_TENANT_ID);
    expect(key.namespace).toBe("inputs");
    expect(key.filename).toBe("goose.yaml");

    // Bytes round-trip.
    const out = await app.blobStore.get(locator, LOCAL_TENANT_ID);
    expect(out.bytes.toString("utf-8")).toBe("recipe body");
  });

  it("sanitises filename + role to avoid filesystem injection", async () => {
    const { locator } = await app.sessionService.saveInput({
      name: "../etc/passwd",
      role: "bad/role",
      content: "hi",
      contentEncoding: "utf-8",
    });
    const key = decodeLocator(locator);
    expect(key.filename).not.toInclude("/");
    expect(key.id).not.toInclude("/");
  });

  it("input/read handler returns the bytes the caller just uploaded", async () => {
    const { registerSessionHandlers } = await import("../../../conductor/handlers/session.js");
    const { Router } = await import("../../../conductor/router.js");
    const { createRequest } = await import("../../../protocol/types.js");

    const router = new Router();
    registerSessionHandlers(router, app);

    const uploadRes = await router.dispatch(
      createRequest(1, "input/upload", {
        name: "hello.txt",
        role: "note",
        content: Buffer.from("payload bytes").toString("base64"),
        contentEncoding: "base64",
      }),
    );
    const upload = (uploadRes as { result: { locator: string } }).result;
    expect(upload.locator).toBeTruthy();

    const readRes = await router.dispatch(createRequest(2, "input/read", { locator: upload.locator }));
    const read = (readRes as { result: { filename: string; content: string; contentEncoding: string } }).result;
    expect(read.filename).toBe("hello.txt");
    expect(read.contentEncoding).toBe("base64");
    expect(Buffer.from(read.content, "base64").toString("utf-8")).toBe("payload bytes");
  });
});
