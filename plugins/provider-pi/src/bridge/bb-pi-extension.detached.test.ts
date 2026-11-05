import { runInNewContext } from "node:vm";
import { StringDecoder } from "node:string_decoder";
import { describe, expect, it } from "vitest";
import { BB_PI_EXTENSION_SOURCE } from "./bb-pi-extension.js";

interface ExtensionHarness {
  messages: Record<string, unknown>[];
  emitPiEvent(type: string, payload?: Record<string, unknown>): Promise<void>;
  emitBusEvent(channel: string, value: unknown): void;
}

function createExtensionHarness(withEventBus: boolean): ExtensionHarness {
  const messages: Record<string, unknown>[] = [];
  const piHandlers = new Map<
    string,
    ((
      event: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => void | Promise<void>)[]
  >();
  const busHandlers = new Map<string, Set<(value: unknown) => void>>();
  const context = { sessionManager: { getLeafId: () => null } };
  const source = BB_PI_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
    "export default function bbExtension",
    "function bbExtension",
  );
  const factory = runInNewContext(`${source}; bbExtension`, {
    Buffer,
    PiRuntime: { VERSION: "0.84.0", SessionManager: {} },
    StringDecoder,
    Type: {},
    process: { env: {} },
    readFileSync: () => "[]",
    renameSync: () => undefined,
    writeSync: (
      _fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
    ) => {
      messages.push(
        JSON.parse(buffer.subarray(offset, offset + length).toString()),
      );
      return length;
    },
    Socket: class {
      on() {
        return this;
      }

      unref() {}
    },
  }) as (pi: Record<string, unknown>) => void;
  const pi: Record<string, unknown> = {
    registerTool: () => undefined,
    on(type: string, handler: unknown) {
      const handlers = piHandlers.get(type) ?? [];
      handlers.push(
        handler as (
          event: Record<string, unknown>,
          context: Record<string, unknown>,
        ) => void | Promise<void>,
      );
      piHandlers.set(type, handlers);
    },
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  };
  if (withEventBus) {
    pi.events = {
      on(channel: string, handler: (value: unknown) => void) {
        const handlers = busHandlers.get(channel) ?? new Set();
        handlers.add(handler);
        busHandlers.set(channel, handlers);
        return () => handlers.delete(handler);
      },
    };
  }
  factory(pi);
  return {
    messages,
    async emitPiEvent(type, payload = {}) {
      for (const handler of piHandlers.get(type) ?? []) {
        await handler({ type, ...payload }, context);
      }
    },
    emitBusEvent(channel, value) {
      for (const handler of busHandlers.get(channel) ?? []) {
        handler(value);
      }
    },
  };
}

function detachedMessages(
  harness: ExtensionHarness,
): Record<string, unknown>[] {
  return harness.messages.filter(
    (message) =>
      message.kind === "tlh:effective-activity" ||
      message.kind === "subagent:async-complete",
  );
}

describe("injected detached-run extension forwarding", () => {
  it("forwards only minimal validated activity and completion fields", async () => {
    const harness = createExtensionHarness(true);
    await harness.emitPiEvent("session_start");
    harness.emitBusEvent("tlh:effective-activity", {
      activeAsyncJobIds: [" run-1 ", "run-2"],
      prompt: "do not forward this prompt",
      task: "do not forward this task",
      args: { secret: "do not forward this argument" },
    });
    harness.emitBusEvent("subagent:async-complete", {
      runId: " run-1 ",
      state: "paused",
      prompt: "do not forward this prompt",
      results: [{ secret: "do not forward this result" }],
      success: true,
    });
    expect(detachedMessages(harness)).toEqual([
      {
        kind: "tlh:effective-activity",
        activeAsyncJobIds: ["run-1", "run-2"],
      },
      {
        kind: "subagent:async-complete",
        runId: "run-1",
        state: "paused",
      },
    ]);
  });

  it("does not use the Pi event handler path when the event bus is unavailable", async () => {
    const harness = createExtensionHarness(false);
    await harness.emitPiEvent("session_start");
    expect(detachedMessages(harness)).toEqual([]);
  });

  it("rejects malformed bus payloads and disposes listeners at shutdown", async () => {
    const harness = createExtensionHarness(true);
    await harness.emitPiEvent("session_start");
    harness.emitBusEvent("tlh:effective-activity", {
      activeAsyncJobIds: ["run-1", 2],
    });
    harness.emitBusEvent("subagent:async-complete", {
      state: "complete",
    });
    expect(detachedMessages(harness)).toEqual([]);
    await harness.emitPiEvent("session_shutdown");
    harness.emitBusEvent("tlh:effective-activity", {
      activeAsyncJobIds: ["run-1"],
    });
    expect(detachedMessages(harness)).toEqual([]);
    await harness.emitPiEvent("session_start");
    harness.emitBusEvent("tlh:effective-activity", {
      activeAsyncJobIds: ["run-1"],
    });
    expect(detachedMessages(harness)).toEqual([
      {
        kind: "tlh:effective-activity",
        activeAsyncJobIds: ["run-1"],
      },
    ]);
  });
});
