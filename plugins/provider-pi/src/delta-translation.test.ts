import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import {
  experimental_createDeltaAssembler as createDeltaAssembler,
  type DeltaAssembler,
  type ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  createPiDeltaTranslator,
  createPiModelContextWindowResolverFrom,
  type PiDetachedRunAssociation,
  type PiModelContextWindowResolver,
} from "./delta-translation.js";

const builtinCatalogResolver = createPiModelContextWindowResolverFrom(
  getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider)),
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "./__fixtures__/pi");

function threadScope(): ThreadEvent["scope"] {
  return { kind: "thread" };
}

function turnScope(turnId: string): ThreadEvent["scope"] {
  return { kind: "turn", turnId };
}

const THREAD_ID = "bb-thread-1";
const ENTROPY = "pi-test";
const TURN_ID_PATTERN = /^pi-test-t\d+$/;
const ITEM_ID_PATTERN = /^pi-test-i\d+$/;

function loadFixture(name: string): AgentSessionEvent {
  return JSON.parse(
    readFileSync(resolve(FIXTURES, name), "utf8"),
  ) as AgentSessionEvent;
}

interface PiTestContext {
  cwd?: string;
  threadId?: string;
  parentToolCallId?: string;
}

interface PiEquivalenceHarness {
  assembler: DeltaAssembler;
  translate(event: unknown, context?: PiTestContext): ThreadEvent[];
  translateDetached(
    associations:
      | readonly PiDetachedRunAssociation[]
      | PiDetachedRunAssociation,
    options?: { cleanup?: boolean; sessionSerial?: number },
  ): ThreadEvent[];
  openTurnId(): string;
}

function createHarness(options?: {
  resolveModelContextWindow?: PiModelContextWindowResolver;
}): PiEquivalenceHarness {
  const translator = createPiDeltaTranslator({
    resolveModelContextWindow:
      options?.resolveModelContextWindow ?? builtinCatalogResolver,
  });
  const assembler = createDeltaAssembler({
    providerId: "pi",
    entropyPrefix: ENTROPY,
    textDeltaFlushMs: 0,
  });
  return {
    assembler,
    translate(event, context) {
      return assembler.assemble({
        threadId: context?.threadId ?? THREAD_ID,
        deltas: translator.translate(event, context),
      });
    },
    translateDetached(associations, options) {
      const entries = Array.isArray(associations)
        ? associations
        : [associations];
      return assembler.assemble({
        threadId: THREAD_ID,
        deltas: translator.translateDetachedRunLifecycle(entries, {
          threadId: THREAD_ID,
          sessionSerial: options?.sessionSerial ?? 1,
          cleanup: options?.cleanup,
        }),
      });
    },
    openTurnId() {
      return assembler.getOpenTurnId(THREAD_ID) ?? "";
    },
  };
}

function sdkMessage(message: unknown) {
  return {
    jsonrpc: "2.0" as const,
    method: "sdk/message",
    params: { threadId: "pi-thread-1", message },
  };
}

function createPiCustomMessage(args: {
  content: string | Array<Record<string, unknown>>;
  display?: boolean;
}) {
  return {
    role: "custom",
    customType: "ad-process:notification",
    content: args.content,
    display: args.display ?? true,
    details: { attention: "turn", kind: "success", processId: "proc_551c" },
    timestamp: 1_786_919_243_630,
  };
}

function createPiAgentErrorEvent(
  errorMessage: string,
  willRetry: boolean,
): AgentSessionEvent {
  return {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 1777995781000,
      },
    ],
    willRetry,
  };
}

interface PiBashStartEventArgs {
  command: string;
  cwd?: string;
  toolCallId: string;
}

function createPiBashStartEvent(args: PiBashStartEventArgs): AgentSessionEvent {
  return {
    type: "tool_execution_start",
    toolCallId: args.toolCallId,
    toolName: "bash",
    args: { command: args.command, cwd: args.cwd ?? "/repo" },
  };
}

interface PiBashUpdateEventArgs {
  text: string;
  threadId: string;
  toolCallId: string;
}

function createPiBashUpdateEvent(args: PiBashUpdateEventArgs) {
  return {
    jsonrpc: "2.0" as const,
    method: "sdk/message",
    params: {
      threadId: args.threadId,
      message: {
        type: "tool_execution_update" as const,
        toolCallId: args.toolCallId,
        toolName: "bash" as const,
        partialResult: {
          content: [{ type: "text" as const, text: args.text }],
        },
      },
    },
  };
}

function createTextDeltaEvent(): AgentSessionEvent {
  return loadFixture("message-update-delta.json");
}

function agentMessageDeltaId(events: ThreadEvent[]): string | undefined {
  const delta = events.find(
    (
      event,
    ): event is Extract<ThreadEvent, { type: "item/agentMessage/delta" }> =>
      event.type === "item/agentMessage/delta",
  );
  return delta?.itemId;
}

describe("pi delta translation equivalence", () => {
  it("keeps turn_start as internal noise while agent_start owns the bb turn", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "turn_start",
    } as AgentSessionEvent);

    expect(events).toEqual([]);
  });

  it("agent_start opens exactly one bb turn", () => {
    const harness = createHarness();
    const events = harness.translate(loadFixture("agent-start.json"));
    expect(events).toEqual([
      expect.objectContaining({ type: "turn/started", threadId: "" }),
    ]);
    expect(harness.openTurnId()).toMatch(TURN_ID_PATTERN);
    expect(harness.translate(loadFixture("agent-start.json"))).toEqual([]);
  });

  it("agent_end emits agentMessage + turn/completed", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      ...loadFixture("agent-end-with-message.json"),
      providerCheckpointId: "pi-entry-42",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          text: "I've updated the configuration file to use the new database connection string. The change affects `/src/config/database.ts` and should resolve the timeout issues you were experiencing.",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
        providerCheckpointId: "pi-entry-42",
      }),
    );
    expect(events.some((event) => event.type === "provider/error")).toBe(false);
  });

  it("completes extension-triggered turns when agent_end includes string custom content", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      type: "agent_end",
      messages: [
        {
          role: "custom",
          customType: "pi-processes",
          content: "Process completed successfully",
          display: true,
          timestamp: 1777995780000,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "The process finished." }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 1777995781000,
        },
      ],
      willRetry: false,
    } satisfies AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
      }),
    );
    expect(events.some((event) => event.type === "provider/unhandled")).toBe(
      false,
    );
  });

  it("records a displayed Pi custom message as the input of the turn it triggered", () => {
    const harness = createHarness();
    harness.translate(sdkMessage(loadFixture("agent-start.json")));
    const turnId = harness.openTurnId();
    const message = createPiCustomMessage({
      content:
        '<process_event kind="success" process_id="proc_551c">Process completed successfully</process_event>',
    });

    const startEvents = harness.translate(
      sdkMessage({ type: "message_start", message }),
    );
    const endEvents = harness.translate(
      sdkMessage({ type: "message_end", message }),
    );

    expect(startEvents).toEqual([
      {
        type: "item/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "userMessage",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          content: [
            {
              type: "text",
              text: '<process_event kind="success" process_id="proc_551c">Process completed successfully</process_event>',
            },
          ],
        },
      },
    ]);
    expect(endEvents).toEqual([]);
    expect(harness.openTurnId()).toBe(turnId);
  });

  it("joins the text blocks of an array-content Pi custom message", () => {
    const harness = createHarness();
    harness.translate(sdkMessage(loadFixture("agent-start.json")));

    const events = harness.translate(
      sdkMessage({
        type: "message_start",
        message: createPiCustomMessage({
          content: [
            { type: "text", text: "first" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
            { type: "text", text: "second" },
          ],
        }),
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "userMessage",
          content: [{ type: "text", text: "first\nsecond" }],
        }),
      }),
    ]);
  });

  it("drops hidden and idle Pi custom messages without surfacing them as unhandled", () => {
    const harness = createHarness();

    const idleMessage = createPiCustomMessage({ content: "idle context note" });
    expect(
      harness.translate(
        sdkMessage({ type: "message_start", message: idleMessage }),
      ),
    ).toEqual([]);
    expect(
      harness.translate(
        sdkMessage({ type: "message_end", message: idleMessage }),
      ),
    ).toEqual([]);
    expect(harness.openTurnId()).toBe("");

    harness.translate(sdkMessage(loadFixture("agent-start.json")));
    const hiddenMessage = createPiCustomMessage({
      content: "hidden",
      display: false,
    });
    expect(
      harness.translate(
        sdkMessage({ type: "message_start", message: hiddenMessage }),
      ),
    ).toEqual([]);
    expect(
      harness.translate(
        sdkMessage({ type: "message_end", message: hiddenMessage }),
      ),
    ).toEqual([]);
  });

  it("agent_end preserves the checkpoint when Pi assistant stop errors fail the turn", () => {
    const harness = createHarness();
    const quotaMessage =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011CajgGfxCAhmznZJw7t6Br"}';

    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      ...createPiAgentErrorEvent(quotaMessage, false),
      providerCheckpointId: "pi-failed-entry",
    });

    expect(events).toEqual([
      {
        type: "provider/error",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        message: "Provider error",
        detail: quotaMessage,
      },
      {
        type: "turn/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        status: "failed",
        providerCheckpointId: "pi-failed-entry",
      },
    ]);
    expect(events.some((event) => event.type === "item/completed")).toBe(false);
  });

  it("keeps the Pi turn active while the SDK retries an assistant error", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const retryEvents = harness.translate(
      createPiAgentErrorEvent("temporary provider failure", true),
    );
    const completedEvents = harness.translate(
      loadFixture("agent-end-with-message.json"),
    );

    expect(retryEvents).toEqual([
      expect.objectContaining({
        type: "provider/error",
        detail: "temporary provider failure",
        willRetry: true,
      }),
    ]);
    expect(retryEvents.some((event) => event.type === "turn/completed")).toBe(
      false,
    );
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
      }),
    );
  });

  it("compaction_start emits a compaction item in the open turn", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      type: "compaction_start",
      reason: "threshold",
    } satisfies AgentSessionEvent);

    expect(events).toEqual([
      expect.objectContaining({
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "contextCompaction",
          id: expect.stringMatching(ITEM_ID_PATTERN),
        },
      }),
    ]);
  });

  it("compaction_end emits thread/compacted", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate({
      type: "compaction_start",
      reason: "threshold",
    } satisfies AgentSessionEvent);

    const events = harness.translate({
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
    } satisfies AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/compacted",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
      }),
    );
  });

  it.each([
    {
      label: "failed",
      end: { aborted: false, errorMessage: "Automatic compaction overflowed" },
      detail: "Automatic compaction overflowed",
    },
    {
      label: "aborted",
      end: { aborted: true },
      detail: "Automatic context compaction was interrupted",
    },
  ])("terminates a $label automatic compaction", ({ end, detail }) => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate({
      type: "compaction_start",
      reason: "threshold",
    } satisfies AgentSessionEvent);

    const events = harness.translate({
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      willRetry: false,
      ...end,
    } satisfies AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(turnId),
        detail,
      }),
    );
    expect(events.some((event) => event.type === "thread/compacted")).toBe(
      false,
    );
  });

  function translateManualCompaction(args: {
    aborted: boolean;
    errorMessage?: string;
  }) {
    const harness = createHarness();
    const started = harness.translate({
      type: "compaction_start",
      reason: "manual",
    } satisfies AgentSessionEvent);
    const turnId = harness.openTurnId();
    const completed = harness.translate({
      type: "compaction_end",
      reason: "manual",
      result: undefined,
      willRetry: false,
      ...args,
    } satisfies AgentSessionEvent);
    return { completed, started, turnId };
  }

  it("manual compaction owns a complete maintenance turn", () => {
    const { completed, started, turnId } = translateManualCompaction({
      aborted: false,
    });

    expect(started.map((event) => event.type)).toEqual([
      "turn/started",
      "item/started",
    ]);
    expect(completed).toEqual([
      expect.objectContaining({
        type: "thread/compacted",
        scope: turnScope(turnId),
      }),
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
      }),
    ]);
  });

  it.each([
    "Compaction failed: Nothing to compact (session too small)",
    "Compaction failed: Already compacted",
  ])(
    "manual compaction refusal %j completes the turn as a no-op",
    (errorMessage) => {
      const { completed, turnId } = translateManualCompaction({
        aborted: false,
        errorMessage,
      });

      expect(completed).toEqual([
        expect.objectContaining({
          type: "provider/warning",
          scope: turnScope(turnId),
          category: "compaction-skipped",
          summary: "Context compaction skipped",
          details: errorMessage,
        }),
        expect.objectContaining({
          type: "turn/completed",
          scope: turnScope(turnId),
          status: "completed",
        }),
      ]);
      expect(completed.some((event) => event.type === "thread/compacted")).toBe(
        false,
      );
    },
  );

  it.each([
    {
      label: "failed",
      args: {
        aborted: false,
        errorMessage: "Compaction failed: Summarization failed: 500",
      },
      expected: {
        status: "failed",
        error: {
          message: "Compaction failed: Summarization failed: 500",
        },
      },
    },
    {
      label: "aborted",
      args: { aborted: true },
      expected: { status: "interrupted" },
    },
  ])(
    "$label manual compaction does not report success",
    ({ args, expected }) => {
      const { completed, turnId } = translateManualCompaction(args);
      expect(completed).toEqual([
        expect.objectContaining({
          type: "turn/completed",
          scope: turnScope(turnId),
          ...expected,
        }),
      ]);
    },
  );

  it("compaction_end without a known turn is unhandled", () => {
    const harness = createHarness();
    const events = harness.translate({
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
    } satisfies AgentSessionEvent);

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/compaction_end",
        scope: threadScope(),
        rawEvent: expect.objectContaining({ method: "sdk/message" }),
      }),
    ]);
  });

  it("compaction_start reuses the last completed turn id without opening a new turn", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate(loadFixture("agent-end-with-message.json"));

    const events = harness.translate({
      type: "compaction_start",
      reason: "threshold",
    } satisfies AgentSessionEvent);

    expect(events).toEqual([
      {
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "contextCompaction",
          id: expect.stringMatching(ITEM_ID_PATTERN),
        },
      },
    ]);
    expect(harness.openTurnId()).toBe("");
  });

  it("reuses the streamed assistant item id when the turn ends", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const deltaEvents = harness.translate(createTextDeltaEvent());
    const deltaItemId = agentMessageDeltaId(deltaEvents);
    const completedEvents = harness.translate(
      loadFixture("agent-end-with-message.json"),
    );

    expect(deltaItemId).toMatch(ITEM_ID_PATTERN);
    expect(deltaEvents.map((event) => event.type)).toEqual([
      "item/started",
      "item/agentMessage/delta",
    ]);
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: deltaItemId,
        }),
      }),
    );
  });

  it("assigns a new assistant id after a tool call interrupts streaming", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const preDelta = harness.translate(createTextDeltaEvent());
    const preItemId = agentMessageDeltaId(preDelta);

    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "ls" },
    });

    const postDelta = harness.translate(createTextDeltaEvent());
    const postItemId = agentMessageDeltaId(postDelta);

    const endEvents = harness.translate(
      loadFixture("agent-end-with-message.json"),
    );
    const completed = endEvents.find(
      (event) =>
        event.type === "item/completed" && event.item.type === "agentMessage",
    );

    expect(preItemId).toMatch(ITEM_ID_PATTERN);
    expect(postItemId).toMatch(ITEM_ID_PATTERN);
    expect(preItemId).not.toBe(postItemId);
    expect(completed).toBeDefined();
    if (
      completed?.type === "item/completed" &&
      completed.item.type === "agentMessage"
    ) {
      expect(completed.item.id).toBe(postItemId);
    }
  });

  it("streams and finalizes Pi thinking with a stable reasoning id", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const deltaEvents = harness.translate({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Thinking through the edit.",
      },
    } as AgentSessionEvent);
    const reasoningDelta = deltaEvents.find(
      (
        event,
      ): event is Extract<ThreadEvent, { type: "item/reasoning/textDelta" }> =>
        event.type === "item/reasoning/textDelta",
    );

    const completedEvents = harness.translate({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "Thinking through the edit.",
      },
    } as AgentSessionEvent);

    expect(reasoningDelta?.itemId).toMatch(ITEM_ID_PATTERN);
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "reasoning",
          id: reasoningDelta?.itemId,
          content: ["Thinking through the edit."],
        }),
      }),
    );
  });

  it("surfaces Pi thinking without contentIndex as provider/unhandled", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "Thinking without a scope.",
      },
    } as AgentSessionEvent);

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/message_update:thinking_delta",
        scope: turnScope(turnId),
      }),
    ]);
  });

  it("tool_execution_start emits item/started with an assembler-minted id", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate(
      loadFixture("tool-execution-start-bash.json"),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          status: "pending",
        }),
      }),
    ]);
    const startedId =
      events[0]?.type === "item/started" ? events[0].item.id : "";
    expect(harness.assembler.getProviderItemId(THREAD_ID, startedId)).toBe(
      "tc_01a2b3c4d5e6f7g8h9i0j1k2",
    );
  });

  it("keeps the call's own cwd over the session's", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const events = harness.translate(
      loadFixture("tool-execution-start-bash.json"),
      { threadId: THREAD_ID, cwd: "/work/tree" },
    );
    expect(events[0]).toMatchObject({
      type: "item/started",
      item: { type: "commandExecution", cwd: "/Users/developer/project" },
    });
  });

  it("never fabricates a command item without a cwd, on start or on a close without start", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const started = harness.translate(
      sdkMessage({
        type: "tool_execution_start",
        toolCallId: "tool-bash-nocwd",
        toolName: "bash",
        args: { command: "ls" },
      }),
    );
    expect(started[0]).toMatchObject({
      type: "item/started",
      item: { type: "toolCall" },
    });
    const closed = harness.translate(
      sdkMessage({
        type: "tool_execution_end",
        toolCallId: "tool-bash-unseen",
        toolName: "bash",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      }),
    );
    expect(
      closed.some(
        (event) =>
          event.type === "item/started" || event.type === "item/completed",
      ),
    ).toBe(true);
    expect(JSON.stringify(closed)).not.toContain('"cwd":""');
    expect(
      closed.every(
        (event) => !("item" in event) || event.item.type !== "commandExecution",
      ),
    ).toBe(true);
  });

  it("maps parent_tool_use_id on nested sdk/message events to the parent's minted id", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        parent_tool_use_id: "agent-parent-1",
        message: {
          type: "tool_execution_start",
          toolCallId: "tool-bash-1",
          toolName: "bash",
          args: { command: "ls", cwd: "/repo" },
        },
      },
    });

    const started = events.find(
      (event) =>
        event.type === "item/started" && event.item.type === "commandExecution",
    );
    if (started?.type !== "item/started") {
      throw new Error("expected a commandExecution item/started");
    }
    expect(started.item.parentToolCallId).toBeDefined();
    expect(started.item.parentToolCallId).not.toBe("agent-parent-1");
    const parentEvents = harness.translate({
      type: "tool_execution_start",
      toolCallId: "agent-parent-1",
      toolName: "spawn_agent",
      args: {},
    } as AgentSessionEvent);
    expect(parentEvents).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          id: started.item.parentToolCallId,
        }),
      }),
    );
  });

  it("falls back to a generic tool call when bash args are malformed", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: 42 },
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "bash",
          status: "pending",
        }),
      }),
    );
  });

  it("surfaces malformed handled sdk envelopes as provider/unhandled", () => {
    const harness = createHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: { type: "agent_end" },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/agent_end",
        scope: threadScope(),
        rawEvent: expect.objectContaining({ method: "sdk/message" }),
      }),
    ]);
  });

  it("drops agent_settled instead of surfacing it in the transcript", () => {
    const harness = createHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: { type: "agent_settled" },
      },
    });

    expect(events).toEqual([]);
  });

  it("scopes unknown sdk envelopes to the active turn", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: { type: "future_event", value: true },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        scope: turnScope(turnId),
        rawEvent: expect.objectContaining({ method: "sdk/message" }),
      }),
    ]);
  });

  it("keeps late unknown sdk envelopes thread scoped", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    harness.translate(loadFixture("agent-end-with-message.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: { type: "future_event", value: true },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        scope: threadScope(),
        rawEvent: expect.objectContaining({ method: "sdk/message" }),
      }),
    ]);
  });

  it("tool_execution_start with edit args emits fileChange with diff", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-edit-1",
      toolName: "edit",
      args: {
        path: "src/app.ts",
        oldText: "const enabled = false;\n",
        newText: "const enabled = true;\n",
      },
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "fileChange",
          status: "pending",
          changes: [
            expect.objectContaining({
              path: "src/app.ts",
              diff: expect.stringContaining("const enabled = true;"),
            }),
          ],
        }),
      }),
    );
  });

  it("tool_execution_start with edit batch args marks the change as an update", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-edit-batch",
      toolName: "edit",
      args: {
        path: "src/app.ts",
        edits: [
          { oldText: "before", newText: "after" },
          { oldText: "second before", newText: "second after" },
        ],
      },
    } as AgentSessionEvent);

    const started = events.find(
      (event): event is Extract<ThreadEvent, { type: "item/started" }> =>
        event.type === "item/started",
    );
    expect(started?.item).toMatchObject({
      type: "fileChange",
      status: "pending",
    });
    if (!started || started.item.type !== "fileChange") return;
    expect(started.item.changes[0]).toMatchObject({
      path: "src/app.ts",
      kind: "update",
    });
    expect(started.item.changes).toHaveLength(2);
    expect(started.item.changes[0]?.diff).toContain("+after");
    expect(started.item.changes[0]?.diff).toContain("-before");
    expect(started.item.changes[1]?.diff).toContain("+second after");
    expect(started.item.changes[1]?.diff).toContain("-second before");
  });

  it("falls back to an update without a diff for unrecognized edit batches", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-edit-unknown-batch",
      toolName: "edit",
      args: {
        path: "src/app.ts",
        edits: [{ old: "before", replacement: "after" }],
      },
    } as AgentSessionEvent);

    const started = events.find(
      (event): event is Extract<ThreadEvent, { type: "item/started" }> =>
        event.type === "item/started",
    );
    expect(started?.item).toMatchObject({
      type: "fileChange",
      status: "pending",
      changes: [{ path: "src/app.ts", kind: "update" }],
    });
    if (!started || started.item.type !== "fileChange") return;
    expect(started.item.changes[0]?.diff).toBeUndefined();
  });

  it("tool_execution_start with content-only write args marks the change as an add", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-write-1",
      toolName: "write",
      args: { path: "src/app.ts", content: "console.log('updated');\n" },
    } as AgentSessionEvent);

    const started = events.find(
      (event): event is Extract<ThreadEvent, { type: "item/started" }> =>
        event.type === "item/started",
    );
    expect(started?.item).toMatchObject({
      type: "fileChange",
      status: "pending",
      changes: [{ path: "src/app.ts", kind: "add" }],
    });
    if (!started || started.item.type !== "fileChange") return;
    expect(started.item.changes[0]?.diff).toContain("+++ b/src/app.ts");
  });

  it("tool_execution_start with read args preserves structured tool arguments", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-read-1",
      toolName: "read",
      args: { path: "src/app.ts", offset: 1, limit: 20 },
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "read",
          status: "pending",
          arguments: expect.objectContaining({
            path: "src/app.ts",
            offset: 1,
            limit: 20,
          }),
        }),
      }),
    );
  });

  it("tool_execution_end emits item/completed under the started item's id", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const started = harness.translate(
      loadFixture("tool-execution-start-bash.json"),
    );
    const startedId =
      started[0]?.type === "item/started" ? started[0].item.id : "";

    const events = harness.translate(
      loadFixture("tool-execution-end-bash.json"),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: startedId,
          status: "completed",
        }),
      }),
    );
  });

  it("tool_execution_end marks bash failures", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "npm test", cwd: "/repo" },
    } as AgentSessionEvent);

    const events = harness.translate({
      type: "tool_execution_end",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      isError: true,
      result: "tests failed",
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          command: "npm test",
          cwd: "/repo",
          aggregatedOutput: "tests failed",
          exitCode: 1,
          status: "failed",
        }),
      }),
    );
  });

  it("recovers non-bash tool results from the started item", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-read-1",
      toolName: "read",
      args: { path: "src/app.ts", offset: 1, limit: 20 },
    } as AgentSessionEvent);

    const events = harness.translate({
      type: "tool_execution_end",
      toolCallId: "tool-read-1",
      toolName: "read",
      isError: false,
      result: "file contents",
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "read",
          status: "completed",
          result: "file contents",
          arguments: expect.objectContaining({
            path: "src/app.ts",
            offset: 1,
            limit: 20,
          }),
        }),
      }),
    );
  });

  it("maps bash tool execution updates to command output deltas", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const started = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "printf 'FIRST\\nSECOND\\n'", cwd: "/repo" },
    } as AgentSessionEvent);
    const startedId =
      started[0]?.type === "item/started" ? started[0].item.id : "";

    const firstEvents = harness.translate(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "FIRST\n",
      }),
    );

    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        itemId: startedId,
        delta: "FIRST\n",
      }),
    );

    const secondEvents = harness.translate(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "FIRST\nSECOND\n",
      }),
    );

    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        itemId: startedId,
        delta: "SECOND\n",
      }),
    );
  });

  it("emits the full bash delta when Pi resets cumulative output", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    harness.translate(
      createPiBashStartEvent({
        toolCallId: "tool-bash-1",
        command: "printf 'FIRST\\nSECOND\\n'",
      }),
    );

    harness.translate(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "FIRST\nSECOND\n",
      }),
    );

    const resetEvents = harness.translate(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "RESET\n",
      }),
    );

    expect(resetEvents).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "RESET\n",
        reset: true,
      }),
    );
  });

  it("clears bash output snapshots when a turn completes", () => {
    const harness = createHarness();

    harness.translate(loadFixture("agent-start.json"));
    harness.translate(
      createPiBashStartEvent({
        toolCallId: "tool-bash-1",
        command: "printf 'FIRST\\n'",
      }),
    );
    harness.translate(
      createPiBashUpdateEvent({
        threadId: THREAD_ID,
        toolCallId: "tool-bash-1",
        text: "FIRST\n",
      }),
    );

    harness.translate(loadFixture("agent-end-with-message.json"));

    harness.translate(loadFixture("agent-start.json"));
    harness.translate(
      createPiBashStartEvent({
        toolCallId: "tool-bash-1",
        command: "printf 'FIRST\\nSECOND\\n'",
      }),
    );
    const events = harness.translate(
      createPiBashUpdateEvent({
        threadId: THREAD_ID,
        toolCallId: "tool-bash-1",
        text: "FIRST\nSECOND\n",
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "FIRST\nSECOND\n",
      }),
    );
  });

  it("skips empty bash updates with no content", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "",
      }),
    );

    expect(events).toEqual([]);
  });

  it("skips Pi bash update placeholders", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "(no output)",
      }),
    );

    expect(events).toEqual([]);
  });

  it("keeps non-bash tool execution updates as shared tool progress", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "tool_execution_update",
          toolCallId: "tool-read-1",
          toolName: "read",
          partialResult: {
            content: [{ type: "text", text: "partial output" }],
          },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/toolCall/progress",
        message: "partial output",
      }),
    );
  });

  it("falls back to legacy non-bash progress text when partial output is empty", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "tool_execution_update",
          toolCallId: "tool-read-1",
          toolName: "read",
          partialResult: { content: [] },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/toolCall/progress",
        message: "read progress update",
      }),
    );
  });

  it("strips Pi no-output placeholders from bash completions", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "true", cwd: "/repo" },
    } as AgentSessionEvent);

    const events = harness.translate({
      type: "tool_execution_end",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "(no output)" }] },
    } as AgentSessionEvent);

    const completedEvent = events.find(
      (event): event is Extract<ThreadEvent, { type: "item/completed" }> =>
        event.type === "item/completed",
    );

    expect(completedEvent?.item).toMatchObject({
      type: "commandExecution",
      command: "true",
      cwd: "/repo",
      status: "completed",
      exitCode: 0,
    });
    if (completedEvent?.item.type !== "commandExecution") {
      throw new Error("Expected commandExecution completion");
    }
    expect(completedEvent.item.aggregatedOutput).toBeUndefined();
  });

  it("surfaces tool events without an active turn as provider/unhandled", () => {
    const harness = createHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "tool_execution_start",
          toolCallId: "tool-bash-1",
          toolName: "bash",
          args: { command: "npm test" },
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/tool_execution_start",
        scope: threadScope(),
        rawEvent: expect.objectContaining({ method: "sdk/message" }),
      }),
    ]);
    expect(harness.openTurnId()).toBe("");
  });

  it("ignores auto retry notifications for now", () => {
    const harness = createHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 2,
          delayMs: 2000,
        },
      },
    });

    expect(events).toEqual([]);
  });

  it.each([
    [{}, {}],
    [{ cacheRead: 0 }, { cacheReadInputTokens: 0 }],
    [{ cacheWrite: 0 }, { cacheWriteInputTokens: 0 }],
    [{ cacheRead: 31 }, { cacheReadInputTokens: 31 }],
    [{ cacheWrite: 9 }, { cacheWriteInputTokens: 9 }],
  ])(
    "preserves independently omitted Pi cache counts %j",
    (counts, expected) => {
      const harness = createHarness();
      harness.translate(loadFixture("agent-start.json"));
      const events = harness.translate({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [],
            usage: { input: 80, output: 20, ...counts },
          },
        ],
      });
      const event = events.find(
        (event) => event.type === "thread/tokenUsage/updated",
      );
      expect(event).toBeDefined();
      expect(event?.tokenUsage.last).toMatchObject(expected);
      expect(
        Object.keys(event?.tokenUsage.last ?? {})
          .filter(
            (key) =>
              key === "cacheReadInputTokens" || key === "cacheWriteInputTokens",
          )
          .sort(),
      ).toEqual(Object.keys(expected).sort());
    },
  );

  it("reports the prompt cache TTL of the latest cache write across turns", () => {
    const harness = createHarness();
    const turns: [Record<string, unknown>, number | undefined][] = [
      [{ cacheWrite: 9 }, undefined],
      [{ cacheWrite: 9, cacheWrite1h: 9 }, 3_600_000],
      [{ cacheWrite: 0, cacheWrite1h: 0 }, 3_600_000],
      [{ cacheWrite: 9, cacheWrite1h: 0 }, 300_000],
      [{ cacheWrite: 9, cacheWrite1h: "invalid" }, 300_000],
    ];

    const reported = turns.map(([cache]) => {
      harness.translate(loadFixture("agent-start.json"));
      const event = harness
        .translate({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [],
              usage: { input: 80, output: 20, ...cache },
            },
          ],
        })
        .find((event) => event.type === "thread/tokenUsage/updated");
      expect(event?.tokenUsage.last.inputTokens).toBe(80);
      return event?.tokenUsage.promptCacheTtlMs;
    });

    expect(reported).toEqual(turns.map(([, ttl]) => ttl));
  });

  it.each(["cacheRead", "cacheWrite"])(
    "invalid %s cannot discard Pi completion or valid usage",
    (field) => {
      for (const invalid of [-1, null, "invalid", Infinity, NaN]) {
        const harness = createHarness();
        harness.translate(loadFixture("agent-start.json"));
        const events = harness.translate({
          type: "agent_end",
          providerCheckpointId: "checkpoint-cache",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Finished" }],
              usage: {
                input: 80,
                output: 20,
                cacheRead: 31,
                cacheWrite: 9,
                [field]: invalid,
              },
            },
          ],
        });
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "item/completed",
            item: expect.objectContaining({ text: "Finished" }),
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "turn/completed",
            providerCheckpointId: "checkpoint-cache",
          }),
        );
        expect(harness.openTurnId()).toBe("");
        const event = events.find(
          (event) => event.type === "thread/tokenUsage/updated",
        );
        const validCounts =
          field === "cacheRead"
            ? { cacheWriteInputTokens: 9 }
            : { cacheReadInputTokens: 31 };
        expect(event?.tokenUsage.last).toEqual({
          totalTokens: field === "cacheRead" ? 109 : 131,
          inputTokens: 80,
          outputTokens: 20,
          cachedInputTokens: field === "cacheRead" ? 9 : 31,
          reasoningOutputTokens: 0,
          ...validCounts,
        });
      }
    },
  );

  it("invalid cache counts in earlier messages cannot discard Pi error settlement", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const events = harness.translate({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [], usage: { cacheRead: -1 } },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Provider failed",
          usage: { cacheWrite: -1 },
        },
      ],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        detail: "Provider failed",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/completed", status: "failed" }),
    );
    expect(harness.openTurnId()).toBe("");
  });

  it("accumulates Pi token usage across turns", () => {
    const harness = createHarness({
      resolveModelContextWindow: () => 123_456,
    });

    harness.translate(loadFixture("agent-start.json"));
    const firstTurnEvents = harness.translate(
      loadFixture("agent-end-with-message.json"),
    );

    harness.translate(loadFixture("agent-start.json"));
    const secondTurnEvents = harness.translate(
      loadFixture("agent-end-with-message.json"),
    );

    const firstTokenUsage = firstTurnEvents.find(
      (
        event,
      ): event is Extract<ThreadEvent, { type: "thread/tokenUsage/updated" }> =>
        event.type === "thread/tokenUsage/updated",
    );
    const secondTokenUsage = secondTurnEvents.find(
      (
        event,
      ): event is Extract<ThreadEvent, { type: "thread/tokenUsage/updated" }> =>
        event.type === "thread/tokenUsage/updated",
    );

    expect(firstTokenUsage?.tokenUsage.last).toMatchObject({
      totalTokens: 7736,
      inputTokens: 4200,
      cachedInputTokens: 3380,
      cacheReadInputTokens: 3100,
      cacheWriteInputTokens: 280,
      outputTokens: 156,
    });
    expect(firstTokenUsage?.tokenUsage.modelContextWindow).toBe(123_456);
    expect(secondTokenUsage?.tokenUsage.total).toMatchObject({
      totalTokens: 15472,
      inputTokens: 8400,
      cachedInputTokens: 6760,
      cacheReadInputTokens: 6200,
      cacheWriteInputTokens: 560,
      outputTokens: 312,
    });
    expect(secondTokenUsage?.tokenUsage.last).toEqual(
      firstTokenUsage?.tokenUsage.last,
    );
    expect(secondTokenUsage?.tokenUsage.modelContextWindow).toBe(123_456);
  });

  it("maps bridge context-window usage updates into the meter event", () => {
    const harness = createHarness();

    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate(loadFixture("agent-end-with-message.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "thread/contextWindowUsage/updated",
      params: {
        threadId: THREAD_ID,
        contextWindowUsage: {
          usedTokens: 54321,
          modelContextWindow: 123456,
          estimated: true,
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        contextWindowUsage: {
          usedTokens: 54321,
          modelContextWindow: 123456,
          estimated: true,
        },
      }),
    );
  });

  it("clears stale tool state when a turn ends without tool results", () => {
    const harness = createHarness();

    harness.translate(loadFixture("agent-start.json"));
    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "npm test", cwd: "/repo" },
    } as AgentSessionEvent);
    harness.translate(loadFixture("agent-end-with-message.json"));

    harness.translate(loadFixture("agent-start.json"));
    const events = harness.translate({
      type: "tool_execution_end",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      isError: false,
      result: "late output",
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "bash",
          result: "late output",
        }),
      }),
    );
  });

  it("prompt-settled settles only a turn owed to accepted input", () => {
    const harness = createHarness();
    const settled = {
      jsonrpc: "2.0",
      method: "pi/prompt/settled",
      params: { threadId: THREAD_ID, status: "completed" as const },
    };

    expect(harness.translate(settled)).toEqual([]);

    harness.assembler.assemble({
      threadId: THREAD_ID,
      deltas: [
        {
          kind: "input.accepted",
          clientRequestId: "creq_abcdefghjk" as never,
        },
      ],
    });
    const events = harness.translate(settled);
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/input/accepted",
      "turn/completed",
    ]);
  });

  it.each(["aborted", "error"])(
    "structured %s without errorMessage cannot complete successfully",
    (stopReason) => {
      const harness = createHarness();
      harness.translate(loadFixture("agent-start.json"));
      const events = harness.translate(
        sdkMessage({
          type: "agent_end",
          messages: [
            { role: "assistant", stopReason, content: [] },
            { role: "toolResult", content: [] },
          ],
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "turn/completed", status: "failed" }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "provider/error",
          detail: expect.any(String),
        }),
      );
      expect(
        events.some(
          (event) =>
            event.type === "turn/completed" && event.status === "completed",
        ),
      ).toBe(false);
    },
  );

  it("defers finality across native recovery and does not double-count text or usage at settlement", () => {
    const translator = createPiDeltaTranslator({
      resolveModelContextWindow: builtinCatalogResolver,
    });
    const initial = translator.translate(
      sdkMessage({
        type: "agent_end",
        deferSettlement: true,
        messages: [
          {
            role: "assistant",
            stopReason: "length",
            content: [{ type: "text", text: "partial" }],
            usage: { input: 2, output: 3 },
          },
        ],
      }),
    );
    expect(initial.some((delta) => delta.kind === "turn.boundary")).toBe(false);
    expect(initial.filter((delta) => delta.kind === "usage")).toHaveLength(1);
    const settled = translator.translate(
      sdkMessage({
        type: "agent_end",
        settlementOnly: true,
        providerCheckpointId: "settled-checkpoint",
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "partial" }],
            usage: { input: 2, output: 3 },
          },
        ],
      }),
    );
    expect(settled).toEqual([
      expect.objectContaining({
        kind: "turn.boundary",
        status: "completed",
        providerCheckpointId: "settled-checkpoint",
      }),
    ]);
  });

  it("reports a failed run that queued work superseded without ending the turn", () => {
    const translator = createPiDeltaTranslator({
      resolveModelContextWindow: builtinCatalogResolver,
    });
    const failedAttempt = translator.translate(
      sdkMessage({
        type: "agent_end",
        deferSettlement: true,
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "original prompt failed",
            content: [],
            usage: { input: 0, output: 0 },
          },
        ],
      }),
    );
    expect(failedAttempt).toEqual([]);
    expect(
      translator.translate(
        sdkMessage({
          type: "agent_end",
          deferSettlement: true,
          settlementSuperseded: true,
          settlementError: "original prompt failed",
          messages: [],
        }),
      ),
    ).toEqual([
      {
        kind: "provider.error",
        message: "Provider error",
        detail: "original prompt failed",
      },
    ]);
  });

  it("does not repeat a recovery failure that compaction already reported", () => {
    const translator = createPiDeltaTranslator({
      resolveModelContextWindow: builtinCatalogResolver,
    });
    const compaction = translator.translate(
      sdkMessage({
        type: "compaction_end",
        reason: "overflow",
        aborted: false,
        willRetry: false,
        errorMessage: "overflow recovery exhausted",
      }),
    );
    expect(
      compaction.filter((delta) => delta.kind === "provider.error"),
    ).toEqual([
      expect.objectContaining({ detail: "overflow recovery exhausted" }),
    ]);
    expect(
      translator.translate(
        sdkMessage({
          type: "agent_end",
          settlementOnly: true,
          settlementError: "overflow recovery exhausted",
          settlementErrorReported: true,
          providerCheckpointId: "settled-checkpoint",
          messages: [],
        }),
      ),
    ).toEqual([
      {
        kind: "turn.boundary",
        status: "failed",
        providerCheckpointId: "settled-checkpoint",
      },
    ]);
  });

  it.each([true, "false", null, 0])(
    "reports explicit or malformed settlement abort %s as failed",
    (aborted) => {
      const translator = createPiDeltaTranslator({
        resolveModelContextWindow: builtinCatalogResolver,
      });
      const deltas = translator.translate(
        sdkMessage({ type: "agent_end", aborted, messages: [] }),
      );
      expect(deltas).toContainEqual(
        expect.objectContaining({ kind: "turn.boundary", status: "failed" }),
      );
      expect(
        deltas.some(
          (delta) =>
            delta.kind === "turn.boundary" && delta.status === "completed",
        ),
      ).toBe(false);
    },
  );

  it("session error envelopes settle the open turn as failed", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "error",
      params: { threadId: THREAD_ID, message: "pi exploded" },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(turnId),
        message: "Provider error",
        detail: "pi exploded",
      }),
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "failed",
      }),
    ]);
  });
});

describe("pi subagent delegation translation", () => {
  function subagentDeltas(
    args: unknown,
    options?: { toolName?: string; isError?: boolean },
  ) {
    const translator = createPiDeltaTranslator({
      resolveModelContextWindow: builtinCatalogResolver,
    });
    const toolName = options?.toolName ?? "subagent";
    const open = translator.translate(
      sdkMessage({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName,
        args,
      }),
    );
    const close = translator.translate(
      sdkMessage({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName,
        result: { content: [{ type: "text", text: "output" }] },
        isError: options?.isError ?? false,
      }),
    );
    return { open: open[0], close: close.at(-1) };
  }

  it("renders a single agent call as a delegation with presentation", () => {
    const { open, close } = subagentDeltas({
      agent: "code-reviewer",
      task: "\n  Review the diff\nmore",
      model: "m1",
    });
    const presentation = {
      label: {
        pending: "Running code-reviewer",
        completed: "Ran code-reviewer",
      },
      icon: { glyph: "UserRound" },
      title: "Review the diff",
      detail: "code-reviewer agent · model m1",
    };
    expect(open).toMatchObject({
      kind: "item.open",
      item: { type: "delegation", childRef: "call-1", background: false },
      presentation,
    });
    expect(close).toMatchObject({
      kind: "item.close",
      status: "completed",
      resultText: "output",
      item: { type: "delegation", childRef: "call-1" },
      presentation,
    });
  });

  it("renders parallel tasks with collapsed agent counts", () => {
    const { open } = subagentDeltas({
      tasks: [
        { agent: "a", task: "x" },
        { agent: "b", task: "y" },
        { agent: "a", task: "z" },
      ],
    });
    expect(open).toMatchObject({
      item: { type: "delegation" },
      presentation: {
        label: { pending: "Running 3 subagents", completed: "Ran 3 subagents" },
        title: "a ×2, b",
      },
    });
    expect(open).not.toMatchObject({
      presentation: { detail: expect.anything() },
    });
  });

  it("uses the singular noun for a single parallel entry", () => {
    const sync = subagentDeltas({ tasks: [{ agent: "a", task: "x" }] });
    expect(sync.open).toMatchObject({
      presentation: {
        label: { pending: "Running 1 subagent", completed: "Ran 1 subagent" },
        title: "a",
      },
    });
    const async = subagentDeltas({
      tasks: [{ agent: "a", task: "x" }],
      async: true,
    });
    expect(async.open).toMatchObject({
      presentation: {
        label: {
          pending: "Launching 1 subagent",
          completed: "Launched 1 subagent",
        },
      },
    });
  });

  it("keeps the model detail and async labels for parallel tasks", () => {
    const { open } = subagentDeltas({
      tasks: [
        { agent: "a", task: "x" },
        { agent: "b", task: "y" },
      ],
      model: "m2",
      async: true,
    });
    expect(open).toMatchObject({
      presentation: {
        label: {
          pending: "Launching 2 subagents",
          completed: "Launched 2 subagents",
        },
        title: "a, b",
        detail: "model m2",
      },
    });
  });

  it("renders resume with the first message line", () => {
    const { open } = subagentDeltas({
      action: "resume",
      id: "f8a58b07",
      message: "continue now\nplease",
    });
    expect(open).toMatchObject({
      item: { type: "delegation" },
      presentation: {
        title: "Resume f8a58b07: continue now",
      },
    });
    expect(open).toMatchObject({
      presentation: {
        label: { pending: "Running subagent", completed: "Subagent finished" },
      },
    });
    const bare = subagentDeltas({ action: "resume", id: "f8a58b07" });
    expect(bare.open).toMatchObject({
      presentation: {
        title: "Resume f8a58b07",
      },
    });
  });

  it("uses launch labels for async calls without backgrounding", () => {
    const { open } = subagentDeltas({ agent: "a", task: "t", async: true });
    expect(open).toMatchObject({
      item: { type: "delegation", background: false },
      presentation: {
        label: {
          pending: "Launching a",
          completed: "Launched a",
        },
      },
    });
  });

  it("closes a failed delegation as failed", () => {
    const { close } = subagentDeltas(
      { agent: "a", task: "t" },
      { isError: true },
    );
    expect(close).toMatchObject({
      kind: "item.close",
      status: "failed",
      item: { type: "delegation" },
      presentation: expect.anything(),
    });
  });

  it("accepts an agent without a task", () => {
    const { open } = subagentDeltas({ agent: "scout" });
    expect(open).toMatchObject({
      item: { type: "delegation" },
      presentation: { title: "scout", detail: "scout agent" },
    });
  });

  it.each([
    ["completed", false, "final answer"],
    ["failed", true, "agent crashed"],
  ])(
    "carries result text as the %s delegation summary",
    (_n, isError, text) => {
      const harness = createHarness();
      harness.translate(loadFixture("agent-start.json"));
      harness.translate(
        sdkMessage({
          type: "tool_execution_start",
          toolCallId: "call-9",
          toolName: "subagent",
          args: { agent: "a", task: "t" },
        }),
      );
      const events = harness.translate(
        sdkMessage({
          type: "tool_execution_end",
          toolCallId: "call-9",
          toolName: "subagent",
          result: { content: [{ type: "text", text: `  ${text}\n` }] },
          isError,
        }),
      );
      const completed = events.find((event) => event.type === "item/completed");
      expect(completed).toMatchObject({
        item: {
          type: "delegation",
          status: isError ? "failed" : "completed",
          summary: text,
        },
      });
    },
  );

  it("collapses repeated agents in parallel titles with counts", () => {
    const repeated = subagentDeltas({
      tasks: [
        { agent: "web-scout", task: "a" },
        { agent: "web-scout", task: "b" },
        { agent: "librarian", task: "c" },
      ],
    });
    expect(repeated.open).toMatchObject({
      presentation: { title: "web-scout ×2, librarian" },
    });
    const single = subagentDeltas({
      tasks: [{ agent: "web-scout", task: "a" }],
    });
    expect(single.open).toMatchObject({
      presentation: { title: "web-scout" },
    });
    const mixed = subagentDeltas({
      tasks: [
        { agent: "a", task: "1" },
        { agent: "b", task: "2" },
        { agent: "a", task: "3" },
        { agent: "a", task: "4" },
      ],
    });
    expect(mixed.open).toMatchObject({
      presentation: { title: "a ×3, b" },
    });
  });

  describe("progress updates", () => {
    function progressMessage(toolName: string, partialResult: unknown) {
      const translator = createPiDeltaTranslator({
        resolveModelContextWindow: builtinCatalogResolver,
      });
      const deltas = translator.translate(
        sdkMessage({
          type: "tool_execution_update",
          toolCallId: "call-1",
          toolName,
          args: {},
          partialResult,
        }),
      );
      return deltas.find((delta) => delta.kind === "item.progress");
    }

    it("renders per-child markdown bullets", () => {
      const delta = progressMessage("subagent", {
        content: [{ type: "text", text: "raw" }],
        details: {
          progress: [
            {
              agent: "web-scout",
              task: "\n  Find docs\nsecond line",
              status: "running",
              currentTool: "read",
              toolCount: 3,
              durationMs: 13_000,
              extra: true,
            },
            {
              agent: "librarian",
              task: "x".repeat(120),
              status: "completed",
              toolCount: 1,
              durationMs: 125_000,
            },
            {
              agent: "a",
              task: "t",
              status: "failed",
              error: "\nboom\ntrace",
              toolCount: 0,
            },
            { agent: "b", status: "pending" },
            { agent: "c", task: "t", status: "running" },
          ],
        },
      });
      expect(delta).toMatchObject({
        message: [
          "- **web-scout** — Find docs · running `read` · 3 tools · 13s",
          `- **librarian** — ${"x".repeat(79)}… · done · 1 tool · 2m 5s`,
          "- **a** — t · failed: boom",
          "- **b** · pending",
          "- **c** — t · running",
        ].join("\n"),
      });
    });

    it("neutralizes markdown and whitespace in child fields", () => {
      const delta = progressMessage("subagent", {
        details: {
          progress: [
            {
              agent: "we*b\n_scout",
              task: "Check *exports* [x](y)",
              status: "running",
              currentTool: "re\nad",
            },
            {
              agent: "a",
              task: "# head <b>",
              status: "running",
              currentTool: "`a``b`",
            },
            { agent: "b", status: "failed", error: "bad `x` | ~y~" },
          ],
        },
      });
      expect(delta).toMatchObject({
        message: [
          "- **we\\*b \\_scout** — Check \\*exports\\* \\[x\\]\\(y\\) · running `re ad`",
          "- **a** — \\# head \\<b\\> · running ``` `a``b` ```",
          "- **b** · failed: bad \\`x\\` \\| \\~y\\~",
        ].join("\n"),
      });
    });

    it.each([
      ["missing details", { content: [{ type: "text", text: "raw" }] }],
      [
        "empty progress",
        { content: [{ type: "text", text: "raw" }], details: { progress: [] } },
      ],
      [
        "malformed progress",
        {
          content: [{ type: "text", text: "raw" }],
          details: { progress: [{ agent: "a", status: "bogus" }] },
        },
      ],
    ])("falls back to raw text for %s", (_name, partialResult) => {
      expect(progressMessage("subagent", partialResult)).toMatchObject({
        message: "raw",
      });
    });

    it("leaves non-subagent progress unchanged", () => {
      expect(
        progressMessage("other", {
          content: [{ type: "text", text: "raw" }],
          details: { progress: [{ agent: "a", status: "running" }] },
        }),
      ).toMatchObject({ message: "raw" });
    });
  });

  it.each([
    ["management action", { action: "list" }, "subagent"],
    ["resume without id", { action: "resume" }, "subagent"],
    ["malformed args", { agent: 5, task: "t" }, "subagent"],
    ["empty tasks", { tasks: [] }, "subagent"],
    ["subagent_wait", { agent: "a", task: "t" }, "subagent_wait"],
    ["subagent_supervisor", { agent: "a", task: "t" }, "subagent_supervisor"],
  ])("falls back to a generic tool for %s", (_name, args, toolName) => {
    const { open, close } = subagentDeltas(args, { toolName });
    expect(open).toMatchObject({ item: { type: "tool" } });
    expect(open).not.toHaveProperty("presentation");
    expect(close).toMatchObject({ item: { type: "tool" } });
    expect(close).not.toHaveProperty("presentation");
  });
});

function detachedAssociation(
  asyncId: string,
  overrides: Partial<PiDetachedRunAssociation> = {},
): PiDetachedRunAssociation {
  return {
    candidate: { asyncId, mode: "single" },
    toolCallId: `call-${asyncId}`,
    eligible: true,
    outcome: null,
    ...overrides,
  };
}

describe("pi detached background-task lifecycle translation", () => {
  function openRootDelegation(
    harness: PiEquivalenceHarness,
    runId = "1",
    startTurn = true,
  ): string {
    if (startTurn) harness.translate(loadFixture("agent-start.json"));
    const events = harness.translate(
      sdkMessage({
        type: "tool_execution_start",
        toolCallId: `call-run-${runId}`,
        toolName: "subagent",
        args: { agent: "reviewer", task: "Review the change" },
      }),
    );
    const started = events.find((event) => event.type === "item/started");
    if (!started || started.type !== "item/started") {
      throw new Error("root subagent delegation did not open");
    }
    return started.item.id;
  }

  it("requires confirmed activity before emitting a detached row", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    expect(
      harness.translateDetached(
        detachedAssociation("run-unconfirmed", { eligible: false }),
      ),
    ).toEqual([]);
    expect(
      harness.translateDetached(detachedAssociation("run-unconfirmed")),
    ).toMatchObject([
      {
        type: "item/started",
        item: { type: "backgroundTask", taskType: "local_subagent" },
      },
    ]);
  });

  it("emits a visible row through the real assembler with the root parent", () => {
    const harness = createHarness();
    const rootId = openRootDelegation(harness);
    harness.translate(
      sdkMessage({
        type: "tool_execution_end",
        toolCallId: "call-run-1",
        toolName: "subagent",
        result: { content: [{ type: "text", text: "launched" }] },
        isError: false,
      }),
    );

    const events = harness.translateDetached(
      detachedAssociation("run-1", { toolCallId: "call-run-1" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item/started",
      scope: turnScope(harness.openTurnId()),
      item: {
        type: "backgroundTask",
        familyId: "pi:detached:run-1",
        taskType: "local_subagent",
        taskStatus: "running",
        parentToolCallId: rootId,
      },
    });
    expect(events[0]).not.toMatchObject({ type: "turn/started" });
  });

  it("attaches delayed confirmation to the current or last turn without fabricating one", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    harness.translate({
      jsonrpc: "2.0",
      method: "pi/prompt/settled",
      params: { threadId: THREAD_ID, status: "completed" },
    });
    const first = harness.translateDetached(detachedAssociation("run-1"));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      type: "item/started",
      scope: turnScope("pi-test-t1"),
    });

    harness.translate(loadFixture("agent-start.json"));
    expect(harness.translateDetached(detachedAssociation("run-1"))).toEqual([]);
    expect(harness.openTurnId()).toBe("pi-test-t2");
  });

  it("attaches a later detached run to the later parent turn", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    harness.translate({
      jsonrpc: "2.0",
      method: "pi/prompt/settled",
      params: { threadId: THREAD_ID, status: "completed" },
    });
    harness.translate(loadFixture("agent-start.json"));
    const rootId = openRootDelegation(harness, "2", false);
    const events = harness.translateDetached(
      detachedAssociation("run-2", { toolCallId: "call-run-2" }),
    );
    expect(events).toMatchObject([
      {
        type: "item/started",
        scope: turnScope("pi-test-t2"),
        item: { parentToolCallId: rootId },
      },
    ]);
  });

  it("closes confirmed outcomes, pauses explicitly, and reports loss without cancellation", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    const opened = harness.translateDetached(detachedAssociation("run-1"));
    const itemId = opened[0]?.type === "item/started" ? opened[0].item.id : "";

    const paused = harness.translateDetached(
      detachedAssociation("run-1", {
        eligible: false,
        outcome: "paused",
      }),
    );
    expect(paused).toMatchObject([
      {
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        item: {
          id: itemId,
          status: "interrupted",
          taskStatus: "paused",
          summary: "Detached subagent paused",
        },
      },
    ]);
    expect(harness.translateDetached(detachedAssociation("run-1"))).toEqual([]);

    const completedHarness = createHarness();
    openRootDelegation(completedHarness);
    completedHarness.translateDetached(detachedAssociation("run-3"));
    expect(
      completedHarness.translateDetached(
        detachedAssociation("run-3", {
          eligible: false,
          outcome: "completed",
        }),
      ),
    ).toMatchObject([
      {
        type: "item/backgroundTask/completed",
        item: {
          status: "completed",
          taskStatus: "completed",
          summary: "Detached subagent completed",
        },
      },
    ]);

    const lossHarness = createHarness();
    openRootDelegation(lossHarness);
    lossHarness.translateDetached(detachedAssociation("run-2"));
    const lost = lossHarness.translateDetached([]);
    expect(lost).toMatchObject([
      {
        type: "item/backgroundTask/completed",
        item: {
          status: "failed",
          taskStatus: "failed",
          error: "Tracking lost; the TLH run may still be running.",
        },
      },
    ]);
  });

  it("opens parallel runs once and uses a fresh provider generation after loss", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    const first = harness.translateDetached([
      detachedAssociation("run-a", { toolCallId: "call-run-1" }),
      detachedAssociation("run-b", {
        candidate: { asyncId: "run-b", mode: "parallel" },
        toolCallId: "call-run-1",
      }),
    ]);
    expect(first).toHaveLength(2);
    const firstItems = first.filter(
      (event): event is Extract<ThreadEvent, { type: "item/started" }> =>
        event.type === "item/started" && event.item.type === "backgroundTask",
    );
    expect(new Set(firstItems.map((event) => event.item.id)).size).toBe(2);
    expect(
      harness.translateDetached([
        detachedAssociation("run-a", { toolCallId: "call-run-1" }),
        detachedAssociation("run-b", {
          candidate: { asyncId: "run-b", mode: "parallel" },
          toolCallId: "call-run-1",
        }),
      ]),
    ).toEqual([]);

    const lost = harness.translateDetached([
      detachedAssociation("run-b", {
        candidate: { asyncId: "run-b", mode: "parallel" },
        toolCallId: "call-run-1",
      }),
    ]);
    expect(lost).toHaveLength(1);
    const reopened = harness.translateDetached([
      detachedAssociation("run-a"),
      detachedAssociation("run-b", {
        candidate: { asyncId: "run-b", mode: "parallel" },
        toolCallId: "call-run-1",
      }),
    ]);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({
      type: "item/started",
      item: {
        type: "backgroundTask",
        familyId: "pi:detached:run-a",
        parentToolCallId: expect.any(String),
      },
    });
    expect(reopened[0]).not.toMatchObject({
      item: {
        id: firstItems.find((event) => event.item.parentToolCallId)?.item.id,
      },
    });
  });

  it("does not materialize a terminal run that arrived before its candidate", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    expect(
      harness.translateDetached(
        detachedAssociation("run-terminal", {
          eligible: false,
          outcome: "completed",
        }),
      ),
    ).toEqual([]);
    expect(
      harness.translateDetached(
        detachedAssociation("run-terminal", { outcome: "completed" }),
      ),
    ).toEqual([]);
  });

  it("settles a late terminal outcome with a fresh item generation", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    const opened = harness.translateDetached(
      detachedAssociation("run-late", { toolCallId: "call-run-late" }),
    );
    const initialId =
      opened[0]?.type === "item/started" ? opened[0].item.id : "";

    expect(harness.translateDetached([])).toMatchObject([
      {
        type: "item/backgroundTask/completed",
        item: {
          id: initialId,
          status: "failed",
          taskStatus: "failed",
        },
      },
    ]);

    const corrected = harness.translateDetached(
      detachedAssociation("run-late", {
        eligible: false,
        outcome: "completed",
        toolCallId: "call-run-late",
      }),
    );
    expect(corrected).toMatchObject([
      {
        type: "item/backgroundTask/completed",
        item: {
          status: "completed",
          taskStatus: "completed",
          summary: "Detached subagent completed",
        },
      },
    ]);
    const correctedId =
      corrected[0]?.type === "item/backgroundTask/completed"
        ? corrected[0].item.id
        : "";
    expect(correctedId).not.toBe(initialId);
    expect(
      harness.translateDetached(
        detachedAssociation("run-late", {
          eligible: true,
          outcome: "completed",
          toolCallId: "call-run-late",
        }),
      ),
    ).toEqual([]);
  });

  it("keeps item generations unique after evicting more than 1024 rows", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    const initial = harness.translateDetached([
      detachedAssociation("run-evicted", { toolCallId: "call-run-evicted" }),
      detachedAssociation("run-late-evicted", {
        toolCallId: "call-run-late-evicted",
      }),
    ]);
    const initialId =
      initial.find(
        (event): event is Extract<ThreadEvent, { type: "item/started" }> =>
          event.type === "item/started" &&
          event.item.type === "backgroundTask" &&
          event.item.familyId === "pi:detached:run-evicted",
      )?.item.id ?? "";
    const lateInitialId =
      initial.find(
        (event): event is Extract<ThreadEvent, { type: "item/started" }> =>
          event.type === "item/started" &&
          event.item.type === "backgroundTask" &&
          event.item.familyId === "pi:detached:run-late-evicted",
      )?.item.id ?? "";
    harness.translateDetached([]);

    for (let index = 1; index <= 1024; index += 1) {
      harness.translateDetached([
        detachedAssociation(`run-${index}`, {
          toolCallId: `call-run-${index}`,
        }),
      ]);
    }

    const reopened = harness.translateDetached(
      detachedAssociation("run-evicted", { toolCallId: "call-run-evicted" }),
    );
    const reopenedItem = reopened.find(
      (event): event is Extract<ThreadEvent, { type: "item/started" }> =>
        event.type === "item/started" &&
        event.item.type === "backgroundTask" &&
        event.item.familyId === "pi:detached:run-evicted",
    );
    expect(reopenedItem?.item.id).toBeDefined();
    expect(reopenedItem?.item.id).not.toBe(initialId);

    const lateCorrection = harness.translateDetached(
      detachedAssociation("run-late-evicted", {
        eligible: false,
        outcome: "completed",
        toolCallId: "call-run-late-evicted",
      }),
    );
    const correctedItem = lateCorrection.find(
      (
        event,
      ): event is Extract<
        ThreadEvent,
        { type: "item/backgroundTask/completed" }
      > =>
        event.type === "item/backgroundTask/completed" &&
        event.item.familyId === "pi:detached:run-late-evicted",
    );
    expect(correctedItem).toMatchObject({
      item: {
        status: "completed",
        taskStatus: "completed",
      },
    });
    expect(correctedItem?.item.id).not.toBe(lateInitialId);
  });

  it("corrects an evicted lost row from cleanup family state", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    const opened = harness.translateDetached(
      detachedAssociation("run-cleanup-evicted", {
        toolCallId: "call-run-cleanup-evicted",
      }),
    );
    const initialId =
      opened[0]?.type === "item/started" ? opened[0].item.id : "";
    harness.translateDetached([]);

    for (let index = 1; index <= 1024; index += 1) {
      harness.translateDetached([
        detachedAssociation(`cleanup-run-${index}`, {
          toolCallId: `call-cleanup-run-${index}`,
        }),
      ]);
    }

    const corrected = harness.translateDetached(
      [
        detachedAssociation("run-cleanup-evicted", {
          eligible: false,
          outcome: "completed",
          toolCallId: "call-run-cleanup-evicted",
        }),
      ],
      { cleanup: true },
    );
    const correctedItem = corrected.find(
      (
        event,
      ): event is Extract<
        ThreadEvent,
        { type: "item/backgroundTask/completed" }
      > =>
        event.type === "item/backgroundTask/completed" &&
        event.item.familyId === "pi:detached:run-cleanup-evicted",
    );
    expect(correctedItem).toMatchObject({
      item: {
        status: "completed",
        taskStatus: "completed",
        summary: "Detached subagent completed",
      },
    });
    expect(correctedItem?.item.id).not.toBe(initialId);
    expect(
      harness.translateDetached(
        [
          detachedAssociation("run-cleanup-evicted", {
            outcome: "completed",
            toolCallId: "call-run-cleanup-evicted",
          }),
        ],
        { cleanup: true },
      ),
    ).toEqual([]);
  });

  it("closes active rows as tracking lost during cleanup, without reopening them", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    harness.translateDetached(detachedAssociation("run-cleanup"));
    const events = harness.translateDetached([], { cleanup: true });
    expect(events).toMatchObject([
      {
        type: "item/backgroundTask/completed",
        item: {
          taskStatus: "failed",
          error: "Tracking lost; the TLH run may still be running.",
        },
      },
    ]);
    expect(
      harness.translateDetached(detachedAssociation("run-cleanup")),
    ).toEqual([]);
  });

  it("applies cleanup outcomes before loss and keeps cleanup idempotent", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    harness.translateDetached([
      detachedAssociation("run-completed"),
      detachedAssociation("run-paused"),
      detachedAssociation("run-unresolved"),
    ]);

    const cleanup = harness.translateDetached(
      [
        detachedAssociation("run-completed", {
          eligible: false,
          outcome: "completed",
        }),
        detachedAssociation("run-paused", {
          eligible: false,
          outcome: "paused",
        }),
        detachedAssociation("run-unresolved", { eligible: false }),
      ],
      { cleanup: true },
    );
    expect(cleanup).toMatchObject([
      {
        type: "item/backgroundTask/completed",
        item: { status: "completed", taskStatus: "completed" },
      },
      {
        type: "item/backgroundTask/completed",
        item: { status: "interrupted", taskStatus: "paused" },
      },
      {
        type: "item/backgroundTask/completed",
        item: {
          status: "failed",
          taskStatus: "failed",
          error: "Tracking lost; the TLH run may still be running.",
        },
      },
    ]);
    expect(
      harness.translateDetached(
        [
          detachedAssociation("run-completed", { outcome: "completed" }),
          detachedAssociation("run-paused", { outcome: "paused" }),
          detachedAssociation("run-unresolved"),
        ],
        { cleanup: true },
      ),
    ).toEqual([]);
  });

  it("corrects a previously lost row during cleanup with a fresh generation", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    const opened = harness.translateDetached(
      detachedAssociation("run-cleanup-late"),
    );
    const initialId =
      opened[0]?.type === "item/started" ? opened[0].item.id : "";
    const lost = harness.translateDetached([]);
    const lostId =
      lost[0]?.type === "item/backgroundTask/completed" ? lost[0].item.id : "";
    expect(lostId).toBe(initialId);

    const corrected = harness.translateDetached(
      [
        detachedAssociation("run-cleanup-late", {
          eligible: false,
          outcome: "completed",
        }),
      ],
      { cleanup: true },
    );
    expect(corrected).toMatchObject([
      {
        type: "item/backgroundTask/completed",
        item: {
          status: "completed",
          taskStatus: "completed",
          summary: "Detached subagent completed",
        },
      },
    ]);
    const correctedId =
      corrected[0]?.type === "item/backgroundTask/completed"
        ? corrected[0].item.id
        : "";
    expect(correctedId).not.toBe(lostId);
    expect(
      harness.translateDetached(
        [detachedAssociation("run-cleanup-late", { outcome: "completed" })],
        { cleanup: true },
      ),
    ).toEqual([]);
  });

  it("scopes cleanup and late signals to the originating session", () => {
    const harness = createHarness();
    openRootDelegation(harness);
    const oldStarted = harness.translateDetached(
      detachedAssociation("run-shared"),
      { sessionSerial: 1 },
    );
    const replacementStarted = harness.translateDetached(
      detachedAssociation("run-shared"),
      { sessionSerial: 2 },
    );
    const oldId =
      oldStarted[0]?.type === "item/started" ? oldStarted[0].item.id : "";
    const replacementId =
      replacementStarted[0]?.type === "item/started"
        ? replacementStarted[0].item.id
        : "";
    expect(replacementId).not.toBe(oldId);

    const oldCleanup = harness.translateDetached([], {
      cleanup: true,
      sessionSerial: 1,
    });
    expect(oldCleanup).toMatchObject([
      {
        type: "item/backgroundTask/completed",
        item: {
          id: oldId,
          error: "Tracking lost; the TLH run may still be running.",
        },
      },
    ]);
    expect(
      harness.translateDetached(
        detachedAssociation("run-shared", {
          eligible: false,
          outcome: "completed",
        }),
        { sessionSerial: 1 },
      ),
    ).toEqual([]);
    expect(
      harness.translateDetached(detachedAssociation("run-shared"), {
        sessionSerial: 2,
      }),
    ).toEqual([]);
    expect(
      harness.translateDetached(
        detachedAssociation("run-shared", {
          eligible: false,
          outcome: "completed",
        }),
        { sessionSerial: 2 },
      ),
    ).toMatchObject([
      {
        type: "item/backgroundTask/completed",
        item: { id: replacementId, status: "completed" },
      },
    ]);
  });
});
