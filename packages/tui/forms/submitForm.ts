import type { AsyncState } from "../hooks/useAsync.js";

/**
 * Submit a form: run the create action (sync or async), close the form,
 * then run async follow-up (dispatch) via the standard async runner.
 *
 * Shows a spinner immediately so the user sees feedback after submitting.
 */
export function submitForm(opts: {
  create: () => void | Promise<void>;
  onDone: () => void;
  asyncFollowUp?: { label: string; action: (updateLabel: (msg: string) => void) => Promise<void> };
  asyncState: AsyncState;
  /** Message to show briefly after create completes (no asyncFollowUp). */
  confirmLabel?: string;
}): void {
  const { create, onDone, asyncFollowUp, asyncState, confirmLabel } = opts;

  const label = asyncFollowUp?.label ?? confirmLabel ?? "Saving...";

  asyncState.run(label, async (updateLabel) => {
    await create();

    // Close form BEFORE async work so React unmount doesn't cancel it
    onDone();

    if (asyncFollowUp) {
      await asyncFollowUp.action(updateLabel);
    }
  });
}
