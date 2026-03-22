import { screen } from "../layout.js";

/** Wrap content in selection highlight */
export function renderRow(content: string, selected: boolean): string {
  if (selected) return `{bold}{inverse}${content}{/inverse}{/bold}`;
  return content;
}

/** Render a section header */
export function sectionHeader(title: string): string {
  return `{bold}{inverse} ${title} {/inverse}{/bold}`;
}

/** Get the usable width of the detail pane */
export function detailPaneWidth(): number {
  return Math.floor((screen.width as number) * 0.6) - 4;
}
