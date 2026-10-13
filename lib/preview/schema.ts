/**
 * x402 Preview: strict JSON schema the LLM must return (schema-locked; no free text
 * outside these fields). Labels, disclaimers, the sample 402 and the dry-run demo are
 * NOT in here: they are written by code (see labels.ts / engine.ts).
 */
import { z } from "zod";

export const PreviewRouteSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().min(1).max(200),
    reason: z.string().min(1).max(300),
    suggestedPriceUsd: z.number().min(0.0001).max(10),
  })
  .strict();

export const PreviewLlmOutputSchema = z
  .object({
    summary: z.string().min(1).max(600),
    candidateRoutes: z.array(PreviewRouteSchema).max(10),
    readinessGaps: z.array(z.string().min(1).max(300)).max(7),
    instructionLikeTextSeen: z.boolean(),
  })
  .strict();

export type PreviewLlmOutput = z.infer<typeof PreviewLlmOutputSchema>;

/** JSON Schema sent to the provider (strict structured output). Keep in sync with the zod schema above. */
export const PREVIEW_JSON_SCHEMA = {
  name: "x402_preview",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "candidateRoutes", "readinessGaps", "instructionLikeTextSeen"],
    properties: {
      summary: { type: "string" },
      candidateRoutes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["method", "path", "reason", "suggestedPriceUsd"],
          properties: {
            method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
            path: { type: "string" },
            reason: { type: "string" },
            suggestedPriceUsd: { type: "number" },
          },
        },
      },
      readinessGaps: { type: "array", items: { type: "string" } },
      instructionLikeTextSeen: { type: "boolean" },
    },
  },
} as const;
