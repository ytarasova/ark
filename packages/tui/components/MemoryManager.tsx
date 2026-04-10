import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import { useArkClient } from "../hooks/useArkClient.js";
import { KeyHint, sep, NAV_HINTS, GLOBAL_HINTS } from "../helpers/statusBarHints.js";
import { TextInputEnhanced } from "./TextInputEnhanced.js";
import { SplitPane } from "./SplitPane.js";
import { TreeList } from "./TreeList.js";
import { DetailPanel } from "./DetailPanel.js";
import { SectionHeader } from "./SectionHeader.js";
import { KeyValue } from "./KeyValue.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import type { AsyncState } from "../hooks/useAsync.js";

type Mode = "list" | "add" | "search" | "stats";
type ViewType = "memories" | "learnings";

interface MemoryManagerProps {
  asyncState?: AsyncState;
  pane?: "left" | "right";
  onClose?: () => void;
}

export function MemoryManager({ asyncState: _asyncState, pane = "left", onClose }: MemoryManagerProps) {
  const theme = getTheme();
  const ark = useArkClient();
  const [memories, setMemories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("list");
  const [viewType, setViewType] = useState<ViewType>("memories");
  const [statusMsg, setStatusMsg] = useState("");
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [stats, setStats] = useState<any>(null);

  // Add mode state
  const [addContent, setAddContent] = useState("");
  const [addTags, setAddTags] = useState("");
  const [addField, setAddField] = useState<"content" | "tags">("content");

  const loadMemories = useCallback(() => {
    setLoading(true);
    if (viewType === "memories") {
      ark.memoryList().then(list => {
        setMemories(list);
        setLoading(false);
      }).catch(() => setLoading(false));
    } else {
      // Load learnings via knowledge search
      ark.knowledgeSearch("", { types: ["learning"], limit: 100 }).then(list => {
        setMemories(list);
        setLoading(false);
      }).catch(() => {
        // Fallback: try the learning/list RPC
        (ark as any).rpc?.("learning/list")?.then?.((r: any) => {
          setMemories(r?.learnings ?? []);
          setLoading(false);
        }) ?? setLoading(false);
      });
    }
  }, [viewType]);

  const loadStats = useCallback(() => {
    ark.knowledgeStats().then(s => setStats(s)).catch(() => {});
  }, []);

  useEffect(() => { loadMemories(); loadStats(); }, [viewType]);

  const displayList = searchResults ?? memories;
  const { sel } = useListNavigation(displayList.length, { active: pane === "left" && mode === "list" });
  const selected = displayList[sel] ?? null;

  // Clear status after timeout
  useEffect(() => {
    if (!statusMsg) return;
    const timer = setTimeout(() => setStatusMsg(""), 3000);
    return () => clearTimeout(timer);
  }, [statusMsg]);

  // List mode input
  useInput((input, key) => {
    if (mode !== "list" || pane !== "left") return;

    if (key.escape) {
      if (searchResults) {
        setSearchResults(null);
        setSearchQuery("");
        return;
      }
      if (onClose) onClose();
      return;
    }

    if (input === "x" && selected) {
      const id = selected.id;
      ark.memoryForget(id).then((ok) => {
        if (ok) {
          setStatusMsg("Memory deleted");
          if (searchResults) setSearchResults(prev => prev ? prev.filter(m => m.id !== id) : null);
          loadMemories();
        }
      });
      return;
    }

    if (input === "n") {
      setMode("add");
      setAddContent("");
      setAddTags("");
      setAddField("content");
      return;
    }

    if (input === "/") {
      setMode("search");
      setSearchQuery("");
      return;
    }

    if (input === "l") {
      setViewType(v => v === "memories" ? "learnings" : "memories");
      setSearchResults(null);
      return;
    }

    if (input === "s") {
      setMode("stats");
      loadStats();
      return;
    }
  });

  // Add mode input
  useInput((_input, key) => {
    if (mode !== "add") return;
    if (key.escape) { setMode("list"); return; }
    if (key.tab) { setAddField(f => f === "content" ? "tags" : "content"); return; }
  });

  // Search mode input
  useInput((_input, key) => {
    if (mode !== "search") return;
    if (key.escape) { setMode("list"); return; }
  });

  // Stats mode input
  useInput((_input, key) => {
    if (mode !== "stats") return;
    if (key.escape) { setMode("list"); return; }
  });

  const handleAddSubmit = useCallback(() => {
    if (!addContent.trim()) { setMode("list"); return; }
    const tags = addTags.trim() ? addTags.split(",").map(t => t.trim()).filter(Boolean) : undefined;
    ark.memoryAdd(addContent.trim(), { tags }).then(() => {
      setStatusMsg("Memory added");
      setMode("list");
      loadMemories();
    }).catch(() => { setStatusMsg("Failed to add"); setMode("list"); });
  }, [addContent, addTags]);

  const handleSearchSubmit = useCallback((q: string) => {
    if (!q.trim()) { setMode("list"); return; }
    ark.knowledgeSearch(q.trim(), { types: ["memory", "learning"], limit: 20 }).then(results => {
      setSearchResults(results);
      setSearchQuery(q.trim());
      setMode("list");
      setStatusMsg(`${results.length} result${results.length !== 1 ? "s" : ""}`);
    }).catch(() => {
      // Fallback to memory recall
      ark.memoryRecall(q.trim(), { limit: 20 }).then(results => {
        setSearchResults(results);
        setSearchQuery(q.trim());
        setMode("list");
        setStatusMsg(`${results.length} result${results.length !== 1 ? "s" : ""}`);
      }).catch(() => { setStatusMsg("Search failed"); setMode("list"); });
    });
  }, []);

  const getItemContent = (m: any) => {
    return m.content ?? m.label ?? "(no content)";
  };

  const getItemLabel = (m: any) => {
    const content = getItemContent(m);
    return content.slice(0, 40);
  };

  const viewLabel = viewType === "memories" ? "Memories" : "Learnings";

  return (
    <SplitPane
      focus={pane}
      leftTitle={searchResults ? `${viewLabel} - "${searchQuery}"` : `${viewLabel} (${memories.length})`}
      rightTitle={mode === "add" ? "Add Memory" : mode === "stats" ? "Knowledge Stats" : "Details"}
      left={
        <Box flexDirection="column">
          {mode === "search" && (
            <Box paddingX={1}>
              <Text color={theme.accent}>{"/ "}</Text>
              <TextInputEnhanced
                value={searchQuery}
                onChange={setSearchQuery}
                onSubmit={handleSearchSubmit}
                focus={true}
                placeholder="Search knowledge..."
              />
            </Box>
          )}
          {loading ? (
            <Text dimColor>{"  Loading..."}</Text>
          ) : (
            <TreeList
              items={displayList}
              renderRow={(m) => getItemLabel(m)}
              renderColoredRow={(m) => (
                <Box flexDirection="column">
                  <Text wrap="truncate">{"  "}{getItemContent(m).slice(0, 36)}</Text>
                  <Text dimColor wrap="truncate">
                    {"  "}
                    {m.type && <Text color={theme.accent}>[{m.type}] </Text>}
                    {m.tags?.length > 0 && <Text>{m.tags.join(", ")}  </Text>}
                    {m.scope && <Text>{m.scope}</Text>}
                    {m.score !== undefined && <Text> ({m.score.toFixed(2)})</Text>}
                  </Text>
                </Box>
              )}
              sel={sel}
              emptyMessage={`  No ${viewLabel.toLowerCase()}. Press n to add.`}
            />
          )}
          {statusMsg && <Text color={theme.running}>{`  ${statusMsg}`}</Text>}
        </Box>
      }
      right={
        mode === "stats" ? (
          <DetailPanel active={pane === "right"}>
            <SectionHeader title="Knowledge Graph Stats" />
            {stats ? (
              <Box flexDirection="column">
                <KeyValue label="Total Nodes">{String(stats.nodes ?? 0)}</KeyValue>
                <KeyValue label="Total Edges">{String(stats.edges ?? 0)}</KeyValue>
                <Text> </Text>
                <SectionHeader title="Nodes by Type" />
                {stats.by_node_type && Object.entries(stats.by_node_type).map(([t, c]) => (
                  <KeyValue key={t} label={t}>{String(c)}</KeyValue>
                ))}
                <Text> </Text>
                <SectionHeader title="Edges by Relation" />
                {stats.by_edge_type && Object.entries(stats.by_edge_type).map(([r, c]) => (
                  <KeyValue key={r} label={r}>{String(c)}</KeyValue>
                ))}
              </Box>
            ) : (
              <Text dimColor>  Loading stats...</Text>
            )}
          </DetailPanel>
        ) : mode === "add" ? (
          <Box flexDirection="column" paddingX={1} paddingTop={1}>
            <Box>
              <Text color={addField === "content" ? theme.accent : theme.dimText}>
                {addField === "content" ? "> " : "  "}Content:{" "}
              </Text>
              {addField === "content" ? (
                <TextInputEnhanced
                  value={addContent}
                  onChange={setAddContent}
                  onSubmit={() => { if (addContent.trim()) setAddField("tags"); }}
                  focus={addField === "content"}
                  placeholder="What to remember..."
                />
              ) : (
                <Text>{addContent || <Text dimColor>empty</Text>}</Text>
              )}
            </Box>
            <Box>
              <Text color={addField === "tags" ? theme.accent : "gray"}>
                {addField === "tags" ? "> " : "  "}Tags:{" "}
              </Text>
              {addField === "tags" ? (
                <TextInputEnhanced
                  value={addTags}
                  onChange={setAddTags}
                  onSubmit={handleAddSubmit}
                  focus={addField === "tags"}
                  placeholder="comma-separated (optional)"
                />
              ) : (
                <Text>{addTags || <Text dimColor>none</Text>}</Text>
              )}
            </Box>
          </Box>
        ) : selected ? (
          <DetailPanel active={pane === "right"}>
            <SectionHeader title="Content" />
            <Text wrap="wrap">{`  ${getItemContent(selected)}`}</Text>
            <Text> </Text>
            <SectionHeader title="Info" />
            {selected.id && <KeyValue label="ID">{selected.id}</KeyValue>}
            {selected.type && <KeyValue label="Type">{selected.type}</KeyValue>}
            {(selected.scope || selected.metadata?.scope) && <KeyValue label="Scope">{selected.scope ?? selected.metadata?.scope}</KeyValue>}
            {(selected.tags?.length > 0 || (selected.metadata?.tags as any)?.length > 0) && (
              <KeyValue label="Tags">{(selected.tags ?? selected.metadata?.tags ?? []).join(", ")}</KeyValue>
            )}
            {selected.score !== undefined && <KeyValue label="Score">{selected.score.toFixed(2)}</KeyValue>}
            {(selected.created_at || selected.createdAt) && (
              <KeyValue label="Created">{(selected.created_at ?? selected.createdAt).slice(0, 10)}</KeyValue>
            )}
            {selected.metadata?.recurrence !== undefined && (
              <KeyValue label="Recurrence">{String(selected.metadata.recurrence)}</KeyValue>
            )}
          </DetailPanel>
        ) : (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text dimColor>Select an item</Text>
          </Box>
        )
      }
    />
  );
}

export function getMemoryHints(): React.ReactNode[] {
  return [
    ...NAV_HINTS, sep(0),
    <KeyHint key="n" k="n" label="add" />,
    <KeyHint key="/" k="/" label="search" />,
    <KeyHint key="l" k="l" label="toggle memories/learnings" />,
    <KeyHint key="s" k="s" label="stats" />,
    <KeyHint key="x" k="x" label="delete" />,
    ...GLOBAL_HINTS,
  ];
}
