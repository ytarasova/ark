/**
 * Email source (interface only, no implementation).
 *
 * Intended to drive `kind: poll` triggers against an IMAP mailbox so that
 * inbound emails tagged with a specific label kick a flow. This is the
 * email equivalent of GitHub issue-label polling we already ship.
 *
 * The `verify` path is a no-op since polled sources don't have an incoming
 * request; the webhook handler refuses to route this source (it is flagged
 * as a stub). `normalize` is unreachable for polled flows; we return an
 * error event that surfaces in logs if reached accidentally.
 *
 * TODO: wire an IMAP client (Bun has raw TCP, but no built-in IMAP library).
 * Options: shell out to a sidecar process, or pull in one of the existing
 * pure-JS IMAP libraries behind a vendored stub. Out of scope for Phase 1.
 */

import type { TriggerSource, NormalizedEvent, TriggerConfig } from "../types.js";
import { buildEvent } from "../normalizer.js";

export const emailSource: TriggerSource = {
  name: "email",
  label: "Email (IMAP -- interface only)",
  secretEnvVar: "ARK_TRIGGER_EMAIL_SECRET",
  status: "stub",

  async verify(_req, _secret) {
    return false;
  },

  async normalize(_req): Promise<NormalizedEvent> {
    return buildEvent({
      source: "email",
      event: "email.not-implemented",
      payload: null,
    });
  },

  async poll(_opts: { cursor?: string; config: TriggerConfig }) {
    // TODO: IMAP fetch loop. Returns zero events while unimplemented.
    return { events: [] };
  },
};
