import blessed from "neo-blessed";
import { screen } from "../layout.js";

/** Create a standard centered prompt widget */
export function createPrompt(): any {
  return blessed.prompt({
    parent: screen,
    top: "center",
    left: "center",
    width: 70,
    height: 8,
    border: { type: "line" },
    style: { border: { fg: "cyan" }, bg: "black" },
    tags: true,
  });
}

/** Ask a question via prompt, returns null on cancel */
export function askInput(prompt: any, title: string, question: string, defaultVal: string): Promise<string | null> {
  return new Promise((resolve) => {
    prompt.input(`{bold}${title}{/bold}\n\n${question}`, defaultVal, (err: any, value: any) => {
      if (err || value === undefined || value === null) resolve(null);
      else resolve(String(value).trim());
    });
  });
}
