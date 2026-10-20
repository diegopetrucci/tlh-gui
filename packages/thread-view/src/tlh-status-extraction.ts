import {
  TLH_STATUS_EXTENSION_KIND,
  threadTimelineTlhStatusSchema,
} from "@bb/domain";
import type { ThreadTimelineTlhStatus } from "@bb/domain";
import type { ThreadEventWithMeta } from "./build-event-projection.js";
import { getOrderedThreadEvents } from "./group-event-projection-turns.js";

export function extractThreadTimelineTlhStatus(
  events: readonly ThreadEventWithMeta[],
): ThreadTimelineTlhStatus | null {
  let best: { seq: number; status: ThreadTimelineTlhStatus | null } | null =
    null;
  for (const { event, meta } of getOrderedThreadEvents(events)) {
    if (
      event.type !== "thread/extensionState/updated" ||
      event.kind !== TLH_STATUS_EXTENSION_KIND
    ) {
      continue;
    }
    if (best !== null && meta.seq <= best.seq) continue;
    if (event.payload === null) {
      best = { seq: meta.seq, status: null };
      continue;
    }
    const parsed = threadTimelineTlhStatusSchema.safeParse(event.payload);
    if (!parsed.success) continue;
    best = { seq: meta.seq, status: parsed.data };
  }
  return best?.status ?? null;
}
