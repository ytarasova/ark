/**
 * Extension catalog -- known MCP servers with metadata.
 * Used by the MCP Manager UI for discovery and one-click installation.
 */

export interface ExtensionEntry {
  name: string;
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  envKeys?: string[];     // env vars the user needs to provide (e.g., API keys)
  category: "search" | "browser" | "database" | "memory" | "code" | "productivity" | "other";
  url?: string;           // homepage or docs URL
}

export const EXTENSION_CATALOG: ExtensionEntry[] = [
  {
    name: "sequential-thinking",
    description: "Sequential thinking for complex multi-step reasoning",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    category: "code",
  },
  {
    name: "filesystem",
    description: "Read/write filesystem access",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    category: "code",
  },
  {
    name: "memory",
    description: "Persistent memory across sessions",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"],
    category: "memory",
  },
  {
    name: "playwright",
    description: "Browser automation via Playwright",
    command: "npx", args: ["-y", "@anthropics/playwright-mcp"],
    category: "browser",
  },
  {
    name: "github",
    description: "GitHub repository access",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-github"],
    envKeys: ["GITHUB_TOKEN"],
    category: "code",
  },
  {
    name: "postgres",
    description: "PostgreSQL database access",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"],
    envKeys: ["POSTGRES_CONNECTION_STRING"],
    category: "database",
  },
  {
    name: "sqlite",
    description: "SQLite database access",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-sqlite"],
    category: "database",
  },
  {
    name: "brave-search",
    description: "Web search via Brave Search API",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"],
    envKeys: ["BRAVE_API_KEY"],
    category: "search",
  },
  {
    name: "exa",
    description: "AI-powered web search via Exa",
    command: "npx", args: ["-y", "exa-mcp-server"],
    envKeys: ["EXA_API_KEY"],
    category: "search",
  },
  {
    name: "slack",
    description: "Slack workspace access",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"],
    envKeys: ["SLACK_BOT_TOKEN"],
    category: "productivity",
  },
  {
    name: "puppeteer",
    description: "Browser automation via Puppeteer",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    category: "browser",
  },
  {
    name: "fetch",
    description: "HTTP fetch for web content retrieval",
    command: "npx", args: ["-y", "@anthropics/fetch-mcp"],
    category: "search",
  },
];

/** Search the catalog by name or description. */
export function searchCatalog(query: string): ExtensionEntry[] {
  const q = query.toLowerCase();
  return EXTENSION_CATALOG.filter(e =>
    e.name.toLowerCase().includes(q) ||
    e.description.toLowerCase().includes(q) ||
    e.category === q
  );
}

/** Get catalog entries by category. */
export function getCatalogByCategory(): Record<string, ExtensionEntry[]> {
  const groups: Record<string, ExtensionEntry[]> = {};
  for (const e of EXTENSION_CATALOG) {
    if (!groups[e.category]) groups[e.category] = [];
    groups[e.category].push(e);
  }
  return groups;
}

/** Get a specific catalog entry by name. */
export function getCatalogEntry(name: string): ExtensionEntry | undefined {
  return EXTENSION_CATALOG.find(e => e.name === name);
}
