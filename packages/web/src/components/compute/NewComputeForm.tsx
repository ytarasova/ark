import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../hooks/useApi.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { selectClassName } from "../ui/styles.js";

// Surface both compute + runtime axes. Static defaults render while the
// server reply is in flight; the queries below overwrite with the live list.
const DEFAULT_COMPUTE_KINDS = ["local", "firecracker", "ec2", "k8s", "k8s-kata"] as const;
const DEFAULT_RUNTIME_KINDS = ["direct", "docker", "compose", "devcontainer", "firecracker-in-container"] as const;

/**
 * Inline copy of providerToPair for the web bundle. The server maintains the
 * canonical table in packages/compute/adapters/provider-map.ts -- keep both
 * in sync. Kept short so drift is obvious.
 */
function providerToPairLocal(name: string): { compute: string; runtime: string } {
  const map: Record<string, { compute: string; runtime: string }> = {
    local: { compute: "local", runtime: "direct" },
    docker: { compute: "local", runtime: "docker" },
    devcontainer: { compute: "local", runtime: "devcontainer" },
    firecracker: { compute: "local", runtime: "firecracker-in-container" },
    ec2: { compute: "ec2", runtime: "direct" },
    "ec2-docker": { compute: "ec2", runtime: "docker" },
    "ec2-devcontainer": { compute: "ec2", runtime: "devcontainer" },
    "ec2-firecracker": { compute: "ec2", runtime: "firecracker-in-container" },
    k8s: { compute: "k8s", runtime: "direct" },
    "k8s-kata": { compute: "k8s-kata", runtime: "direct" },
  };
  return map[name] ?? { compute: "local", runtime: "direct" };
}

// Zod schema -- single source of truth for form validation. The submit
// payload type is `NewComputeFormValues`, derived from the schema so caller
// never has to double-declare the shape.
export const NewComputeFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  compute: z.string().min(1),
  runtime: z.string().min(1),
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
}

export function NewComputeForm({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (form: NewComputePayload) => void;
}) {
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

  const runtimeKindsQuery = useQuery({
    queryKey: ["runtime", "kinds"],
    queryFn: () =>
      (api as any)
        .listRuntimeKinds?.()
        .then((d: any) =>
          Array.isArray(d?.kinds) && d.kinds.length ? (d.kinds as string[]) : [...DEFAULT_RUNTIME_KINDS],
        )
        .catch(() => [...DEFAULT_RUNTIME_KINDS]),
  });
  const runtimeKinds = runtimeKindsQuery.data ?? [...DEFAULT_RUNTIME_KINDS];

  const { register, handleSubmit, watch, setValue, formState } = useForm<NewComputeFormValues>({
    resolver: zodResolver(NewComputeFormSchema),
    defaultValues: {
      name: "",
      compute: "local",
      runtime: "direct",
      size: "",
      region: "",
      aws_profile: "",
      vpc_id: "",
      subnet_id: "",
      selectedTemplate: "",
    },
  });

  const compute = watch("compute");
  const selectedTemplate = watch("selectedTemplate");

  // Keep templateConfig in a ref-style state via watch / setValue -- we
  // stash the chosen template's config object and hand it over on submit.
  // The template dropdown drives (compute, runtime) + config together.
  useEffect(() => {
    if (!selectedTemplate) return;
    const tmpl = (templates as any[]).find((t) => t.name === selectedTemplate);
    if (!tmpl) return;
    const pair = providerToPairLocal(tmpl.provider as string);
    setValue("compute", pair.compute, { shouldDirty: true });
    setValue("runtime", pair.runtime, { shouldDirty: true });
  }, [selectedTemplate, templates, setValue]);

  const submit = handleSubmit((values) => {
    const tmpl = (templates as any[]).find((t) => t.name === values.selectedTemplate);
    const templateConfig: Record<string, unknown> = tmpl?.config ?? {};
    onSubmit({ ...values, templateConfig });
  });

  return (
    <div className="flex flex-col h-full p-5 overflow-y-auto">
      <h2 className="text-base font-semibold text-foreground mb-5">New Compute Target</h2>
      <form onSubmit={submit} className="flex flex-col flex-1 min-h-0" noValidate>
        {templates.length > 0 && (
          <div className="mb-3.5">
            <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
              Template
            </label>
            <select className={selectClassName} aria-label="Select compute template" {...register("selectedTemplate")}>
              <option value="">(None)</option>
              {(templates as any[]).map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                  {t.description ? ` - ${t.description}` : ""} [{t.provider}]
                </option>
              ))}
            </select>
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
          <select className={selectClassName} aria-label="Select compute kind" {...register("compute")}>
            {computeKinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Runtime
          </label>
          <select className={selectClassName} aria-label="Select runtime kind" {...register("runtime")}>
            {runtimeKinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        {compute === "ec2" && (
          <>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                Size
              </label>
              <select className={selectClassName} aria-label="Select instance size" {...register("size")}>
                <option value="">Default</option>
                <option value="xs">XS (2 vCPU, 8 GB)</option>
                <option value="s">S (4 vCPU, 16 GB)</option>
                <option value="m">M (8 vCPU, 32 GB)</option>
                <option value="l">L (16 vCPU, 64 GB)</option>
                <option value="xl">XL (32 vCPU, 128 GB)</option>
              </select>
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
          <Button type="submit" size="sm" aria-label="Create compute target" disabled={formState.isSubmitting}>
            Create Compute
          </Button>
        </div>
      </form>
    </div>
  );
}
