import { describe, expect, it } from "vitest";
import {
  classifyDetachedResultCandidate,
  createDetachedRunReconciler,
  parseDetachedActivitySnapshot,
  parseDetachedRunOutcome,
} from "./detached-run-reconciliation.js";

function detachedLaunchDetails(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mode: "single",
    runId: "run-1",
    results: [],
    asyncId: "run-1",
    asyncDir: "/tmp/async/run-1",
    ...overrides,
  };
}

function detachedLaunchEvent(
  detailOverrides: Record<string, unknown> = {},
  eventOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "subagent",
    result: {
      content: [{ type: "text", text: "Async: agent [run-1]" }],
      details: detachedLaunchDetails(detailOverrides),
    },
    isError: false,
    ...eventOverrides,
  };
}

function detachedActivitySnapshot(
  activeAsyncJobIds: readonly string[],
): Record<string, unknown> {
  return {
    inProgress: activeAsyncJobIds.length > 0,
    waitingForUser: false,
    activeAsyncJobIds,
  };
}

function detachedCompletionEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId: "run-1",
    state: "complete",
    success: true,
    results: [],
    ...overrides,
  };
}

describe("classifyDetachedResultCandidate", () => {
  it("recognizes the real detached launch result without args.async", () => {
    expect(classifyDetachedResultCandidate(detachedLaunchEvent())).toEqual({
      asyncId: "run-1",
      mode: "single",
    });
  });

  it("recognizes single, parallel, and resumed runs by their new result ids", () => {
    expect(
      classifyDetachedResultCandidate(
        detachedLaunchEvent({
          asyncId: "run-2",
          runId: "run-2",
          mode: "parallel",
        }),
      ),
    ).toEqual({ asyncId: "run-2", mode: "parallel" });
    expect(
      classifyDetachedResultCandidate(
        detachedLaunchEvent({ asyncId: "run-3", runId: "run-3" }),
      ),
    ).toEqual({ asyncId: "run-3", mode: "single" });
  });

  it.each([
    {
      type: "tool_execution_end",
      toolCallId: "failed-call",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "Failed to start async run" }],
        details: { mode: "single", results: [] },
      },
      isError: true,
    },
    {
      type: "tool_execution_end",
      toolCallId: "management-call",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "Resume was not accepted" }],
        details: { mode: "management", results: [] },
      },
      isError: true,
    },
    detachedLaunchEvent({ awaited: true }),
    detachedLaunchEvent({ results: [{ asyncId: "child-1" }] }),
  ])(
    "rejects failed, management, awaited, and non-empty results: %j",
    (value) => {
      expect(classifyDetachedResultCandidate(value)).toBeNull();
    },
  );

  it("rejects errors nested inside the tool result before reading details", () => {
    expect(
      classifyDetachedResultCandidate({
        toolName: "subagent",
        isError: false,
        result: { isError: true, details: detachedLaunchDetails() },
      }),
    ).toBeNull();
    expect(
      classifyDetachedResultCandidate({
        toolName: "subagent",
        isError: false,
        result: { error: "failed", details: detachedLaunchDetails() },
      }),
    ).toBeNull();
  });

  it.each([
    {},
    detachedLaunchDetails({ asyncId: "" }),
    detachedLaunchDetails({ mode: "unknown" }),
    detachedLaunchDetails({ results: undefined }),
    detachedLaunchDetails({ awaited: "false" }),
    detachedLaunchEvent({}, { toolName: "other" }),
  ])("rejects malformed result details: %j", (value) => {
    expect(classifyDetachedResultCandidate(value)).toBeNull();
  });
});

describe("parseDetachedRunOutcome", () => {
  it.each([
    ["complete", "completed"],
    ["completed", "completed"],
    ["continued", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["paused", "paused"],
  ] as const)("maps the producer state %s to %s", (state, outcome) => {
    expect(
      parseDetachedRunOutcome({
        runId: "run-1",
        state,
        success:
          state === "complete" ||
          state === "completed" ||
          state === "continued",
      }),
    ).toEqual({ asyncId: "run-1", outcome });
  });

  it("uses id when a completion event has no runId", () => {
    expect(
      parseDetachedRunOutcome({ id: "run-2", state: "failed", success: false }),
    ).toEqual({ asyncId: "run-2", outcome: "failed" });
  });

  it.each([
    { runId: "run-1" },
    { runId: "run-1", state: "running" },
    { id: "run-1", status: "failed" },
    { runId: "run-1", state: "unknown" },
  ])("rejects a missing or unknown explicit completion state: %j", (value) => {
    expect(parseDetachedRunOutcome(value)).toBeNull();
  });
});

describe("detached run reconciliation", () => {
  it("requires a candidate, a latest activity snapshot, and no outcome", () => {
    const reconciler = createDetachedRunReconciler();

    expect(reconciler.recordResult(detachedLaunchEvent())).not.toBeNull();
    expect(reconciler.getEligibleCandidates()).toEqual([]);
    expect(
      reconciler.recordActivitySnapshot(detachedActivitySnapshot(["run-1"])),
    ).toBe(true);
    expect(reconciler.getEligibleCandidates()).toEqual([
      { asyncId: "run-1", mode: "single" },
    ]);
    expect(reconciler.getOutcome("run-1")).toBeNull();
  });

  it.each([
    ["failed", "failed"],
    ["paused", "paused"],
  ] as const)(
    "keeps an earlier %s terminal before the candidate arrives",
    (state, outcome) => {
      const reconciler = createDetachedRunReconciler();

      expect(
        reconciler.recordOutcome(
          detachedCompletionEvent({
            state,
            success: state === "failed" ? false : undefined,
          }),
        ),
      ).toBe(true);
      expect(reconciler.getOutcome("run-1")).toBe(outcome);
      expect(
        reconciler.recordActivitySnapshot(detachedActivitySnapshot(["run-1"])),
      ).toBe(true);
      expect(reconciler.recordResult(detachedLaunchEvent())).not.toBeNull();
      expect(reconciler.isEligible("run-1")).toBe(false);
      expect(reconciler.getEligibleCandidates()).toEqual([]);
    },
  );

  it("treats activity removal as inactive rather than successful", () => {
    const reconciler = createDetachedRunReconciler();

    expect(
      reconciler.recordActivitySnapshot(detachedActivitySnapshot([])),
    ).toBe(true);
    expect(reconciler.recordResult(detachedLaunchEvent())).not.toBeNull();
    expect(reconciler.getEligibleCandidates()).toEqual([]);
    expect(reconciler.getOutcome("run-1")).toBeNull();
    expect(
      reconciler.recordActivitySnapshot(detachedActivitySnapshot(["run-1"])),
    ).toBe(true);
    expect(reconciler.getEligibleCandidates()).toEqual([
      { asyncId: "run-1", mode: "single" },
    ]);
  });

  it("handles duplicate and out-of-order signals without duplicate candidates", () => {
    const reconciler = createDetachedRunReconciler();

    expect(
      reconciler.recordActivitySnapshot(
        detachedActivitySnapshot(["run-1", "run-1"]),
      ),
    ).toBe(true);
    expect(reconciler.getEligibleCandidates()).toEqual([]);
    expect(reconciler.recordResult(detachedLaunchEvent())).not.toBeNull();
    expect(reconciler.recordResult(detachedLaunchEvent())).not.toBeNull();
    expect(reconciler.getEligibleCandidates()).toEqual([
      { asyncId: "run-1", mode: "single" },
    ]);
    expect(reconciler.recordOutcome(detachedCompletionEvent())).toBe(true);
    expect(reconciler.recordOutcome(detachedCompletionEvent())).toBe(true);
    expect(reconciler.getOutcome("run-1")).toBe("completed");
    expect(reconciler.getEligibleCandidates()).toEqual([]);
  });

  it("does not resurrect a paused run from a stale activity snapshot", () => {
    const reconciler = createDetachedRunReconciler();

    reconciler.recordResult(detachedLaunchEvent());
    reconciler.recordActivitySnapshot(detachedActivitySnapshot(["run-1"]));
    expect(reconciler.isEligible("run-1")).toBe(true);
    expect(
      reconciler.recordOutcome(
        detachedCompletionEvent({ state: "paused", success: false }),
      ),
    ).toBe(true);
    expect(reconciler.getOutcome("run-1")).toBe("paused");
    reconciler.recordActivitySnapshot(detachedActivitySnapshot([]));
    reconciler.recordActivitySnapshot(detachedActivitySnapshot(["run-1"]));
    expect(reconciler.isEligible("run-1")).toBe(false);
    expect(reconciler.getEligibleCandidates()).toEqual([]);
  });

  it("ignores malformed snapshots and outcomes without changing eligibility", () => {
    const reconciler = createDetachedRunReconciler();

    reconciler.recordResult(detachedLaunchEvent());
    expect(
      reconciler.recordActivitySnapshot(
        detachedActivitySnapshot(["run-1", "2"]),
      ),
    ).toBe(true);
    expect(
      reconciler.recordActivitySnapshot({
        ...detachedActivitySnapshot(["run-1"]),
        activeAsyncJobIds: ["run-1", 2],
      }),
    ).toBe(false);
    expect(reconciler.recordOutcome({ id: 2, state: "failed" })).toBe(false);
    expect(reconciler.recordOutcome({ runId: "run-1" })).toBe(false);
    expect(reconciler.getEligibleCandidates()).toEqual([
      { asyncId: "run-1", mode: "single" },
    ]);
    expect(
      parseDetachedActivitySnapshot({ activeAsyncJobIds: [null] }),
    ).toBeNull();
    expect(
      parseDetachedRunOutcome({ runId: "run-1", state: "running" }),
    ).toBeNull();
  });

  it("resets all session-local state and disposes cleanly", () => {
    const reconciler = createDetachedRunReconciler();

    reconciler.recordResult(detachedLaunchEvent());
    reconciler.recordActivitySnapshot(detachedActivitySnapshot(["run-1"]));
    reconciler.recordOutcome(
      detachedCompletionEvent({ state: "failed", success: false }),
    );
    expect(reconciler.getOutcome("run-1")).toBe("failed");
    reconciler.reset();
    expect(reconciler.getEligibleCandidates()).toEqual([]);
    expect(reconciler.getOutcome("run-1")).toBeNull();
    expect(reconciler.isEligible("run-1")).toBe(false);
    reconciler.recordResult(
      detachedLaunchEvent({ asyncId: "new-run", runId: "new-run" }),
    );
    reconciler.recordActivitySnapshot(detachedActivitySnapshot(["new-run"]));
    expect(reconciler.getEligibleCandidates()).toEqual([
      { asyncId: "new-run", mode: "single" },
    ]);
    reconciler.dispose();
    expect(reconciler.getEligibleCandidates()).toEqual([]);
    expect(reconciler.getOutcome("new-run")).toBeNull();
    expect(
      reconciler.recordActivitySnapshot(detachedActivitySnapshot(["new-run"])),
    ).toBe(false);
    expect(reconciler.recordResult(detachedLaunchEvent())).toBeNull();
  });
});
