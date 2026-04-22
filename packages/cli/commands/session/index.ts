import { type Command } from "commander";
import { registerStartCommands } from "./start.js";
import { registerLifecycleCommands } from "./lifecycle.js";
import { registerForkCloneCommands } from "./fork-clone.js";
import { registerExportImportCommands } from "./export-import.js";
import { registerViewCommands } from "./view.js";

export function registerSessionCommands(program: Command) {
  const session = program.command("session").description("Manage SDLC flow sessions");

  registerStartCommands(session);
  registerViewCommands(session);
  registerLifecycleCommands(session);
  registerForkCloneCommands(session);
  registerExportImportCommands(session);
}
