import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  BridgeJsonRpcObject,
  BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  FULL_PERMISSION_OPTIONS,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

const MINI = {
  ...FULL_PERMISSION_OPTIONS,
  model: "fake-provider/fake-mini",
  reasoningLevel: "medium",
};
const FULL_MODEL = { ...MINI, model: "fake-provider/fake-model" };
const TEST_TIMEOUT_MS = 60_000;

let harness: FakePiBridgeHarness;

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-detached-lifecycle-",
    initialize: true,
    processLog: true,
  });
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function providerThreadIdFor(threadId: string): string {
  const identity = [...harness.messages]
    .reverse()
    .find(
      (message) =>
        message.method === "thread/identity" &&
        (message.params as { threadId?: unknown }).threadId === threadId,
    );
  const providerThreadId = (identity?.params as { providerThreadId?: unknown })
    .providerThreadId;
  expect(typeof providerThreadId).toBe("string");
  if (typeof providerThreadId !== "string") {
    throw new Error("missing provider thread identity");
  }
  return providerThreadId;
}

function turnStart(
  id: number,
  threadId: string,
  text: string,
  options: BridgeJsonRpcObject,
): Promise<BridgeJsonRpcOutputMessage> {
  return harness.request(id, "turn/start", {
    threadId,
    providerThreadId: providerThreadIdFor(threadId),
    clientRequestId: `creq_abcdefghi${"23456789"[id % 8] ?? "2"}`,
    input: [{ type: "text", text, mentions: [] }],
    options,
  });
}

it(
  "preserves detached rows when replacement startup fails",
  async () => {
    const threadId = "thr_detached_failed_rebuild";
    await harness.startThread(threadId, { options: MINI });
    const initial = harness.deltasOf(threadId).length;

    expect(
      (await turnStart(1, threadId, "/detached-start run-old", MINI)).error,
    ).toBeUndefined();
    await harness.waitForDelta(
      threadId,
      (delta) =>
        delta.kind === "item.open" &&
        (delta.item as { type?: unknown }).type === "backgroundTask" &&
        (delta.item as { familyId?: unknown }).familyId ===
          "pi:detached:run-old",
      initial,
    );

    vi.stubEnv("FAKE_PI_EXIT_BEFORE_FIRST_RESPONSE", "1");
    const failed = await turnStart(
      2,
      threadId,
      "replacement fails",
      FULL_MODEL,
    );
    vi.stubEnv("FAKE_PI_EXIT_BEFORE_FIRST_RESPONSE", undefined);
    expect(failed.error).toMatchObject({ code: -32000 });

    const beforeCompletion = harness.deltasOf(threadId).length;
    expect(
      (await turnStart(3, threadId, "/detached-complete run-old", MINI)).error,
    ).toBeUndefined();
    await harness.waitForDelta(
      threadId,
      (delta) =>
        delta.kind === "item.close" &&
        (delta.item as { familyId?: unknown }).familyId ===
          "pi:detached:run-old" &&
        (delta.item as { status?: unknown }).status === "completed",
      beforeCompletion,
    );

    const oldRows = harness
      .deltasOf(threadId)
      .filter(
        (delta) =>
          delta.kind === "item.close" &&
          (delta.item as { familyId?: unknown }).familyId ===
            "pi:detached:run-old",
      );
    expect(oldRows).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ status: "completed" }),
      }),
    ]);
  },
  TEST_TIMEOUT_MS,
);

it(
  "reconciles old terminal signals received during a failed rebuild",
  async () => {
    const threadId = "thr_detached_failed_rebuild_terminal";
    await harness.startThread(threadId, { options: MINI });
    const initial = harness.deltasOf(threadId).length;

    expect(
      (await turnStart(1, threadId, "/detached-start run-old", MINI)).error,
    ).toBeUndefined();
    await harness.waitForDelta(
      threadId,
      (delta) =>
        delta.kind === "item.open" &&
        (delta.item as { familyId?: unknown }).familyId ===
          "pi:detached:run-old",
      initial,
    );
    expect(
      (
        await turnStart(
          2,
          threadId,
          "/detached-complete-later run-old 1000",
          MINI,
        )
      ).error,
    ).toBeUndefined();

    vi.stubEnv("FAKE_PI_NO_SESSION_START", "1");
    vi.stubEnv("BB_PI_BRIDGE_READINESS_TIMEOUT_MS", "3000");
    const failedTurn = turnStart(3, threadId, "replacement fails", FULL_MODEL);
    await harness.waitFor(
      () => harness.readProcessLog().spawned.length >= 3,
      "replacement Pi child to spawn",
    );
    const failed = await failedTurn;
    vi.stubEnv("FAKE_PI_NO_SESSION_START", undefined);
    vi.stubEnv("BB_PI_BRIDGE_READINESS_TIMEOUT_MS", undefined);
    expect(failed.error).toMatchObject({ code: -32000 });

    const oldRows = harness
      .deltasOf(threadId)
      .filter(
        (delta) =>
          delta.kind === "item.close" &&
          (delta.item as { familyId?: unknown }).familyId ===
            "pi:detached:run-old",
      );
    expect(oldRows).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ status: "completed" }),
      }),
    ]);
  },
  TEST_TIMEOUT_MS,
);

it.each(["complete", "paused"] as const)(
  "settles retired detached rows from a %s outcome during replacement startup",
  async (state) => {
    const threadId = `thr_detached_successful_rebuild_${state}`;
    await harness.startThread(threadId, { options: MINI });
    const initial = harness.deltasOf(threadId).length;

    expect(
      (await turnStart(1, threadId, "/detached-start run-retired", MINI)).error,
    ).toBeUndefined();
    await harness.waitForDelta(
      threadId,
      (delta) =>
        delta.kind === "item.open" &&
        (delta.item as { familyId?: unknown }).familyId ===
          "pi:detached:run-retired",
      initial,
    );

    const beforeScheduledCompletion = harness.deltasOf(threadId).length;
    const scheduledCompletion = turnStart(
      2,
      threadId,
      `/detached-complete-later run-retired 250 ${state}`,
      MINI,
    );
    await harness.waitForTurnBoundary(threadId, beforeScheduledCompletion);

    vi.stubEnv("FAKE_PI_STARTUP_DELAY_MS", "1000");
    const beforeReplacement = harness.deltasOf(threadId).length;
    const replacement = turnStart(
      3,
      threadId,
      "/detached-start run-replacement",
      FULL_MODEL,
    );
    await harness.waitFor(
      () => harness.readProcessLog().spawned.length >= 3,
      "replacement Pi child to spawn",
    );
    const replacementResponse = await replacement;
    vi.stubEnv("FAKE_PI_STARTUP_DELAY_MS", undefined);
    expect(replacementResponse.error).toBeUndefined();
    expect((await scheduledCompletion).error).toBeUndefined();

    await harness.waitForDelta(
      threadId,
      (delta) =>
        delta.kind === "item.open" &&
        (delta.item as { familyId?: unknown }).familyId ===
          "pi:detached:run-replacement",
      beforeReplacement,
    );
    await harness.waitForTurnBoundary(threadId, beforeReplacement);

    const replacementDeltas = harness
      .deltasOf(threadId)
      .slice(beforeReplacement);
    expect(replacementDeltas).toContainEqual(
      expect.objectContaining({
        kind: "item.close",
        item: expect.objectContaining({
          familyId: "pi:detached:run-retired",
          ...(state === "complete"
            ? {
                status: "completed",
                taskStatus: "completed",
                summary: "Detached subagent completed",
              }
            : {
                status: "interrupted",
                taskStatus: "paused",
                summary: "Detached subagent paused",
              }),
        }),
      }),
    );
    expect(replacementDeltas).not.toContainEqual(
      expect.objectContaining({
        kind: "item.close",
        item: expect.objectContaining({
          familyId: "pi:detached:run-retired",
          error: "Tracking lost; the TLH run may still be running.",
        }),
      }),
    );
    expect(replacementDeltas).toContainEqual(
      expect.objectContaining({
        kind: "item.open",
        item: expect.objectContaining({
          familyId: "pi:detached:run-replacement",
          status: "pending",
        }),
      }),
    );
  },
  TEST_TIMEOUT_MS,
);
