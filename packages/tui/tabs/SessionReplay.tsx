import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import { COLOR } from "../constants.js";
import { ScrollBox } from "../components/ScrollBox.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import type { ReplayStep } from "../../core/index.js";

export interface SessionReplayProps {
  session: core.Session;
  onClose: () => void;
}

/** Replay overlay - step through a session's event timeline */
export function SessionReplay({ session, onClose }: SessionReplayProps) {
  const steps = useMemo(() => core.buildReplay(session.id), [session.id]);
  const [sel, setSel] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterText, setFilterText] = useState("");

  const filtered = useMemo(() => {
    if (!filterText) return steps;
    const lower = filterText.toLowerCase();
    return steps.filter(
      (s) =>
        s.type.toLowerCase().includes(lower) ||
        s.summary.toLowerCase().includes(lower) ||
        (s.stage ?? "").toLowerCase().includes(lower),
    );
  }, [steps, filterText]);

  const max = filtered.length - 1;

  useInput((input, key) => {
    if (searchMode) {
      if (key.escape) {
        setSearchMode(false);
        return;
      }
      if (key.return) {
        setFilterText(searchQuery);
        setSearchMode(false);
        setSel(0);
        return;
      }
      return;
    }

    if (key.escape) { onClose(); return; }

    // Navigation
    if (filtered.length === 0) return;
    if (input === "j" || key.downArrow) {
      setSel((s) => Math.min(s + 1, max));
    } else if (input === "k" || key.upArrow) {
      setSel((s) => Math.max(s - 1, 0));
    } else if (input === "f" || key.pageDown) {
      setSel((s) => Math.min(s + 20, max));
    } else if (input === "b" || key.pageUp) {
      setSel((s) => Math.max(s - 20, 0));
    } else if (input === "g") {
      setSel(0);
    } else if (input === "G") {
      setSel(max);
    } else if (key.return) {
      setExpanded((e) => !e);
    } else if (input === "/") {
      setSearchMode(true);
      setSearchQuery("");
    }
  });

  // Clamp selection
  const clampedSel = Math.min(sel, Math.max(0, max));
  const selectedStep = filtered[clampedSel] ?? null;

  const ago = session.updated_at ? core.safeParseConfig({}) /* unused, just for type */ : null;
  const flowLabel = session.flow ?? "default";

  return (
    <ScrollBox active={!searchMode} reserveRows={9}>
      {/* Header */}
      <Text bold>
        {` Session ${session.id} | flow: ${flowLabel} | ${session.status} | ${steps.length} events`}
      </Text>
      <Text dimColor>{" " + "━".repeat(60)}</Text>

      {/* Search bar */}
      {searchMode && (
        <Box>
          <Text color="cyan">{" / "}</Text>
          <TextInputEnhanced
            value={searchQuery}
            onChange={setSearchQuery}
            onSubmit={(q: string) => {
              setFilterText(q);
              setSearchMode(false);
              setSel(0);
            }}
            focus={true}
            placeholder="Filter events..."
          />
        </Box>
      )}

      {filterText && (
        <Text dimColor>{`  Filtered: "${filterText}" (${filtered.length}/${steps.length} events)`}</Text>
      )}

      <Text> </Text>

      {/* Event list */}
      {filtered.length === 0 ? (
        <Text dimColor>{"  No events" + (filterText ? " matching filter." : ".")}</Text>
      ) : (
        filtered.map((step, i) => {
          const isSel = i === clampedSel;
          const pointer = isSel ? ">" : " ";
          const typeColor = eventTypeColor(step.type);
          return (
            <React.Fragment key={step.index}>
              <Text wrap="truncate">
                <Text color={isSel ? "cyan" : undefined} bold={isSel}>{pointer}</Text>
                {" "}
                <Text dimColor>[{step.elapsed}]</Text>
                {" "}
                <Text color={typeColor as any}>{step.type}</Text>
                {" - "}
                <Text color={isSel ? "white" : undefined} dimColor={!isSel}>{step.summary}</Text>
              </Text>
              {/* Show detail inline for selected step when expanded */}
              {isSel && expanded && step.detail && (
                <Box flexDirection="column" marginLeft={4} marginBottom={1}>
                  {step.detail.split("\n").map((line, li) => (
                    <Text key={li} dimColor wrap="wrap">{`  ${line}`}</Text>
                  ))}
                </Box>
              )}
            </React.Fragment>
          );
        })
      )}

      {/* Footer status */}
      <Text> </Text>
      {selectedStep && (
        <Text dimColor>
          {`  Step ${clampedSel + 1}/${filtered.length}`}
          {selectedStep.stage ? ` | stage:${selectedStep.stage}` : ""}
          {selectedStep.actor ? ` | actor:${selectedStep.actor}` : ""}
        </Text>
      )}
    </ScrollBox>
  );
}

/** Color coding for event types */
function eventTypeColor(type: string): string {
  if (type.includes("error") || type.includes("failed") || type.includes("crashed")) return "red";
  if (type.includes("completed") || type.includes("done") || type.includes("joined")) return "green";
  if (type.includes("started") || type.includes("resumed") || type.includes("dispatch")) return "cyan";
  if (type.includes("ready") || type.includes("waiting") || type.includes("paused")) return "yellow";
  if (type.includes("progress")) return "blue";
  if (type.includes("stopped")) return "gray";
  return "white";
}
