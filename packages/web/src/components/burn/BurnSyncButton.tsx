import { useState, useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { useBurnSync } from "../../hooks/useBurnQueries.js";

export function BurnSyncButton() {
  const sync = useBurnSync();
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (sync.isSuccess && sync.data) {
      const count = sync.data?.synced ?? sync.data?.sessions ?? 0;
      setSuccessMsg(`Synced ${count}`);
      const t = setTimeout(() => setSuccessMsg(null), 2000);
      return () => clearTimeout(t);
    }
  }, [sync.isSuccess, sync.data]);

  return (
    <button
      onClick={() => sync.mutate(false)}
      disabled={sync.isPending}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] transition-colors",
        "text-muted-foreground hover:text-foreground hover:bg-accent",
        sync.isPending && "opacity-60 cursor-not-allowed",
      )}
    >
      <RefreshCw
        size={13}
        className={cn(sync.isPending && "animate-spin")}
      />
      {successMsg ? (
        <span className="text-emerald-400">{successMsg}</span>
      ) : (
        <span>Sync</span>
      )}
    </button>
  );
}
