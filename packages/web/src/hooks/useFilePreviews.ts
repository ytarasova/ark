import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Role -> blob URL map for local image previews.
 *
 * Blob URLs are created via `URL.createObjectURL` and scoped to the page's
 * lifetime. This hook owns their lifecycle -- revoke on unmount, revoke when
 * a role is cleared, revoke when replaced.
 *
 * Works for any image File: paste, drag-drop, file-picker. Non-image Files
 * are ignored (no preview emitted).
 */
export function useFilePreviews() {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const urlsRef = useRef<Record<string, string>>({});

  const setPreview = useCallback((role: string, blob: Blob | File) => {
    if (!blob.type?.startsWith("image/")) return;
    const url = URL.createObjectURL(blob);
    // Revoke any previous URL for this role before overwriting.
    const prev = urlsRef.current[role];
    if (prev) URL.revokeObjectURL(prev);
    urlsRef.current[role] = url;
    setPreviews((m) => ({ ...m, [role]: url }));
  }, []);

  const clearPreview = useCallback((role: string) => {
    const prev = urlsRef.current[role];
    if (prev) URL.revokeObjectURL(prev);
    delete urlsRef.current[role];
    setPreviews((m) => {
      const { [role]: _omit, ...rest } = m;
      return rest;
    });
  }, []);

  // Revoke everything on unmount.
  useEffect(() => {
    return () => {
      for (const url of Object.values(urlsRef.current)) URL.revokeObjectURL(url);
      urlsRef.current = {};
    };
  }, []);

  return { previews, setPreview, clearPreview };
}
