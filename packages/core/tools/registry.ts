import type { ToolDriver } from "../tool-driver.js";
import { ClaudeDriver } from "./claude-driver.js";
import { GeminiDriver } from "./gemini-driver.js";

const drivers = new Map<string, ToolDriver>();

// Register built-in drivers
drivers.set("claude", new ClaudeDriver());
drivers.set("gemini", new GeminiDriver());

/** Get a tool driver by name. Defaults to "claude". */
export function getToolDriver(name?: string | null): ToolDriver {
  return drivers.get(name ?? "claude") ?? drivers.get("claude")!;
}

/** List available tool driver names. */
export function listToolDrivers(): string[] {
  return Array.from(drivers.keys());
}

/** Register a custom tool driver. */
export function registerToolDriver(driver: ToolDriver): void {
  drivers.set(driver.name, driver);
}
