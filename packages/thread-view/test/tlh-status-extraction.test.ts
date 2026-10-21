import type { JsonValue } from "@bb/domain";
import { TLH_STATUS_EXTENSION_KIND, threadScope } from "@bb/domain";
import { describe, expect, it } from "vitest";
import type { ThreadEventWithMeta } from "../src/build-event-projection.js";
import { extractThreadTimelineTlhStatus } from "../src/tlh-status-extraction.js";

function statusEvent(seq: number, payload: JsonValue): ThreadEventWithMeta {
  return {
    event: {
      type: "thread/extensionState/updated",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: threadScope(),
      kind: TLH_STATUS_EXTENSION_KIND,
      payload,
    },
    meta: { id: `event-${seq}`, seq, createdAt: seq * 100 },
  };
}

describe("extractThreadTimelineTlhStatus", () => {
  it("returns null when no status events exist", () => {
    expect(extractThreadTimelineTlhStatus([])).toBeNull();
  });

  it("uses the latest status regardless of input order", () => {
    expect(
      extractThreadTimelineTlhStatus([
        statusEvent(5, { fast: true, usage: "5h 10%" }),
        statusEvent(2, { fast: false, usage: null }),
      ]),
    ).toEqual({ fast: true, usage: "5h 10%" });
  });

  it("ignores invalid payloads", () => {
    expect(
      extractThreadTimelineTlhStatus([
        statusEvent(1, { fast: true, usage: null }),
        statusEvent(2, { fast: "yes" }),
      ]),
    ).toEqual({ fast: true, usage: null });
  });

  it("returns null when the latest payload is null", () => {
    expect(
      extractThreadTimelineTlhStatus([
        statusEvent(1, { fast: true, usage: null }),
        statusEvent(2, null),
      ]),
    ).toBeNull();
  });
});
