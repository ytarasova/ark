import type { PlacementCtx } from "../placement-types.js";

export type MockCall =
  | { kind: "writeFile"; path: string; mode: number; bytes: Uint8Array }
  | { kind: "appendFile"; path: string; marker: string; bytes: Uint8Array }
  | { kind: "setEnv"; key: string; value: string }
  | { kind: "setProvisionerConfig"; cfg: { kubeconfig?: Uint8Array } };

export class MockPlacementCtx implements PlacementCtx {
  public calls: MockCall[] = [];
  private readonly env: Record<string, string> = {};
  constructor(private readonly homeRoot: string = "/home/ubuntu") {}

  async writeFile(path: string, mode: number, bytes: Uint8Array): Promise<void> {
    this.calls.push({ kind: "writeFile", path, mode, bytes });
  }
  async appendFile(path: string, marker: string, bytes: Uint8Array): Promise<void> {
    this.calls.push({ kind: "appendFile", path, marker, bytes });
  }
  setEnv(key: string, value: string): void {
    this.env[key] = value;
    this.calls.push({ kind: "setEnv", key, value });
  }
  setProvisionerConfig(cfg: { kubeconfig?: Uint8Array }): void {
    this.calls.push({ kind: "setProvisionerConfig", cfg });
  }
  expandHome(rel: string): string {
    return rel.startsWith("~/") ? `${this.homeRoot}/${rel.slice(2)}` : rel;
  }
  getEnv(): Record<string, string> {
    return { ...this.env };
  }
}
