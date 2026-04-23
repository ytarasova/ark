import { Controller } from "react-hook-form";
import { useFilePreviews } from "../hooks/useFilePreviews.js";
import { useNewSessionForm } from "../hooks/useNewSessionForm.js";
import { useAppMode } from "../providers/AppModeProvider.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { FolderPickerModal } from "./FolderPickerModal.js";
import { InputsSection } from "./session/InputsSection.js";
import { Zap } from "lucide-react";
import { FlowDropdown } from "./session/new/FlowDropdown.js";
import { ComputeDropdown } from "./session/new/ComputeDropdown.js";
import { RichTaskInput } from "./session/new/RichTaskInput.js";
import { detectReferences } from "./session/new/references.js";
import type { AttachmentInfo, DetectedReference } from "./session/new/types.js";
import type { InputsValue } from "./session/InputsSection.js";

// Re-exported so `__tests__/form-schemas.test.ts` and any other external
// consumers keep working via `import { NewSessionSchema } from ".../NewSessionModal.js"`.
export { NewSessionSchema } from "./session/new/schema.js";
export type { NewSessionFormValues } from "./session/new/schema.js";

interface NewSessionModalProps {
  onClose: () => void;
  onSubmit: (form: {
    summary: string;
    repo: string;
    flow: string;
    group_name: string;
    ticket: string;
    compute_name: string;
    agent: string;
    dispatch: boolean;
    attachments: AttachmentInfo[];
    references: DetectedReference[];
    inputs?: InputsValue;
  }) => void;
}

export function NewSessionModal({ onClose, onSubmit }: NewSessionModalProps) {
  const { binding } = useAppMode();
  const { RepoPicker } = binding;
  const { previews, setPreview, clearPreview } = useFilePreviews();

  const form = useNewSessionForm({
    onClose,
    onSubmit: (values) => {
      onSubmit({
        summary: values.summary,
        repo: values.repo,
        flow: values.flow,
        ticket: values.ticket,
        compute_name: values.compute,
        agent: "",
        group_name: "",
        dispatch: true,
        attachments: form.attachments,
        references,
        ...(Object.keys(form.inputs.files).length || Object.keys(form.inputs.params).length
          ? { inputs: { files: { ...form.inputs.files }, params: { ...form.inputs.params } } }
          : {}),
      });
    },
  });

  const references = detectReferences(form.summary);

  return (
    <div
      ref={form.panelRef}
      tabIndex={-1}
      className="flex flex-col h-full overflow-y-auto"
      role="region"
      aria-labelledby="new-session-title"
      data-testid="new-session-modal"
    >
      <div className="p-5 pb-0">
        <h2 id="new-session-title" className="text-base font-semibold text-[var(--fg)] mb-1">
          New Session
        </h2>
        <p className="text-[12px] text-[var(--fg-muted)] mb-5">Configure and launch an agent session</p>
      </div>

      <form onSubmit={form.submit} className="flex flex-col flex-1 min-h-0 px-5" noValidate>
        {/* Flow */}
        <div className="mb-4">
          <label className="block text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            <Zap size={12} className="inline mr-1 opacity-60" />
            Flow
          </label>
          <Controller
            name="flow"
            control={form.control}
            render={({ field }) => <FlowDropdown flows={form.flows} selected={field.value} onSelect={field.onChange} />}
          />
        </div>

        {/* Repository */}
        <div className="mb-4">
          <label className="block text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Repository
          </label>
          <Controller
            name="repo"
            control={form.control}
            render={({ field }) => (
              <RepoPicker
                value={field.value}
                onChange={field.onChange}
                recentRepos={form.recentRepos}
                onBrowse={() => form.setPickerOpen(true)}
              />
            )}
          />
        </div>

        {/* Compute */}
        <div className="mb-4">
          <label className="block text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Compute
          </label>
          <Controller
            name="compute"
            control={form.control}
            render={({ field }) => (
              <ComputeDropdown computes={form.computes} selected={field.value} onSelect={field.onChange} />
            )}
          />
        </div>

        {/* Flow inputs (files + params) -- driven by the selected flow's
            declarative `inputs:` schema plus any ad-hoc extras the user adds. */}
        <InputsSection
          flowName={form.selectedFlow}
          value={form.inputs}
          onChange={form.setInputs}
          onValidityChange={form.setInputsValid}
          previews={previews}
          onPreview={setPreview}
          onClearPreview={clearPreview}
        />

        {/* Ticket -- conditional */}
        {form.showTicket && (
          <div className="mb-4">
            <label className="block text-[11px] text-[var(--fg-muted)] mb-1.5 tracking-[0.04em]">
              Ticket <span className="opacity-50">(optional)</span>
            </label>
            <Controller
              name="ticket"
              control={form.control}
              render={({ field }) => (
                <Input
                  value={field.value}
                  onChange={field.onChange}
                  placeholder="JIRA-123, github.com/org/repo/issues/42"
                />
              )}
            />
          </div>
        )}

        {/* Task description -- rich input with markdown toolbar */}
        <div className="mb-4 mt-1">
          <label className="block text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Task
          </label>
          <Controller
            name="summary"
            control={form.control}
            render={({ field }) => (
              <RichTaskInput
                value={field.value}
                onChange={field.onChange}
                textareaRef={form.textareaRef}
                attachments={form.attachments}
                onAttachmentsChange={form.setAttachments}
                references={references}
                inputs={form.inputs}
                onInputsChange={form.setInputs}
                previews={previews}
                onPreview={setPreview}
                onClearPreview={clearPreview}
              />
            )}
          />
          {form.formState.errors.summary && (
            <p className="mt-1 text-[11px] text-[var(--failed)]">{form.formState.errors.summary.message}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-3 pb-5">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel{" "}
            <kbd className="ml-1 text-[9px] opacity-40 font-mono bg-[var(--bg-hover)] px-1 py-0.5 rounded">Esc</kbd>
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!form.summary.trim() || !form.inputsValid || form.formState.isSubmitting}
            title={!form.inputsValid ? "Fill in all required flow inputs before starting" : undefined}
          >
            Start Session{" "}
            <kbd className="ml-1 text-[9px] opacity-40 font-mono bg-[var(--bg-hover)] px-1 py-0.5 rounded">
              Cmd+Enter
            </kbd>
          </Button>
        </div>
      </form>

      {form.pickerOpen && (
        <FolderPickerModal
          initialPath={form.repo && form.repo !== "." ? form.repo : undefined}
          onSelect={(path) => {
            form.setValue("repo", path, { shouldDirty: true });
            form.setPickerOpen(false);
          }}
          onClose={() => form.setPickerOpen(false)}
        />
      )}
    </div>
  );
}
