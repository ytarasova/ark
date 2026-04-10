/**
 * Core router -- TensorZero integration.
 *
 * Config generation and lifecycle management for the TensorZero LLM gateway.
 */

export { generateTensorZeroConfig, type TensorZeroConfigOpts } from "./tensorzero-config.js";
export { TensorZeroManager, type TensorZeroManagerOpts } from "./tensorzero.js";
