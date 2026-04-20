/**
 * Contract between `AppModeProvider` and the mode-specific component variants.
 *
 * Each binding exposes one component per user-facing affordance that differs
 * between modes. Consumers pull the component out of the binding and render
 * it as if it were a normal React component -- no prop-drilling of a mode
 * flag, no `if (hosted)` in the body.
 */

import type { ComponentType } from "react";

export type AppModeKind = "local" | "hosted";

// ── Repo picker ────────────────────────────────────────────────────────────

export interface RecentRepo {
  path: string;
  basename: string;
  lastUsed: string;
}

export interface RepoPickerProps {
  value: string;
  onChange: (v: string) => void;
  recentRepos: RecentRepo[];
  /** Local-only: asked by `LocalRepoPicker` to open the folder picker modal.
   * Hosted mode ignores this -- there is no client filesystem to browse. */
  onBrowse: () => void;
}

// ── File input row (per-role) ──────────────────────────────────────────────
//
// One row per file input on the NewSession form. The row displays the current
// file locator (or an empty input for the user to type / upload into), plus
// a remove button when the row is user-added (i.e. not declared by the flow).
//
// Local mode: when no file is yet selected, the user may type an absolute path.
// Hosted mode: typing a path is disabled (server has no stable filesystem
// view); basename-only display.

export interface FileInputRowProps {
  role: string;
  required: boolean;
  /** Optional description -- used as placeholder + tooltip. */
  description?: string;
  /** Optional accept pattern for the <input type="file"> picker. */
  accept?: string;
  /** Current locator or typed path; empty string means "no value". */
  value: string;
  /** True when the row was added at runtime (vs declared by the flow schema). */
  isExtra: boolean;
  /** Optional preview URL (blob: URL) for image inputs. */
  previewUrl?: string;
  onTypeValue: (path: string) => void;
  onUpload: (file: File) => Promise<void> | void;
  onRemove: () => void;
}

// ── File input add editor (the "Add file" button / inline editor) ──────────
//
// The inline editor the user gets after clicking "Add file". Local mode offers
// a second input for a typed path plus an upload button; hosted mode offers
// only the upload button.

export interface FileInputAddEditorProps {
  /** `null` -> render the "Add file" trigger. Non-null -> render the inline editor. */
  pendingRole: string | null;
  onPendingRoleChange: (role: string | null) => void;
  pendingPath: string;
  onPendingPathChange: (path: string) => void;
  onCommitRole: () => void;
  onCommitUpload: (file: File) => Promise<void> | void;
  onCancel: () => void;
}

// ── Binding ────────────────────────────────────────────────────────────────

export interface AppModeBinding {
  RepoPicker: ComponentType<RepoPickerProps>;
  FileInputRow: ComponentType<FileInputRowProps>;
  FileInputAddEditor: ComponentType<FileInputAddEditorProps>;
}
