import React, { useMemo, useState, useCallback, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { ToolEntry } from "../../core/tools.js";
import type { RecipeInstance } from "../../core/index.js";
import { findProjectRoot } from "../../core/agent.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { useFocus } from "../hooks/useFocus.js";
import { useArkClient } from "../hooks/useArkClient.js";
import type { AsyncState } from "../hooks/useAsync.js";

// ── Grouping: global vs project-scoped ──────────────────────────────────────

const PROJECT_KINDS = new Set<ToolEntry["kind"]>(["mcp-server", "command", "context", "claude-skill"]);

function groupLabel(entry: ToolEntry): string {
  if (PROJECT_KINDS.has(entry.kind)) {
    switch (entry.kind) {
      case "mcp-server": return "Project: MCP Servers";
      case "command": return "Project: Commands";
      case "context": return "Project: Context";
      case "claude-skill": return "Project: Skills";
      default: return "Project";
    }
  }
  switch (entry.kind) {
    case "ark-skill": return "Skills";
    case "ark-recipe": return "Recipes";
    default: return entry.kind;
  }
}

// Global groups always shown; project groups only when projectRoot exists
const GLOBAL_GROUPS = ["Skills", "Recipes"];
const PROJECT_GROUPS = ["Project: MCP Servers", "Project: Commands", "Project: Skills", "Project: Context"];

// ── Props ───────────────────────────────────────────────────────────────────

interface ToolsTabProps {
  pane: "left" | "right";
  asyncState?: AsyncState;
  refresh?: () => void;
  onUseRecipe?: (instance: RecipeInstance) => void;
}

// ── Main Component ──────────────────────────────────────────────────────────

export function ToolsTab({ pane, asyncState, refresh, onUseRecipe }: ToolsTabProps) {
  const ark = useArkClient();
  const focus = useFocus();
  const status = useStatusMessage();
  const [version, setVersion] = useState(0);
  const projectRoot = useMemo(() => findProjectRoot(process.cwd()) ?? undefined, []);

  const [items, setItems] = useState<ToolEntry[]>([]);
  useEffect(() => {
    ark.toolsList(projectRoot).then((raw: ToolEntry[]) => {
      const sorted = raw.sort((a: ToolEntry, b: ToolEntry) => {
        const ga = groupLabel(a);
        const gb = groupLabel(b);
        if (ga === gb) return a.name.localeCompare(b.name);
        return ga.localeCompare(gb);
      });
      setItems(sorted);
    });
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
            await ark.toolsDeleteItem({
              name: item.name,
              kind: item.kind,
              source: item.source,
              scope: item.source !== "builtin" ? item.source : undefined,
              projectRoot,
            });
            status.show(`Deleted '${item.name}'`);
            doRefresh();
          });
        } else {
          ark.toolsDeleteItem({
            name: item.name,
            kind: item.kind,
            source: item.source,
            scope: item.source !== "builtin" ? item.source : undefined,
            projectRoot,
          }).then(() => {
            status.show(`Deleted '${item.name}'`);
            doRefresh();
          });
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

    // Use recipe
    if (key.return && selected.kind === "ark-recipe") {
      if (asyncState) {
        asyncState.run("Loading recipe...", async () => {
          const recipe = await ark.recipeRead(selected.name);
          if (recipe) {
            const missing = recipe.variables.filter((v: any) => v.required && !v.default && !recipe.defaults?.[v.name] && !recipe.repo);
            if (missing.length > 0) {
              status.show(`Recipe needs: ${missing.map((v: any) => v.name).join(", ")}`);
              return;
            }
            // Use server-side recipe/use which instantiates + starts session
            const session = await ark.recipeUse(selected.name, recipe.defaults ?? {});
            onUseRecipe?.({ ...recipe, ...session });
            status.show(`Session created from recipe '${selected.name}'`);
          }
        });
      }
      return;
    }

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
          emptyGroups={projectRoot ? [...GLOBAL_GROUPS, ...PROJECT_GROUPS] : GLOBAL_GROUPS}
          renderRow={(item) => {
            return `${item.name.padEnd(20)} ${item.description}`;
          }}
          sel={sel}
          emptyMessage="  No tools found."
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
    return <Box flexGrow={1}><Text dimColor>{"  No tool selected."}</Text></Box>;
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
          {(() => {
            const mcpCfg = item.config as { command?: string; args?: string[]; env?: Record<string, string> };
            return (
              <>
                <Text> </Text>
                <SectionHeader title="Server Config" />
                {mcpCfg.command && (
                  <Text>{`  Command: ${mcpCfg.command}`}</Text>
                )}
                {mcpCfg.args && mcpCfg.args.length > 0 && (
                  <Text>{`  Args:    ${mcpCfg.args.join(" ")}`}</Text>
                )}
                {mcpCfg.env && Object.keys(mcpCfg.env).length > 0 && (
                  <>
                    <Text> </Text>
                    <SectionHeader title="Environment" />
                    {Object.entries(mcpCfg.env).map(([k, v]) => (
                      <Text key={k}>{`  ${k}=${String(v)}`}</Text>
                    ))}
                  </>
                )}
              </>
            );
          })()}
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
  const ark = useArkClient();
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    const path = require("path");
    const projectRoot = path.dirname(path.dirname(path.dirname(source)));
    const name = path.basename(source, ".md");
    ark.toolsRead({ name, kind: "command", projectRoot }).then((r: any) => setContent(r?.content ?? null)).catch(() => setContent(null));
  }, [source]);

  if (!content) return null;

  return (
    <>
      <Text> </Text>
      <SectionHeader title="Content" />
      {content.split("\n").slice(0, 30).map((line: string, i: number) => (
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
  const ark = useArkClient();
  const [skill, setSkill] = useState<any>(null);
  useEffect(() => {
    ark.skillRead(name).then(setSkill).catch(() => setSkill(null));
  }, [name]);
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
  const ark = useArkClient();
  const [recipe, setRecipe] = useState<any>(null);
  useEffect(() => {
    ark.recipeRead(name).then(setRecipe).catch(() => setRecipe(null));
  }, [name]);
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
          {recipe.variables.map((v: any) => (
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

// deleteToolItem is now handled server-side via ark.toolsDeleteItem()
