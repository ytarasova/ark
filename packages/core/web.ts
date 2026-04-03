/**
 * Web UI dashboard — browser-based session management.
 * Serves HTML dashboard + JSON API + SSE live updates on a single port.
 *
 * All data is read from the local SQLite store (no external/untrusted input).
 * The dashboard renders local session data using template literals.
 */

import { listSessions, getSession, getEvents, type Session } from "./store.js";
import { getAllSessionCosts, formatCost } from "./costs.js";

export interface WebServerOptions {
  port?: number;
  readOnly?: boolean;
  token?: string;
}

export function startWebServer(opts?: WebServerOptions): { stop: () => void; url: string } {
  const port = opts?.port ?? 8420;
  const readOnly = opts?.readOnly ?? false;
  const token = opts?.token;

  // SSE clients
  const sseClients = new Set<ReadableStreamController>();

  // Broadcast to all SSE clients
  function broadcast(event: string, data: any) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try { client.enqueue(new TextEncoder().encode(msg)); }
      catch { sseClients.delete(client); }
    }
  }

  // Periodic broadcast of session status
  const statusInterval = setInterval(() => {
    const sessions = listSessions({ limit: 200 });
    broadcast("sessions", sessions.map(s => ({
      id: s.id, summary: s.summary, status: s.status,
      agent: s.agent, repo: s.repo, group: s.group_name,
      updated: s.updated_at,
    })));
  }, 3000);

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);

      // Token auth
      if (token) {
        const provided = url.searchParams.get("token") ?? req.headers.get("authorization")?.replace("Bearer ", "");
        if (provided !== token) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      // SSE endpoint
      if (url.pathname === "/api/events/stream") {
        const stream = new ReadableStream({
          start(controller) {
            sseClients.add(controller);
          },
          cancel(controller) {
            sseClients.delete(controller);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // API routes
      if (url.pathname === "/api/sessions") {
        const sessions = listSessions({ limit: 200 });
        return Response.json(sessions);
      }

      if (url.pathname.startsWith("/api/sessions/")) {
        const id = url.pathname.split("/")[3];
        const session = getSession(id);
        if (!session) return Response.json({ error: "Not found" }, { status: 404 });
        const events = getEvents(id);
        return Response.json({ session, events });
      }

      if (url.pathname === "/api/costs") {
        const sessions = listSessions({ limit: 500 });
        const costs = getAllSessionCosts(sessions);
        return Response.json(costs);
      }

      // Dashboard HTML
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(dashboardHtml(readOnly, token), {
          headers: { "Content-Type": "text/html" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const serverUrl = `http://localhost:${port}${token ? `?token=${token}` : ""}`;

  return {
    url: serverUrl,
    stop: () => {
      clearInterval(statusInterval);
      for (const client of sseClients) {
        try { client.close(); } catch { /* ignore */ }
      }
      sseClients.clear();
      server.stop();
    },
  };
}

/** Escape text for safe insertion into HTML (prevents XSS from session data). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dashboardHtml(readOnly: boolean, token?: string): string {
  const tokenParam = token ? `?token=${esc(token)}` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ark Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1b26; color: #c0caf5; }
  .header { background: #24283b; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #3b4261; }
  .header h1 { font-size: 20px; color: #7aa2f7; }
  .header .stats { color: #787fa0; font-size: 14px; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 24px; }
  .tab { padding: 8px 16px; border-radius: 6px; cursor: pointer; background: #24283b; color: #787fa0; border: 1px solid #3b4261; }
  .tab.active { background: #7aa2f7; color: #1a1b26; border-color: #7aa2f7; }
  .card { background: #24283b; border-radius: 8px; padding: 16px; margin-bottom: 12px; border: 1px solid #3b4261; }
  .card:hover { border-color: #7aa2f7; }
  .session-row { display: flex; justify-content: space-between; align-items: center; }
  .session-name { font-weight: 600; color: #c0caf5; }
  .session-meta { color: #787fa0; font-size: 13px; }
  .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
  .status-running { background: #9ece6a; }
  .status-waiting { background: #e0af68; }
  .status-completed { background: #7aa2f7; }
  .status-failed { background: #f7768e; }
  .status-stopped, .status-pending, .status-ready { background: #787fa0; }
  .status-deleting { background: #565f89; }
  .cost-total { font-size: 28px; font-weight: 700; color: #9ece6a; margin-bottom: 8px; }
  .cost-breakdown { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-top: 16px; }
  .cost-card { background: #1a1b26; border-radius: 6px; padding: 12px; }
  .cost-model { font-weight: 600; color: #e0af68; }
  .cost-amount { font-size: 20px; color: #c0caf5; }
  .empty { color: #565f89; text-align: center; padding: 48px; }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #9ece6a; display: inline-block; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
</style>
</head>
<body>
<div class="header">
  <h1>Ark Dashboard</h1>
  <div class="stats"><span class="live-dot"></span> Live${readOnly ? " (read-only)" : ""}</div>
</div>
<div class="container">
  <div class="tabs">
    <div class="tab active" onclick="showTab('sessions')">Sessions</div>
    <div class="tab" onclick="showTab('costs')">Costs</div>
  </div>
  <div id="sessions-tab"></div>
  <div id="costs-tab" style="display:none"></div>
</div>
<script>
const TOKEN_PARAM = "${tokenParam}";

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t, i) => {
    t.classList.toggle('active', t.textContent.toLowerCase() === name);
  });
  document.getElementById('sessions-tab').style.display = name === 'sessions' ? 'block' : 'none';
  document.getElementById('costs-tab').style.display = name === 'costs' ? 'block' : 'none';
  if (name === 'costs') loadCosts();
}

function renderSessions(sessions) {
  const el = document.getElementById('sessions-tab');
  if (!sessions.length) { el.textContent = ''; const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No sessions'; el.appendChild(e); return; }
  el.textContent = '';
  sessions.forEach(s => {
    const card = document.createElement('div');
    card.className = 'card';
    const row = document.createElement('div');
    row.className = 'session-row';
    const left = document.createElement('div');
    const dot = document.createElement('span');
    dot.className = 'status status-' + escHtml(s.status);
    left.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = s.summary || s.id;
    left.appendChild(name);
    row.appendChild(left);
    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = [s.status, s.agent || '', s.group || ''].filter(Boolean).join(' \\u00b7 ');
    row.appendChild(meta);
    card.appendChild(row);
    const repo = document.createElement('div');
    repo.className = 'session-meta';
    repo.style.marginTop = '4px';
    repo.textContent = s.repo || '';
    card.appendChild(repo);
    el.appendChild(card);
  });
}

async function loadCosts() {
  const resp = await fetch('/api/costs' + TOKEN_PARAM);
  const data = await resp.json();
  const el = document.getElementById('costs-tab');
  el.textContent = '';
  const byModel = {};
  for (const s of data.sessions) {
    const m = s.model || 'unknown';
    if (!byModel[m]) byModel[m] = { cost: 0, count: 0 };
    byModel[m].cost += s.cost;
    byModel[m].count++;
  }

  const total = document.createElement('div');
  total.className = 'cost-total';
  total.textContent = '$' + data.total.toFixed(2);
  el.appendChild(total);

  const summary = document.createElement('div');
  summary.className = 'session-meta';
  summary.textContent = data.sessions.length + ' sessions with usage data';
  el.appendChild(summary);

  const grid = document.createElement('div');
  grid.className = 'cost-breakdown';
  Object.entries(byModel).forEach(([m, d]) => {
    const c = document.createElement('div');
    c.className = 'cost-card';
    const mn = document.createElement('div');
    mn.className = 'cost-model';
    mn.textContent = m;
    c.appendChild(mn);
    const amt = document.createElement('div');
    amt.className = 'cost-amount';
    amt.textContent = '$' + d.cost.toFixed(2);
    c.appendChild(amt);
    const cnt = document.createElement('div');
    cnt.className = 'session-meta';
    cnt.textContent = d.count + ' sessions';
    c.appendChild(cnt);
    grid.appendChild(c);
  });
  el.appendChild(grid);

  const heading = document.createElement('h3');
  heading.style.marginTop = '24px';
  heading.style.color = '#787fa0';
  heading.textContent = 'Top Sessions';
  el.appendChild(heading);

  data.sessions.slice(0, 20).forEach(s => {
    const card = document.createElement('div');
    card.className = 'card';
    const row = document.createElement('div');
    row.className = 'session-row';
    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = s.summary || s.sessionId;
    row.appendChild(name);
    const cost = document.createElement('span');
    cost.className = 'cost-model';
    cost.textContent = '$' + s.cost.toFixed(2);
    row.appendChild(cost);
    card.appendChild(row);
    el.appendChild(card);
  });
}

// SSE live updates
const evtSource = new EventSource('/api/events/stream' + TOKEN_PARAM);
evtSource.addEventListener('sessions', (e) => {
  renderSessions(JSON.parse(e.data));
});

// Initial load
fetch('/api/sessions' + TOKEN_PARAM).then(r => r.json()).then(renderSessions);
</script>
</body>
</html>`;
}
