import { test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

test("startSession rejects inline attachment bytes", async () => {
  await expect(
    app.sessionService.start({
      summary: "test",
      attachments: [{ name: "foo.txt", content: "aGVsbG8=", type: "text/plain" }],
    }),
  ).rejects.toThrow("upload to BlobStore");
});
