import { Loader2 } from "lucide-react";
import { Button } from "../ui/button.js";
import type { ComputeCapabilities } from "../../../../types/rpc.js";

/**
 * Actions available on a compute row.
 *
 * Model:
 * - Template rows are blueprints. Provision clones the blueprint into a
 *   running concrete instance -- same flow the dispatcher uses when a
 *   session references a template, just triggered manually by the user.
 *   Delete removes the blueprint itself.
 * - Concrete rows are real infrastructure. Start brings the pod / container
 *   / VM up, Stop brings it down without deleting the row, Destroy tears
 *   down both the infra and the row.
 *
 * Capabilities are authoritative -- Destroy and Reboot only render when the
 * provider advertises `canDelete` / `canReboot` via `compute/capabilities`.
 * That's why (for example) the local provider -- which cannot be destroyed
 * -- ends up with no destructive buttons without any name-based branching
 * in this component. When capabilities are still loading or the RPC fails,
 * the flags stay undefined and the guarded buttons stay hidden: a harmless
 * default given that the server-side handlers also refuse unsupported
 * actions with UNSUPPORTED (see Wave B).
 *
 * While an action is in flight, `pendingAction` disables every button and
 * shows a spinner on the one that's running. Start/Provision/Stop can take
 * tens of seconds on k8s / ec2 -- firing a second action mid-flight is
 * exactly the kind of race we don't want in an orchestrator.
 */
export function ComputeActions({
  compute,
  capabilities,
  onAction,
  pendingAction,
}: {
  compute: any;
  capabilities?: ComputeCapabilities;
  onAction: (action: string) => void;
  pendingAction?: string | null;
}) {
  const isTemplate = !!compute.is_template;
  const status = compute.status || "unknown";
  const busy = !!pendingAction;

  const ActionButton = ({
    label,
    action,
    variant = "default",
    ariaLabel,
  }: {
    label: string;
    action: string;
    variant?: "default" | "outline" | "destructive";
    ariaLabel: string;
  }) => {
    const isThisOneRunning = pendingAction === action;
    return (
      <Button
        size="xs"
        variant={variant}
        onClick={() => onAction(action)}
        aria-label={ariaLabel}
        disabled={busy}
        className="min-w-[82px]"
      >
        {isThisOneRunning ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" />
            {label}
          </span>
        ) : (
          label
        )}
      </Button>
    );
  };

  if (isTemplate) {
    return (
      <div className="flex gap-1.5 flex-wrap">
        <ActionButton label="Provision" action="provision" ariaLabel="Provision instance from template" />
        {capabilities?.canDelete && (
          <ActionButton
            label="Delete Template"
            action="destroy"
            variant="destructive"
            ariaLabel="Delete compute template"
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex gap-1.5 flex-wrap">
      {(status === "stopped" || status === "created" || status === "destroyed" || status === "failed") && (
        <ActionButton label={status === "failed" ? "Retry" : "Start"} action="start" ariaLabel="Start compute target" />
      )}
      {status === "running" && (
        <ActionButton label="Stop" action="stop" variant="outline" ariaLabel="Stop compute target" />
      )}
      {capabilities?.canReboot && status === "running" && (
        <ActionButton label="Reboot" action="reboot" variant="outline" ariaLabel="Reboot compute target" />
      )}
      {/* Destroy stays available across every runnable status -- even
          (especially) stuck "provisioning" rows -- so the user isn't
          trapped in a dead state. Still gated on the provider's
          canDelete capability flag, which is how the local provider
          (which cannot be destroyed) ends up without a Destroy button. */}
      {capabilities?.canDelete && (
        <ActionButton label="Destroy" action="destroy" variant="destructive" ariaLabel="Destroy compute target" />
      )}
    </div>
  );
}
