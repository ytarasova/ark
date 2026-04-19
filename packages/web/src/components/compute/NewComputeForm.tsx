import { useState, useEffect, useRef, type FormEvent } from "react";
import { api } from "../../hooks/useApi.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { selectClassName } from "../ui/styles.js";

// Wave 3: surface both compute + runtime axes. Static defaults render while
// the server reply is in flight; useEffect below overwrites with the live list.
const DEFAULT_COMPUTE_KINDS = ["local", "firecracker", "ec2", "fly-machines", "k8s", "k8s-kata", "e2b"] as const;
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
    e2b: { compute: "e2b", runtime: "direct" },
    "fly-machines": { compute: "fly-machines", runtime: "direct" },
  };
  return map[name] ?? { compute: "local", runtime: "direct" };
}

export function NewComputeForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (form: any) => void }) {
  const [form, setForm] = useState({
    name: "",
    compute: "local",
    runtime: "direct",
    size: "",
    region: "",
    aws_profile: "",
    vpc_id: "",
    subnet_id: "",
  });
  const [templates, setTemplates] = useState<any[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [templateConfig, setTemplateConfig] = useState<Record<string, unknown>>({});
  const [computeKinds, setComputeKinds] = useState<string[]>([...DEFAULT_COMPUTE_KINDS]);
  const [runtimeKinds, setRuntimeKinds] = useState<string[]>([...DEFAULT_RUNTIME_KINDS]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    api
      .listComputeTemplates()
      .then((data) => {
        if (mountedRef.current) setTemplates(data);
      })
      .catch(() => {});
    // Fetch live (compute, runtime) kind lists from the server. Falls back to
    // the static defaults above on network error.
    (api as any)
      .listComputeKinds?.()
      .then((data: any) => {
        if (mountedRef.current && Array.isArray(data?.kinds) && data.kinds.length) setComputeKinds(data.kinds);
      })
      .catch?.(() => {});
    (api as any)
      .listRuntimeKinds?.()
      .then((data: any) => {
        if (mountedRef.current && Array.isArray(data?.kinds) && data.kinds.length) setRuntimeKinds(data.kinds);
      })
      .catch?.(() => {});
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function update(key: string, val: string) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleTemplateChange(templateName: string) {
    setSelectedTemplate(templateName);
    if (!templateName) {
      setTemplateConfig({});
      return;
    }
    const tmpl = templates.find((t) => t.name === templateName);
    if (tmpl) {
      // Template still carries a legacy `provider`; map to (compute, runtime).
      const pair = providerToPairLocal(tmpl.provider as string);
      setForm((prev) => ({ ...prev, compute: pair.compute, runtime: pair.runtime }));
      setTemplateConfig(tmpl.config ?? {});
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSubmit({ ...form, templateConfig });
  }

  return (
    <div className="flex flex-col h-full p-5 overflow-y-auto">
      <h2 className="text-base font-semibold text-foreground mb-5">New Compute Target</h2>
      <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
        {templates.length > 0 && (
          <div className="mb-3.5">
            <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
              Template
            </label>
            <select
              className={selectClassName}
              value={selectedTemplate}
              onChange={(e) => handleTemplateChange(e.target.value)}
              aria-label="Select compute template"
            >
              <option value="">(None)</option>
              {templates.map((t: any) => (
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
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="my-compute"
            aria-label="Compute target name"
          />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Compute
          </label>
          <select
            className={selectClassName}
            value={form.compute}
            onChange={(e) => update("compute", e.target.value)}
            aria-label="Select compute kind"
          >
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
          <select
            className={selectClassName}
            value={form.runtime}
            onChange={(e) => update("runtime", e.target.value)}
            aria-label="Select runtime kind"
          >
            {runtimeKinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        {form.compute === "ec2" && (
          <>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                Size
              </label>
              <select
                className={selectClassName}
                value={form.size}
                onChange={(e) => update("size", e.target.value)}
                aria-label="Select instance size"
              >
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
              <Input
                value={form.region}
                onChange={(e) => update("region", e.target.value)}
                placeholder="us-east-1"
                aria-label="AWS region"
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                AWS Profile
              </label>
              <Input
                value={form.aws_profile}
                onChange={(e) => update("aws_profile", e.target.value)}
                placeholder="default"
                aria-label="AWS profile name"
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                VPC ID
              </label>
              <Input
                value={form.vpc_id}
                onChange={(e) => update("vpc_id", e.target.value)}
                placeholder="vpc-xxxxxxxx (optional)"
                aria-label="VPC ID"
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                Subnet ID
              </label>
              <Input
                value={form.subnet_id}
                onChange={(e) => update("subnet_id", e.target.value)}
                placeholder="subnet-xxxxxxxx (optional)"
                aria-label="Subnet ID"
              />
            </div>
          </>
        )}
        <div className="flex gap-2 pt-4 border-t border-border mt-auto">
          <Button type="button" variant="outline" size="sm" onClick={onClose} aria-label="Cancel creating compute">
            Cancel
          </Button>
          <Button type="submit" size="sm" aria-label="Create compute target">
            Create Compute
          </Button>
        </div>
      </form>
    </div>
  );
}
