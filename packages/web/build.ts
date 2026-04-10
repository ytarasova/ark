import { join } from "path";
import { execFileSync } from "child_process";

const webDir = join(import.meta.dir, ".");
execFileSync("npx", ["vite", "build"], {
  cwd: webDir,
  stdio: "inherit",
  timeout: 60_000,
});

// eslint-disable-next-line no-console
console.log("Build complete: packages/web/dist/");
