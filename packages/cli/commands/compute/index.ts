import type { Command } from "commander";
import { registerCreateCommand } from "./create.js";
import { registerLifecycleCommands } from "./lifecycle.js";
import { registerViewCommands } from "./view.js";
import { registerPoolCommands } from "./pool.js";
import { registerTemplateCommands } from "./template.js";

export function registerComputeCommands(program: Command) {
  const computeCmd = program.command("compute").description("Manage compute resources");

  registerCreateCommand(computeCmd);
  registerLifecycleCommands(computeCmd);
  registerViewCommands(computeCmd);
  registerPoolCommands(computeCmd);
  registerTemplateCommands(computeCmd);
}
