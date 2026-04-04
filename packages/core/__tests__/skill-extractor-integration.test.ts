import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, setContext, type TestContext } from "../context.js";
import { extractAndSaveSkills } from "../skill-extractor.js";
import { listSkills } from "../skill.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });

describe("skill extraction integration", () => {
  it("extractAndSaveSkills saves high-confidence candidates as global skills", () => {
    const conversation = [
      { role: "user", content: "How do I deploy?" },
      { role: "assistant", content: "Here's the deployment procedure:\n1. Build the project\n2. Run tests\n3. Push to staging\n4. Run smoke tests\n5. Promote to production" },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "You're welcome!" },
    ];
    const saved = extractAndSaveSkills("s-test", conversation);
    expect(saved).toBeGreaterThan(0);

    const skills = listSkills();
    const extracted = skills.find(s => s._source === "global" && s.tags?.includes("extracted"));
    expect(extracted).toBeDefined();
  });

  it("extractAndSaveSkills skips low-confidence candidates", () => {
    const conversation = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "Done:\n1. Step one\n2. Step two" },
    ];
    const saved = extractAndSaveSkills("s-test2", conversation);
    expect(saved).toBe(0);
  });
});
