/**
 * Per-agent message filtering -- control what context each agent sees.
 * Reduces token usage by limiting history to relevant messages.
 */

export interface MessageFilter {
  maxMessages?: number;        // max N most recent messages
  fromAgents?: string[];       // only include messages from these agents
  excludeAgents?: string[];    // exclude messages from these agents
  includeSystemPrompt?: boolean;
  maxTokenEstimate?: number;   // rough token budget for history
}

export interface FilteredMessage {
  role: string;
  content: string;
  agent?: string;
  timestamp?: string;
}

/** Apply a message filter to a conversation history. */
export function filterMessages(messages: FilteredMessage[], filter: MessageFilter): FilteredMessage[] {
  let result = [...messages];

  // Filter by source agent
  if (filter.fromAgents?.length) {
    const allowed = new Set(filter.fromAgents);
    result = result.filter(m => !m.agent || allowed.has(m.agent));
  }
  if (filter.excludeAgents?.length) {
    const excluded = new Set(filter.excludeAgents);
    result = result.filter(m => !m.agent || !excluded.has(m.agent));
  }

  // Limit to most recent N messages
  if (filter.maxMessages) {
    result = result.slice(-filter.maxMessages);
  }

  // Rough token budget
  if (filter.maxTokenEstimate) {
    let totalTokens = 0;
    const kept: FilteredMessage[] = [];
    for (let i = result.length - 1; i >= 0; i--) {
      const tokens = Math.ceil(result[i].content.length / 4);  // rough estimate
      if (totalTokens + tokens > filter.maxTokenEstimate) break;
      totalTokens += tokens;
      kept.unshift(result[i]);
    }
    result = kept;
  }

  return result;
}

/** Create a filter from agent YAML config. */
export function parseMessageFilter(config: any): MessageFilter | null {
  if (!config?.message_filter) return null;
  const f = config.message_filter;
  return {
    maxMessages: f.max_messages,
    fromAgents: f.from_agents,
    excludeAgents: f.exclude_agents,
    maxTokenEstimate: f.max_tokens,
    includeSystemPrompt: f.include_system_prompt ?? true,
  };
}
