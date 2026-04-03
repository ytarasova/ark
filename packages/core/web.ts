/**
 * Web UI dashboard — browser-based session management.
 * Serves HTML dashboard + JSON API + SSE live updates on a single port.
 *
 * All data is read from the local SQLite store (no external/untrusted input).
 * The dashboard renders local session data using template literals.
 */

import { listSessions, getSession, getEvents, getGroups, type Session } from "./store.js";
import { getAllSessionCosts, formatCost } from "./costs.js";
import {
  startSession,
  dispatch,
  stop,
  resume,
  deleteSessionAsync,
  undeleteSessionAsync,
  getOutput,
} from "./session.js";

export interface WebServerOptions {
  port?: number;
  readOnly?: boolean;
  token?: string;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS });
}

function errorResponse(err: unknown, status = 500): Response {
  const message = err instanceof Error ? err.message : String(err);
  return jsonResponse({ ok: false, message }, status);
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
    async fetch(req) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

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
            ...CORS,
          },
        });
      }

      // --- API routes ---

      // GET /api/status
      if (url.pathname === "/api/status" && req.method === "GET") {
        const sessions = listSessions({ limit: 500 });
        const byStatus: Record<string, number> = {};
        for (const s of sessions) {
          byStatus[s.status] = (byStatus[s.status] || 0) + 1;
        }
        return jsonResponse({ total: sessions.length, byStatus });
      }

      // GET /api/groups
      if (url.pathname === "/api/groups" && req.method === "GET") {
        return jsonResponse(getGroups());
      }

      // GET /api/costs
      if (url.pathname === "/api/costs") {
        const sessions = listSessions({ limit: 500 });
        const costs = getAllSessionCosts(sessions);
        return jsonResponse(costs);
      }

      // POST /api/sessions (create)
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json();
          const session = startSession({
            summary: body.summary,
            repo: body.repo,
            flow: body.flow,
            group_name: body.group_name,
            workdir: body.workdir,
          });
          return jsonResponse({ ok: true, session });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/sessions
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const sessions = listSessions({ limit: 200 });
        return jsonResponse(sessions);
      }

      // Session-specific routes: /api/sessions/:id/...
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(.+)$/);
      if (sessionMatch) {
        const [, id, action] = sessionMatch;

        if (action === "output" && req.method === "GET") {
          try {
            const output = await getOutput(id);
            return jsonResponse({ ok: true, output });
          } catch (err) {
            return errorResponse(err);
          }
        }

        if (req.method === "POST") {
          if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);

          try {
            switch (action) {
              case "dispatch": {
                const result = await dispatch(id);
                return jsonResponse(result);
              }
              case "stop": {
                const result = await stop(id);
                return jsonResponse(result);
              }
              case "restart": {
                const result = await resume(id);
                return jsonResponse(result);
              }
              case "delete": {
                const result = await deleteSessionAsync(id);
                return jsonResponse(result);
              }
              case "undelete": {
                const result = await undeleteSessionAsync(id);
                return jsonResponse(result);
              }
              default:
                return jsonResponse({ error: "Unknown action" }, 404);
            }
          } catch (err) {
            return errorResponse(err);
          }
        }
      }

      // GET /api/sessions/:id (detail)
      if (url.pathname.startsWith("/api/sessions/")) {
        const id = url.pathname.split("/")[3];
        const session = getSession(id);
        if (!session) return jsonResponse({ error: "Not found" }, 404);
        const events = getEvents(id);
        return jsonResponse({ session, events });
      }

      // Dashboard HTML
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(dashboardHtml(readOnly, token), {
          headers: { "Content-Type": "text/html", ...CORS },
        });
      }

      return new Response("Not Found", { status: 404, headers: CORS });
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
/* ---- Reset & Base ---- */
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: #1a1b26; color: #c0caf5; line-height: 1.5;
}
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #3b4261; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #565f89; }
::selection { background: #7aa2f7; color: #1a1b26; }
input, select, textarea, button { font-family: inherit; }

/* ---- Layout ---- */
.app { display: grid; grid-template-columns: 220px 1fr; grid-template-rows: 1fr; height: 100vh; }
@media (max-width: 768px) { .app { grid-template-columns: 56px 1fr; } .sidebar-label { display: none; } }

/* ---- Sidebar ---- */
.sidebar {
  background: #16161e; border-right: 1px solid #3b4261;
  display: flex; flex-direction: column; padding: 0; overflow-y: auto;
}
.sidebar-header {
  padding: 20px 16px 16px; border-bottom: 1px solid #3b4261;
  display: flex; align-items: center; gap: 10px;
}
.sidebar-logo { font-size: 18px; font-weight: 700; color: #7aa2f7; letter-spacing: -0.5px; }
.sidebar-live {
  width: 8px; height: 8px; border-radius: 50%; background: #9ece6a;
  animation: pulse 2s infinite; flex-shrink: 0;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.sidebar-nav { flex: 1; padding: 8px; }
.nav-item {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  border-radius: 8px; cursor: pointer; color: #787fa0;
  transition: all 0.15s ease; font-size: 14px; font-weight: 500;
  user-select: none; border: 1px solid transparent;
}
.nav-item:hover { color: #c0caf5; background: #1a1b26; }
.nav-item.active { color: #7aa2f7; background: #24283b; border-color: #3b4261; }
.nav-icon { font-size: 16px; width: 20px; text-align: center; flex-shrink: 0; }
.sidebar-footer {
  padding: 12px 16px; border-top: 1px solid #3b4261;
  font-size: 11px; color: #565f89; text-align: center;
}

/* ---- Main Content ---- */
.main { overflow-y: auto; padding: 0; display: flex; flex-direction: column; }
.main-header {
  padding: 16px 24px; border-bottom: 1px solid #3b4261;
  display: flex; justify-content: space-between; align-items: center;
  background: #1a1b26; position: sticky; top: 0; z-index: 10;
}
.main-title { font-size: 18px; font-weight: 600; color: #c0caf5; }
.main-body { flex: 1; padding: 20px 24px; overflow-y: auto; }

/* ---- Buttons ---- */
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 14px; border-radius: 6px; font-size: 13px; font-weight: 500;
  cursor: pointer; border: 1px solid #3b4261; background: #24283b; color: #c0caf5;
  transition: all 0.15s ease; user-select: none;
}
.btn:hover { border-color: #7aa2f7; color: #7aa2f7; }
.btn-primary { background: #7aa2f7; color: #1a1b26; border-color: #7aa2f7; }
.btn-primary:hover { background: #89b4fa; border-color: #89b4fa; }
.btn-danger { color: #f7768e; border-color: #f7768e33; }
.btn-danger:hover { background: #f7768e22; border-color: #f7768e; }
.btn-success { color: #9ece6a; border-color: #9ece6a33; }
.btn-success:hover { background: #9ece6a22; border-color: #9ece6a; }
.btn-warning { color: #e0af68; border-color: #e0af6833; }
.btn-warning:hover { background: #e0af6822; border-color: #e0af68; }
.btn-sm { padding: 4px 10px; font-size: 12px; }
.btn-group { display: flex; gap: 6px; flex-wrap: wrap; }

/* ---- Filter bar ---- */
.filter-bar {
  display: flex; gap: 8px; align-items: center; margin-bottom: 16px; flex-wrap: wrap;
}
.search-input {
  background: #24283b; border: 1px solid #3b4261; border-radius: 6px;
  color: #c0caf5; padding: 7px 12px; font-size: 13px; width: 240px;
  outline: none; transition: border-color 0.15s;
}
.search-input:focus { border-color: #7aa2f7; }
.search-input::placeholder { color: #565f89; }
.filter-chip {
  padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: 500;
  cursor: pointer; border: 1px solid #3b4261; background: transparent; color: #787fa0;
  transition: all 0.15s; user-select: none;
}
.filter-chip:hover { border-color: #565f89; color: #c0caf5; }
.filter-chip.active { background: #7aa2f7; color: #1a1b26; border-color: #7aa2f7; }

/* ---- Session list ---- */
.session-list { display: flex; flex-direction: column; gap: 6px; }
.session-card {
  background: #24283b; border: 1px solid #3b4261; border-radius: 8px;
  padding: 14px 16px; cursor: pointer; transition: all 0.15s;
}
.session-card:hover { border-color: #565f89; }
.session-card.selected { border-color: #7aa2f7; background: #292e42; }
.session-row { display: flex; justify-content: space-between; align-items: center; }
.session-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.session-name {
  font-weight: 600; color: #c0caf5; font-size: 14px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.session-meta {
  display: flex; gap: 12px; color: #787fa0; font-size: 12px; margin-top: 4px;
}
.session-meta span { white-space: nowrap; }

/* ---- Status dot ---- */
.dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  display: inline-block;
}
.dot-running { background: #9ece6a; box-shadow: 0 0 6px #9ece6a88; }
.dot-waiting { background: #e0af68; }
.dot-completed { background: #7aa2f7; }
.dot-failed { background: #f7768e; box-shadow: 0 0 6px #f7768e88; }
.dot-stopped, .dot-pending, .dot-ready { background: #787fa0; }
.dot-deleting { background: #565f89; }
.status-badge {
  display: inline-block; padding: 2px 10px; border-radius: 12px;
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
}
.badge-running { background: #9ece6a22; color: #9ece6a; }
.badge-waiting { background: #e0af6822; color: #e0af68; }
.badge-completed { background: #7aa2f722; color: #7aa2f7; }
.badge-failed { background: #f7768e22; color: #f7768e; }
.badge-stopped { background: #787fa022; color: #787fa0; }
.badge-pending, .badge-ready { background: #787fa022; color: #787fa0; }

/* ---- Detail panel ---- */
.detail-panel {
  position: fixed; top: 0; right: 0; width: 520px; height: 100vh;
  background: #1a1b26; border-left: 1px solid #3b4261;
  display: flex; flex-direction: column; z-index: 100;
  box-shadow: -4px 0 24px #00000044;
  transform: translateX(100%); transition: transform 0.2s ease;
}
.detail-panel.open { transform: translateX(0); }
.detail-header {
  padding: 16px 20px; border-bottom: 1px solid #3b4261;
  display: flex; justify-content: space-between; align-items: center;
}
.detail-close {
  background: none; border: none; color: #787fa0; font-size: 20px;
  cursor: pointer; padding: 4px; line-height: 1;
}
.detail-close:hover { color: #c0caf5; }
.detail-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
.detail-section { margin-bottom: 20px; }
.detail-section-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 1px; color: #565f89; margin-bottom: 8px;
}
.detail-grid {
  display: grid; grid-template-columns: 100px 1fr; gap: 4px 12px;
  font-size: 13px;
}
.detail-label { color: #787fa0; }
.detail-value { color: #c0caf5; word-break: break-all; }

/* ---- Output terminal ---- */
.output-box {
  background: #16161e; border: 1px solid #3b4261; border-radius: 6px;
  padding: 12px; font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 12px; line-height: 1.6; max-height: 300px; overflow-y: auto;
  white-space: pre-wrap; word-break: break-all; color: #a9b1d6;
}

/* ---- Event timeline ---- */
.timeline { display: flex; flex-direction: column; gap: 0; }
.timeline-item {
  display: flex; gap: 12px; padding: 6px 0; font-size: 12px;
  border-left: 2px solid #3b4261; margin-left: 6px; padding-left: 14px;
}
.timeline-time { color: #565f89; white-space: nowrap; flex-shrink: 0; width: 70px; }
.timeline-event { color: #787fa0; }
.timeline-event b { color: #c0caf5; font-weight: 600; }

/* ---- Modal ---- */
.modal-backdrop {
  position: fixed; inset: 0; background: #00000088; z-index: 200;
  display: flex; align-items: center; justify-content: center;
  animation: fadeIn 0.15s ease;
}
@keyframes fadeIn { from { opacity: 0; } }
.modal {
  background: #24283b; border: 1px solid #3b4261; border-radius: 12px;
  padding: 24px; width: 480px; max-width: 90vw; max-height: 90vh;
  overflow-y: auto; box-shadow: 0 8px 32px #00000066;
}
.modal-title { font-size: 16px; font-weight: 600; color: #c0caf5; margin-bottom: 16px; }
.form-group { margin-bottom: 14px; }
.form-label { display: block; font-size: 12px; font-weight: 500; color: #787fa0; margin-bottom: 4px; }
.form-input {
  width: 100%; background: #1a1b26; border: 1px solid #3b4261; border-radius: 6px;
  color: #c0caf5; padding: 8px 12px; font-size: 13px; outline: none;
}
.form-input:focus { border-color: #7aa2f7; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

/* ---- Costs view ---- */
.cost-hero { text-align: center; padding: 32px 0 24px; }
.cost-total { font-size: 48px; font-weight: 700; color: #9ece6a; }
.cost-subtitle { color: #787fa0; font-size: 14px; margin-top: 4px; }
.cost-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px; margin-bottom: 24px;
}
.cost-card {
  background: #24283b; border: 1px solid #3b4261; border-radius: 8px; padding: 16px;
}
.cost-model { font-weight: 600; color: #e0af68; font-size: 13px; text-transform: capitalize; }
.cost-amount { font-size: 24px; font-weight: 700; color: #c0caf5; margin-top: 4px; }
.cost-count { font-size: 12px; color: #787fa0; margin-top: 2px; }

/* ---- Status view ---- */
.status-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px; margin-bottom: 24px;
}
.status-card {
  background: #24283b; border: 1px solid #3b4261; border-radius: 8px;
  padding: 20px; text-align: center;
}
.status-count { font-size: 36px; font-weight: 700; }
.status-label {
  font-size: 12px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 1px; margin-top: 4px;
}
.status-bar-row {
  display: flex; height: 8px; border-radius: 4px; overflow: hidden;
  background: #16161e; margin-bottom: 24px;
}
.status-bar-segment { transition: width 0.3s ease; }

/* ---- Table ---- */
.table { width: 100%; border-collapse: collapse; }
.table th {
  text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 1px; color: #565f89; padding: 8px 12px;
  border-bottom: 1px solid #3b4261;
}
.table td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #3b426133; }
.table tr:hover td { background: #24283b; }

/* ---- Empty state ---- */
.empty { text-align: center; padding: 64px 24px; color: #565f89; }
.empty-icon { font-size: 48px; margin-bottom: 12px; }
.empty-text { font-size: 15px; }

/* ---- Toast ---- */
.toast {
  position: fixed; bottom: 24px; right: 24px; padding: 12px 20px;
  background: #24283b; border: 1px solid #3b4261; border-radius: 8px;
  color: #c0caf5; font-size: 13px; z-index: 300;
  box-shadow: 0 4px 16px #00000044;
  animation: slideUp 0.2s ease;
}
.toast-success { border-color: #9ece6a; }
.toast-error { border-color: #f7768e; }
@keyframes slideUp { from { transform: translateY(20px); opacity: 0; } }
</style>
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@19",
    "react-dom/client": "https://esm.sh/react-dom@19/client",
    "react/jsx-runtime": "https://esm.sh/react@19/jsx-runtime"
  }
}
</script>
</head>
<body>
<div id="root"></div>
<script type="module">
import { createElement as h, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

const TOKEN = "${tokenParam}";
const READ_ONLY = ${readOnly};

// ---- API helpers ----
async function api(path, opts) {
  const url = path + (TOKEN && !path.includes('?') ? TOKEN : '');
  const resp = await fetch(url, opts);
  return resp.json();
}
async function apiPost(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ---- Utility ----
function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function fmtCost(n) { return n < 0.01 && n > 0 ? '<$0.01' : '$' + n.toFixed(2); }

const STATUS_COLORS = {
  running: '#9ece6a', waiting: '#e0af68', completed: '#7aa2f7',
  failed: '#f7768e', stopped: '#787fa0', pending: '#787fa0',
  ready: '#787fa0', deleting: '#565f89',
};

// ---- Components ----

function StatusDot({ status }) {
  return h('span', { className: 'dot dot-' + (status || 'pending') });
}

function StatusBadge({ status }) {
  return h('span', { className: 'status-badge badge-' + (status || 'pending') }, status || 'unknown');
}

function Toast({ message, type, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, []);
  return h('div', { className: 'toast toast-' + type }, message);
}

function Sidebar({ activeView, onNavigate }) {
  const items = [
    { id: 'sessions', icon: '\\u25B6', label: 'Sessions' },
    { id: 'costs', icon: '\\u0024', label: 'Costs' },
    { id: 'status', icon: '\\u2261', label: 'System Status' },
  ];
  return h('div', { className: 'sidebar' },
    h('div', { className: 'sidebar-header' },
      h('span', { className: 'sidebar-logo' }, 'Ark'),
      h('span', { className: 'sidebar-live' }),
    ),
    h('nav', { className: 'sidebar-nav' },
      items.map(it =>
        h('div', {
          key: it.id,
          className: 'nav-item' + (activeView === it.id ? ' active' : ''),
          onClick: () => onNavigate(it.id),
        },
          h('span', { className: 'nav-icon' }, it.icon),
          h('span', { className: 'sidebar-label' }, it.label),
        )
      )
    ),
    h('div', { className: 'sidebar-footer' },
      READ_ONLY ? 'Read-only mode' : 'Ark Dashboard',
    ),
  );
}

function SessionActions({ session, onAction }) {
  if (READ_ONLY || !session) return null;
  const s = session.status;
  const btns = [];
  if (s === 'ready' || s === 'pending') {
    btns.push(h('button', { key: 'dispatch', className: 'btn btn-primary btn-sm', onClick: () => onAction('dispatch') }, 'Dispatch'));
  }
  if (s === 'running' || s === 'waiting') {
    btns.push(h('button', { key: 'stop', className: 'btn btn-warning btn-sm', onClick: () => onAction('stop') }, 'Stop'));
  }
  if (s === 'stopped' || s === 'failed') {
    btns.push(h('button', { key: 'restart', className: 'btn btn-success btn-sm', onClick: () => onAction('restart') }, 'Restart'));
  }
  if (s !== 'deleting') {
    btns.push(h('button', { key: 'delete', className: 'btn btn-danger btn-sm', onClick: () => onAction('delete') }, 'Delete'));
  }
  if (s === 'deleting') {
    btns.push(h('button', { key: 'undelete', className: 'btn btn-sm', onClick: () => onAction('undelete') }, 'Undelete'));
  }
  return h('div', { className: 'btn-group' }, ...btns);
}

function SessionDetail({ sessionId, onClose, onToast }) {
  const [detail, setDetail] = useState(null);
  const [output, setOutput] = useState('');
  const outputRef = useRef(null);

  // Load detail
  useEffect(() => {
    if (!sessionId) return;
    api('/api/sessions/' + sessionId).then(setDetail);
  }, [sessionId]);

  // Poll output for running sessions
  useEffect(() => {
    if (!detail || !detail.session) return;
    if (detail.session.status !== 'running' && detail.session.status !== 'waiting') return;
    let active = true;
    function poll() {
      if (!active) return;
      api('/api/sessions/' + sessionId + '/output')
        .then(d => { if (active && d.output) setOutput(d.output); })
        .catch(() => {});
    }
    poll();
    const iv = setInterval(poll, 2000);
    return () => { active = false; clearInterval(iv); };
  }, [detail?.session?.status, sessionId]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  async function handleAction(action) {
    const res = await apiPost('/api/sessions/' + sessionId + '/' + action);
    if (res.ok !== false) {
      onToast(action + ' successful', 'success');
      // Reload detail
      const d = await api('/api/sessions/' + sessionId);
      setDetail(d);
    } else {
      onToast(res.message || 'Action failed', 'error');
    }
  }

  if (!detail || !detail.session) {
    return h('div', { className: 'detail-panel open' },
      h('div', { className: 'detail-header' },
        h('span', null, 'Loading...'),
        h('button', { className: 'detail-close', onClick: onClose }, '\\u2715'),
      ),
    );
  }

  const s = detail.session;
  const events = detail.events || [];

  return h('div', { className: 'detail-panel open' },
    h('div', { className: 'detail-header' },
      h('div', null,
        h(StatusBadge, { status: s.status }),
        h('span', { style: { marginLeft: 8, fontWeight: 600 } }, s.id),
      ),
      h('button', { className: 'detail-close', onClick: onClose }, '\\u2715'),
    ),
    h('div', { className: 'detail-body' },
      // Actions
      h('div', { className: 'detail-section' },
        h(SessionActions, { session: s, onAction: handleAction }),
      ),
      // Metadata
      h('div', { className: 'detail-section' },
        h('div', { className: 'detail-section-title' }, 'Details'),
        h('div', { className: 'detail-grid' },
          h('span', { className: 'detail-label' }, 'Summary'),
          h('span', { className: 'detail-value' }, s.summary || '-'),
          h('span', { className: 'detail-label' }, 'Agent'),
          h('span', { className: 'detail-value' }, s.agent || '-'),
          h('span', { className: 'detail-label' }, 'Flow'),
          h('span', { className: 'detail-value' }, s.pipeline || s.flow || '-'),
          h('span', { className: 'detail-label' }, 'Stage'),
          h('span', { className: 'detail-value' }, s.stage || '-'),
          h('span', { className: 'detail-label' }, 'Repo'),
          h('span', { className: 'detail-value' }, s.repo || '-'),
          h('span', { className: 'detail-label' }, 'Branch'),
          h('span', { className: 'detail-value' }, s.branch || '-'),
          h('span', { className: 'detail-label' }, 'Group'),
          h('span', { className: 'detail-value' }, s.group_name || '-'),
          h('span', { className: 'detail-label' }, 'Created'),
          h('span', { className: 'detail-value' }, relTime(s.created_at)),
          h('span', { className: 'detail-label' }, 'Updated'),
          h('span', { className: 'detail-value' }, relTime(s.updated_at)),
        ),
      ),
      // Output
      output ? h('div', { className: 'detail-section' },
        h('div', { className: 'detail-section-title' }, 'Live Output'),
        h('div', { className: 'output-box', ref: outputRef }, output),
      ) : null,
      // Events
      events.length > 0 ? h('div', { className: 'detail-section' },
        h('div', { className: 'detail-section-title' }, 'Events (' + events.length + ')'),
        h('div', { className: 'timeline' },
          events.slice(-50).reverse().map((ev, i) =>
            h('div', { key: i, className: 'timeline-item' },
              h('span', { className: 'timeline-time' }, relTime(ev.created_at)),
              h('span', { className: 'timeline-event' },
                h('b', null, ev.type),
                ev.data ? ' ' + (typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)).slice(0, 120) : '',
              ),
            )
          )
        ),
      ) : null,
    ),
  );
}

function NewSessionModal({ onClose, onSubmit }) {
  const [form, setForm] = useState({ summary: '', repo: '.', flow: '', group_name: '' });

  function update(key, val) { setForm(prev => ({ ...prev, [key]: val })); }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.summary.trim()) return;
    onSubmit(form);
  }

  return h('div', { className: 'modal-backdrop', onClick: e => { if (e.target === e.currentTarget) onClose(); } },
    h('form', { className: 'modal', onSubmit: handleSubmit },
      h('div', { className: 'modal-title' }, 'New Session'),
      h('div', { className: 'form-group' },
        h('label', { className: 'form-label' }, 'Summary *'),
        h('input', {
          className: 'form-input', autoFocus: true,
          value: form.summary, onChange: e => update('summary', e.target.value),
          placeholder: 'What should the agent work on?',
        }),
      ),
      h('div', { className: 'form-group' },
        h('label', { className: 'form-label' }, 'Repository'),
        h('input', {
          className: 'form-input',
          value: form.repo, onChange: e => update('repo', e.target.value),
          placeholder: '/path/to/repo or .',
        }),
      ),
      h('div', { className: 'form-group' },
        h('label', { className: 'form-label' }, 'Flow'),
        h('input', {
          className: 'form-input',
          value: form.flow, onChange: e => update('flow', e.target.value),
          placeholder: 'default',
        }),
      ),
      h('div', { className: 'form-group' },
        h('label', { className: 'form-label' }, 'Group'),
        h('input', {
          className: 'form-input',
          value: form.group_name, onChange: e => update('group_name', e.target.value),
          placeholder: 'Optional group name',
        }),
      ),
      h('div', { className: 'form-actions' },
        h('button', { type: 'button', className: 'btn', onClick: onClose }, 'Cancel'),
        h('button', { type: 'submit', className: 'btn btn-primary' }, 'Create Session'),
      ),
    ),
  );
}

function SessionList({ sessions, selectedId, onSelect, filter, onFilterChange, search, onSearchChange, groups, groupFilter, onGroupFilter, onNewSession }) {
  const filters = ['all', 'running', 'waiting', 'stopped', 'failed', 'completed'];

  const filtered = useMemo(() => {
    let list = sessions || [];
    if (filter !== 'all') list = list.filter(s => s.status === filter);
    if (groupFilter) list = list.filter(s => s.group_name === groupFilter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(s =>
        (s.summary || '').toLowerCase().includes(q) ||
        (s.id || '').toLowerCase().includes(q) ||
        (s.repo || '').toLowerCase().includes(q) ||
        (s.agent || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [sessions, filter, search, groupFilter]);

  return h('div', null,
    h('div', { className: 'filter-bar' },
      h('input', {
        className: 'search-input',
        placeholder: 'Search sessions...',
        value: search, onChange: e => onSearchChange(e.target.value),
      }),
      ...filters.map(f =>
        h('button', {
          key: f, className: 'filter-chip' + (filter === f ? ' active' : ''),
          onClick: () => onFilterChange(f),
        }, f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1))
      ),
      groups && groups.length > 0 ? h('select', {
        className: 'form-input',
        style: { width: 140, padding: '5px 8px' },
        value: groupFilter,
        onChange: e => onGroupFilter(e.target.value),
      },
        h('option', { value: '' }, 'All groups'),
        ...groups.map(g => h('option', { key: g, value: g }, g)),
      ) : null,
      !READ_ONLY ? h('button', { className: 'btn btn-primary', onClick: onNewSession }, '+ New Session') : null,
    ),
    filtered.length === 0
      ? h('div', { className: 'empty' },
          h('div', { className: 'empty-icon' }, '\\u2205'),
          h('div', { className: 'empty-text' }, 'No sessions match your filters'),
        )
      : h('div', { className: 'session-list' },
          filtered.map(s =>
            h('div', {
              key: s.id,
              className: 'session-card' + (selectedId === s.id ? ' selected' : ''),
              onClick: () => onSelect(s.id),
            },
              h('div', { className: 'session-row' },
                h('div', { className: 'session-left' },
                  h(StatusDot, { status: s.status }),
                  h('span', { className: 'session-name' }, s.summary || s.id),
                ),
                h(StatusBadge, { status: s.status }),
              ),
              h('div', { className: 'session-meta' },
                h('span', null, s.id),
                s.agent ? h('span', null, s.agent) : null,
                s.group_name ? h('span', null, s.group_name) : null,
                s.repo ? h('span', null, s.repo) : null,
                h('span', null, relTime(s.updated_at)),
              ),
            )
          )
        ),
  );
}

function CostsView() {
  const [costs, setCosts] = useState(null);

  useEffect(() => {
    api('/api/costs').then(setCosts);
  }, []);

  if (!costs) return h('div', { className: 'empty' }, 'Loading costs...');

  const byModel = {};
  for (const s of costs.sessions || []) {
    const m = s.model || 'unknown';
    if (!byModel[m]) byModel[m] = { cost: 0, count: 0 };
    byModel[m].cost += s.cost;
    byModel[m].count++;
  }

  return h('div', null,
    h('div', { className: 'cost-hero' },
      h('div', { className: 'cost-total' }, fmtCost(costs.total || 0)),
      h('div', { className: 'cost-subtitle' }, (costs.sessions || []).length + ' sessions with usage data'),
    ),
    h('div', { className: 'cost-grid' },
      ...Object.entries(byModel).map(([model, data]) =>
        h('div', { key: model, className: 'cost-card' },
          h('div', { className: 'cost-model' }, model),
          h('div', { className: 'cost-amount' }, fmtCost(data.cost)),
          h('div', { className: 'cost-count' }, data.count + ' sessions'),
        )
      )
    ),
    (costs.sessions || []).length > 0 ? h('div', null,
      h('h3', { style: { color: '#787fa0', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 12 } }, 'Top Sessions by Cost'),
      h('table', { className: 'table' },
        h('thead', null,
          h('tr', null,
            h('th', null, 'Session'),
            h('th', null, 'Model'),
            h('th', { style: { textAlign: 'right' } }, 'Cost'),
          ),
        ),
        h('tbody', null,
          (costs.sessions || []).slice(0, 20).map((s, i) =>
            h('tr', { key: i },
              h('td', null, s.summary || s.sessionId),
              h('td', null, s.model || '-'),
              h('td', { style: { textAlign: 'right', color: '#9ece6a', fontWeight: 600 } }, fmtCost(s.cost)),
            )
          )
        ),
      ),
    ) : null,
  );
}

function StatusView({ sessions }) {
  const [statusData, setStatusData] = useState(null);

  useEffect(() => {
    api('/api/status').then(setStatusData);
  }, []);

  if (!statusData) return h('div', { className: 'empty' }, 'Loading...');

  const entries = Object.entries(statusData.byStatus || {}).sort((a, b) => b[1] - a[1]);
  const total = statusData.total || 0;

  return h('div', null,
    h('div', { style: { textAlign: 'center', marginBottom: 24 } },
      h('div', { style: { fontSize: 48, fontWeight: 700, color: '#c0caf5' } }, total),
      h('div', { style: { color: '#787fa0', fontSize: 14 } }, 'Total Sessions'),
    ),
    // Status bar
    total > 0 ? h('div', { className: 'status-bar-row' },
      ...entries.map(([status, count]) =>
        h('div', {
          key: status,
          className: 'status-bar-segment',
          style: { width: (count / total * 100) + '%', background: STATUS_COLORS[status] || '#565f89' },
        })
      )
    ) : null,
    // Cards
    h('div', { className: 'status-grid' },
      ...entries.map(([status, count]) =>
        h('div', { key: status, className: 'status-card' },
          h('div', { className: 'status-count', style: { color: STATUS_COLORS[status] || '#787fa0' } }, count),
          h('div', { className: 'status-label', style: { color: '#787fa0' } }, status),
        )
      )
    ),
    // Recent sessions
    sessions && sessions.length > 0 ? h('div', null,
      h('h3', { style: { color: '#787fa0', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 12 } }, 'Recent Sessions'),
      h('table', { className: 'table' },
        h('thead', null,
          h('tr', null,
            h('th', null, ''),
            h('th', null, 'Session'),
            h('th', null, 'Status'),
            h('th', null, 'Agent'),
            h('th', null, 'Updated'),
          ),
        ),
        h('tbody', null,
          sessions.slice(0, 15).map((s, i) =>
            h('tr', { key: s.id },
              h('td', null, h(StatusDot, { status: s.status })),
              h('td', null, s.summary || s.id),
              h('td', null, h(StatusBadge, { status: s.status })),
              h('td', null, s.agent || '-'),
              h('td', { style: { color: '#787fa0' } }, relTime(s.updated_at)),
            )
          )
        ),
      ),
    ) : null,
  );
}

function App() {
  const [view, setView] = useState('sessions');
  const [sessions, setSessions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [toast, setToast] = useState(null);

  function showToast(msg, type) { setToast({ msg, type }); }

  // Load sessions
  useEffect(() => {
    api('/api/sessions').then(setSessions);
    api('/api/groups').then(setGroups);
  }, []);

  // SSE live updates
  useEffect(() => {
    const es = new EventSource('/api/events/stream' + TOKEN);
    es.addEventListener('sessions', e => {
      try {
        const data = JSON.parse(e.data);
        setSessions(prev => {
          // Merge updates with full session data, preserving fields SSE doesn't carry
          const map = new Map(prev.map(s => [s.id, s]));
          for (const u of data) {
            const existing = map.get(u.id);
            if (existing) {
              map.set(u.id, { ...existing, status: u.status, summary: u.summary, agent: u.agent, repo: u.repo, group_name: u.group, updated_at: u.updated });
            } else {
              map.set(u.id, { id: u.id, status: u.status, summary: u.summary, agent: u.agent, repo: u.repo, group_name: u.group, updated_at: u.updated });
            }
          }
          return Array.from(map.values());
        });
      } catch {}
    });
    return () => es.close();
  }, []);

  async function handleNewSession(form) {
    const res = await apiPost('/api/sessions', form);
    if (res.ok) {
      showToast('Session created', 'success');
      setShowNew(false);
      const data = await api('/api/sessions');
      setSessions(data);
    } else {
      showToast(res.message || 'Failed to create session', 'error');
    }
  }

  const viewTitles = { sessions: 'Sessions', costs: 'Costs', status: 'System Status' };

  return h('div', { className: 'app' },
    h(Sidebar, { activeView: view, onNavigate: setView }),
    h('div', { className: 'main' },
      h('div', { className: 'main-header' },
        h('div', { className: 'main-title' }, viewTitles[view] || 'Dashboard'),
        h('div', { style: { color: '#787fa0', fontSize: 13 } }, sessions.length + ' sessions'),
      ),
      h('div', { className: 'main-body' },
        view === 'sessions' ? h(SessionList, {
          sessions, selectedId, onSelect: setSelectedId,
          filter, onFilterChange: setFilter,
          search, onSearchChange: setSearch,
          groups, groupFilter, onGroupFilter: setGroupFilter,
          onNewSession: () => setShowNew(true),
        }) : null,
        view === 'costs' ? h(CostsView) : null,
        view === 'status' ? h(StatusView, { sessions }) : null,
      ),
    ),
    // Detail panel
    selectedId ? h(SessionDetail, {
      key: selectedId,
      sessionId: selectedId,
      onClose: () => setSelectedId(null),
      onToast: showToast,
    }) : null,
    // New session modal
    showNew ? h(NewSessionModal, {
      onClose: () => setShowNew(false),
      onSubmit: handleNewSession,
    }) : null,
    // Toast
    toast ? h(Toast, {
      key: Date.now(),
      message: toast.msg, type: toast.type,
      onDone: () => setToast(null),
    }) : null,
  );
}

// ---- Mount ----
const root = createRoot(document.getElementById('root'));
root.render(h(App));
<\/script>
</body>
</html>`;
}
