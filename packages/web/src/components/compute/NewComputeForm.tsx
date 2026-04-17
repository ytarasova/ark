import { useState, useEffect, useRef, type FormEvent } from "react";
import { api } from "../../hooks/useApi.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { selectClassName } from "../ui/styles.js";

export function NewComputeForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (form: any) => void }) {
  const [form, setForm] = useState({
    name: "",
    provider: "local",
    size: "",
    region: "",
    aws_profile: "",
    vpc_id: "",
    subnet_id: "",
  });
  const [templates, setTemplates] = useState<any[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [templateConfig, setTemplateConfig] = useState<Record<string, unknown>>({});
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    api
      .listComputeTemplates()
      .then((data) => {
        if (mountedRef.current) setTemplates(data);
      })
      .catch(() => {});
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
      setForm((prev) => ({ ...prev, provider: tmpl.provider }));
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
            Provider
          </label>
          <select
            className={selectClassName}
            value={form.provider}
            onChange={(e) => update("provider", e.target.value)}
            aria-label="Select compute provider"
          >
            <option value="local">local</option>
            <option value="docker">docker</option>
            <option value="devcontainer">devcontainer</option>
            <option value="ec2">ec2</option>
            <option value="ec2-docker">ec2-docker</option>
            <option value="ec2-devcontainer">ec2-devcontainer</option>
          </select>
        </div>
        {form.provider.startsWith("ec2") && (
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
