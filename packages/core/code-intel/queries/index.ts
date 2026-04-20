/**
 * Query registry helpers -- builds a populated registry for Wave 1.
 *
 * Each new query adds an entry here. The registry feeds CLI / MCP / RPC
 * dispatch in later waves.
 */

import { QueryRegistry } from "../interfaces/query.js";
import { searchQuery } from "./search.js";
import { getContextQuery } from "./get-context.js";

export function buildDefaultRegistry(): QueryRegistry {
  const reg = new QueryRegistry();
  reg.register(searchQuery);
  reg.register(getContextQuery);
  return reg;
}

export { searchQuery, getContextQuery };
