import { z } from "zod";
import { PI_PLUGIN_ID } from "./extension-ui-contract.js";

export const PI_STATUS_EXTENSION_KIND = `${PI_PLUGIN_ID}/status` as const;
export const PI_TLH_STATUS_UPDATED_METHOD = "thread/tlhStatus/updated";

const PI_STATUS_USAGE_MAX_LENGTH = 200;

export const piStatusStateSchema = z.object({
  fast: z.boolean(),
  usage: z.string().nullable(),
});
export type PiStatusState = z.infer<typeof piStatusStateSchema>;

export const piExtensionKinds = {
  status: { state: piStatusStateSchema },
} as const;

export const piStatusUpdatedEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal(PI_TLH_STATUS_UPDATED_METHOD),
  params: z.object({
    threadId: z.string().min(1),
    status: piStatusStateSchema,
  }),
});

export const INITIAL_PI_STATUS: PiStatusState = { fast: false, usage: null };

export function sanitizePiStatusUsage(text: unknown): string | null {
  if (typeof text !== "string") {
    return null;
  }
  const cleaned = text
    .replace(/[\r\n\t]/gu, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, PI_STATUS_USAGE_MAX_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function applyPiStatusRequest(
  current: PiStatusState,
  request: Record<string, unknown>,
  published: boolean,
): PiStatusState | null {
  if (request.method !== "setStatus") {
    return null;
  }
  if (request.statusKey === "fast") {
    const fast =
      typeof request.statusText === "string" &&
      request.statusText.trim().length > 0;
    return published && fast === current.fast ? null : { ...current, fast };
  }
  if (request.statusKey === "tlh-usage") {
    const usage = sanitizePiStatusUsage(request.statusText);
    return published && usage === current.usage ? null : { ...current, usage };
  }
  return null;
}
