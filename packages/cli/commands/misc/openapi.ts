import type { Command } from "commander";
import * as core from "../../../core/index.js";

/** `ark openapi` -- emit the server's OpenAPI spec to stdout. */
export function registerOpenApiCommand(program: Command): void {
  program
    .command("openapi")
    .description("Generate OpenAPI spec")
    .action(() => {
      console.log(JSON.stringify(core.generateOpenApiSpec(), null, 2));
    });
}
