export function StatusDot({ status }: { status?: string }) {
  return <span className={`dot dot-${status || "pending"}`} />;
}

export function StatusBadge({ status }: { status?: string }) {
  return (
    <span className={`status-badge badge-${status || "pending"}`}>
      {status || "unknown"}
    </span>
  );
}
