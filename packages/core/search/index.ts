export {
  searchSessions,
  searchTranscripts,
  indexTranscripts,
  indexSession,
  getIndexStats,
  getSessionConversation,
  searchSessionConversation,
  ftsTableExists,
  type SearchResult,
  type SearchOpts,
} from "./search.js";
export { searchAllConversations, type GlobalSearchResult } from "./global-search.js";
