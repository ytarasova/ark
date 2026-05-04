/**
 * Stage-control MCP server for the claude-agent runtime.
 *
 * Exposes `complete_stage` -- the EXPLICIT signal an agent calls when its
 * stage's task is finished. The Anthropic SDK's `Stop` hook reads the flag
 * this tool sets; the SDK is allowed to actually stop only when:
 *
 *   1. complete_stage has been called (agent says "I'm done"), AND
 *   2. the user-input PromptQueue has no pending messages.
 *
 * Anything else -- end_turn with no explicit completion, or a steer message
 * arriving after the model thought it was done -- causes the Stop hook to
 * return `{ decision: "block", reason: ... }` and the SDK keeps going. The
 * `reason` text is fed back as a user turn, which prompts the model to
 * either continue working or call `complete_stage` to finalise.
 *
 * Why a tool instead of "model just hits end_turn":
 *   - end_turn is a per-iteration signal ("I'm done with this assistant
 *     turn"), NOT a per-task signal. Conflating them was the original bug
 *     that closed sessions early and made UI sends invisible after a
 *     model turn finished.
 *   - An explicit tool gives the agent agency over its own lifecycle. The
 *     completion message is logged on the conductor side, the reason text
 *     surfaces in `report` events, and the conductor's stage-advance is
 *     driven by the SDK exiting (process death) rather than guessing.
 */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export interface StageControlOpts {
  /**
   * Invoked when the agent calls `complete_stage`. The launcher uses this to
   * flip a flag the Stop hook reads. The optional `reason` text is the
   * agent's own summary of what it accomplished -- exposed back to the user
   * via the conductor's normal hook stream.
   *
   * Return `true` to accept the completion (normal path), or `false` to
   * REJECT it -- the tool returns an error string and the agent's
   * `stageCompleteRequested` flag stays unset. Used by the launcher to
   * block stage completion while a user steer is being processed: a steer
   * is a side message, not a stage-completion directive.
   */
  onCompleteStage: (reason?: string) => boolean;
}

export interface StageControlResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Build the `ark-stage-control` MCP server. Returned object is compatible
 * with the SDK's `mcpServers` option (`McpSdkServerConfigWithInstance`).
 */
export function createStageControlMcpServer(opts: StageControlOpts): McpSdkServerConfigWithInstance {
  const completeStage = tool(
    "complete_stage",
    [
      "Signal that this stage's task is complete. The runtime stays alive",
      "between assistant turns to receive mid-run user messages -- without",
      "this explicit signal end_turn does NOT close the stage. Call this",
      "tool only when the work the user asked for in this stage is finished",
      "and you have no further actions to take. The conductor advances to",
      "the next stage AFTER you call this AND any pending user messages",
      "have been processed.",
    ].join(" "),
    {
      reason: z
        .string()
        .optional()
        .describe("Brief summary of what was accomplished in this stage. Surfaced in conductor events for UI display."),
    },
    async (args): Promise<StageControlResult> => {
      let accepted = false;
      try {
        accepted = opts.onCompleteStage(args.reason);
      } catch {
        // Callback is local to launcher; failure here is non-recoverable
        // anyway. Surface it but don't crash the tool call.
      }
      if (!accepted) {
        // Rejected -- the launcher decided this completion should not
        // terminate the stage (most commonly: the call arrived inside the
        // post-steer window where a user side-message was just answered).
        // Surface a clear error so the model treats this as "no, keep
        // working" rather than "ambiguous, exit anyway."
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "complete_stage rejected: the user just sent a side message (steer). A steer asks " +
                "you to clarify, pause, or answer something -- it is not a directive to end the stage. " +
                "Resume the original task you were working on before the steer arrived. Only call " +
                "complete_stage when the stage's actual work is finished, not in reaction to phrasing " +
                "in the user's side message.",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              "Stage marked complete. The runtime will exit once any pending user messages are processed; " +
              "if no further input arrives, the conductor will advance to the next stage shortly.",
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: "ark-stage-control",
    version: "0.1.0",
    tools: [completeStage],
  });
}
