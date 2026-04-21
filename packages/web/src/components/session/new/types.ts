/**
 * Shared types + UI constants for the NewSessionModal subcomponents.
 */
import { cn } from "../../../lib/utils.js";

export interface FlowInfo {
  name: string;
  description?: string;
  stages?: string[];
}

export interface ComputeInfo {
  name: string;
  type?: string;
  provider?: string;
  status?: string;
  is_template?: boolean;
}

export interface RecentRepo {
  path: string;
  basename: string;
  lastUsed: string;
}

export interface DetectedReference {
  type: "jira" | "github" | "url";
  value: string;
  label: string;
}

export interface AttachmentInfo {
  name: string;
  size: number;
  type: string;
  content?: string;
}

export const triggerClass = cn(
  "flex items-center justify-between w-full h-9 px-3 rounded-md",
  "border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] text-[13px]",
  "hover:border-[var(--fg-muted)] transition-colors duration-150 cursor-pointer",
  "outline-none focus:ring-2 focus:ring-[var(--primary)]",
);

export const popoverContentClass = cn(
  "w-[var(--radix-popover-trigger-width)] max-h-[300px] overflow-y-auto",
  "rounded-md border border-[var(--border)] bg-[var(--bg-card,var(--bg))] shadow-lg",
  "p-1 z-50",
);
