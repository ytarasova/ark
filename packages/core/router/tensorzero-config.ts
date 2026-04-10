/**
 * TensorZero config generator.
 *
 * Generates tensorzero.toml from Ark's configuration. Maps Ark's
 * runtimes/models to TensorZero model providers with appropriate
 * API key references.
 */

export interface TensorZeroConfigOpts {
  anthropicKey?: string;
  openaiKey?: string;
  geminiKey?: string;
  postgresUrl?: string;
  port?: number;
}

/**
 * Generate tensorzero.toml content from Ark configuration.
 * Maps Ark's runtimes/models to TensorZero model providers.
 */
export function generateTensorZeroConfig(opts: TensorZeroConfigOpts): string {
  const port = opts.port ?? 3000;
  const lines: string[] = [];

  lines.push(`[gateway]`);
  lines.push(`bind_address = "0.0.0.0:${port}"`);
  lines.push(``);

  // Postgres for observability (optional)
  if (opts.postgresUrl) {
    lines.push(`[postgres]`);
    lines.push(`connection_string = "${opts.postgresUrl}"`);
    lines.push(``);
  }

  // Anthropic models
  if (opts.anthropicKey) {
    for (const [alias, modelName] of [
      ["claude-opus", "claude-opus-4-6"],
      ["claude-sonnet", "claude-sonnet-4-6"],
      ["claude-haiku", "claude-haiku-4-5"],
    ] as const) {
      lines.push(`[models.${alias}]`);
      lines.push(`routing = ["anthropic"]`);
      lines.push(``);
      lines.push(`[models.${alias}.providers.anthropic]`);
      lines.push(`type = "anthropic"`);
      lines.push(`model_name = "${modelName}"`);
      lines.push(`api_key_location = "env::ANTHROPIC_API_KEY"`);
      lines.push(``);
    }
  }

  // OpenAI models
  if (opts.openaiKey) {
    for (const [alias, modelName] of [
      ["gpt-4-1", "gpt-4.1"],
      ["gpt-4-1-mini", "gpt-4.1-mini"],
      ["gpt-4-1-nano", "gpt-4.1-nano"],
    ] as const) {
      lines.push(`[models.${alias}]`);
      lines.push(`routing = ["openai"]`);
      lines.push(``);
      lines.push(`[models.${alias}.providers.openai]`);
      lines.push(`type = "openai"`);
      lines.push(`model_name = "${modelName}"`);
      lines.push(`api_key_location = "env::OPENAI_API_KEY"`);
      lines.push(``);
    }
  }

  // Google models
  if (opts.geminiKey) {
    for (const [alias, modelName] of [
      ["gemini-pro", "gemini-2.5-pro"],
      ["gemini-flash", "gemini-2.5-flash"],
    ] as const) {
      lines.push(`[models.${alias}]`);
      lines.push(`routing = ["google"]`);
      lines.push(``);
      lines.push(`[models.${alias}.providers.google]`);
      lines.push(`type = "google_ai_studio_gemini"`);
      lines.push(`model_name = "${modelName}"`);
      lines.push(`api_key_location = "env::GEMINI_API_KEY"`);
      lines.push(``);
    }
  }

  // Default chat function
  lines.push(`[functions.chat]`);
  lines.push(`type = "chat"`);
  lines.push(``);
  lines.push(`[functions.chat.variants.default]`);
  lines.push(`type = "chat_completion"`);
  lines.push(`model = "claude-sonnet"`);
  lines.push(``);

  return lines.join("\n");
}
