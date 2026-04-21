/**
 * NewSecretForm -- "Add a new secret" form.
 *
 * The name field is validated live against `[A-Z0-9_]+`; bad input shows
 * an inline error instead of round-tripping to the server. The value
 * field is a masked `<input type="password">` so casual shoulder-surfing
 * doesn't leak the secret while the user pastes it in.
 *
 * A successful submit clears the form and fires the parent `onCreated`
 * callback. Values are never echoed back to the user.
 */

import { useState } from "react";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";

const NAME_RE = /^[A-Z0-9_]+$/;

export function NewSecretForm({
  onCreated,
  readOnly,
}: {
  onCreated: (input: { name: string; value: string; description?: string }) => Promise<void>;
  readOnly: boolean;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const nameValid = NAME_RE.test(name);
  const canSubmit = !readOnly && !submitting && nameValid && value.length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onCreated({ name, value, description: description || undefined });
      setName("");
      setValue("");
      setDescription("");
    } catch (e: any) {
      setErr(e?.message ?? "Failed to save secret");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 max-w-2xl" data-testid="new-secret-form">
      <div className="grid grid-cols-[200px_1fr] gap-2 items-start">
        <Input
          placeholder="ANTHROPIC_API_KEY"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          aria-invalid={!nameValid && name.length > 0}
          data-testid="new-secret-name"
          disabled={readOnly || submitting}
        />
        <Input
          type="password"
          placeholder="Value (never shown again)"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid="new-secret-value"
          disabled={readOnly || submitting}
        />
      </div>
      {name.length > 0 && !nameValid && (
        <div className="text-[11px] text-[var(--failed)]" data-testid="new-secret-name-error">
          Name must match [A-Z0-9_]+. Uppercase ASCII, digits, underscore.
        </div>
      )}
      <Input
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="max-w-[400px]"
        data-testid="new-secret-description"
        disabled={readOnly || submitting}
      />
      {err && <div className="text-[12px] text-[var(--failed)]">{err}</div>}
      <div>
        <Button type="submit" size="sm" disabled={!canSubmit} data-testid="new-secret-submit">
          {submitting ? "Saving..." : "Save secret"}
        </Button>
      </div>
    </form>
  );
}
