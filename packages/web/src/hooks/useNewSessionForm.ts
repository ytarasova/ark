import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";
import { relTime, formatRepoName } from "../util.js";
import { NewSessionSchema, type NewSessionFormValues } from "../components/session/new/schema.js";
import type { FlowInfo, ComputeInfo, RecentRepo, AttachmentInfo } from "../components/session/new/types.js";
import type { InputsValue } from "../components/session/InputsSection.js";

/**
 * Owns all form state for the `NewSessionModal`:
 *
 * - react-hook-form instance with the Zod-backed schema
 * - `attachments` / `inputs` / `inputsValid` side state (these live outside
 *   RHF because they have client-only semantics: file reads, flow-driven
 *   shape, and per-role previews)
 * - TanStack queries for flows / computes / recent repos (memoised so
 *   downstream effects don't see a fresh `[]` every render)
 * - auto-selection of the first flow / compute once the lists load
 * - "show Ticket?" derivation from the selected flow
 *
 * The panel container is also tracked via `panelRef` + `triggerElement`,
 * which together with the keyboard handler below implement the focus trap
 * + Cmd+Enter / Escape shortcuts described in
 * `.workflow/audit/8-a11y.md` findings A3 + A4.
 */
export function useNewSessionForm({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (values: NewSessionFormValues) => void;
}) {
  const api = useApi();
  const { control, handleSubmit, watch, setValue, formState } = useForm<NewSessionFormValues>({
    resolver: zodResolver(NewSessionSchema),
    defaultValues: { summary: "", repo: ".", ticket: "", flow: "", compute: "" },
  });

  const summary = watch("summary");
  const repo = watch("repo");
  const selectedFlow = watch("flow");
  const selectedCompute = watch("compute");

  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [inputs, setInputs] = useState<InputsValue>({ files: {}, params: {} });
  const [inputsValid, setInputsValid] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Save the trigger element so we can restore focus on close.
  // See `.workflow/audit/8-a11y.md` finding A4.
  // Capture BEFORE the component's autoFocus textarea steals focus -- lazy
  // useState init runs during first render (pre-commit), whereas useEffect
  // runs after commit (post-autoFocus), by which time activeElement is the
  // textarea, not the trigger button.
  const [triggerElement] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null,
  );
  useEffect(() => {
    return () => {
      try {
        triggerElement?.focus?.();
      } catch {
        /* ignore */
      }
    };
  }, [triggerElement]);

  const flowsQuery = useQuery<FlowInfo[]>({ queryKey: ["flows"], queryFn: api.getFlows });
  const computesQuery = useQuery<ComputeInfo[]>({ queryKey: ["compute"], queryFn: api.getCompute });
  const recentReposQuery = useQuery<RecentRepo[]>({
    queryKey: ["sessions", "recent-repos"],
    queryFn: async () => {
      const sessions: any[] = await api.getSessions();
      const seen = new Map<string, string>();
      for (const s of sessions) {
        if (s.repo && s.repo !== "." && !seen.has(s.repo)) {
          seen.set(s.repo, s.updated_at || s.created_at || "");
        }
      }
      const repos: RecentRepo[] = [];
      for (const [path, lastUsed] of seen) {
        repos.push({ path, basename: formatRepoName(path), lastUsed: relTime(lastUsed) });
      }
      return repos.slice(0, 15);
    },
  });

  const flows = useMemo<FlowInfo[]>(() => flowsQuery.data ?? [], [flowsQuery.data]);
  const computes = useMemo<ComputeInfo[]>(() => computesQuery.data ?? [], [computesQuery.data]);
  const recentRepos = useMemo<RecentRepo[]>(() => recentReposQuery.data ?? [], [recentReposQuery.data]);

  // Auto-select the first flow / compute once the lists load, unless the
  // user has already chosen one.
  useEffect(() => {
    if (!selectedFlow && flows.length > 0) setValue("flow", flows[0].name);
  }, [flows, selectedFlow, setValue]);
  useEffect(() => {
    if (!selectedCompute && computes.length > 0) setValue("compute", computes[0].name);
  }, [computes, selectedCompute, setValue]);

  const currentFlow = flows.find((f) => f.name === selectedFlow);
  const showTicket =
    !!currentFlow &&
    ((currentFlow.description || "").toLowerCase().includes("ticket") ||
      (currentFlow.stages || []).some((s) =>
        (typeof s === "string" ? s : (s.name ?? "")).toLowerCase().includes("ticket"),
      ));

  const submit = handleSubmit(onSubmit);

  // Keyboard shortcuts: Cmd+Enter to submit, Escape to cancel, focus trap.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && summary.trim()) {
        e.preventDefault();
        submit();
        return;
      }
      // Focus trap: keep Tab cycling inside the panel while it's open.
      // The panel renders inline (not as a true modal overlay), so without
      // this trap Tab escapes to the surrounding page chrome. See
      // `.workflow/audit/8-a11y.md` finding A3.
      //
      // Edge case: Radix Popover content is rendered through a portal
      // (outside panelRef). When a popover is open we leave focus alone.
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const active = document.activeElement as HTMLElement | null;
        const inPortal = !!active?.closest("[data-radix-popper-content-wrapper], [role=dialog]");
        if (inPortal) return;
        const focusables = Array.from(
          panel.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => {
          if (el.hasAttribute("disabled")) return false;
          if (el.getAttribute("aria-hidden") === "true") return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          return true;
        });
        if (focusables.length === 0) {
          e.preventDefault();
          panel.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const activeInside = active && panel.contains(active);
        if (!activeInside) {
          e.preventDefault();
          first.focus();
          return;
        }
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, onClose]);

  return {
    control,
    submit,
    formState,
    setValue,
    // watched
    summary,
    repo,
    selectedFlow,
    // state
    attachments,
    setAttachments,
    inputs,
    setInputs,
    inputsValid,
    setInputsValid,
    pickerOpen,
    setPickerOpen,
    // queries
    flows,
    computes,
    recentRepos,
    showTicket,
    // refs
    textareaRef,
    panelRef,
  };
}
