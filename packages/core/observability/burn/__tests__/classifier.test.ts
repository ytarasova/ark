import { describe, it, expect } from "bun:test";
import { classifyTurn, countRetries } from "../classifier.js";
import type { ParsedTurn, ParsedApiCall } from "../types.js";

/** Helper to construct a minimal ParsedTurn for testing. */
function makeTurn(
  userMessage: string,
  tools: string[],
  opts?: {
    hasPlanMode?: boolean;
    hasAgentSpawn?: boolean;
    multiCall?: ParsedApiCall[];
  }
): ParsedTurn {
  if (opts?.multiCall) {
    return {
      userMessage,
      assistantCalls: opts.multiCall,
      timestamp: new Date().toISOString(),
      sessionId: "test-session",
    };
  }
  return {
    userMessage,
    assistantCalls: [
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
        },
        costUSD: 0.01,
        tools,
        mcpTools: [],
        hasAgentSpawn: opts?.hasAgentSpawn ?? false,
        hasPlanMode: opts?.hasPlanMode ?? false,
        speed: "standard" as const,
        timestamp: new Date().toISOString(),
        bashCommands: [],
        deduplicationKey: `key-${Math.random()}`,
      },
    ],
    timestamp: new Date().toISOString(),
    sessionId: "test-session",
  };
}

function makeCall(tools: string[], overrides?: Partial<ParsedApiCall>): ParsedApiCall {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      inputTokens: 500,
      outputTokens: 250,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: 0.005,
    tools,
    mcpTools: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: "standard" as const,
    timestamp: new Date().toISOString(),
    bashCommands: [],
    deduplicationKey: `key-${Math.random()}`,
    ...overrides,
  };
}

describe("classifyTurn", () => {
  // -- Category: coding --
  it("classifies Edit tool usage as coding", () => {
    const turn = makeTurn("update the handler", ["Edit"]);
    const result = classifyTurn(turn);
    expect(result.category).toBe("coding");
  });

  // -- Category: debugging --
  it("classifies Edit + debug keyword as debugging", () => {
    const turn = makeTurn("fix the bug in auth", ["Edit", "Bash"]);
    const result = classifyTurn(turn);
    expect(result.category).toBe("debugging");
  });

  // -- Category: feature --
  it("classifies Edit + feature keyword as feature", () => {
    const turn = makeTurn("add a new login page", ["Edit", "Write"]);
    const result = classifyTurn(turn);
    expect(result.category).toBe("feature");
  });

  // -- Category: refactoring --
  it("classifies Edit + refactor keyword as refactoring", () => {
    const turn = makeTurn("refactor the database module", ["Edit"]);
    const result = classifyTurn(turn);
    expect(result.category).toBe("refactoring");
  });

  // -- Category: testing --
  it("classifies Bash + pytest keyword as testing", () => {
    const turn = makeTurn("run pytest tests/unit", ["Bash"]);
    const result = classifyTurn(turn);
    expect(result.category).toBe("testing");
  });

  // -- Category: exploration --
  it("classifies Read + Grep as exploration", () => {
    const turn = makeTurn("look at the config files", ["Read", "Grep"]);
    const result = classifyTurn(turn);
    expect(result.category).toBe("exploration");
  });

  // -- Category: planning --
  it("classifies plan mode as planning", () => {
    const turn = makeTurn("plan the architecture", ["TaskCreate"], {
      hasPlanMode: true,
    });
    const result = classifyTurn(turn);
    expect(result.category).toBe("planning");
  });

  // -- Category: delegation --
  it("classifies agent spawn as delegation", () => {
    const turn = makeTurn("delegate to sub-agent", ["Read"], {
      hasAgentSpawn: true,
    });
    const result = classifyTurn(turn);
    expect(result.category).toBe("delegation");
  });

  // -- Category: git --
  it("classifies Bash + git push as git", () => {
    const turn = makeTurn("git push origin main", ["Bash"]);
    const result = classifyTurn(turn);
    expect(result.category).toBe("git");
  });

  // -- Category: build/deploy --
  it("classifies Bash + npm run build as build/deploy", () => {
    const turn = makeTurn("npm run build the project", ["Bash"]);
    const result = classifyTurn(turn);
    expect(result.category).toBe("build/deploy");
  });

  // -- Category: brainstorming --
  it("classifies brainstorm keyword with no tools as brainstorming", () => {
    const turn = makeTurn("brainstorm ideas for the API design", []);
    const result = classifyTurn(turn);
    expect(result.category).toBe("brainstorming");
  });

  // -- Category: conversation --
  it("classifies no tools + generic message as conversation", () => {
    const turn = makeTurn("thanks, that looks good", []);
    const result = classifyTurn(turn);
    expect(result.category).toBe("conversation");
  });

  // -- Category: general --
  it("classifies Skill tool as general", () => {
    const turn = makeTurn("use the skill", ["Skill"]);
    const result = classifyTurn(turn);
    expect(result.category).toBe("general");
  });

  // -- hasEdits --
  it("sets hasEdits true when Edit tools are present", () => {
    const turn = makeTurn("change the code", ["Edit", "Bash"]);
    const result = classifyTurn(turn);
    expect(result.hasEdits).toBe(true);
  });

  it("sets hasEdits false when no Edit tools are present", () => {
    const turn = makeTurn("read the file", ["Read", "Grep"]);
    const result = classifyTurn(turn);
    expect(result.hasEdits).toBe(false);
  });
});

describe("countRetries", () => {
  it("returns 0 for a single edit call (one-shot)", () => {
    const turn = makeTurn("update handler", ["Edit"]);
    expect(countRetries(turn)).toBe(0);
  });

  it("detects retry in Edit -> Bash -> Edit sequence", () => {
    const turn = makeTurn("fix the test", [], {
      multiCall: [
        makeCall(["Edit"]),
        makeCall(["Bash"]),
        makeCall(["Edit"]),
      ],
    });
    expect(countRetries(turn)).toBeGreaterThan(0);
  });

  it("returns 0 for Edit -> Bash without re-edit", () => {
    const turn = makeTurn("write and run", [], {
      multiCall: [
        makeCall(["Edit"]),
        makeCall(["Bash"]),
      ],
    });
    expect(countRetries(turn)).toBe(0);
  });
});

describe("isOneShot", () => {
  it("is true for single edit with no retries", () => {
    const turn = makeTurn("update the handler", ["Edit"]);
    const result = classifyTurn(turn);
    expect(result.isOneShot).toBe(true);
    expect(result.retries).toBe(0);
  });

  it("is false for Edit -> Bash -> Edit retry sequence", () => {
    const turn = makeTurn("fix the bug", [], {
      multiCall: [
        makeCall(["Edit"]),
        makeCall(["Bash"]),
        makeCall(["Edit"]),
      ],
    });
    const result = classifyTurn(turn);
    expect(result.isOneShot).toBe(false);
    expect(result.retries).toBeGreaterThan(0);
  });

  it("is false when there are no edits", () => {
    const turn = makeTurn("read the files", ["Read", "Grep"]);
    const result = classifyTurn(turn);
    expect(result.isOneShot).toBe(false);
  });
});
