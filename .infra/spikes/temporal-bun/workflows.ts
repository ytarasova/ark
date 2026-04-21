/**
 * Trivial workflow used by the Phase 0 Bun spike.
 *
 * `bundleWorkflowCode()` points here; we keep the file as small as possible
 * so a bundler failure is unambiguously the bundler and not our code.
 */

import * as workflow from "@temporalio/workflow";

export async function pingWorkflow(name: string): Promise<string> {
  // Proxy a single activity so the bundle walks the activity-proxy codepath.
  const { ping } = workflow.proxyActivities<{ ping(): Promise<string> }>({
    startToCloseTimeout: "10s",
  });
  return `hello ${name}, got ${await ping()}`;
}
