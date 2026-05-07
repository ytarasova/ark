import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../hooks/useApi.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { cn } from "../../lib/utils.js";
import { RichSelect } from "../ui/RichSelect.js";
import { effectiveLifecycle, type ComputeKindName, type IsolationKindName } from "../../../../types/compute.js";

// Surface both compute + isolation axes. Static defaults render while the
// server reply is in flight; the queries below overwrite with the live list.
const DEFAULT_COMPUTE_KINDS = ["local", "firecracker", "ec2", "k8s", "k8s-kata"] as const;
const DEFAULT_ISOLATION_KINDS = ["direct", "docker", "compose", "devcontainer"] as const;

// Zod schema -- single source of truth for form validation. The submit
// payload type is `NewComputeFormValues`, derived from the schema so caller
// never has to double-declare the shape.
export const NewComputeFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  compute: z.string().min(1),
  isolation: z.string().min(1),
  size: z.string().optional().default(""),
  region: z.string().optional().default(""),
  aws_profile: z.string().optional().default(""),
  vpc_id: z.string().optional().default(""),
  subnet_id: z.string().optional().default(""),
  selectedTemplate: z.string().optional().default(""),
});

type NewComputeFormValues = z.infer<typeof NewComputeFormSchema>;

export interface NewComputePayload extends NewComputeFormValues {
  templateConfig: Record<string, unknown>;
  is_template: boolean;
}

export function NewComputeForm({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (form: NewComputePayload) => void;
}) {
  const api = useApi();
  const templatesQuery = useQuery({
    queryKey: ["compute", "templates"],
    queryFn: () => api.listComputeTemplates(),
  });
  const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data]);

  const computeKindsQuery = useQuery({
    queryKey: ["compute", "kinds"],
    queryFn: () =>
      (api as any)
        .listComputeKinds?.()
        .then((d: any) =>
          Array.isArray(d?.kinds) && d.kinds.length ? (d.kinds as string[]) : [...DEFAULT_COMPUTE_KINDS],
        )
        .catch(() => [...DEFAULT_COMPUTE_KINDS]),
  });
  const computeKinds = computeKindsQuery.data ?? [...DEFAULT_COMPUTE_KINDS];

  const isolationKindsQuery = useQuery({
    queryKey: ["isolation", "kinds"],
    queryFn: () =>
      (api as any)
        .listRuntimeKinds?.()
        .then((d: any) =>
          Array.isArray(d?.kinds) && d.kinds.length ? (d.kinds as string[]) : [...DEFAULT_ISOLATION_KINDS],
        )
        .catch(() => [...DEFAULT_ISOLATION_KINDS]),
  });
  const isolationKinds = isolationKindsQuery.data ?? [...DEFAULT_ISOLATION_KINDS];

  const { register, handleSubmit, watch, setValue, formState } = useForm<NewComputeFormValues>({
    resolver: zodResolver(NewComputeFormSchema),
    defaultValues: {
      name: "",
      compute: "local",
      isolation: "direct",
      size: "",
      region: "",
      aws_profile: "",
      vpc_id: "",
      subnet_id: "",
      selectedTemplate: "",
    },
  });

  const compute = watch("compute");
  const isolation = watch("isolation");
  const size = watch("size");
  const selectedTemplate = watch("selectedTemplate");

  // Template-lifecycle pairs can only exist as templates -- they have no
  // persistent infrastructure, so a "concrete" row would be nonsense.
  // Source of truth: packages/types/compute.ts.
  const isTemplateLifecycle =
    effectiveLifecycle(compute as ComputeKindName, isolation as IsolationKindName) === "template";

  // Keep templateConfig in a ref-style state via watch / setValue -- we
  // stash the chosen template's config object and hand it over on submit.
  // The template dropdown drives (compute, isolation) + config together.
  // The server attaches `compute` + `isolation` to every template row, so
  // the web bundle no longer needs its own copy of the legacy
  // provider-to-axes mapping.
  useEffect(() => {
    if (!selectedTemplate) return;
    const tmpl = (templates as any[]).find((t) => t.name === selectedTemplate);
    if (!tmpl) return;
    if (typeof tmpl.compute === "string" && tmpl.compute.length > 0) {
      setValue("compute", tmpl.compute, { shouldDirty: true });
    }
    if (typeof tmpl.isolation === "string" && tmpl.isolation.length > 0) {
      setValue("isolation", tmpl.isolation, { shouldDirty: true });
    }
  }, [selectedTemplate, templates, setValue]);

  // Segmented control: the only real difference between a template and a
  // concrete target is this flag. The rest of the form is identical.
  const [kind, setKind] = useState<"compute" | "template">("compute");

  // Auto-switch to template when the user picks a template-lifecycle pair.
  // A concrete k8s / docker / firecracker row is meaningless -- those kinds
  // have no infrastructure to provision in advance, so the DB row would
  // never map to anything runnable.
  useEffect(() => {
    if (isTemplateLifecycle && kind === "compute") {
      setKind("template");
    }
  }, [isTemplateLifecycle, kind]);

  const submit = handleSubmit((values) => {
    const tmpl = (templates as any[]).find((t) => t.name === values.selectedTemplate);
    const templateConfig: Record<string, unknown> = tmpl?.config ?? {};
    onSubmit({ ...values, templateConfig, is_template: kind === "template" });
  });

  return (
    <div className="flex flex-col h-full p-5 overflow-y-auto">
      <h2 className="text-base font-semibold text-foreground mb-5">
        {kind === "template" ? "New Compute Template" : "New Compute Target"}
      </h2>
      <form onSubmit={submit} className="flex flex-col flex-1 min-h-0" noValidate>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Kind
          </label>
          <div
            role="tablist"
            aria-label="Choose compute kind"
            className="inline-flex rounded-md border border-border overflow-hidden"
          >
            <button
              type="button"
              role="tab"
              aria-selected={kind === "compute"}
              onClick={() => setKind("compute")}
              className={cn(
                "px-3 py-1.5 text-[12px] transition-colors duration-150 ease-[cubic-bezier(0.32,0.72,0,1)]",
                kind === "compute" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/40",
              )}
            >
              Compute target
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={kind === "template"}
              onClick={() => setKind("template")}
              className={cn(
                "px-3 py-1.5 text-[12px] transition-colors duration-150 ease-[cubic-bezier(0.32,0.72,0,1)] border-l border-border",
                kind === "template" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/40",
              )}
            >
              Template
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {kind === "compute"
              ? "This compute is provisioned now and reused by sessions referencing it directly."
              : "A reusable config blueprint. Sessions that reference this template get an isolated clone that's torn down when the session ends."}
          </p>
        </div>
        {kind === "compute" && templates.length > 0 && (
          <div className="mb-3.5">
            <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
              Base template
            </label>
            <p className="mb-1.5 text-[11px] text-muted-foreground">
              Optional. Pre-fill compute, isolation, and config from an existing template.
            </p>
            <RichSelect
              value={selectedTemplate ?? ""}
              onChange={(v) => setValue("selectedTemplate", v, { shouldDirty: true })}
              placeholder="(None)"
              options={[
                { value: "", label: "(None)" },
                ...(templates as any[]).map((t) => ({
                  value: t.name,
                  label: t.name,
                  description: t.description,
                  badge: t.provider,
                })),
              ]}
            />
          </div>
        )}
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Name *
          </label>
          <Input
            autoFocus
            placeholder="my-compute"
            aria-label="Compute target name"
            aria-invalid={!!formState.errors.name}
            {...register("name")}
          />
          {formState.errors.name && (
            <p className="mt-1 text-[11px] text-[var(--failed)]">{formState.errors.name.message}</p>
          )}
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Compute
          </label>
          <RichSelect
            value={compute}
            onChange={(v) => setValue("compute", v, { shouldDirty: true })}
            options={computeKinds.map((k) => ({ value: k, label: k }))}
          />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Isolation
          </label>
          <RichSelect
            value={isolation}
            onChange={(v) => setValue("isolation", v, { shouldDirty: true })}
            options={isolationKinds.map((k) => ({ value: k, label: k }))}
          />
        </div>
        {compute === "ec2" && (
          <>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                Size
              </label>
              <RichSelect
                value={size ?? ""}
                onChange={(v) => setValue("size", v, { shouldDirty: true })}
                placeholder="Default"
                options={[
                  { value: "", label: "Default" },
                  { value: "xs", label: "XS", description: "2 vCPU, 8 GB" },
                  { value: "s", label: "S", description: "4 vCPU, 16 GB" },
                  { value: "m", label: "M", description: "8 vCPU, 32 GB" },
                  { value: "l", label: "L", description: "16 vCPU, 64 GB" },
                  { value: "xl", label: "XL", description: "32 vCPU, 128 GB" },
                ]}
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                Region
              </label>
              <Input placeholder="us-east-1" aria-label="AWS region" {...register("region")} />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                AWS Profile
              </label>
              <Input placeholder="default" aria-label="AWS profile name" {...register("aws_profile")} />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                VPC ID
              </label>
              <Input placeholder="vpc-xxxxxxxx (optional)" aria-label="VPC ID" {...register("vpc_id")} />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                Subnet ID
              </label>
              <Input placeholder="subnet-xxxxxxxx (optional)" aria-label="Subnet ID" {...register("subnet_id")} />
            </div>
          </>
        )}
        <div className="flex gap-2 pt-4 border-t border-border mt-auto">
          <Button type="button" variant="outline" size="sm" onClick={onClose} aria-label="Cancel creating compute">
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            aria-label={kind === "template" ? "Create compute template" : "Create compute target"}
            disabled={formState.isSubmitting}
          >
            {kind === "template" ? "Create Template" : "Create Compute"}
          </Button>
        </div>
      </form>
    </div>
  );
}
