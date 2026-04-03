export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

export function fmtCost(n: number): string {
  return n < 0.01 && n > 0 ? "<$0.01" : "$" + n.toFixed(2);
}
