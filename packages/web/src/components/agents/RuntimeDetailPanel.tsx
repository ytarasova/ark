interface RuntimeDetailPanelProps {
  runtime: any;
}

export function RuntimeDetailPanel({ runtime }: RuntimeDetailPanelProps) {
  return (
    <div className="p-5">
      <h2 className="text-lg font-semibold text-foreground mb-1">{runtime.name}</h2>
      {runtime.description && <p className="text-sm text-muted-foreground mb-5">{runtime.description}</p>}
      <div className="mb-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
          Configuration
        </h3>
        <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
          <span className="text-muted-foreground">Type</span>
          <span
            className="text-card-foreground"
            style={{ fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace' }}
          >
            {runtime.type || "-"}
          </span>
          <span className="text-muted-foreground">Source</span>
          <span
            className="text-card-foreground"
            style={{ fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace' }}
          >
            {runtime._source || "builtin"}
          </span>
          {runtime.permission_mode && (
            <>
              <span className="text-muted-foreground">Permission</span>
              <span
                className="text-card-foreground"
                style={{ fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace' }}
              >
                {runtime.permission_mode}
              </span>
            </>
          )}
          {runtime.task_delivery && (
            <>
              <span className="text-muted-foreground">Task Delivery</span>
              <span
                className="text-card-foreground"
                style={{ fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace' }}
              >
                {runtime.task_delivery}
              </span>
            </>
          )}
        </div>
      </div>

      {runtime.command && runtime.command.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Command</h3>
          <div className="bg-[var(--bg-code)] border border-border rounded-lg px-3.5 py-2.5 font-mono text-[12px] text-muted-foreground">
            {runtime.command.join(" ")}
          </div>
        </div>
      )}

      {runtime.env && Object.keys(runtime.env).length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
            Environment
          </h3>
          <div className="bg-[var(--bg-code)] border border-border rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] text-muted-foreground">
            {Object.entries(runtime.env).map(([k, v]) => (
              <div key={k}>
                {k}={String(v)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
