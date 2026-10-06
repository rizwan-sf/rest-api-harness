import { z } from "zod";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/**
 * RFC 7807 problem document. `type`, `title` and `status` are required by the
 * house standard (the RFC makes them optional); extension members are allowed.
 */
export const ProblemDocumentSchema = z.looseObject({
  type: z.union([z.url(), z.literal("about:blank")]),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
});
