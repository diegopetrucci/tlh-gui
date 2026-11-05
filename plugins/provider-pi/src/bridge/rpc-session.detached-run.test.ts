import { afterEach, describe, expect, it, vi } from "vitest";
import {
  experimental_createDeltaAssembler as createDeltaAssembler,
  type ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createPiDeltaTranslator } from "../delta-translation.js";
import {
  parseDetachedRunChannelMessage,
  PiRpcSession,
  type DetachedRunUpdate,
  type PiRpcEvent,
} from "./rpc-session.js";

function createSession(
  onDetachedRunUpdate?: (update: DetachedRunUpdate) => void,
) {
  const events: PiRpcEvent[] = [];
  const session = new PiRpcSession(
    {
      cwd: ".",
      sessionFilePath: "unused",
      sessionDir: ".",
      scratchDir: ".",
      extensionPath: "unused",
      recordThreadId: "detached-test",
      onDetachedRunUpdate,
    },
    async () => ({ content: "" }),
    (event) => events.push(event),
    () => undefined,
  );
  const control = session as unknown as {
    handleEvent(event: PiRpcEvent): void;
    handleChannelMessage(message: Record<string, unknown>): void;
    deliveryChain: Promise<void>;
  };
  return { session, control, events };
}

function detachedLaunchEvent(
  asyncId: string,
  toolCallId = `call-${asyncId}`,
  details: Record<string, unknown> = {},
): PiRpcEvent {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName: "subagent",
    isError: false,
    result: {
      content: [{ type: "text", text: `Async: agent [${asyncId}]` }],
      details: {
        asyncId,
        mode: "single",
        results: [],
        ...details,
      },
    },
  };
}

function activity(...activeAsyncJobIds: string[]): Record<string, unknown> {
  return {
    kind: "tlh:effective-activity",
    activeAsyncJobIds,
  };
}

function detachedLaunchStartEvent(
  asyncId: string,
  toolCallId = `call-${asyncId}`,
): PiRpcEvent {
  return {
    type: "tool_execution_start",
    toolCallId,
    toolName: "subagent",
    args: { agent: "reviewer", task: `Review ${asyncId}` },
  };
}

function completion(runId: string, state: string): Record<string, unknown> {
  return {
    kind: "subagent:async-complete",
    runId,
    state,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("detached run FD boundary", () => {
  it("accepts only minimal internal messages and strips no fields in the session", () => {
    expect(parseDetachedRunChannelMessage(activity("run-1"))).toEqual(
      activity("run-1"),
    );
    expect(
      parseDetachedRunChannelMessage({
        ...completion("run-1", "complete"),
        prompt: "private prompt",
      }),
    ).toBeNull();
    expect(
      parseDetachedRunChannelMessage({
        ...activity("run-1"),
        task: "private task",
      }),
    ).toBeNull();
    expect(
      parseDetachedRunChannelMessage({
        kind: "subagent:async-complete",
        id: "run-2",
        state: "failed",
      }),
    ).toEqual({
      kind: "subagent:async-complete",
      id: "run-2",
      state: "failed",
    });
  });

  it("requires activity confirmation and associates only final launch results", async () => {
    const { session, control } = createSession();
    control.handleEvent({
      type: "tool_execution_update",
      toolCallId: "progress-call",
      toolName: "subagent",
      result: detachedLaunchEvent("progress-run").result,
    });
    control.handleEvent({
      type: "tool_execution_end",
      toolCallId: "management-call",
      toolName: "subagent",
      isError: true,
      result: {
        content: [{ type: "text", text: "status" }],
        details: { asyncId: "management-run", mode: "single", results: [] },
      },
    });
    control.handleChannelMessage(activity("run-1"));
    control.handleEvent(detachedLaunchEvent("run-1"));
    await control.deliveryChain;
    expect(session.getDetachedRunAssociations()).toEqual([
      {
        candidate: { asyncId: "run-1", mode: "single" },
        toolCallId: "call-run-1",
        eligible: true,
        outcome: null,
      },
    ]);
  });

  it("reconciles duplicate and out-of-order activity, result, and terminal signals", async () => {
    const { session, control } = createSession();
    control.handleChannelMessage(completion("run-1", "complete"));
    control.handleChannelMessage(activity("run-1", "run-1"));
    control.handleEvent(detachedLaunchEvent("run-1"));
    control.handleEvent(detachedLaunchEvent("run-1", "duplicate-call"));
    control.handleChannelMessage(completion("run-1", "complete"));
    await control.deliveryChain;
    expect(session.getDetachedRunAssociations()).toEqual([
      {
        candidate: { asyncId: "run-1", mode: "single" },
        toolCallId: "call-run-1",
        eligible: false,
        outcome: "completed",
      },
    ]);
  });

  it("keeps removal unknown until a later activity snapshot and never infers cancellation", () => {
    const { session, control } = createSession();
    control.handleChannelMessage(activity());
    control.handleEvent(detachedLaunchEvent("run-1"));
    expect(session.getDetachedRunAssociations()).toEqual([
      {
        candidate: { asyncId: "run-1", mode: "single" },
        toolCallId: "call-run-1",
        eligible: false,
        outcome: null,
      },
    ]);
    control.handleChannelMessage(activity("run-1"));
    expect(session.getDetachedRunAssociations()).toEqual([
      {
        candidate: { asyncId: "run-1", mode: "single" },
        toolCallId: "call-run-1",
        eligible: true,
        outcome: null,
      },
    ]);
  });

  it("bounds inactive settlement grace and cancels timers on reactivation, terminal, and reset", async () => {
    vi.useFakeTimers();
    const updates: DetachedRunUpdate[] = [];
    const { session, control } = createSession((update) =>
      updates.push(update),
    );

    control.handleChannelMessage(activity("run-1"));
    control.handleEvent(detachedLaunchEvent("run-1"));
    await control.deliveryChain;

    control.handleChannelMessage(activity());
    await control.deliveryChain;
    const afterRemoval = updates.length;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(updates).toHaveLength(afterRemoval);

    control.handleChannelMessage(activity("run-1"));
    await control.deliveryChain;
    const afterReactivation = updates.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updates).toHaveLength(afterReactivation);

    control.handleChannelMessage(activity());
    await control.deliveryChain;
    control.handleChannelMessage(completion("run-1", "complete"));
    await control.deliveryChain;
    const afterCompletion = updates.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updates).toHaveLength(afterCompletion);

    control.handleChannelMessage(activity("run-2"));
    control.handleEvent(detachedLaunchEvent("run-2"));
    await control.deliveryChain;
    control.handleChannelMessage(activity());
    await control.deliveryChain;
    session.resetDetachedRunTracking();
    const afterReset = updates.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updates).toHaveLength(afterReset);
    session.kill();
  });

  it("keeps a recorded terminal outcome in cleanup when kill drops its queued update", async () => {
    const updates: DetachedRunUpdate[] = [];
    const { session, control } = createSession((update) =>
      updates.push(update),
    );
    control.handleChannelMessage(activity("run-1"));
    control.handleEvent(detachedLaunchEvent("run-1"));
    await control.deliveryChain;
    updates.length = 0;

    control.handleChannelMessage(completion("run-1", "complete"));
    session.kill();

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      cleanup: true,
      associations: [
        {
          candidate: { asyncId: "run-1" },
          outcome: "completed",
        },
      ],
    });
    await control.deliveryChain;
    expect(updates).toHaveLength(1);
  });

  it("settles RPC activity removal and late completion through the translator and assembler", async () => {
    vi.useFakeTimers();
    const threadId = "rpc-assembled-thread";
    const translator = createPiDeltaTranslator({
      resolveModelContextWindow: () => null,
    });
    const assembler = createDeltaAssembler({
      providerId: "pi",
      entropyPrefix: "rpc-assembled",
      textDeltaFlushMs: 0,
    });
    const events: ThreadEvent[] = [];
    const emit = (deltas: ReturnType<typeof translator.translate>): void => {
      events.push(...assembler.assemble({ threadId, deltas }));
    };
    const onEvent = (event: PiRpcEvent): void => {
      emit(translator.translate(event, { threadId }));
    };
    const eventSession = new PiRpcSession(
      {
        cwd: ".",
        sessionFilePath: "unused",
        sessionDir: ".",
        scratchDir: ".",
        extensionPath: "unused",
        recordThreadId: threadId,
        onDetachedRunUpdate: (update) => {
          emit(
            translator.translateDetachedRunLifecycle(update.associations, {
              threadId,
              sessionSerial: 1,
              cleanup: update.cleanup,
            }),
          );
        },
      },
      async () => ({ content: "" }),
      onEvent,
      () => undefined,
    );
    const eventControl = eventSession as unknown as {
      handleEvent(event: PiRpcEvent): void;
      handleChannelMessage(message: Record<string, unknown>): void;
      deliveryChain: Promise<void>;
    };

    eventControl.handleEvent({ type: "agent_start" });
    eventControl.handleChannelMessage(activity("run-1"));
    eventControl.handleEvent(detachedLaunchStartEvent("run-1"));
    eventControl.handleEvent(detachedLaunchEvent("run-1"));
    await eventControl.deliveryChain;

    const started = events.find(
      (event): event is Extract<ThreadEvent, { type: "item/started" }> =>
        event.type === "item/started" && event.item.type === "backgroundTask",
    );
    expect(started).toBeDefined();

    eventControl.handleChannelMessage(activity());
    await eventControl.deliveryChain;
    expect(
      events.some((event) => event.type === "item/backgroundTask/completed"),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    await eventControl.deliveryChain;
    const lost = [...events]
      .reverse()
      .find(
        (
          event,
        ): event is Extract<
          ThreadEvent,
          { type: "item/backgroundTask/completed" }
        > => event.type === "item/backgroundTask/completed",
      );
    expect(lost).toMatchObject({
      item: {
        status: "failed",
        taskStatus: "failed",
        error: "Tracking lost; the TLH run may still be running.",
      },
    });

    const beforeCorrection = events.length;
    eventControl.handleChannelMessage(completion("run-1", "complete"));
    await eventControl.deliveryChain;
    const corrected = [...events]
      .reverse()
      .find(
        (
          event,
        ): event is Extract<
          ThreadEvent,
          { type: "item/backgroundTask/completed" }
        > => event.type === "item/backgroundTask/completed",
      );
    expect(corrected).toMatchObject({
      item: {
        status: "completed",
        taskStatus: "completed",
        summary: "Detached subagent completed",
      },
    });
    expect(corrected?.item.id).not.toBe(lost?.item.id);
    expect(
      events
        .slice(beforeCorrection)
        .some(
          (event) =>
            event.type === "item/started" &&
            event.item.type === "backgroundTask",
        ),
    ).toBe(false);

    eventSession.kill();
  });

  it("settles activity removal then terminal completion within grace once", async () => {
    vi.useFakeTimers();
    const threadId = "rpc-assembled-within-grace";
    const translator = createPiDeltaTranslator({
      resolveModelContextWindow: () => null,
    });
    const assembler = createDeltaAssembler({
      providerId: "pi",
      entropyPrefix: "rpc-assembled-within-grace",
      textDeltaFlushMs: 0,
    });
    const events: ThreadEvent[] = [];
    const emit = (deltas: ReturnType<typeof translator.translate>): void => {
      events.push(...assembler.assemble({ threadId, deltas }));
    };
    const eventSession = new PiRpcSession(
      {
        cwd: ".",
        sessionFilePath: "unused",
        sessionDir: ".",
        scratchDir: ".",
        extensionPath: "unused",
        recordThreadId: threadId,
        onDetachedRunUpdate: (update) => {
          emit(
            translator.translateDetachedRunLifecycle(update.associations, {
              threadId,
              sessionSerial: 1,
              cleanup: update.cleanup,
            }),
          );
        },
      },
      async () => ({ content: "" }),
      (event) => emit(translator.translate(event, { threadId })),
      () => undefined,
    );
    const eventControl = eventSession as unknown as {
      handleEvent(event: PiRpcEvent): void;
      handleChannelMessage(message: Record<string, unknown>): void;
      deliveryChain: Promise<void>;
    };

    eventControl.handleEvent({ type: "agent_start" });
    eventControl.handleEvent(detachedLaunchStartEvent("run-1"));
    eventControl.handleChannelMessage(activity("run-1"));
    eventControl.handleEvent(detachedLaunchEvent("run-1"));
    await eventControl.deliveryChain;

    eventControl.handleChannelMessage(activity());
    await eventControl.deliveryChain;
    await vi.advanceTimersByTimeAsync(4_999);
    eventControl.handleChannelMessage(completion("run-1", "complete"));
    await eventControl.deliveryChain;

    const terminalEvents = events.filter(
      (
        event,
      ): event is Extract<
        ThreadEvent,
        { type: "item/backgroundTask/completed" }
      > => event.type === "item/backgroundTask/completed",
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).toMatchObject({
      item: {
        status: "completed",
        taskStatus: "completed",
        summary: "Detached subagent completed",
      },
    });
    expect(terminalEvents[0]).not.toMatchObject({
      item: { error: "Tracking lost; the TLH run may still be running." },
    });
    await vi.advanceTimersByTimeAsync(1);
    await eventControl.deliveryChain;
    expect(
      events.filter((event) => event.type === "item/backgroundTask/completed"),
    ).toHaveLength(1);
    eventSession.kill();
  });

  it("keeps a paused tombstone from resurrecting an old run after a resume", () => {
    const { session, control } = createSession();
    control.handleChannelMessage(activity("old-run", "new-run"));
    control.handleEvent(detachedLaunchEvent("old-run", "old-call"));
    control.handleChannelMessage(completion("old-run", "paused"));
    control.handleEvent(
      detachedLaunchEvent("new-run", "new-call", { mode: "parallel" }),
    );
    expect(session.getDetachedRunAssociations()).toEqual([
      {
        candidate: { asyncId: "old-run", mode: "single" },
        toolCallId: "old-call",
        eligible: false,
        outcome: "paused",
      },
      {
        candidate: { asyncId: "new-run", mode: "parallel" },
        toolCallId: "new-call",
        eligible: true,
        outcome: null,
      },
    ]);
    control.handleChannelMessage(activity("old-run", "new-run"));
    expect(session.getDetachedRunAssociations()[0]).toMatchObject({
      candidate: { asyncId: "old-run" },
      eligible: false,
      outcome: "paused",
    });
  });

  it("resets and disposes session-local tracking", () => {
    const { session, control } = createSession();
    control.handleChannelMessage(activity("run-1"));
    control.handleEvent(detachedLaunchEvent("run-1"));
    expect(session.getDetachedRunAssociations()).toHaveLength(1);
    session.resetDetachedRunTracking();
    expect(session.getDetachedRunAssociations()).toEqual([]);
    control.handleChannelMessage(activity("run-2"));
    control.handleEvent(detachedLaunchEvent("run-2"));
    expect(session.getDetachedRunAssociations()).toHaveLength(1);
    session.kill();
    expect(session.getDetachedRunAssociations()).toEqual([]);
    control.handleChannelMessage(activity("run-3"));
    control.handleEvent(detachedLaunchEvent("run-3"));
    expect(session.getDetachedRunAssociations()).toEqual([]);
  });
});
