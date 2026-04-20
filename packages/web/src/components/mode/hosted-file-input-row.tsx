/**
 * Hosted-mode file input row.
 *
 * In hosted mode the only way to attach a file is to upload it (the server has
 * no stable local filesystem view, so typing an absolute path is meaningless).
 * When a file has been uploaded we render the basename of the opaque locator
 * so the user gets recognizable feedback without exposing tenant/id prefixes.
 */

import { cn } from "../../lib/utils.js";
import { FileInputRowShell, fieldClass } from "./file-input-row-shell.js";
import type { FileInputRowProps } from "./binding-types.js";

/**
 * Blob locators are opaque strings (base64url-ish `{tenant}/{ns}/{id}/{name}`).
 * For display we strip everything before the final `/` so the user sees just
 * the file name they uploaded.
 */
function basename(locator: string): string {
  const tail = locator.split("/").pop();
  return tail && tail.length > 0 ? tail : locator;
}

export function HostedFileInputRow(props: FileInputRowProps) {
  const { role, required, accept, value, isExtra, previewUrl, onUpload, onRemove } = props;
  const hasFile = value.length > 0;

  return (
    <FileInputRowShell
      role={role}
      required={required}
      accept={accept}
      previewUrl={previewUrl}
      isExtra={isExtra}
      hasFile={hasFile}
      onUpload={onUpload}
      onRemove={onRemove}
      emptySlot={
        <div className={cn(fieldClass, "flex items-center text-[var(--fg-muted)] truncate")}>
          <span className="text-[var(--fg-faint)]">click Upload</span>
        </div>
      }
      filledSlot={
        <div className={cn(fieldClass, "flex items-center text-[var(--fg-muted)] truncate")}>
          <span className="truncate" title={value}>
            {basename(value)}
          </span>
        </div>
      }
    />
  );
}
