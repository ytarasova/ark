/**
 * /_design hash route -- renders all design system components with sample data.
 * Validates components work before wiring them to real data.
 */
import { useState } from "react";
import { useTheme } from "../themes/ThemeProvider.js";
import type { ThemeName } from "../themes/tokens.js";
import {
  IconRail,
  SessionList,
  SessionHeader,
  ContentTabs,
  WorkspacePanel,
  ChatInput,
  AgentMessage,
  UserMessage,
  SystemEvent,
  ToolCallRow,
  ToolCallFailed,
  ReviewFinding,
  SessionSummary,
  TypingIndicator,
  StatusDot,
  FilterChip,
  StagePipeline,
  IntegrationPill,
  ScrollProgress,
  CommandPalette,
  DiffViewer,
  EventTimeline,
  TodoList,
} from "../components/ui/index.js";
import type { StageProgress } from "../components/ui/StageProgressBar.js";
import type { SessionStatus } from "../components/ui/StatusDot.js";

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_STAGES: StageProgress[] = [
  { name: "plan", state: "done" },
  { name: "implement", state: "active" },
  { name: "verify", state: "pending" },
  { name: "review", state: "pending" },
  { name: "merge", state: "pending" },
];

const SAMPLE_SESSIONS = [
  {
    id: "s-a1b2",
    status: "running" as SessionStatus,
    summary: "Add auth middleware to all API routes",
    agentName: "implementer",
    cost: "$0.82",
    relativeTime: "2m ago",
    stages: SAMPLE_STAGES,
  },
  {
    id: "s-c3d4",
    status: "waiting" as SessionStatus,
    summary: "Refactor database connection pooling",
    agentName: "planner",
    cost: "$0.14",
    relativeTime: "5m ago",
    stages: [
      { name: "plan", state: "done" as const },
      { name: "implement", state: "pending" as const },
      { name: "verify", state: "pending" as const },
    ],
  },
  {
    id: "s-e5f6",
    status: "completed" as SessionStatus,
    summary: "Fix rate limiter bypass vulnerability",
    agentName: "reviewer",
    cost: "$1.24",
    relativeTime: "12m ago",
    stages: [
      { name: "plan", state: "done" as const },
      { name: "implement", state: "done" as const },
      { name: "verify", state: "done" as const },
      { name: "review", state: "done" as const },
      { name: "merge", state: "done" as const },
    ],
  },
  {
    id: "s-g7h8",
    status: "failed" as SessionStatus,
    summary: "Migrate to PostgreSQL 16",
    agentName: "verifier",
    cost: "$0.56",
    relativeTime: "18m ago",
    stages: [
      { name: "plan", state: "done" as const },
      { name: "implement", state: "done" as const },
      { name: "verify", state: "pending" as const },
    ],
  },
];

const SAMPLE_TABS = [
  { id: "conversation", label: "Conversation" },
  { id: "terminal", label: "Terminal" },
  { id: "events", label: "Events", badge: "24" },
  { id: "diff", label: "Diff", badge: "+42/-8" },
  { id: "todos", label: "Todos", badge: "3" },
];

const NAV_ITEMS = [
  {
    id: "sessions",
    label: "Sessions",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M5 3l14 9-14 9V3z" />
      </svg>
    ),
  },
  {
    id: "agents",
    label: "Agents",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="3" />
      </svg>
    ),
  },
  {
    id: "compute",
    label: "Compute",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <circle cx="6" cy="6" r="1" />
        <circle cx="6" cy="18" r="1" />
      </svg>
    ),
  },
  {
    id: "costs",
    label: "Costs",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
      </svg>
    ),
  },
];

const SETTINGS_ITEM = {
  id: "settings",
  label: "Settings",
  icon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
};

// ---------------------------------------------------------------------------
// Preview Page
// ---------------------------------------------------------------------------

export function DesignPreviewPage() {
  const { themeName, setThemeName, colorMode, toggleColorMode } = useTheme();
  const [selectedSession, setSelectedSession] = useState("s-a1b2");
  const [activeTab, setActiveTab] = useState("conversation");
  const [chatValue, setChatValue] = useState("");
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdSearch, setCmdSearch] = useState("");
  const [search, setSearch] = useState("");
  const [activeNav, setActiveNav] = useState("sessions");

  return (
    <div className="flex h-screen bg-[var(--bg)] text-[var(--fg)]" style={{ fontFamily: "var(--font-sans)" }}>
      {/* Icon Rail */}
      <IconRail items={NAV_ITEMS} activeId={activeNav} onSelect={setActiveNav} settingsItem={SETTINGS_ITEM} />

      {/* List Panel */}
      <div className="w-[300px] min-w-[300px] border-r border-[var(--border)] flex flex-col overflow-hidden">
        <SessionList
          sessions={SAMPLE_SESSIONS}
          selectedId={selectedSession}
          onSelect={setSelectedSession}
          search={search}
          onSearchChange={setSearch}
          headerAction={
            <button
              type="button"
              className="h-7 px-2.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--primary)] text-[var(--primary-fg)] text-[12px] font-medium flex items-center gap-1 cursor-pointer hover:bg-[var(--primary-hover)] transition-colors"
            >
              + New
            </button>
          }
          filterChips={
            <>
              <FilterChip status="running" count={7} active />
              <FilterChip status="waiting" count={2} />
              <FilterChip status="completed" count={3} />
              <FilterChip status="failed" count={1} active />
            </>
          }
          className="flex-1"
        />
      </div>

      {/* Detail Panel */}
      <WorkspacePanel>
        <SessionHeader
          sessionId="s-a1b2"
          summary="Add auth middleware to all API routes"
          status="running"
          stages={SAMPLE_STAGES}
          cost="$0.82"
          actions={
            <button
              type="button"
              className="h-7 px-2.5 rounded-[var(--radius-sm)] border border-[var(--failed)] bg-transparent text-[var(--failed)] text-[11px] font-medium cursor-pointer hover:bg-[var(--diff-rm-bg)] transition-colors"
            >
              Stop
            </button>
          }
        />

        {/* Meta row */}
        <div className="h-10 border-b border-[var(--border)] flex items-center px-5 gap-2.5 shrink-0">
          <IntegrationPill label="JIRA-1234" />
          <IntegrationPill label="PR #42" count="2 comments" />
          <div className="flex-1" />
          <span className="text-[11px] font-[family-name:var(--font-mono-ui)] text-[var(--fg-muted)]">
            65% complete
          </span>
        </div>

        <ScrollProgress progress={42} />
        <ContentTabs tabs={SAMPLE_TABS} activeTab={activeTab} onTabChange={setActiveTab} />

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="max-w-[720px] mx-auto">
            {activeTab === "conversation" && (
              <>
                <AgentMessage agentName="Planner" model="claude-4-opus" timestamp="2:13 PM">
                  <p>
                    Analyzing the codebase. Found 3 files that need auth middleware applied. The current routes in{" "}
                    <code className="bg-[var(--bg-code)] px-1 py-0.5 rounded text-[12px] font-[family-name:var(--font-mono)]">
                      packages/conductor/routes/
                    </code>{" "}
                    are missing authentication checks.
                  </p>
                </AgentMessage>

                <ToolCallRow
                  label="Read: packages/conductor/routes/api.ts"
                  duration="0.3s"
                  status="done"
                  detail={<pre>{"const router = express.Router();\n// ... file contents"}</pre>}
                />
                <ToolCallRow label="Read: packages/conductor/routes/admin.ts" duration="0.2s" status="done" />
                <ToolCallRow label="Edit: packages/conductor/middleware/auth.ts" duration="1.2s" status="done" />

                <AgentMessage agentName="Implementer" avatarColor="#3b82f6" model="claude-4-sonnet" timestamp="2:14 PM">
                  <p>Applied auth middleware to all 3 route files. Each route now requires a valid JWT token.</p>
                </AgentMessage>

                <ToolCallFailed
                  label="Run: bun test packages/conductor/__tests__/auth.test.ts"
                  duration="4.2s"
                  error="FAIL: Expected status 401, received 200. The middleware is not rejecting expired tokens."
                />

                <SystemEvent>Stage advanced: plan -&gt; implement (2:15 PM)</SystemEvent>

                <AgentMessage agentName="Implementer" avatarColor="#3b82f6" timestamp="2:16 PM">
                  <p>
                    Fixed the token expiry check. The issue was that{" "}
                    <code className="bg-[var(--bg-code)] px-1 py-0.5 rounded text-[12px] font-[family-name:var(--font-mono)]">
                      jwt.verify()
                    </code>{" "}
                    was not checking the{" "}
                    <code className="bg-[var(--bg-code)] px-1 py-0.5 rounded text-[12px] font-[family-name:var(--font-mono)]">
                      exp
                    </code>{" "}
                    claim.
                  </p>
                </AgentMessage>

                <ToolCallRow label="Edit: packages/conductor/middleware/auth.ts" duration="0.8s" status="done" />
                <ToolCallRow
                  label="Run: bun test packages/conductor/__tests__/auth.test.ts"
                  duration="3.1s"
                  status="done"
                />

                <UserMessage timestamp="2:17 PM">
                  <p>Can you also add rate limiting to the admin routes?</p>
                </UserMessage>

                <TypingIndicator agentName="Implementer" />

                {/* Review findings */}
                <div className="mt-6 flex flex-col gap-2">
                  <h3 className="text-[13px] font-semibold mb-1">Review Findings</h3>
                  <ReviewFinding severity="good">Auth middleware correctly validates JWT signatures</ReviewFinding>
                  <ReviewFinding severity="note">
                    Consider adding refresh token rotation for long-lived sessions
                  </ReviewFinding>
                  <ReviewFinding severity="issue">
                    Admin routes missing RBAC check -- any authenticated user can access
                  </ReviewFinding>
                </div>

                {/* Session summary */}
                <SessionSummary
                  duration="4m 12s"
                  cost="$0.82"
                  filesChanged={3}
                  testsPassed={12}
                  prLink={{ href: "#", label: "View Pull Request #42" }}
                />
              </>
            )}

            {activeTab === "events" && (
              <EventTimeline
                events={[
                  {
                    id: "1",
                    timestamp: "2:13 PM",
                    label: "Session started",
                    status: "running",
                    detail: "Flow: autonomous-sdlc",
                  },
                  { id: "2", timestamp: "2:13 PM", label: "Stage: plan", status: "completed" },
                  { id: "3", timestamp: "2:14 PM", label: "Stage: implement", status: "running" },
                  {
                    id: "4",
                    timestamp: "2:14 PM",
                    label: "Test failed: auth.test.ts",
                    status: "failed",
                    detail: "Expected 401, got 200",
                  },
                  { id: "5", timestamp: "2:15 PM", label: "Test passed: auth.test.ts", status: "completed" },
                  { id: "6", timestamp: "2:16 PM", label: "User message received", status: "waiting" },
                ]}
              />
            )}

            {activeTab === "diff" && (
              <DiffViewer
                files={[
                  {
                    filename: "packages/conductor/middleware/auth.ts",
                    additions: 28,
                    deletions: 3,
                    lines: [
                      { type: "context", lineNumber: 1, content: 'import { verify } from "jsonwebtoken";' },
                      { type: "context", lineNumber: 2, content: "" },
                      { type: "remove", lineNumber: 3, content: "export function auth(req, res, next) {" },
                      {
                        type: "add",
                        lineNumber: 3,
                        content: "export function auth(req: Request, res: Response, next: NextFunction) {",
                      },
                      {
                        type: "context",
                        lineNumber: 4,
                        content: '  const token = req.headers["authorization"]?.split(" ")[1];',
                      },
                      {
                        type: "add",
                        lineNumber: 5,
                        content: "  if (!token) return res.status(401).json({ error: 'Missing token' });",
                      },
                      { type: "add", lineNumber: 6, content: "  try {" },
                      {
                        type: "add",
                        lineNumber: 7,
                        content: "    const decoded = verify(token, process.env.JWT_SECRET);",
                      },
                      { type: "add", lineNumber: 8, content: "    req.user = decoded;" },
                      { type: "add", lineNumber: 9, content: "    next();" },
                      { type: "add", lineNumber: 10, content: "  } catch (err) {" },
                      {
                        type: "add",
                        lineNumber: 11,
                        content: "    return res.status(401).json({ error: 'Invalid token' });",
                      },
                      { type: "add", lineNumber: 12, content: "  }" },
                    ],
                  },
                  {
                    filename: "packages/conductor/routes/api.ts",
                    additions: 2,
                    deletions: 1,
                    lines: [
                      { type: "context", lineNumber: 1, content: 'import { Router } from "express";' },
                      { type: "add", lineNumber: 2, content: 'import { auth } from "../middleware/auth";' },
                      { type: "context", lineNumber: 3, content: "" },
                      { type: "remove", lineNumber: 4, content: "const router = Router();" },
                      { type: "add", lineNumber: 4, content: "const router = Router().use(auth);" },
                    ],
                  },
                ]}
              />
            )}

            {activeTab === "todos" && (
              <TodoList
                items={[
                  { id: "1", text: "Add auth middleware to API routes", done: true },
                  { id: "2", text: "Fix token expiry validation", done: true },
                  { id: "3", text: "Add rate limiting to admin routes", done: false, priority: "high" },
                  { id: "4", text: "Add RBAC check for admin endpoints", done: false, priority: "medium" },
                  { id: "5", text: "Update API documentation", done: false, priority: "low" },
                ]}
              />
            )}

            {activeTab === "terminal" && (
              <div className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--fg-muted)] leading-[1.6]">
                <div>$ bun test packages/conductor/__tests__/auth.test.ts</div>
                <div className="text-[var(--running)]">PASS 12/12 tests passed (3.1s)</div>
              </div>
            )}
          </div>
        </div>

        {activeTab === "conversation" && (
          <ChatInput
            value={chatValue}
            onChange={setChatValue}
            onSend={() => setChatValue("")}
            modelName="claude-4-opus"
          />
        )}
      </WorkspacePanel>

      {/* Theme controls (floating) */}
      <div className="fixed bottom-4 right-4 flex gap-2 z-40">
        {(["midnight-circuit", "arctic-slate", "warm-obsidian"] as ThemeName[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setThemeName(t)}
            className={`px-2 py-1 text-[10px] rounded border cursor-pointer transition-colors ${
              themeName === t
                ? "border-[var(--primary)] bg-[var(--primary-subtle)] text-[var(--primary)]"
                : "border-[var(--border)] bg-[var(--bg-card)] text-[var(--fg-muted)] hover:text-[var(--fg)]"
            }`}
          >
            {t}
          </button>
        ))}
        <button
          type="button"
          onClick={toggleColorMode}
          className="px-2 py-1 text-[10px] rounded border border-[var(--border)] bg-[var(--bg-card)] text-[var(--fg-muted)] cursor-pointer hover:text-[var(--fg)] transition-colors"
        >
          {colorMode === "dark" ? "Light" : "Dark"}
        </button>
      </div>

      {/* Command palette */}
      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        search={cmdSearch}
        onSearchChange={setCmdSearch}
        items={[
          {
            id: "1",
            label: "Go to Sessions",
            shortcut: "1",
            section: "Navigation",
            onSelect: () => setActiveNav("sessions"),
          },
          {
            id: "2",
            label: "Go to Agents",
            shortcut: "2",
            section: "Navigation",
            onSelect: () => setActiveNav("agents"),
          },
          { id: "3", label: "New Session", shortcut: "Cmd+N", section: "Actions", onSelect: () => {} },
          { id: "4", label: "Stop Session", section: "Actions", onSelect: () => {} },
          { id: "5", label: "Toggle Theme", shortcut: "T", section: "System", onSelect: toggleColorMode },
          { id: "6", label: "Midnight Circuit", section: "Themes", onSelect: () => setThemeName("midnight-circuit") },
          { id: "7", label: "Arctic Slate", section: "Themes", onSelect: () => setThemeName("arctic-slate") },
          { id: "8", label: "Warm Obsidian", section: "Themes", onSelect: () => setThemeName("warm-obsidian") },
        ]}
      />

      {/* Status dots showcase */}
      <div className="fixed top-4 right-4 flex gap-2 items-center z-40 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-2">
        <span className="text-[10px] text-[var(--fg-muted)] mr-1">Status:</span>
        <StatusDot status="running" size="md" />
        <StatusDot status="waiting" size="md" />
        <StatusDot status="completed" size="md" />
        <StatusDot status="failed" size="md" />
        <StatusDot status="stopped" size="md" />
        <StagePipeline stages={SAMPLE_STAGES} className="ml-2" />
      </div>
    </div>
  );
}
