import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { useArkClient } from "../hooks/useArkClient.js";
import { TextInputEnhanced } from "./TextInputEnhanced.js";
import type { AsyncState } from "../hooks/useAsync.js";

type Mode = "list" | "add" | "search";

interface MemoryManagerProps {
  asyncState?: AsyncState;
  onClose?: () => void;
}

export function MemoryManager({ asyncState, onClose }: MemoryManagerProps) {
  const ark = useArkClient();
  const [memories, setMemories] = useState<any[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("list");
  const [statusMsg, setStatusMsg] = useState("");

  // Add mode state
  const [addContent, setAddContent] = useState("");
  const [addTags, setAddTags] = useState("");
  const [addField, setAddField] = useState<"content" | "tags">("content");

  // Search mode state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[] | null>(null);

  const loadMemories = useCallback(() => {
    setLoading(true);
    ark.memoryList().then(list => {
      setMemories(list);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { loadMemories(); }, []);

  // Keep cursor in bounds
  useEffect(() => {
    const list = searchResults ?? memories;
    if (cursor >= list.length) setCursor(Math.max(0, list.length - 1));
  }, [memories.length, searchResults?.length]);

  // Clear status after timeout
  useEffect(() => {
    if (!statusMsg) return;
    const timer = setTimeout(() => setStatusMsg(""), 3000);
    return () => clearTimeout(timer);
  }, [statusMsg]);

  // List mode input
  useInput((input, key) => {
    if (mode !== "list") return;

    if (key.escape) {
      if (searchResults) {
        // Clear search results, go back to full list
        setSearchResults(null);
        setSearchQuery("");
        setCursor(0);
        return;
      }
      onClose();
      return;
    }

    const list = searchResults ?? memories;

    if (input === "j" || key.downArrow) setCursor(c => Math.min(c + 1, list.length - 1));
    if (input === "k" || key.upArrow) setCursor(c => Math.max(c - 1, 0));

    // Delete
    if (input === "x" && list[cursor]) {
      const id = list[cursor].id;
      ark.memoryForget(id).then((ok) => {
        if (ok) {
          setStatusMsg("Memory deleted");
          if (searchResults) {
            setSearchResults(prev => prev ? prev.filter(m => m.id !== id) : null);
          }
          loadMemories();
        }
      });
      return;
    }

    // Add
    if (input === "n") {
      setMode("add");
      setAddContent("");
      setAddTags("");
      setAddField("content");
      return;
    }

    // Search
    if (input === "/") {
      setMode("search");
      setSearchQuery("");
      return;
    }
  });

  // Add mode input - Tab to switch fields, Esc to cancel
  useInput((input, key) => {
    if (mode !== "add") return;

    if (key.escape) {
      setMode("list");
      return;
    }

    // Tab switches between content and tags
    if (key.tab) {
      setAddField(f => f === "content" ? "tags" : "content");
      return;
    }
  });

  // Search mode input
  useInput((_input, key) => {
    if (mode !== "search") return;
    if (key.escape) {
      setMode("list");
      return;
    }
  });

  const handleAddSubmit = useCallback(() => {
    if (!addContent.trim()) {
      setMode("list");
      return;
    }
    const tags = addTags.trim()
      ? addTags.split(",").map(t => t.trim()).filter(Boolean)
      : undefined;
    ark.memoryAdd(addContent.trim(), { tags }).then(() => {
      setStatusMsg("Memory added");
      setMode("list");
      loadMemories();
    }).catch(() => {
      setStatusMsg("Failed to add memory");
      setMode("list");
    });
  }, [addContent, addTags]);

  const handleSearchSubmit = useCallback((q: string) => {
    if (!q.trim()) {
      setMode("list");
      return;
    }
    ark.memoryRecall(q.trim(), { limit: 20 }).then(results => {
      setSearchResults(results);
      setSearchQuery(q.trim());
      setCursor(0);
      setMode("list");
      setStatusMsg(`${results.length} result${results.length !== 1 ? "s" : ""}`);
    }).catch(() => {
      setStatusMsg("Search failed");
      setMode("list");
    });
  }, []);

  const displayList = searchResults ?? memories;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {searchResults ? `Memories - search: "${searchQuery}"` : "Memories"}
      </Text>

      {mode === "list" && (
        <Text dimColor>
          {searchResults
            ? "j/k:navigate  x:delete  n:add  /:search  Esc:clear search"
            : "j/k:navigate  x:delete  n:add  /:search  Esc:close"}
        </Text>
      )}

      {/* Add mode */}
      {mode === "add" && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Add Memory</Text>
          <Box>
            <Text color={addField === "content" ? "cyan" : undefined}>
              {addField === "content" ? "> " : "  "}Content:{" "}
            </Text>
            {addField === "content" ? (
              <TextInputEnhanced
                value={addContent}
                onChange={setAddContent}
                onSubmit={() => {
                  // If content done, move to tags or submit
                  if (addContent.trim()) {
                    setAddField("tags");
                  }
                }}
                focus={addField === "content"}
                placeholder="What to remember..."
              />
            ) : (
              <Text>{addContent || <Text dimColor>empty</Text>}</Text>
            )}
          </Box>
          <Box>
            <Text color={addField === "tags" ? "cyan" : undefined}>
              {addField === "tags" ? "> " : "  "}Tags:{" "}
            </Text>
            {addField === "tags" ? (
              <TextInputEnhanced
                value={addTags}
                onChange={setAddTags}
                onSubmit={handleAddSubmit}
                focus={addField === "tags"}
                placeholder="comma-separated tags (optional)"
              />
            ) : (
              <Text>{addTags || <Text dimColor>none</Text>}</Text>
            )}
          </Box>
          <Text dimColor>Tab:switch field  Enter:submit  Esc:cancel</Text>
        </Box>
      )}

      {/* Search mode */}
      {mode === "search" && (
        <Box marginTop={1}>
          <Text color="cyan">{" / "}</Text>
          <TextInputEnhanced
            value={searchQuery}
            onChange={setSearchQuery}
            onSubmit={handleSearchSubmit}
            focus={true}
            placeholder="Search memories..."
          />
        </Box>
      )}

      {/* Memory list */}
      {mode === "list" && (
        <Box flexDirection="column" marginTop={1}>
          {loading && <Text dimColor>Loading...</Text>}
          {!loading && displayList.length === 0 && (
            <Text dimColor>{searchResults ? "No matching memories" : "No memories stored. Press n to add."}</Text>
          )}
          {displayList.map((m, i) => (
            <Box key={m.id} flexDirection="column">
              <Text inverse={i === cursor}>
                {` ${m.content.slice(0, 70)}${m.content.length > 70 ? "..." : ""} `}
              </Text>
              {i === cursor && m.tags && m.tags.length > 0 && (
                <Text dimColor>{`   tags: ${m.tags.join(", ")}`}</Text>
              )}
              {i === cursor && m.scope && (
                <Text dimColor>{`   scope: ${m.scope}`}</Text>
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* Status message */}
      {statusMsg && (
        <Box marginTop={1}>
          <Text color="green">{statusMsg}</Text>
        </Box>
      )}
    </Box>
  );
}
