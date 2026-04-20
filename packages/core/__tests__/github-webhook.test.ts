/**
 * Tests for GitHub issue webhook handler.
 */

import { describe, it, expect } from "bun:test";
import {
  handleIssueWebhook,
  type IssueWebhookPayload,
  type IssueWebhookConfig,
} from "../integrations/github-webhook.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

function makePayload(overrides?: Partial<IssueWebhookPayload>): IssueWebhookPayload {
  return {
    action: "labeled",
    issue: {
      number: 42,
      title: "Fix authentication bug",
      body: "Users are getting 401 errors on login",
      labels: [{ name: "ark" }, { name: "bug" }],
      html_url: "https://github.com/test/repo/issues/42",
    },
    label: { name: "ark" },
    repository: {
      full_name: "test/repo",
      clone_url: "https://github.com/test/repo.git",
    },
    ...overrides,
  };
}

const defaultConfig: IssueWebhookConfig = {
  triggerLabel: "ark",
  autoDispatch: false,
};

describe("handleIssueWebhook", () => {
  it("creates session for labeled action with matching label", async () => {
    const payload = makePayload();
    const result = await handleIssueWebhook(getApp(), payload, defaultConfig);

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();
    expect(result.message).toContain("issue #42");

    // Verify session was created with correct fields
    const session = getApp().sessions.get(result.sessionId!);
    expect(session).not.toBeNull();
    expect(session!.ticket).toBe("#42");
    expect(session!.summary).toBe("Fix authentication bug");
    expect(session!.repo).toBe("https://github.com/test/repo.git");
    expect(session!.flow).toBe("quick");
    expect(session!.group_name).toBe("github-issues");
    expect(session!.config.github_issue_url).toBe("https://github.com/test/repo/issues/42");
    expect(session!.config.github_repo).toBe("test/repo");
  });

  it("logs a webhook event", async () => {
    const payload = makePayload();
    const result = await handleIssueWebhook(getApp(), payload, defaultConfig);

    const events = getApp().events.list(result.sessionId!);
    const webhookEvents = events.filter((e) => e.type === "issue_webhook_triggered");
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0].actor).toBe("github");
    expect(webhookEvents[0].data!.issue_number).toBe(42);
  });

  it("ignores non-labeled action", async () => {
    const payload = makePayload({ action: "opened" });
    const result = await handleIssueWebhook(getApp(), payload, defaultConfig);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Ignoring action: opened");
    expect(result.sessionId).toBeUndefined();
  });

  it("ignores non-matching label", async () => {
    const payload = makePayload({ label: { name: "bug" } });
    const result = await handleIssueWebhook(getApp(), payload, defaultConfig);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not match trigger");
    expect(result.sessionId).toBeUndefined();
  });

  it("uses custom flow and group from config", async () => {
    const config: IssueWebhookConfig = {
      triggerLabel: "ark",
      autoDispatch: false,
      flow: "parallel",
      group: "custom-group",
    };
    const payload = makePayload();
    const result = await handleIssueWebhook(getApp(), payload, config);

    const session = getApp().sessions.get(result.sessionId!);
    expect(session!.flow).toBe("parallel");
    expect(session!.group_name).toBe("custom-group");
  });
});
