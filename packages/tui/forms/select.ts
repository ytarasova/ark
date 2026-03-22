import blessed from "neo-blessed";
import { screen } from "../layout.js";

export function selectOne(title: string, items: string[], defaultIdx = 0): Promise<string | null> {
  return new Promise((resolve) => {
    const list = blessed.list({
      parent: screen,
      top: "center", left: "center", width: 50, height: Math.min(items.length + 4, 20),
      border: { type: "line" },
      style: {
        border: { fg: "cyan" }, bg: "black",
        selected: { bg: "cyan", fg: "black" },
        item: { fg: "white" },
      },
      label: ` ${title} `,
      keys: true, vi: true, mouse: true,
      scrollable: true,
      items,
    });
    list.select(defaultIdx);
    list.focus();
    list.on("select", (item: any) => {
      const val = item.getText ? item.getText() : String(item.content ?? items[list.selected ?? 0]);
      list.destroy();
      screen.render();
      resolve(val);
    });
    list.key(["escape"], () => { list.destroy(); screen.render(); resolve(null); });
    screen.render();
  });
}

export async function selectOrType(title: string, items: string[], defaultIdx = 0, promptBox?: any): Promise<string | null> {
  const allItems = [...items, "── Other (type manually) ──"];
  const choice = await selectOne(title, allItems, defaultIdx);
  if (choice === null) return null;
  if (choice.includes("Other (type manually)")) {
    if (!promptBox) return null;
    return new Promise((resolve) => {
      promptBox.input(`{bold}${title}{/bold}\n\nEnter value:`, "", (err: any, value: any) => {
        if (err || value === undefined || value === null) resolve(null);
        else resolve(String(value).trim());
      });
    });
  }
  return choice;
}
