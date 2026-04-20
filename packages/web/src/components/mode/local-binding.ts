import type { AppModeBinding } from "./binding-types.js";
import { LocalRepoPicker } from "./local-repo-picker.js";
import { LocalFileInputRow } from "./local-file-input-row.js";
import { LocalFileInputAddEditor } from "./local-file-input-add-editor.js";

export const LocalBinding: AppModeBinding = {
  RepoPicker: LocalRepoPicker,
  FileInputRow: LocalFileInputRow,
  FileInputAddEditor: LocalFileInputAddEditor,
};
