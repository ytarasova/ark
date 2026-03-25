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
  asyncFollowUp?: { label: string; action: () => Promise<void> };
  asyncState: AsyncState;
}): void {
  const { create, onDone, asyncFollowUp, asyncState } = opts;

  try {
    create();
  } catch (e: any) {
    asyncState.run(`Failed: ${e.message}`, async () => { throw e; });
    return;
  }

  // Close form BEFORE async work so React unmount doesn't cancel it
  onDone();

  // Async follow-up via standard runner
  // useAsync.run() now sets loading/label immediately for instant feedback
  if (asyncFollowUp) {
    asyncState.run(asyncFollowUp.label, asyncFollowUp.action);
  }
}
