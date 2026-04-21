import { z } from "zod";

/**
 * Zod schema for the NewSession form. Attachments, references and flow
 * inputs are managed as separate state because they have non-trivial
 * client-only semantics (file reads, regex detection, flow-driven shapes).
 */
export const NewSessionSchema = z.object({
  summary: z.string().trim().min(1, "Describe the task"),
  repo: z.string().min(1),
  ticket: z.string().default(""),
  flow: z.string().default(""),
  compute: z.string().default(""),
});
export type NewSessionFormValues = z.infer<typeof NewSessionSchema>;
