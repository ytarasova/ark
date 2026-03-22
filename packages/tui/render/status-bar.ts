import { state } from "../state.js";
import { statusBar } from "../layout.js";

export function renderStatusBar() {
  const { sessions, tab } = state;

  const nRun = sessions.filter((s) => s.status === "running").length;
  const nWait = sessions.filter((s) => s.status === "waiting").length;
  const nErr = sessions.filter((s) => s.status === "failed").length;

  let left = ` ${sessions.length} sessions`;
  if (nRun) left += `  {blue-fg}● ${nRun} running{/blue-fg}`;
  if (nWait) left += `  {yellow-fg}⏸ ${nWait} waiting{/yellow-fg}`;
  if (nErr) left += `  {red-fg}✕ ${nErr} errors{/red-fg}`;

  const keys = tab === "hosts"
    ? "j/k:move  n:new  Enter:provision  s:start/stop  S:sync  x:delete  a:ssh  q:quit"
    : tab === "sessions"
    ? "j/k:move  Enter:dispatch  a:attach  c:done  s:stop  r:resume  n:new  x:kill  q:quit"
    : tab === "agents"
    ? "j/k:move  e:edit  q:quit"
    : "j/k:move  q:quit";

  statusBar.setContent(`${left}   {gray-fg}${keys}{/gray-fg}`);
}
