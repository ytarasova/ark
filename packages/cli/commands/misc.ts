/**
 * Back-compat re-export -- the previous 500+ LOC grab-bag now lives under
 * `misc/` with one file per verb. Existing imports like
 * `./commands/misc.js` continue to work.
 */
export { registerMiscCommands, WebCommand } from "./misc/index.js";
