import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
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

type Mode = "list" | "add" | "search";

interface MemoryManagerProps {
  asyncState?: AsyncState;
  pane?: "left" | "right";
  onClose?: () => void;
}

export function MemoryManager({ asyncState, pane = "left", onClose }: MemoryManagerProps) {
  const ark = useArkClient();
  const [memories, setMemories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("list");
  const [statusMsg, setStatusMsg] = useState("");
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Add mode state
  const [addContent, setAddContent] = useState("");
  const [addTags, setAddTags] = useState("");
  const [addField, setAddField] = useState<"content" | "tags">("content");

  const loadMemories = useCallback(() => {
    setLoading(true);
    ark.memoryList().then(list => {
      setMemories(list);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { loadMemories(); }, []);

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
      ark.memoryForget(selected.id).then((ok) => {
        if (ok) {
          setStatusMsg("Memory deleted");
          if (searchResults) setSearchResults(prev => prev ? prev.filter(m => m.id !== selected.id) : null);
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
    ark.memoryRecall(q.trim(), { limit: 20 }).then(results => {
      setSearchResults(results);
      setSearchQuery(q.trim());
      setMode("list");
      setStatusMsg(`${results.length} result${results.length !== 1 ? "s" : ""}`);
    }).catch(() => { setStatusMsg("Search failed"); setMode("list"); });
  }, []);

  return (
    <SplitPane
      focus={pane}
      leftTitle={searchResults ? `Memories - "${searchQuery}"` : `Memories (${memories.length})`}
      rightTitle={mode === "add" ? "Add Memory" : "Details"}
      left={
        <Box flexDirection="column">
          {mode === "search" && (
            <Box paddingX={1}>
              <Text color="cyan">{"/ "}</Text>
              <TextInputEnhanced
                value={searchQuery}
                onChange={setSearchQuery}
                onSubmit={handleSearchSubmit}
                focus={true}
                placeholder="Search memories..."
              />
            </Box>
          )}
          {loading ? (
            <Text dimColor>{"  Loading..."}</Text>
          ) : (
            <TreeList
              items={displayList}
              renderRow={(m) => m.content.slice(0, 40)}
              renderColoredRow={(m) => (
                <Box flexDirection="column">
                  <Text wrap="truncate">{"  "}{m.content.slice(0, 36)}</Text>
                  <Text dimColor wrap="truncate">
                    {"  "}
                    {m.tags?.length > 0 && <Text>{m.tags.join(", ")}  </Text>}
                    {m.scope && <Text>{m.scope}</Text>}
                  </Text>
                </Box>
              )}
              sel={sel}
              emptyMessage="  No memories. Press n to add."
            />
          )}
          {statusMsg && <Text color="green">{`  ${statusMsg}`}</Text>}
        </Box>
      }
      right={
        mode === "add" ? (
          <Box flexDirection="column" paddingX={1} paddingTop={1}>
            <Box>
              <Text color={addField === "content" ? "cyan" : "gray"}>
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
              <Text color={addField === "tags" ? "cyan" : "gray"}>
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
            <Text wrap="wrap">{`  ${selected.content}`}</Text>
            <Text> </Text>
            <SectionHeader title="Info" />
            {selected.id && <KeyValue label="ID">{selected.id}</KeyValue>}
            {selected.scope && <KeyValue label="Scope">{selected.scope}</KeyValue>}
            {selected.tags?.length > 0 && <KeyValue label="Tags">{selected.tags.join(", ")}</KeyValue>}
            {selected.created_at && <KeyValue label="Created">{selected.created_at.slice(0, 10)}</KeyValue>}
          </DetailPanel>
        ) : (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text dimColor>Select a memory</Text>
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
    <KeyHint key="x" k="x" label="delete" />,
    ...GLOBAL_HINTS,
  ];
}
