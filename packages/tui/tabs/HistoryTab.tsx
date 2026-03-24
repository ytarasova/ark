import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import * as core from "../../core/index.js";
import { ago } from "../helpers.js";
import { SplitPane } from "../components/SplitPane.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { KeyValue } from "../components/KeyValue.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface HistoryTabProps extends StoreData {
  pane: "left" | "right";
  async: AsyncState;
}

export function HistoryTab({ pane, async: asyncState, refresh }: HistoryTabProps) {
  const [claudeSessions, setClaudeSessions] = useState<core.ClaudeSession[]>([]);
  const status = useStatusMessage();

  const { sel } = useListNavigation(claudeSessions.length, { active: pane === "left" });
  const selected = claudeSessions[sel] ?? null;

  // Load Claude sessions on mount
  useEffect(() => {
    asyncState.run("Loading Claude sessions...", async () => {
      await new Promise(r => setTimeout(r, 50)); // yield so spinner renders
      const sessions = core.listClaudeSessions({ limit: 50 });
      setClaudeSessions(sessions);
      if (sessions.length === 0) {
        status.show("No Claude sessions found");
      }
    });
  }, []);

  useInput((input, key) => {
    if (pane !== "left") return;

    // Enter — import selected session
    if (key.return && selected) {
      asyncState.run("Importing session...", () => {
        const s = core.startSession({
          summary: selected.summary?.slice(0, 100) || `Import ${selected.sessionId.slice(0, 8)}`,
          repo: selected.project,
          workdir: selected.project,
          flow: "bare",
        });
        core.updateSession(s.id, { claude_session_id: selected.sessionId });
        status.show(`Imported Claude session ${selected.sessionId.slice(0, 8)}`);
        refresh();
      });
      return;
    }

    // / — rebuild FTS5 transcript index
    if (input === "/") {
      asyncState.run("Indexing transcripts...", async () => {
        const count = await core.indexTranscripts({
          onProgress: (indexed, files) => {
            status.show(`Indexing... ${files} files, ${indexed} entries`);
          },
        });
        status.show(`Indexed ${count} transcript entries`);
      });
      return;
    }

    // r — reload sessions list
    if (input === "r") {
      asyncState.run("Reloading Claude sessions...", async () => {
        await new Promise(r => setTimeout(r, 50)); // yield so spinner renders
        const sessions = core.listClaudeSessions({ limit: 50 });
        setClaudeSessions(sessions);
        status.show(`Loaded ${sessions.length} Claude sessions`);
      });
      return;
    }

    // s — search (coming soon)
    if (input === "s") {
      status.show("Search coming soon");
      return;
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <SplitPane
        focus={pane}
        leftTitle="Claude Sessions"
        rightTitle="Details"
        left={
          asyncState.loading && claudeSessions.length === 0 ? (
            <Text><Spinner type="dots" /> <Text dimColor>loading...</Text></Text>
          ) : (
            <TreeList
              items={claudeSessions}
              renderRow={(cs) => {
                const marker = claudeSessions.indexOf(cs) === sel ? ">" : " ";
                const id = cs.sessionId.slice(0, 8);
                const date = (cs.lastActivity || cs.timestamp || "").slice(0, 10);
                const proj = cs.project.split("/").slice(-2).join("/").slice(0, 16).padEnd(16);
                const summary = (cs.summary || "(no summary)").slice(0, 30);
                return `${marker}  ${id}  ${date}  ${proj}  ${summary}`;
              }}
              sel={sel}
              emptyMessage="No Claude sessions found. Press r to reload."
            />
          )
        }
        right={
          asyncState.loading && asyncState.label ? (
            <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
              <Text color="yellow"><Spinner type="dots" />{` ${asyncState.label}`}</Text>
            </Box>
          ) : (
            <SessionDetail session={selected} pane={pane} />
          )
        }
      />
      {status.message && (
        <Box>
          <Text color="cyan">{` ${status.message}`}</Text>
        </Box>
      )}
    </Box>
  );
}

// -- Detail ------------------------------------------------------------------

interface SessionDetailProps {
  session: core.ClaudeSession | null;
  pane: "left" | "right";
}

function SessionDetail({ session: cs, pane }: SessionDetailProps) {
  if (!cs) {
    return <Text dimColor>{"  No session selected"}</Text>;
  }

  return (
    <DetailPanel active={pane === "right"}>
      <SectionHeader title="Session" />
      <KeyValue label="ID">{cs.sessionId}</KeyValue>
      <KeyValue label="Project">{cs.project}</KeyValue>
      <KeyValue label="Messages">{String(cs.messageCount)}</KeyValue>
      <KeyValue label="Created">{cs.timestamp || "unknown"}</KeyValue>
      <KeyValue label="Last active">{cs.lastActivity || "unknown"}</KeyValue>
      <KeyValue label="Age">{ago(cs.lastActivity || cs.timestamp)}</KeyValue>

      <Text> </Text>
      <SectionHeader title="Summary" />
      {cs.summary ? (
        cs.summary.split("\n").map((line, i) => (
          <Text key={i} wrap="wrap">{`  ${line}`}</Text>
        ))
      ) : (
        <Text dimColor>{"  (no summary)"}</Text>
      )}

      <Text> </Text>
      <SectionHeader title="File" />
      <Text dimColor wrap="wrap">{`  ${cs.transcriptPath}`}</Text>

      <Text> </Text>
      <Text dimColor>{"  Press Enter to import into Ark"}</Text>
    </DetailPanel>
  );
}
