/** SHIM -- moved to server/routes/channels.ts. Will be deleted in Task 10. */
export {
  channelWebSocketHandler,
  handleChannelRoutes,
  matchWsChannelPath,
  publishOnChannel,
  SUBSCRIBED_ACK,
  _resetForTests,
} from "../server/routes/channels.js";
export type { ChannelWsData } from "../server/routes/channels.js";
