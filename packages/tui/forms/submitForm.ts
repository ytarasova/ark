import type { AsyncState } from "../hooks/useAsync.js";

/**
 * Submit a form: run a sync action (create resource), close the form,
 * then run async follow-up (dispatch) via the standard async runner.
 *
 * Shows a spinner immediately so the user sees feedback after submitting.
 */
export function submitForm(opts: {
  create: () => void;
  onDone: () => void;
  asyncFollowUp?: { label: string; action: (updateLabel: (msg: string) => void) => Promise<void> };
  asyncState: AsyncState;
  /** Message to show briefly after sync create (no asyncFollowUp). */
  confirmLabel?: string;
}): void {
  const { create, onDone, asyncFollowUp, asyncState, confirmLabel } = opts;

  try {
    create();
  } catch (e: any) {
    asyncState.run(`Failed: ${e.message}`, async () => { throw e; });
    return;
  }

  // Close form BEFORE async work so React unmount doesn't cancel it
  onDone();

  if (asyncFollowUp) {
    // Async follow-up — spinner persists until action completes
    asyncState.run(asyncFollowUp.label, (updateLabel) => asyncFollowUp.action(updateLabel));
  } else if (confirmLabel) {
    // Brief confirmation flash for sync-only creates
    asyncState.run(confirmLabel, async () => {});
  }
}
