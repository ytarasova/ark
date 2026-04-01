import React, { useMemo, useState, useCallback, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import type { ToolEntry } from "../../core/tools.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { useFocus } from "../hooks/useFocus.js";
import type { AsyncState } from "../hooks/useAsync.js";

// ── Kind labels for TreeList groups ─────────────────────────────────────────

const KIND_LABELS: Record<ToolEntry["kind"], string> = {
  "mcp-server": "MCP Servers",
  "command": "Commands",
  "claude-skill": "Skills",
  "ark-skill": "Skills",
  "ark-recipe": "Recipes",
  "context": "Context",
};

function groupLabel(entry: ToolEntry): string {
  // Merge claude-skill and ark-skill into one "Skills" group
  return KIND_LABELS[entry.kind] ?? entry.kind;
}

// All group names in display order
const ALL_GROUPS = ["MCP Servers", "Commands", "Skills", "Recipes", "Context"];

// ── Props ───────────────────────────────────────────────────────────────────

interface ToolsTabProps {
  pane: "left" | "right";
  asyncState?: AsyncState;
  refresh?: () => void;
}

// ── Main Component ──────────────────────────────────────────────────────────

export function ToolsTab({ pane, asyncState, refresh }: ToolsTabProps) {
  const focus = useFocus();
  const status = useStatusMessage();
  const [version, setVersion] = useState(0);
  const projectRoot = useMemo(() => core.findProjectRoot(process.cwd()) ?? undefined, []);

  const items = useMemo(() => {
    return core.discoverTools(projectRoot);
  }, [projectRoot, version]);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const hasOverlay = confirmDelete;
  const { sel } = useListNavigation(items.length, { active: pane === "left" && !hasOverlay });
  const selected = items[sel] ?? null;

  // Clear confirm on selection change
  useEffect(() => { setConfirmDelete(false); }, [sel]);

  // Push focus when confirmation overlay is active
  useEffect(() => {
    if (confirmDelete) focus.push("confirm-delete");
    else focus.pop("confirm-delete");
  }, [confirmDelete]);

  const doRefresh = useCallback(() => {
    setVersion(v => v + 1);
    refresh?.();
  }, [refresh]);

  useInput((input, key) => {
    if (pane !== "left") return;

    // Handle delete confirmation
    if (confirmDelete && selected) {
      if (input === "y" || input === "Y") {
        const item = selected;
        setConfirmDelete(false);
        if (asyncState) {
          asyncState.run(`Deleting ${item.name}...`, async () => {
            deleteToolItem(item, projectRoot);
            status.show(`Deleted '${item.name}'`);
            doRefresh();
          });
        } else {
          deleteToolItem(item, projectRoot);
          status.show(`Deleted '${item.name}'`);
          doRefresh();
        }
        return;
      }
      if (input === "n" || input === "N" || key.escape) {
        setConfirmDelete(false);
        status.show("Delete cancelled");
        return;
      }
      return;
    }

    if (hasOverlay) return;

    if (!selected) return;

    // Delete
    if (input === "x") {
      if (!isDeletable(selected)) {
        status.show(`Cannot delete ${selected.kind === "context" ? "context files" : "builtin"} items`);
        return;
      }
      setConfirmDelete(true);
      return;
    }

    // Edit - open in $EDITOR for commands/skills
    if (input === "e") {
      if (selected.kind === "command" || selected.kind === "claude-skill") {
        const filePath = selected.source;
        if (filePath && filePath !== "builtin") {
          const editor = process.env.EDITOR ?? "vim";
          status.show(`Opening in ${editor}...`);
          // We can't block TUI, just show the path
          status.show(`Edit: ${filePath}`);
        } else {
          status.show("Cannot edit builtin items");
        }
        return;
      }
      status.show(`Edit not yet supported for ${selected.kind}`);
      return;
    }
  });

  return (
    <SplitPane
      focus={pane}
      leftTitle="Tools"
      rightTitle={confirmDelete ? "Confirm Delete" : "Details"}
      left={
        <TreeList
          items={items}
          groupBy={groupLabel}
          emptyGroups={ALL_GROUPS}
          renderRow={(item) => {
            return `${item.name.padEnd(20)} ${item.description}`;
          }}
          sel={sel}
          emptyMessage="No tools found."
        />
      }
      right={
        confirmDelete && selected ? (
          <DetailPanel active={pane === "right"}>
            <Text bold color="red">{` Delete '${selected.name}'?`}</Text>
            <Text> </Text>
            <Text>{`  Type: ${selected.kind}`}</Text>
            <Text>{`  Source: ${selected.source}`}</Text>
            <Text> </Text>
            <Text bold>{`  Press 'y' to confirm, 'n' to cancel`}</Text>
          </DetailPanel>
        ) : (
          <ToolDetail item={selected} pane={pane} statusMessage={status.message} />
        )
      }
    />
  );
}

// ── Detail Component ────────────────────────────────────────────────────────

function ToolDetail({ item, pane, statusMessage }: {
  item: ToolEntry | null;
  pane: string;
  statusMessage: string | null;
}) {
  if (!item) {
    return <Box flexGrow={1}><Text dimColor>{"  No tool selected"}</Text></Box>;
  }

  return (
    <DetailPanel active={pane === "right"}>
      <Text bold>{` ${item.name}`}</Text>
      <Text dimColor>{` ${item.description}`}</Text>
      {statusMessage && <Text color="yellow">{` ${statusMessage}`}</Text>}

      <Text> </Text>
      <SectionHeader title="Info" />
      <Text>{`  Kind:   ${item.kind}`}</Text>
      <Text>{`  Source: ${item.source}`}</Text>

      {/* MCP Server details */}
      {item.kind === "mcp-server" && item.config && (
        <>
          <Text> </Text>
          <SectionHeader title="Server Config" />
          {(item.config as any).command && (
            <Text>{`  Command: ${(item.config as any).command}`}</Text>
          )}
          {(item.config as any).args?.length > 0 && (
            <Text>{`  Args:    ${(item.config as any).args.join(" ")}`}</Text>
          )}
          {(item.config as any).env && Object.keys((item.config as any).env).length > 0 && (
            <>
              <Text> </Text>
              <SectionHeader title="Environment" />
              {Object.entries((item.config as any).env).map(([k, v]) => (
                <Text key={k}>{`  ${k}=${String(v)}`}</Text>
              ))}
            </>
          )}
        </>
      )}

      {/* Command content */}
      {item.kind === "command" && (
        <CommandContent source={item.source} />
      )}

      {/* Claude skill content */}
      {item.kind === "claude-skill" && (
        <SkillFileContent source={item.source} />
      )}

      {/* Ark skill details */}
      {item.kind === "ark-skill" && (
        <ArkSkillDetail name={item.name} />
      )}

      {/* Ark recipe details */}
      {item.kind === "ark-recipe" && (
        <ArkRecipeDetail name={item.name} />
      )}

      {/* Context file preview */}
      {item.kind === "context" && (
        <ContextPreview source={item.source} />
      )}
    </DetailPanel>
  );
}

// ── Sub-detail components ───────────────────────────────────────────────────

function CommandContent({ source }: { source: string }) {
  const content = useMemo(() => {
    try { return core.getCommand(require("path").dirname(require("path").dirname(require("path").dirname(source))), require("path").basename(source, ".md")); }
    catch { return null; }
  }, [source]);

  if (!content) return null;

  return (
    <>
      <Text> </Text>
      <SectionHeader title="Content" />
      {content.split("\n").slice(0, 30).map((line, i) => (
        <Text key={i} dimColor>{`  ${line}`}</Text>
      ))}
      {content.split("\n").length > 30 && (
        <Text dimColor>{"  ... (truncated)"}</Text>
      )}
    </>
  );
}

function SkillFileContent({ source }: { source: string }) {
  const content = useMemo(() => {
    try {
      const { readFileSync } = require("fs");
      return readFileSync(source, "utf-8") as string;
    } catch { return null; }
  }, [source]);

  if (!content) return null;

  return (
    <>
      <Text> </Text>
      <SectionHeader title="Prompt" />
      {content.split("\n").slice(0, 30).map((line, i) => (
        <Text key={i} dimColor>{`  ${line}`}</Text>
      ))}
      {content.split("\n").length > 30 && (
        <Text dimColor>{"  ... (truncated)"}</Text>
      )}
    </>
  );
}

function ArkSkillDetail({ name }: { name: string }) {
  const projectRoot = useMemo(() => core.findProjectRoot(process.cwd()) ?? undefined, []);
  const skill = useMemo(() => core.loadSkill(name, projectRoot), [name, projectRoot]);
  if (!skill) return null;

  return (
    <>
      {skill.tags?.length > 0 && (
        <>
          <Text> </Text>
          <Text dimColor>{`  Tags: ${skill.tags.join(", ")}`}</Text>
        </>
      )}
      {skill.prompt && (
        <>
          <Text> </Text>
          <SectionHeader title="Prompt" />
          {skill.prompt.split("\n").slice(0, 30).map((line: string, i: number) => (
            <Text key={i} dimColor>{`  ${line}`}</Text>
          ))}
          {skill.prompt.split("\n").length > 30 && (
            <Text dimColor>{"  ... (truncated)"}</Text>
          )}
        </>
      )}
    </>
  );
}

function ArkRecipeDetail({ name }: { name: string }) {
  const projectRoot = useMemo(() => core.findProjectRoot(process.cwd()) ?? undefined, []);
  const recipe = useMemo(() => core.loadRecipe(name, projectRoot), [name, projectRoot]);
  if (!recipe) return null;

  return (
    <>
      <Text> </Text>
      <SectionHeader title="Config" />
      <Text>{`  Flow:  ${recipe.flow}`}</Text>
      {recipe.agent && <Text>{`  Agent: ${recipe.agent}`}</Text>}
      {recipe.compute && <Text>{`  Compute: ${recipe.compute}`}</Text>}
      {recipe.variables?.length > 0 && (
        <>
          <Text> </Text>
          <SectionHeader title={`Variables (${recipe.variables.length})`} />
          {recipe.variables.map((v) => (
            <Text key={v.name}>{`  ${v.name}${v.required ? " *" : ""} - ${v.description}`}</Text>
          ))}
        </>
      )}
    </>
  );
}

function ContextPreview({ source }: { source: string }) {
  const content = useMemo(() => {
    try {
      const { readFileSync } = require("fs");
      return readFileSync(source, "utf-8") as string;
    } catch { return null; }
  }, [source]);

  if (!content) return null;

  const lines = content.split("\n");
  return (
    <>
      <Text> </Text>
      <SectionHeader title={`Preview (${lines.length} lines)`} />
      {lines.slice(0, 40).map((line, i) => (
        <Text key={i} dimColor>{`  ${line}`}</Text>
      ))}
      {lines.length > 40 && (
        <Text dimColor>{"  ... (truncated)"}</Text>
      )}
    </>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isDeletable(item: ToolEntry): boolean {
  if (item.kind === "context") return false;
  if (item.source === "builtin") return false;
  return true;
}

function deleteToolItem(item: ToolEntry, projectRoot?: string): void {
  switch (item.kind) {
    case "mcp-server":
      if (projectRoot) core.removeMcpServer(projectRoot, item.name);
      break;
    case "command":
      if (projectRoot) core.removeCommand(projectRoot, item.name);
      break;
    case "claude-skill": {
      // Delete the .md file directly
      try {
        const { unlinkSync, existsSync } = require("fs");
        if (existsSync(item.source)) unlinkSync(item.source);
      } catch { /* skip */ }
      break;
    }
    case "ark-skill":
      if (item.source !== "builtin") {
        core.deleteSkill(item.name, item.source as "project" | "global", projectRoot);
      }
      break;
    case "ark-recipe":
    case "context":
      break;
  }
}
