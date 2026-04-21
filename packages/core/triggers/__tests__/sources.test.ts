/**
 * Per-source signature + normalize tests.
 *
 * Covers every `full` source (github, bitbucket, slack, linear, jira,
 * generic-hmac) for both the happy path and a forged/bad signature to
 * make sure no source silently accepts an attacker's request.
 *
 * `scaffolded` and `stub` sources are exercised lightly -- we only assert
 * the source is registered and that signature rejection still works.
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "crypto";
import { githubSource } from "../sources/github.js";
import { bitbucketSource } from "../sources/bitbucket.js";
import { slackSource } from "../sources/slack.js";
import { linearSource } from "../sources/linear.js";
import { jiraSource } from "../sources/jira.js";
import { genericHmacSource } from "../sources/generic-hmac.js";
import { piSageSource } from "../sources/pi-sage.js";
import { alertmanagerSource } from "../sources/alertmanager.js";
import { prometheusSource } from "../sources/prometheus.js";
import { pagerdutySource } from "../sources/pagerduty.js";
import { emailSource } from "../sources/email.js";
import { createDefaultRegistry, builtinSources } from "../registry.js";

function sha256(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function mkReq(headers: Record<string, string>, body: string) {
  return { headers: new Headers(headers), body };
}

// ── GitHub ────────────────────────────────────────────────────────────────

describe("github source", async () => {
  const SECRET = "gh_secret";
  const body = JSON.stringify({
    action: "opened",
    pull_request: { number: 7, head: { ref: "fix/thing" } },
    repository: { full_name: "acme/api" },
    sender: { login: "octocat", id: 99 },
  });

  test("valid HMAC is accepted", async () => {
    const sig = "sha256=" + sha256(body, SECRET);
    const ok = await githubSource.verify(
      mkReq({ "x-hub-signature-256": sig, "x-github-event": "pull_request" }, body),
      SECRET,
    );
    expect(ok).toBe(true);
  });

  test("wrong secret fails", async () => {
    const sig = "sha256=" + sha256(body, "wrong");
    const ok = await githubSource.verify(mkReq({ "x-hub-signature-256": sig }, body), SECRET);
    expect(ok).toBe(false);
  });

  test("missing header fails", async () => {
    expect(await githubSource.verify(mkReq({}, body), SECRET)).toBe(false);
  });

  test("normalize builds event, ref, actor", async () => {
    const ev = await githubSource.normalize(mkReq({ "x-github-event": "pull_request" }, body));
    expect(ev.event).toBe("pull_request.opened");
    expect(ev.ref).toBe("fix/thing");
    expect(ev.actor?.name).toBe("octocat");
    expect((ev.payload as { repo: string }).repo).toBe("acme/api");
  });

  test("push event (no action) keeps raw event name", async () => {
    const pushBody = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "acme/api" } });
    const ev = await githubSource.normalize(mkReq({ "x-github-event": "push" }, pushBody));
    expect(ev.event).toBe("push");
    expect(ev.ref).toBe("refs/heads/main");
  });
});

// ── Bitbucket ─────────────────────────────────────────────────────────────

describe("bitbucket source", async () => {
  const SECRET = "bb_secret";
  const body = JSON.stringify({
    pullrequest: { id: 4, title: "PR", source: { branch: { name: "feat/y" } } },
    repository: { full_name: "org/repo" },
    actor: { uuid: "{abc}", display_name: "Alice" },
  });

  test("valid X-Hub-Signature is accepted", async () => {
    const sig = "sha256=" + sha256(body, SECRET);
    const ok = await bitbucketSource.verify(mkReq({ "x-hub-signature": sig }, body), SECRET);
    expect(ok).toBe(true);
  });

  test("plain hex (server) also accepted", async () => {
    const sig = sha256(body, SECRET);
    const ok = await bitbucketSource.verify(mkReq({ "x-bitbucket-signature": sig }, body), SECRET);
    expect(ok).toBe(true);
  });

  test("bad signature rejected", async () => {
    const ok = await bitbucketSource.verify(mkReq({ "x-hub-signature": "sha256=deadbeef" }, body), SECRET);
    expect(ok).toBe(false);
  });

  test("normalize rewrites colon to dot and pulls ref", async () => {
    const ev = await bitbucketSource.normalize(mkReq({ "x-event-key": "pullrequest:created" }, body));
    expect(ev.event).toBe("pullrequest.created");
    expect(ev.ref).toBe("feat/y");
    expect(ev.actor?.name).toBe("Alice");
  });
});

// ── Slack ─────────────────────────────────────────────────────────────────

describe("slack source", async () => {
  const SECRET = "slk_secret";
  const body = JSON.stringify({ event: { type: "app_mention", user: "U1", channel: "C1", text: "hi" } });

  test("valid signature (fresh timestamp) is accepted", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = "v0=" + sha256(`v0:${ts}:${body}`, SECRET);
    const ok = await slackSource.verify(
      mkReq({ "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body),
      SECRET,
    );
    expect(ok).toBe(true);
  });

  test("stale timestamp is rejected (replay window)", async () => {
    const ts = (Math.floor(Date.now() / 1000) - 3600).toString();
    const sig = "v0=" + sha256(`v0:${ts}:${body}`, SECRET);
    const ok = await slackSource.verify(
      mkReq({ "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body),
      SECRET,
    );
    expect(ok).toBe(false);
  });

  test("bad signature is rejected even within window", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const ok = await slackSource.verify(
      mkReq({ "x-slack-request-timestamp": ts, "x-slack-signature": "v0=deadbeef" }, body),
      SECRET,
    );
    expect(ok).toBe(false);
  });

  test("normalize resolves app_mention to event=app_mention", async () => {
    const ev = await slackSource.normalize(mkReq({}, body));
    expect(ev.event).toBe("app_mention");
    expect(ev.actor?.id).toBe("U1");
  });

  test("slash command maps to slash.<name>", async () => {
    const cmdBody = JSON.stringify({ command: "/deploy", text: "prod", team_id: "T1" });
    const ev = await slackSource.normalize(mkReq({}, cmdBody));
    expect(ev.event).toBe("slash.deploy");
  });
});

// ── Linear ────────────────────────────────────────────────────────────────

describe("linear source", async () => {
  const SECRET = "ln_secret";
  const body = JSON.stringify({
    action: "create",
    type: "Issue",
    data: { id: "abc", identifier: "ENG-42" },
    actor: { id: "u1", name: "Zoe" },
  });

  test("valid HMAC accepted", async () => {
    const sig = sha256(body, SECRET);
    expect(await linearSource.verify(mkReq({ "linear-signature": sig }, body), SECRET)).toBe(true);
  });

  test("bad HMAC rejected", async () => {
    expect(await linearSource.verify(mkReq({ "linear-signature": "bad" }, body), SECRET)).toBe(false);
  });

  test("normalize builds 'type.action' event + issue ref", async () => {
    const ev = await linearSource.normalize(mkReq({}, body));
    expect(ev.event).toBe("issue.create");
    expect(ev.ref).toBe("ENG-42");
    expect(ev.actor?.name).toBe("Zoe");
  });
});

// ── Jira ──────────────────────────────────────────────────────────────────

describe("jira source", async () => {
  const SECRET = "ji_secret";
  const body = JSON.stringify({
    webhookEvent: "jira:issue_created",
    issue: { id: "10", key: "PROJ-7", fields: { summary: "Thing" } },
    user: { accountId: "a", displayName: "Bea" },
  });

  test("hub-signature HMAC accepted", async () => {
    const sig = "sha256=" + sha256(body, SECRET);
    expect(await jiraSource.verify(mkReq({ "x-hub-signature": sig }, body), SECRET)).toBe(true);
  });

  test("bearer token accepted", async () => {
    expect(await jiraSource.verify(mkReq({ authorization: `Bearer ${SECRET}` }, body), SECRET)).toBe(true);
  });

  test("no auth rejected", async () => {
    expect(await jiraSource.verify(mkReq({}, body), SECRET)).toBe(false);
  });

  test("normalize strips jira: prefix + underscore swap", async () => {
    const ev = await jiraSource.normalize(mkReq({}, body));
    expect(ev.event).toBe("issue.created");
    expect(ev.ref).toBe("PROJ-7");
  });
});

// ── Generic HMAC ──────────────────────────────────────────────────────────

describe("generic-hmac source", async () => {
  const SECRET = "generic_secret";
  const body = JSON.stringify({ event: "deploy.started", ref: "build-123" });

  test("valid signature (default header) accepted", async () => {
    const sig = sha256(body, SECRET);
    expect(await genericHmacSource.verify(mkReq({ "x-signature": sig }, body), SECRET)).toBe(true);
  });

  test("accepts sha256= prefix variant", async () => {
    const sig = "sha256=" + sha256(body, SECRET);
    expect(await genericHmacSource.verify(mkReq({ "x-signature": sig }, body), SECRET)).toBe(true);
  });

  test("bad signature rejected", async () => {
    expect(await genericHmacSource.verify(mkReq({ "x-signature": "nope" }, body), SECRET)).toBe(false);
  });

  test("normalize: header X-Event-Name wins over payload", async () => {
    const ev = await genericHmacSource.normalize(mkReq({ "x-event-name": "override" }, body));
    expect(ev.event).toBe("override");
  });
});

// ── Scaffolded + stub sources ────────────────────────────────────────────

describe("pi-sage source (scaffolded)", async () => {
  const SECRET = "sage_secret";
  const body = JSON.stringify({ event: "analysis.ready", analysis_id: "A-99", ticket: "T-1" });

  test("valid HMAC accepted", async () => {
    const sig = sha256(body, SECRET);
    expect(await piSageSource.verify(mkReq({ "x-sage-signature": sig }, body), SECRET)).toBe(true);
  });

  test("missing secret rejected", async () => {
    expect(await piSageSource.verify(mkReq({ "x-sage-signature": "ignored" }, body), null)).toBe(false);
  });

  test("normalize carries analysisId + ticket in sourceMeta", async () => {
    const ev = await piSageSource.normalize(mkReq({}, body));
    expect(ev.event).toBe("analysis.ready");
    expect(ev.ref).toBe("A-99");
    expect(ev.sourceMeta?.analysisId).toBe("A-99");
    expect(ev.sourceMeta?.ticket).toBe("T-1");
  });
});

describe("alertmanager + prometheus (scaffolded)", async () => {
  const SECRET = "am_secret";
  const body = JSON.stringify({ status: "firing", commonLabels: { alertname: "HighCpu" } });

  test("alertmanager Bearer accepted", async () => {
    expect(await alertmanagerSource.verify(mkReq({ authorization: `Bearer ${SECRET}` }, body), SECRET)).toBe(true);
  });

  test("alertmanager Basic accepted", async () => {
    const token = Buffer.from(`ignored:${SECRET}`).toString("base64");
    expect(await alertmanagerSource.verify(mkReq({ authorization: `Basic ${token}` }, body), SECRET)).toBe(true);
  });

  test("alertmanager with no auth rejected", async () => {
    expect(await alertmanagerSource.verify(mkReq({}, body), SECRET)).toBe(false);
  });

  test("prometheus shares shape -- event name", async () => {
    const ev = await prometheusSource.normalize(mkReq({}, body));
    expect(ev.event).toBe("HighCpu.firing");
  });
});

describe("pagerduty source (scaffolded)", async () => {
  const SECRET = "pd_secret";
  const body = JSON.stringify({
    event: { event_type: "incident.triggered", id: "E1", data: { incident: { id: "INC1" } } },
  });

  test("valid v1 signature accepted", async () => {
    const sig = "v1=" + sha256(body, SECRET);
    expect(await pagerdutySource.verify(mkReq({ "x-pagerduty-signature": sig }, body), SECRET)).toBe(true);
  });

  test("rotation: accepts comma-separated list if any match", async () => {
    const good = "v1=" + sha256(body, SECRET);
    expect(await pagerdutySource.verify(mkReq({ "x-pagerduty-signature": `v1=deadbeef, ${good}` }, body), SECRET)).toBe(
      true,
    );
  });
});

describe("email stub", async () => {
  test("verify always returns false", async () => {
    expect(await emailSource.verify(mkReq({}, ""), "s")).toBe(false);
  });

  test("normalize returns non-routable event", async () => {
    const ev = await emailSource.normalize(mkReq({}, ""));
    expect(ev.event).toBe("email.not-implemented");
  });
});

// ── Registry seeding ─────────────────────────────────────────────────────

describe("default registry", () => {
  test("registers every built-in source", () => {
    const reg = createDefaultRegistry();
    for (const src of builtinSources()) {
      expect(reg.get(src.name)?.name).toBe(src.name);
    }
  });

  test("get returns null for unknown", () => {
    expect(createDefaultRegistry().get("nope")).toBeNull();
  });

  test("register replaces existing entry", () => {
    const reg = createDefaultRegistry();
    reg.register({ ...githubSource, label: "Overridden" });
    expect(reg.get("github")?.label).toBe("Overridden");
  });
});
