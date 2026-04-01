import React, { useMemo } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { useListNavigation } from "../hooks/useListNavigation.js";

type ToolKind = "skill" | "recipe";

interface ToolItem {
  kind: ToolKind;
  name: string;
  description: string;
  source: string;
  raw: any;
}

interface ToolsTabProps {
  pane: "left" | "right";
}

export function ToolsTab({ pane }: ToolsTabProps) {
  const projectRoot = useMemo(() => core.findProjectRoot(process.cwd()) ?? undefined, []);

  const items = useMemo(() => {
    const skills: ToolItem[] = core.listSkills(projectRoot).map(s => ({
      kind: "skill" as const,
      name: s.name,
      description: s.description,
      source: s._source ?? "builtin",
      raw: s,
    }));
    const recipes: ToolItem[] = core.listRecipes(projectRoot).map(r => ({
      kind: "recipe" as const,
      name: r.name,
      description: r.description,
      source: r._source ?? "builtin",
      raw: r,
    }));
    return [...skills, ...recipes];
  }, [projectRoot]);

  const { sel } = useListNavigation(items.length, { active: pane === "left" });
  const selected = items[sel] ?? null;

  return (
    <SplitPane
      focus={pane}
      leftTitle="Tools"
      rightTitle="Details"
      left={
        <TreeList
          items={items}
          groupBy={(item) => item.kind === "skill" ? "Skills" : "Recipes"}
          renderRow={(item) => {
            const marker = items.indexOf(item) === sel ? ">" : " ";
            return `${marker} ${item.name.padEnd(20)} ${item.description}`;
          }}
          sel={sel}
          emptyMessage="No skills or recipes found."
        />
      }
      right={<ToolDetail item={selected} pane={pane} />}
    />
  );
}

function ToolDetail({ item, pane }: { item: ToolItem | null; pane: string }) {
  if (!item) {
    return <Box flexGrow={1}><Text dimColor>{"  No tool selected"}</Text></Box>;
  }

  return (
    <DetailPanel active={pane === "right"}>
      <Text bold>{` ${item.name}`}</Text>
      <Text dimColor>{` ${item.description}`}</Text>
      <Text> </Text>
      <SectionHeader title="Info" />
      <Text>{`  Type:   ${item.kind}`}</Text>
      <Text>{`  Source: ${item.source}`}</Text>

      {item.kind === "skill" && item.raw.prompt && (
        <>
          <Text> </Text>
          <SectionHeader title="Prompt" />
          {item.raw.prompt.split("\n").map((line: string, i: number) => (
            <Text key={i} dimColor>{`  ${line}`}</Text>
          ))}
        </>
      )}

      {item.kind === "skill" && item.raw.tags?.length > 0 && (
        <>
          <Text> </Text>
          <Text dimColor>{`  Tags: ${item.raw.tags.join(", ")}`}</Text>
        </>
      )}

      {item.kind === "recipe" && (
        <>
          <Text> </Text>
          <SectionHeader title="Config" />
          <Text>{`  Flow:  ${item.raw.flow}`}</Text>
          {item.raw.agent && <Text>{`  Agent: ${item.raw.agent}`}</Text>}
          {item.raw.variables?.length > 0 && (
            <>
              <Text> </Text>
              <SectionHeader title={`Variables (${item.raw.variables.length})`} />
              {item.raw.variables.map((v: any) => (
                <Text key={v.name}>{`  ${v.name}${v.required ? " *" : ""} - ${v.description}`}</Text>
              ))}
            </>
          )}
        </>
      )}
    </DetailPanel>
  );
}
