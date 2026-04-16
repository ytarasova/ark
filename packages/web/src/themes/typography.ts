/**
 * Typography system -- 9-step semantic scale from the design spec.
 *
 * Base size: 13px. Tight but legible for dense dashboards.
 * Font stacks: Inter (sans), JetBrains Mono (code), Geist Mono (data/UI mono).
 */

export interface TypeStyle {
  fontSize: string;
  fontWeight: number;
  lineHeight: string;
  letterSpacing: string;
}

export const typography = {
  /** 24px -- page titles (rarely used) */
  display: { fontSize: "24px", fontWeight: 600, lineHeight: "32px", letterSpacing: "-0.015em" },
  /** 18px -- section titles */
  title: { fontSize: "18px", fontWeight: 600, lineHeight: "28px", letterSpacing: "-0.01em" },
  /** 15px -- card titles, dialog titles, panel headers */
  heading: { fontSize: "15px", fontWeight: 600, lineHeight: "22px", letterSpacing: "-0.01em" },
  /** 13px -- default body text, list items, form inputs */
  body: { fontSize: "13px", fontWeight: 400, lineHeight: "20px", letterSpacing: "0" },
  /** 13px medium -- emphasized body, nav labels, section headers */
  bodyMedium: { fontSize: "13px", fontWeight: 500, lineHeight: "20px", letterSpacing: "0" },
  /** 12px -- form labels, tab labels, metadata */
  label: { fontSize: "12px", fontWeight: 500, lineHeight: "16px", letterSpacing: "0" },
  /** 11px -- timestamps, secondary info, table metadata */
  caption: { fontSize: "11px", fontWeight: 400, lineHeight: "16px", letterSpacing: "+0.01em" },
  /** 10px -- badges, status text, keyboard shortcuts */
  micro: { fontSize: "10px", fontWeight: 500, lineHeight: "14px", letterSpacing: "+0.02em" },
  /** 9px -- superscripts, count badges (use sparingly) */
  "2xs": { fontSize: "9px", fontWeight: 500, lineHeight: "12px", letterSpacing: "+0.04em" },
} as const satisfies Record<string, TypeStyle>;

/** Font stack tokens matching the design spec. */
export const fontStacks = {
  sans: '"Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  mono: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
  monoUi: '"Geist Mono", "JetBrains Mono", "SF Mono", ui-monospace, monospace',
} as const;

/** Weight convention from the spec. */
export const fontWeights = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;
