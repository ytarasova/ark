import type { AsyncState } from "../hooks/useAsync.js";

/**
 * Submit a form: run a sync action (create resource), close the form,
 * then run async follow-up (dispatch) after a yield so React can render the spinner.
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

  // Yield to let React render the form close, THEN start async work
  if (asyncFollowUp) {
    setTimeout(() => {
      asyncState.run(asyncFollowUp.label, asyncFollowUp.action);
    }, 50);
  }
}
