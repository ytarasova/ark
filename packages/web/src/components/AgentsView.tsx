import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Settings } from "lucide-react";
import { useApi } from "../hooks/useApi.js";
import { useAgentsQuery } from "../hooks/useAgentQueries.js";
import { useRuntimesQuery } from "../hooks/useRuntimeQueries.js";
import { cn } from "../lib/utils.js";
import { Badge } from "./ui/badge.js";
import { AgentForm } from "./agents/AgentForm.js";
import { AgentDetailPanel } from "./agents/AgentDetailPanel.js";
import { RuntimeDetailPanel } from "./agents/RuntimeDetailPanel.js";
import { SubTabBar, type AgentsSubTab } from "./agents/SubTabBar.js";

interface AgentsViewProps {
  showCreate?: boolean;
  onCloseCreate?: () => void;
  initialSelectedName?: string | null;
  onSelectedChange?: (name: string | null) => void;
  subTab?: AgentsSubTab;
  onSubTabChange?: (tab: AgentsSubTab) => void;
}

export function AgentsView({
  showCreate = false,
  onCloseCreate,
  initialSelectedName,
  onSelectedChange,
  subTab: controlledSubTab,
  onSubTabChange,
}: AgentsViewProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: agents = [] } = useAgentsQuery();
  const { data: runtimes = [] } = useRuntimesQuery();
  const [internalSubTab, setInternalSubTab] = useState<AgentsSubTab>("roles");
  const subTab = controlledSubTab ?? internalSubTab;
  const setSubTab = onSubTabChange ?? setInternalSubTab;
  const [selectedInternal, setSelectedInternal] = useState<any>(null);
  const selected =
    selectedInternal ?? (initialSelectedName ? agents.find((a: any) => a.name === initialSelectedName) : null);
  const setSelected = (item: any) => {
    setSelectedInternal(item);
    onSelectedChange?.(item?.name ?? null);
  };
  const [editing, setEditing] = useState<any>(null);

  const [actionMsg, setActionMsg] = useState<{ text: string; type: string } | null>(null);

  function showActionMsg(text: string, type: string) {
    setActionMsg({ text, type });
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function handleCreate(form: any) {
    try {
      await api.createAgent(form);
      onCloseCreate?.();
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch (err: any) {
      showActionMsg(err.message || "Failed to create agent", "error");
    }
  }

  async function handleUpdate(form: any) {
    try {
      await api.updateAgent(editing.name, form);
      setEditing(null);
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch (err: any) {
      showActionMsg(err.message || "Failed to update agent", "error");
    }
  }

  async function handleDelete(name: string) {
    try {
      await api.deleteAgent(name);
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch (err: any) {
      showActionMsg(err.message || "Failed to delete agent", "error");
    }
  }

  function handleTabChange(tab: AgentsSubTab) {
    setSubTab(tab);
    setSelected(null);
    setEditing(null);
  }

  const isEmpty = subTab === "roles" ? agents.length === 0 : runtimes.length === 0;

  if (isEmpty && !showCreate) {
    return (
      <div className="flex flex-col h-full">
        <SubTabBar active={subTab} onChange={handleTabChange} />
        <div className="flex items-center justify-center flex-1">
          <div className="text-center">
            <Settings size={28} className="text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              {subTab === "roles" ? "No custom agents. Builtin agents are shown by default." : "No runtimes found."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden h-full">
      <SubTabBar active={subTab} onChange={handleTabChange} />
      <div className="grid grid-cols-[260px_1fr] overflow-hidden flex-1">
        <div
          className="border-r border-border overflow-y-auto"
          role="listbox"
          aria-label={subTab === "roles" ? "Agent roles" : "Runtimes"}
        >
          {subTab === "roles"
            ? agents.map((a: any) => (
                <div
                  key={a.name}
                  className={cn(
                    "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                    "hover:bg-accent",
                    selected?.name === a.name &&
                      selected?._kind === "role" &&
                      "bg-accent border-l-2 border-l-primary font-semibold",
                  )}
                  onClick={() => setSelected({ ...a, _kind: "role" })}
                >
                  <div className="flex flex-col min-w-0 mr-2">
                    <span className="text-foreground truncate">{a.name}</span>
                    <span className="text-[11px] text-muted-foreground truncate">
                      {a.runtime || "claude"} / {a.model}
                    </span>
                  </div>
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    {a.source || "builtin"}
                  </Badge>
                </div>
              ))
            : runtimes.map((r: any) => (
                <div
                  key={r.name}
                  className={cn(
                    "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                    "hover:bg-accent",
                    selected?.name === r.name &&
                      selected?._kind === "runtime" &&
                      "bg-accent border-l-2 border-l-primary font-semibold",
                  )}
                  onClick={() => setSelected({ ...r, _kind: "runtime" })}
                >
                  <div className="flex flex-col min-w-0 mr-2">
                    <span className="text-foreground truncate">{r.name}</span>
                    <span className="text-[11px] text-muted-foreground truncate">
                      {r.type} / {r.default_model || "-"}
                    </span>
                  </div>
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    {r._source || "builtin"}
                  </Badge>
                </div>
              ))}
        </div>

        <div className="overflow-y-auto bg-background">
          {showCreate ? (
            <AgentForm onClose={() => onCloseCreate?.()} onSubmit={handleCreate} runtimes={runtimes} />
          ) : editing ? (
            <AgentForm
              onClose={() => setEditing(null)}
              onSubmit={handleUpdate}
              agent={editing}
              isEdit
              runtimes={runtimes}
            />
          ) : selected?._kind === "role" ? (
            <AgentDetailPanel
              agent={selected}
              onEdit={() => setEditing(selected)}
              onDelete={() => handleDelete(selected.name)}
              actionMsg={actionMsg}
            />
          ) : selected?._kind === "runtime" ? (
            <RuntimeDetailPanel runtime={selected} />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              {subTab === "roles" ? "Select an agent" : "Select a runtime"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
