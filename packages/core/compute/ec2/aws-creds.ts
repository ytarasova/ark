/**
 * Shared AWS credential helpers for EC2-related compute paths.
 *
 * Solves one specific problem in the *local-dev* path: when the Ark
 * daemon runs for hours, a static-token AWS profile (the kind written
 * to `~/.aws/credentials` by `aws sso login` -- with `aws_access_key_id`
 * + `aws_session_token` lines) expires after the STS lifetime (~1h on
 * basic SSO roles, up to 12h on extended ones). The default
 * `fromIni({ profile })` provider in the AWS SDK reads the file ONCE on
 * first SDK request and memoises the resolved credentials inside the
 * closure. So even after the user runs `aws sso login` to rewrite the
 * file, every subsequent SDK call keeps using the old expired tokens
 * until the daemon is restarted.
 *
 * The control-plane path (Ark daemon running on EC2/ECS/Lambda) does
 * NOT have this problem: credentials come from IMDSv2 / task role and
 * the SDK's default credential chain handles refresh natively. So this
 * helper deliberately falls through to the default chain whenever no
 * profile is specified -- callers don't have to branch on
 * "control-plane vs local-dev". One call, both modes:
 *
 *   credentials: awsCredentialsForProfile({ profile: cfg.aws_profile })
 *
 *   - profile === undefined  -> returns undefined  -> SDK uses default
 *                               chain (env vars, IMDS, ECS task role,
 *                               default profile). All native auto-refresh.
 *   - profile === "name"     -> returns a provider that re-runs fromIni
 *                               on every SDK call so file rotations from
 *                               `aws sso login` are picked up immediately.
 *
 * `withAwsRetry(buildClient, op)` complements the provider: catches
 * ExpiredTokenException at the operation boundary and retries once
 * after rebuilding the client. This handles the narrow window where
 * the SDK has a just-expired credential cached between provider calls.
 * Other auth errors (bad profile name, IAM AccessDenied, etc.) are NOT
 * retried -- they're real failures and a fresh client wouldn't help.
 */

import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { logDebug } from "../../observability/structured-log.js";

let _fromIni: typeof import("@aws-sdk/credential-providers").fromIni | null = null;

async function loadFromIni(): Promise<typeof import("@aws-sdk/credential-providers").fromIni> {
  if (_fromIni) return _fromIni;
  const cred = await import("@aws-sdk/credential-providers");
  _fromIni = cred.fromIni;
  return _fromIni;
}

/**
 * The `credentials` option to pass to any AWS SDK client constructor.
 *
 * Returns `undefined` when no profile is given so the SDK uses its
 * default credential chain (env vars, container/instance role, default
 * profile, SSO session). Returns a self-refreshing `fromIni` provider
 * when a profile is named, so static-token profiles rotated by
 * `aws sso login` don't keep using stale tokens.
 *
 * Pass the result directly to client config:
 *   `new EC2Client({ region, credentials: awsCredentialsForProfile({ profile }) })`
 *
 * AWS SDK v3 treats `credentials: undefined` the same as the field
 * being absent -- both fall through to the default chain.
 */
export function awsCredentialsForProfile({ profile }: { profile?: string }): AwsCredentialIdentityProvider | undefined {
  if (!profile) return undefined;
  return async () => {
    // Construct a fresh fromIni provider each call so the next file
    // read picks up post-`aws sso login` token rotation. fromIni()
    // itself returns a memoised closure; making a new one breaks the
    // memoisation. Cost: one ~/.aws file parse per SDK request, which
    // is negligible vs. the network call that follows.
    const fromIni = await loadFromIni();
    return await fromIni({ profile })();
  };
}

/** True when an SDK error indicates an expired credential. */
export function isExpiredCredsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { name?: string; Code?: string };
  return e.name === "ExpiredToken" || e.name === "ExpiredTokenException" || e.Code === "ExpiredTokenException";
}

/**
 * Run `op(client)` with one transparent retry on credential expiry.
 *
 * `buildClient` constructs a new SDK client; the helper invokes it
 * twice at most -- once for the normal call, and once again on
 * ExpiredTokenException to force a fresh credential resolve. Other
 * errors propagate without retry.
 *
 * Test-injected `pinnedClient` short-circuits the rebuild path so unit
 * tests can drive specific failure modes without the helper masking
 * them as transient.
 *
 * Works for both local-dev (profile-backed) and control-plane
 * (default-chain) paths because the rebuild always goes through
 * `awsCredentialsForProfile` semantics: undefined profile -> default
 * chain (which handles its own refresh, so this retry is essentially
 * a no-op there but harmless), named profile -> fresh fromIni read.
 */
export async function withAwsRetry<C, T>(
  buildClient: () => Promise<C>,
  op: (client: C) => Promise<T>,
  opts?: { pinnedClient?: C; label?: string },
): Promise<T> {
  if (opts?.pinnedClient) {
    return await op(opts.pinnedClient);
  }
  const client = await buildClient();
  try {
    return await op(client);
  } catch (err) {
    if (!isExpiredCredsError(err)) throw err;
    logDebug("aws", `${opts?.label ?? "AWS"} credentials expired; rebuilding client and retrying once`);
    const fresh = await buildClient();
    return await op(fresh);
  }
}
