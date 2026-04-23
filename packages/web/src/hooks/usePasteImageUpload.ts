import { useCallback } from "react";
import { useApi } from "./useApi.js";
import type { InputsValue } from "../components/session/InputsSection.js";

export interface UsePasteImageUploadOptions {
  /** Current inputs.files map (needed to pick a free role slot). */
  inputs: InputsValue;
  /** Write-back for the updated inputs after upload. */
  onInputsChange: (next: InputsValue) => void;
  /**
   * Called after a successful upload with the auto-derived role and the
   * blob locator. Typical use: insert `{{files.<role>}}` at the cursor.
   */
  onUploaded?: (role: string, locator: string) => void;
  /**
   * Called with the blob BEFORE upload completes so the UI can stash a
   * local preview URL keyed by the derived role. Decouples the previews
   * hook from this one.
   */
  onPreview?: (role: string, blob: Blob) => void;
  /**
   * Prefix for auto-derived roles. Produces `image-1`, `image-2`, ... by default.
   * Use `screenshot` etc. to tag where the paste happened.
   */
  rolePrefix?: string;
  /** Hard cap on paste size. Default 5 MB. Larger images require Add file. */
  maxBytes?: number;
  /** Called with an error message when upload is rejected or fails. */
  onError?: (message: string) => void;
}

/**
 * Clipboard-image paste handler for any `<textarea>` or `contentEditable`.
 *
 * Wires `onPaste`: if the clipboard holds an image, encodes it to base64,
 * uploads via `input/upload`, registers it under `inputs.files` with an
 * auto-derived role (`image-N`), and fires `onUploaded(role, locator)` so
 * the caller can insert a reference token.
 *
 * Returns a memoised `onPaste` handler to spread onto the target element.
 */
export function usePasteImageUpload(opts: UsePasteImageUploadOptions) {
  const api = useApi();
  const {
    inputs,
    onInputsChange,
    onUploaded,
    onPreview,
    rolePrefix = "image",
    maxBytes = 5 * 1024 * 1024,
    onError,
  } = opts;

  const upload = useCallback(
    async (blob: File, mime: string) => {
      const pattern = new RegExp(`^${rolePrefix}-(\\d+)$`);
      const existing = Object.keys(inputs.files ?? {})
        .map((k) => k.match(pattern)?.[1])
        .filter((n): n is string => !!n)
        .map((n) => parseInt(n, 10));
      const next = existing.length ? Math.max(...existing) + 1 : 1;
      const role = `${rolePrefix}-${next}`;
      const ext = mime.split("/")[1] || "png";
      const name = `clipboard-${Date.now()}.${ext}`;

      // Emit the local preview URL immediately so the UI shows a thumbnail
      // while the upload is still in flight.
      onPreview?.(role, blob);

      // Chunked base64 to avoid call-stack issues on large images.
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
      }
      const content = btoa(bin);
      const { locator } = await api.uploadInput({ name, role, content, contentEncoding: "base64" });
      onInputsChange({ ...inputs, files: { ...inputs.files, [role]: locator } });
      onUploaded?.(role, locator);
    },
    [api, inputs, onInputsChange, onUploaded, onPreview, rolePrefix],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (!item.type.startsWith("image/")) continue;
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;
        if (blob.size > maxBytes) {
          onError?.(`Pasted image exceeds ${Math.round(maxBytes / 1024 / 1024)} MB -- use Add file for larger assets.`);
          return;
        }
        upload(blob, item.type).catch((err) => {
          onError?.(`Failed to upload pasted image: ${err?.message ?? err}`);
        });
        break; // only handle the first image item on the event
      }
    },
    [upload, maxBytes, onError],
  );

  return { onPaste };
}
