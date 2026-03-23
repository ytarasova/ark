import type { AsyncState } from "../hooks/useAsync.js";

/**
 * Submit a form: run a sync action (create resource), close the form,
 * then optionally run an async follow-up (dispatch).
 *
 * This ensures the form unmounts cleanly before any async work starts,
 * preventing the useEffect/setPending race where unmount cancels the action.
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

  // Async follow-up runs after form is gone
  if (asyncFollowUp) {
    asyncState.run(asyncFollowUp.label, asyncFollowUp.action);
  }
}
