import blessed from "neo-blessed";
import { screen } from "../layout.js";

export interface SelectItem {
  label: string;
  value: string;
}

type SelectInput = string | SelectItem;

function toItems(input: SelectInput[]): SelectItem[] {
  return input.map(i => typeof i === "string" ? { label: i, value: i } : i);
}

export function selectOne(title: string, items: SelectInput[], defaultIdx = 0): Promise<string | null> {
  const resolved = toItems(items);
  return new Promise((resolve) => {
    const list = blessed.list({
      parent: screen,
      top: "center", left: "center", width: 50, height: Math.min(resolved.length + 4, 20),
      border: { type: "line" },
      style: {
        border: { fg: "cyan" }, bg: "black",
        selected: { bg: "cyan", fg: "black" },
        item: { fg: "white" },
      },
      label: ` ${title} `,
      keys: true, vi: true, mouse: true,
      scrollable: true,
      items: resolved.map(i => i.label),
    });
    list.select(defaultIdx);
    list.focus();
    list.on("select", (_item: any, idx: number) => {
      list.destroy();
      screen.render();
      resolve(resolved[idx]?.value ?? null);
    });
    list.key(["escape"], () => { list.destroy(); screen.render(); resolve(null); });
    screen.render();
  });
}

export async function selectOrType(title: string, items: SelectInput[], defaultIdx = 0, promptBox?: any): Promise<string | null> {
  const allItems: SelectInput[] = [...items, { label: "-- Other (type manually) --", value: "__other__" }];
  const choice = await selectOne(title, allItems, defaultIdx);
  if (choice === null) return null;
  if (choice === "__other__") {
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
