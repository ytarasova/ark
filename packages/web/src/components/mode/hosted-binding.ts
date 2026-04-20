import type { AppModeBinding } from "./binding-types.js";
import { HostedRepoPicker } from "./hosted-repo-picker.js";
import { HostedFileInputRow } from "./hosted-file-input-row.js";
import { HostedFileInputAddEditor } from "./hosted-file-input-add-editor.js";

export const HostedBinding: AppModeBinding = {
  RepoPicker: HostedRepoPicker,
  FileInputRow: HostedFileInputRow,
  FileInputAddEditor: HostedFileInputAddEditor,
};
