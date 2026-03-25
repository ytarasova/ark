/**
 * Post-exit action registry.
 * Components set an action before calling exit().
 * After Ink unmounts, index.tsx runs the action.
 */

export interface PostExitAction {
  type: "tmux-attach" | "ssh";
  args: string[];
}

let pending: PostExitAction | null = null;

export function setPostExitAction(action: PostExitAction): void {
  pending = action;
}

export function getPostExitAction(): PostExitAction | null {
  return pending;
}
