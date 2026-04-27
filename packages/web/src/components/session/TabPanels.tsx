import { cn } from "../../lib/utils.js";
import { tabButtonId, tabPanelId } from "../ui/ContentTabs.js";
import { TodoList, type TodoItem } from "../ui/TodoList.js";
import type { DiffFile } from "../ui/DiffViewer.js";
import type { StageProgress } from "../ui/StageProgressBar.js";
import { ConversationTab } from "./tabs/ConversationTab.js";
import { LogsTab } from "./tabs/LogsTab.js";
import { DiffTab } from "./tabs/DiffTab.js";
import { ErrorsTab } from "./tabs/ErrorsTab.js";
import { FlowTab } from "./tabs/FlowTab.js";
import { FilesTab } from "./tabs/FilesTab.js";
import { CostTab } from "./tabs/CostTab.js";
import { KnowledgeTab } from "./tabs/KnowledgeTab.js";
import type { ErrorInfo } from "./types.js";

interface TabPanelsProps {
  activeTab: string;
  scrollRef: React.RefObject<HTMLDivElement>;
  onScroll: () => void;

  // Conversation
  session: any;
  timeline: any[];
  conversationMessages: any[];
  events: any[];
  cost: any;
  isActive: boolean;
  agentIsTyping: boolean;
  bottomRef: React.RefObject<HTMLDivElement>;

  // Terminal
  output: string | null | undefined;

  // Diff
  diffData: any;
  diffFiles: DiffFile[];
  activeDiffFile: string | undefined;
  onDiffFileSelect: (name: string) => void;

  // Todos
  todoItems: TodoItem[];
  onToggleTodo: (id: number) => void;

  // Errors
  errorEvents: any[];
  onSelectError: (err: ErrorInfo) => void;

  // Flow widget (Conversation tab right rail)
  stages?: StageProgress[];
}

/**
 * Scrollable body of the session detail view. Renders exactly one tab
 * panel based on `activeTab`; provides the `role=tabpanel` wrapper and
 * scroll-progress handler the outer component wires up.
 */
export function TabPanels(props: TabPanelsProps) {
  const {
    activeTab,
    scrollRef,
    onScroll,
    session,
    timeline,
    conversationMessages,
    events,
    cost,
    isActive,
    agentIsTyping,
    bottomRef,
    output,
    diffData,
    diffFiles,
    activeDiffFile,
    onDiffFileSelect,
    todoItems,
    onToggleTodo,
    errorEvents,
    onSelectError,
    stages,
  } = props;

  return (
    <div
      ref={scrollRef}
      role="tabpanel"
      id={tabPanelId(activeTab)}
      aria-labelledby={tabButtonId(activeTab)}
      tabIndex={0}
      className={cn(
        "flex-1 min-h-0",
        activeTab === "logs" ? "flex flex-col overflow-hidden p-2" : "overflow-y-auto px-6 py-6",
        "focus-visible:outline-none",
      )}
      onScroll={onScroll}
    >
      {activeTab === "conversation" && (
        <ConversationTab
          session={session}
          timeline={timeline}
          conversationMessages={conversationMessages}
          events={events}
          cost={cost}
          isActive={isActive}
          agentIsTyping={agentIsTyping}
          bottomRef={bottomRef}
          filesChangedCount={diffFiles.length}
        />
      )}
      {activeTab === "diff" && (
        <DiffTab
          diffData={diffData}
          diffFiles={diffFiles}
          activeDiffFile={activeDiffFile}
          onFileSelect={onDiffFileSelect}
          hasWorkdir={!!session.workdir}
        />
      )}
      {activeTab === "logs" && (
        <LogsTab
          sessionId={session?.id ?? ""}
          status={session?.status}
          output={output}
          ptyCols={session?.pty_cols}
          ptyRows={session?.pty_rows}
          isActive={isActive}
          tabActive={activeTab === "logs"}
        />
      )}
      {activeTab === "todos" && <TodoList items={todoItems} onToggle={(id) => onToggleTodo(Number(id))} />}
      {activeTab === "flow" && <FlowTab session={session} stages={stages ?? []} />}
      {activeTab === "files" && <FilesTab diffFiles={diffFiles} onSelect={onDiffFileSelect} />}
      {activeTab === "cost" && <CostTab session={session} cost={cost} />}
      {activeTab === "knowledge" && <KnowledgeTab session={session} />}
      {activeTab === "errors" && (
        <ErrorsTab session={session} errorEvents={errorEvents} onSelectError={onSelectError} />
      )}
    </div>
  );
}
