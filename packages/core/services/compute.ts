/**
 * ComputeService -- thin orchestration layer over ComputeRepository.
 *
 * For now, all methods delegate directly to the repository.
 * Provider operations (provision, destroy, startInstance, etc.) will be
 * added in a later pass when provider registries are wired in.
 */

import type {
  Compute,
  ComputeStatus,
  ComputeProviderName,
  ComputeConfig,
  CreateComputeOpts,
} from "../../types/index.js";
import type { ComputeRepository } from "../repositories/compute.js";

export class ComputeService {
  constructor(private computes: ComputeRepository) {}

  create(opts: CreateComputeOpts): Promise<Compute> {
    return this.computes.create(opts);
  }

  get(name: string): Promise<Compute | null> {
    return this.computes.get(name);
  }

  list(filters?: { status?: ComputeStatus; provider?: ComputeProviderName; limit?: number }): Promise<Compute[]> {
    return this.computes.list(filters);
  }

  update(name: string, fields: Partial<Compute>): Promise<Compute | null> {
    return this.computes.update(name, fields);
  }

  delete(name: string): Promise<boolean> {
    return this.computes.delete(name);
  }

  mergeConfig(name: string, patch: Partial<ComputeConfig>): Promise<Compute | null> {
    return this.computes.mergeConfig(name, patch);
  }
}
