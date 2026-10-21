import { describe, expect, it } from "vitest";
import {
  applyPiStatusRequest,
  INITIAL_PI_STATUS,
  piStatusStateSchema,
  sanitizePiStatusUsage,
} from "./extension-kinds.js";

function setStatus(statusKey: string, statusText?: string) {
  return {
    type: "extension_ui_request",
    id: "x",
    method: "setStatus",
    statusKey,
    statusText,
  };
}

describe("applyPiStatusRequest", () => {
  it("sets and clears fast", () => {
    const on = applyPiStatusRequest(
      INITIAL_PI_STATUS,
      setStatus("fast", "fast"),
      false,
    );
    expect(on).toEqual({ fast: true, usage: null });
    expect(
      applyPiStatusRequest(on!, setStatus("fast", "fast"), true),
    ).toBeNull();
    expect(applyPiStatusRequest(on!, setStatus("fast"), true)).toEqual(
      INITIAL_PI_STATUS,
    );
  });

  it("sets and clears usage, preserving fast", () => {
    const text = "5h session 12% used · weekly 40% used";
    const set = applyPiStatusRequest(
      { fast: true, usage: null },
      setStatus("tlh-usage", text),
      true,
    );
    expect(set).toEqual({ fast: true, usage: text });
    expect(
      applyPiStatusRequest(set!, setStatus("tlh-usage", text), true),
    ).toBeNull();
    expect(applyPiStatusRequest(set!, setStatus("tlh-usage"), true)).toEqual({
      fast: true,
      usage: null,
    });
  });

  it("ignores other keys and methods", () => {
    expect(
      applyPiStatusRequest(INITIAL_PI_STATUS, setStatus("other", "x"), false),
    ).toBeNull();
    expect(
      applyPiStatusRequest(
        INITIAL_PI_STATUS,
        {
          method: "notify",
          statusKey: "fast",
          statusText: "fast",
        },
        false,
      ),
    ).toBeNull();
  });

  it("always emits the first allowlisted status, then dedupes", () => {
    const first = applyPiStatusRequest(
      INITIAL_PI_STATUS,
      setStatus("fast"),
      false,
    );
    expect(first).toEqual(INITIAL_PI_STATUS);
    expect(applyPiStatusRequest(first!, setStatus("fast"), true)).toBeNull();
    expect(
      applyPiStatusRequest(INITIAL_PI_STATUS, setStatus("tlh-usage"), false),
    ).toEqual(INITIAL_PI_STATUS);
  });

  it("sanitizes usage text", () => {
    expect(sanitizePiStatusUsage("  a\u0007\nb\t\t c\r\n ")).toBe("a b c");
    expect(sanitizePiStatusUsage("\u0001  ")).toBeNull();
    expect(sanitizePiStatusUsage("x".repeat(500))).toHaveLength(200);
    expect(
      piStatusStateSchema.safeParse({ fast: true, usage: null }).success,
    ).toBe(true);
  });
});
