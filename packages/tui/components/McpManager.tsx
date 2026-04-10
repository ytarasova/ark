import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import { useArkClient } from "../hooks/useArkClient.js";
import type { Session } from "../../core/index.js";
import { EXTENSION_CATALOG } from "../../core/extension-catalog.js";

interface McpManagerProps {
  session: Session;
  onClose: () => void;
  onApply: () => void;
}

// Build catalog from extension-catalog module (single source of truth)
const MCP_CATALOG: Record<string, { command: string; args: string[]; env?: Record<string, string>; description: string }> = Object.fromEntries(
  EXTENSION_CATALOG.map(e => [e.name, { command: e.command, args: e.args, env: e.env ?? {}, description: e.description }])
);

export function McpManager({ session, onClose, onApply }: McpManagerProps) {
  const theme = getTheme();
  const ark = useArkClient();
  const projectDir = session.workdir ?? ".";

  // Discover currently attached servers (async via ark client)
  const [currentServers, setCurrentServers] = useState<string[]>([]);
  useEffect(() => {
    ark.toolsList(projectDir).then(tools => {
      setCurrentServers(tools.filter((t: any) => t.kind === "mcp-server").map((t: any) => t.name));
    }).catch(() => {});
  }, [ark, projectDir]);

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

  const [toggleState, setToggleState] = useState<Map<string, boolean>>(() => new Map());

  // Sync toggle state when allServers changes (initial load)
  useEffect(() => {
    const state = new Map<string, boolean>();
    for (const [name, info] of allServers) {
      state.set(name, info.attached);
    }
    setToggleState(state);
  }, [allServers]);

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
      // Apply changes async
      (async () => {
        for (const [name, enabled] of toggleState) {
          const wasAttached = allServers.get(name)?.attached ?? false;
          if (enabled && !wasAttached) {
            const catalogEntry = MCP_CATALOG[name];
            if (catalogEntry) {
              await ark.mcpAttach(session.id, { name, ...catalogEntry });
            }
          } else if (!enabled && wasAttached) {
            await ark.mcpDetach(session.id, name);
          }
        }
        onApply();
        onClose();
      })();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={theme.accent}>MCP Manager</Text>
        <Text color={theme.dimText}> — {projectDir}</Text>
      </Box>

      {serverNames.map((name, i) => {
        const enabled = toggleState.get(name) ?? false;
        const info = allServers.get(name)!;
        const isCursor = i === cursor;
        const changed = enabled !== info.attached;

        return (
          <Box key={name}>
            <Text color={isCursor ? theme.highlight : undefined} bold={isCursor}>
              {isCursor ? ">" : " "} {enabled ? "[x]" : "[ ]"} {name}
            </Text>
            <Text color={theme.dimText}> — {info.description}</Text>
            {changed && <Text color={theme.waiting}> *</Text>}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color={theme.dimText}>Space:toggle  Enter:apply  Esc:cancel</Text>
      </Box>
    </Box>
  );
}
