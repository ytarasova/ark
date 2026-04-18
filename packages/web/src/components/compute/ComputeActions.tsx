import { Button } from "../ui/button.js";

export function ComputeActions({ compute, onAction }: { compute: any; onAction: (action: string) => void }) {
  const s = compute.status || "unknown";
  return (
    <div className="flex gap-1.5 flex-wrap">
      {(s === "stopped" || s === "created" || s === "destroyed") && (
        <Button size="xs" onClick={() => onAction("provision")} aria-label="Provision compute target">
          Provision
        </Button>
      )}
      {(s === "stopped" || s === "created") && (
        <Button variant="outline" size="xs" onClick={() => onAction("start")} aria-label="Start compute target">
          Start
        </Button>
      )}
      {s === "running" && (
        <Button variant="destructive" size="xs" onClick={() => onAction("stop")} aria-label="Stop compute target">
          Stop
        </Button>
      )}
      {s !== "provisioning" && (
        <Button variant="destructive" size="xs" onClick={() => onAction("destroy")} aria-label="Destroy compute target">
          Destroy
        </Button>
      )}
    </div>
  );
}
