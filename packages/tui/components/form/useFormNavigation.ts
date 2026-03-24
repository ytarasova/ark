/**
 * Form field navigation hook.
 *
 * Manages which field is active. Handles:
 * - Tab / Shift+Tab: move between fields
 * - j/k: move between fields (only for text fields, select fields own j/k)
 * - Esc: close form (unless a field is editing)
 */

import { useState, useMemo, useRef } from "react";
import { useInput } from "ink";

interface FieldDef {
  name: string;
  type: "text" | "select" | "path" | "textarea";
  visible?: boolean;
}

interface UseFormNavigationOpts {
  fields: FieldDef[];
  onCancel: () => void;
  onSubmit?: () => void;
}

export function useFormNavigation({ fields: allFields, onCancel, onSubmit }: UseFormNavigationOpts) {
  const fields = useMemo(
    () => allFields.filter(f => f.visible !== false),
    [allFields],
  );

  const [activeIndex, setActiveIndex] = useState(0);
  const active = fields[activeIndex];
  // Track if a field is currently in edit mode (set by field components)
  const editingRef = useRef(false);

  const moveField = (dir: 1 | -1) => {
    editingRef.current = false;
    setActiveIndex(i => {
      const next = i + dir;
      if (next < 0) return 0;
      if (next >= fields.length) return i;
      return next;
    });
  };

  const isActiveTextField = active?.type === "text" || active?.type === "path" || active?.type === "textarea";

  useInput((input, key) => {
    // Esc: if editing, let the field handle it (they set editingRef.current = false)
    if (key.escape) {
      if (editingRef.current) {
        editingRef.current = false;
        return;
      }
      onCancel();
      return;
    }

    // Tab / Shift+Tab: navigate between fields (skip when editing — field owns Tab)
    if (!editingRef.current) {
      if (key.tab && !key.shift) {
        if (activeIndex === fields.length - 1 && onSubmit) {
          onSubmit();
        } else {
          moveField(1);
        }
        return;
      }
      if (key.tab && key.shift) {
        moveField(-1);
        return;
      }
    }

  });

  return {
    active: active?.name ?? "",
    activeType: active?.type ?? "text",
    fields,
    advance: () => moveField(1),
    /** Call when a field enters/exits edit mode */
    setEditing: (v: boolean) => { editingRef.current = v; },
  };
}
