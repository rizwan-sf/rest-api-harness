import { z } from "zod";
import { ProbeSchema } from "../task/schema.js";

/** stdin of the probe child process. */
export const ProbeInputSchema = z.object({
  appModule: z.string(),
  probes: z.array(ProbeSchema),
});
export type ProbeInput = z.infer<typeof ProbeInputSchema>;

export const ObservationSchema = z.object({
  name: z.string(),
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  bodyText: z.string(),
});
export type Observation = z.infer<typeof ObservationSchema>;

/** stdout of the probe child process, on a single line after the marker. */
export const ProbeOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), observations: z.array(ObservationSchema) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type ProbeOutput = z.infer<typeof ProbeOutputSchema>;

export const PROBE_MARKER = "__HARNESS_PROBE_RESULT__";
