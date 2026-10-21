import { z } from "zod";

export const TLH_STATUS_EXTENSION_KIND = "provider-pi/status";

export const threadTimelineTlhStatusSchema = z.object({
  fast: z.boolean(),
  usage: z.string().nullable(),
});
export type ThreadTimelineTlhStatus = z.infer<
  typeof threadTimelineTlhStatusSchema
>;
