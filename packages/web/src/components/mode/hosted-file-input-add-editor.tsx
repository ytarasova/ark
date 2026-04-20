/**
 * Hosted-mode "Add file" inline editor.
 *
 * Shows one input (role) and an Upload button. No typed-path field -- hosted
 * mode only accepts uploads against the BlobStore.
 */

import { Button } from "../ui/button.js";
import { Paperclip, Upload } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { fieldClass } from "./file-input-row-shell.js";
import type { FileInputAddEditorProps } from "./binding-types.js";

export function HostedFileInputAddEditor(props: FileInputAddEditorProps) {
  const { pendingRole, onPendingRoleChange, onCommitRole, onCommitUpload, onCancel } = props;

  if (pendingRole === null) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => onPendingRoleChange("")}>
        <Paperclip size={12} className="mr-1" /> Add file
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        type="text"
        value={pendingRole}
        onChange={(e) => onPendingRoleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommitRole();
          }
          if (e.key === "Escape") onCancel();
        }}
        placeholder="File role (e.g. recipe, prd)"
        className={cn(fieldClass, "w-28 flex-none")}
      />
      <label
        className={cn(
          "shrink-0 inline-flex items-center gap-1.5 justify-center h-9 px-3 rounded-md cursor-pointer",
          "bg-[var(--primary)] text-[var(--primary-fg,white)] text-[12px] font-medium",
          "hover:opacity-90 transition-opacity",
        )}
        title="Upload file (auto-adds entry)"
      >
        <Upload size={12} />
        Upload
        <input
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onCommitUpload(f);
          }}
        />
      </label>
      <Button type="button" size="sm" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
