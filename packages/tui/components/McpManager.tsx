import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import { EXTENSION_CATALOG } from "../../core/extension-catalog.js";

interface McpManagerProps {
  session: core.Session;
  onClose: () => void;
  onApply: () => void;
}

// Build catalog from extension-catalog module (single source of truth)
const MCP_CATALOG: Record<string, { command: string; args: string[]; env?: Record<string, string>; description: string }> = Object.fromEntries(
  EXTENSION_CATALOG.map(e => [e.name, { command: e.command, args: e.args, env: e.env ?? {}, description: e.description }])
);

export function McpManager({ session, onClose, onApply }: McpManagerProps) {
  const projectDir = session.workdir ?? ".";

  // Discover currently attached servers
  const currentServers = useMemo(() => {
    const tools = core.discoverTools(projectDir);
    return tools.filter(t => t.kind === "mcp-server").map(t => t.name);
  }, [projectDir]);

  // Build list: catalog + any currently attached that aren't in catalog
  const allServers = useMemo(() => {
    const servers = new Map<string, { description: string; attached: boolean }>();

    // Add catalog entries
    for (const [name, info] of Object.entries(MCP_CATALOG)) {
      servers.set(name, { description: info.description, attached: currentServers.includes(name) });
    }

    // Add currently attached servers not in catalog
    for (const name of currentServers) {
      if (!servers.has(name)) {
        servers.set(name, { description: "Custom server", attached: true });
      }
    }

    return servers;
  }, [currentServers]);

  const [toggleState, setToggleState] = useState<Map<string, boolean>>(() => {
    const state = new Map<string, boolean>();
    for (const [name, info] of allServers) {
      state.set(name, info.attached);
    }
    return state;
  });

  const serverNames = useMemo(() => Array.from(allServers.keys()), [allServers]);
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }

    if (input === "j" || key.downArrow) {
      setCursor(c => Math.min(c + 1, serverNames.length - 1));
    } else if (input === "k" || key.upArrow) {
      setCursor(c => Math.max(c - 1, 0));
    } else if (input === " ") {
      const name = serverNames[cursor];
      setToggleState(prev => {
        const next = new Map(prev);
        next.set(name, !next.get(name));
        return next;
      });
    } else if (key.return) {
      // Apply changes
      for (const [name, enabled] of toggleState) {
        const wasAttached = allServers.get(name)?.attached ?? false;
        if (enabled && !wasAttached) {
          // Attach
          const catalogEntry = MCP_CATALOG[name];
          if (catalogEntry) {
            core.addMcpServer(projectDir, name, catalogEntry);
          }
        } else if (!enabled && wasAttached) {
          // Detach
          core.removeMcpServer(projectDir, name);
        }
      }
      onApply();
      onClose();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">MCP Manager</Text>
        <Text color="gray"> — {projectDir}</Text>
      </Box>

      {serverNames.map((name, i) => {
        const enabled = toggleState.get(name) ?? false;
        const info = allServers.get(name)!;
        const isCursor = i === cursor;
        const changed = enabled !== info.attached;

        return (
          <Box key={name}>
            <Text color={isCursor ? "cyan" : undefined} bold={isCursor}>
              {isCursor ? ">" : " "} {enabled ? "[x]" : "[ ]"} {name}
            </Text>
            <Text color="gray"> — {info.description}</Text>
            {changed && <Text color="yellow"> *</Text>}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color="gray">Space:toggle  Enter:apply  Esc:cancel</Text>
      </Box>
    </Box>
  );
}
