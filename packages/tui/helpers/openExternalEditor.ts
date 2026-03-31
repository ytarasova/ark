import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

/**
 * Opens an external editor ($EDITOR or vi) with the given content,
 * waits for it to close, and returns the edited content.
 *
 * Note: This is synchronous and blocks the process. It should only be
 * called in contexts where the editor takes over the terminal (e.g.,
 * form fields that explicitly pause the TUI). The TUI form sets
 * `editing` state before/after to prevent other input handling.
 */
export function openExternalEditor(content: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "ark-agent-"));
  const tmpFile = join(tmpDir, "system-prompt.md");
  writeFileSync(tmpFile, content);
  const editor = process.env.EDITOR || "vi";
  execFileSync(editor, [tmpFile], { stdio: "inherit" });
  return readFileSync(tmpFile, "utf-8");
}
