import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  bashArgsSchema,
  errorEnvelopeSchema,
  extractResultText,
  jsonRpcEnvelopeSchema,
  normalizeProviderCommandOutput,
  providerRawEventSchema,
  sdkMessageEnvelopeSchema,
  textBlockSchema,
  threadContextWindowUsageEnvelopeSchema,
  toNonNegativeNumber,
  toOptionalString,
  toPositiveNumber,
  experimental_presentationDetail as presentationDetail,
  experimental_presentationTitle as presentationTitle,
  experimental_withTitle as withTitle,
  type DeltaItemShape,
  type DeltaPresentation,
  type DeltaNoTurnFallback,
  type JsonRpcMessage,
  type ProviderRawEvent,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  PI_STATUS_EXTENSION_KIND,
  piStatusUpdatedEnvelopeSchema,
} from "./extension-kinds.js";
import { toCanonicalPiModelId } from "./model-list.js";
import { piVisibilityMetadata } from "./visibility.js";
import { runSettlementError } from "./bridge/run-settlement.js";
import type {
  DetachedRunMode,
  DetachedRunOutcomeKind,
} from "./detached-run-reconciliation.js";

export interface PiContextWindowModel {
  contextWindow?: number;
  id: string;
  provider: string;
}

const piEventTypeSchema = z
  .object({
    type: z.enum([
      "agent_end",
      "agent_start",
      "compaction_end",
      "compaction_start",
      "message_end",
      "message_start",
      "message_update",
      "tool_execution_end",
      "tool_execution_start",
      "tool_execution_update",
    ]),
  })
  .passthrough();

const piPromptSettledEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("pi/prompt/settled"),
  params: z.object({
    threadId: z.string().min(1),
    status: z.enum(["completed", "failed"]),
    error: z.string().optional(),
  }),
});

const PI_IGNORED_EVENT_TYPES = new Set(["agent_settled"]);

const piIgnoredEventSchema = z
  .object({ type: z.string() })
  .passthrough()
  .refine((event) => PI_IGNORED_EVENT_TYPES.has(event.type));

const piMessageContentBlockSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const piAssistantUsageSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().nonnegative().optional().catch(undefined),
    cacheWrite: z.number().nonnegative().optional().catch(undefined),
    cacheWrite1h: z.number().nonnegative().optional().catch(undefined),
    totalTokens: z.number().optional(),
  })
  .passthrough();

const piConversationMessageSchema = z
  .object({
    role: z.string(),
    content: z
      .union([z.string(), z.array(piMessageContentBlockSchema)])
      .optional(),
    stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    usage: piAssistantUsageSchema.optional(),
  })
  .passthrough();

const piAssistantMessageSchema = piConversationMessageSchema.extend({
  role: z.literal("assistant"),
  content: z.array(piMessageContentBlockSchema),
});

const piCustomMessageBoundaryEventSchema = z
  .object({
    type: z.enum(["message_end", "message_start"]),
    message: z
      .object({
        role: z.literal("custom"),
        content: z.union([z.string(), z.array(piMessageContentBlockSchema)]),
        display: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

const piAgentEndEventSchema = z
  .object({
    type: z.literal("agent_end"),
    messages: z.array(piConversationMessageSchema),
    providerCheckpointId: z.string().min(1).optional(),
    willRetry: z.boolean().default(false),
    deferSettlement: z.boolean().optional(),
    settlementOnly: z.boolean().optional(),
    settlementError: z.string().optional(),
    settlementErrorReported: z.boolean().optional(),
    settlementSuperseded: z.boolean().optional(),
  })
  .passthrough();

const piCompactionStartEventSchema = z
  .object({
    type: z.literal("compaction_start"),
    reason: z.enum(["manual", "threshold", "overflow"]),
  })
  .passthrough();

const piCompactionEndEventSchema = z
  .object({
    type: z.literal("compaction_end"),
    reason: z.enum(["manual", "threshold", "overflow"]),
    aborted: z.boolean(),
    errorMessage: z.string().optional(),
  })
  .passthrough();

const piCompactionNoopMessages = new Set([
  "Compaction failed: Nothing to compact (session too small)",
  "Compaction failed: Already compacted",
]);

function isPiCompactionNoop(errorMessage: string): boolean {
  return piCompactionNoopMessages.has(errorMessage.trim());
}

const piMessageUpdateEventSchema = z
  .object({
    type: z.literal("message_update"),
    assistantMessageEvent: z
      .object({
        type: z.string(),
        content: z.string().optional(),
        contentIndex: z.number().optional(),
        delta: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const piToolExecutionStartEventSchema = z
  .object({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
  })
  .passthrough();

const piToolExecutionEndEventSchema = z
  .object({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.unknown(),
    isError: z.boolean(),
  })
  .passthrough();

const piReadArgsSchema = z.object({
  path: z.string().refine((path) => path.trim().length > 0),
});

const piImageContentBlockSchema = z.object({
  type: z.literal("image"),
  data: z.string().trim().min(1),
  mimeType: z.string().regex(/^image\/[^\s/]+$/),
});

const piToolResultContentSchema = z.object({
  content: z.array(z.unknown()),
});

function hasPiImageContent(result: unknown): boolean {
  const parsed = piToolResultContentSchema.safeParse(result);
  return (
    parsed.success &&
    parsed.data.content.some(
      (block) => piImageContentBlockSchema.safeParse(block).success,
    )
  );
}

const piToolExecutionUpdateEventSchema = z
  .object({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    toolName: z.string(),
    partialResult: z.unknown(),
  })
  .passthrough();

const piFileEditArgsSchema = z
  .object({
    path: z.string().optional(),
    oldText: z.string().optional(),
    newText: z.string().optional(),
    content: z.string().optional(),
    edits: z.unknown().optional(),
  })
  .passthrough();

const piFileEditBatchSchema = z.array(
  z.object({
    oldText: z.string(),
    newText: z.string(),
  }),
);

const piSubagentTaskSchema = z.object({
  agent: z.string().trim().min(1),
  task: z.string(),
});

const piSubagentArgsSchema = z
  .object({
    action: z.string().optional(),
    agent: z.string().trim().min(1).optional(),
    task: z.string().optional(),
    tasks: z.array(piSubagentTaskSchema).min(1).optional(),
    id: z.string().trim().min(1).optional(),
    message: z.string().optional(),
    model: z.string().optional(),
    async: z.boolean().optional(),
  })
  .passthrough();

const piSubagentProgressEntrySchema = z
  .object({
    agent: z.string().trim().min(1),
    task: z.string().optional(),
    status: z.enum(["pending", "running", "completed", "failed"]),
    currentTool: z.string().optional(),
    toolCount: z.number().optional(),
    durationMs: z.number().optional(),
    error: z.string().optional(),
  })
  .passthrough();

const piSubagentPartialResultSchema = z
  .object({
    details: z
      .object({
        progress: z.array(piSubagentProgressEntrySchema).min(1),
      })
      .passthrough(),
  })
  .passthrough();

interface PiClassifiedTool {
  shape: DeltaItemShape;
  presentation?: DeltaPresentation;
}

type PiAssistantMessage = z.infer<typeof piAssistantMessageSchema>;
type PiAssistantErrorMessage = PiAssistantMessage & {
  errorMessage: string;
  stopReason: "error";
};
type PiConversationMessage = z.infer<typeof piConversationMessageSchema>;
type PiToolExecutionUpdateEvent = z.infer<
  typeof piToolExecutionUpdateEventSchema
>;

const PI_EMPTY_BASH_OUTPUT_PLACEHOLDERS = ["(no output)"] as const;
const PI_COMMAND_TOOL_NAMES = new Set(["bash"]);
const PI_FILE_CHANGE_TOOL_NAMES = new Set(["edit", "write"]);
const PI_IMAGE_READ_PATH_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
const PI_UNICODE_SPACE_PATTERN = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;

const ASSISTANT_STREAM_KEY = "assistant";

function thinkingStreamChannel(contentIndex: number): string {
  return `thinking-${contentIndex}`;
}

function firstNonEmptyLine(text: string | undefined): string | undefined {
  return text
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function formatPiSubagentParallelTitle(agents: string[]): string {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    counts.set(agent, (counts.get(agent) ?? 0) + 1);
  }
  return [...counts]
    .map(([agent, count]) => (count > 1 ? `${agent} ×${count}` : agent))
    .join(", ");
}

const PI_SUBAGENT_TASK_MAX_CHARS = 80;

function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeMarkdownText(text: string): string {
  return text.replace(/[\\`*_[\]()<>#!|~]/g, "\\$&");
}

function formatInlineCode(text: string): string {
  const longestRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(longestRun + 1);
  const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

function formatPiSubagentElapsed(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function formatPiSubagentProgress(partialResult: unknown): string | undefined {
  const parsed = piSubagentPartialResultSchema.safeParse(partialResult);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.details.progress
    .map((child) => {
      const agent = escapeMarkdownText(collapseWhitespace(child.agent));
      const currentTool =
        child.currentTool === undefined
          ? ""
          : collapseWhitespace(child.currentTool);
      const rawTaskLine = firstNonEmptyLine(child.task);
      const taskLine =
        rawTaskLine === undefined
          ? undefined
          : escapeMarkdownText(
              truncateText(rawTaskLine, PI_SUBAGENT_TASK_MAX_CHARS),
            );
      let status: string;
      switch (child.status) {
        case "running":
          status =
            currentTool.length === 0
              ? "running"
              : `running ${formatInlineCode(currentTool)}`;
          break;
        case "completed":
          status = "done";
          break;
        case "failed": {
          const errorLine = firstNonEmptyLine(child.error);
          status =
            errorLine === undefined
              ? "failed"
              : `failed: ${escapeMarkdownText(errorLine)}`;
          break;
        }
        case "pending":
          status = "pending";
          break;
      }
      const parts = [
        `**${agent}**${taskLine === undefined ? "" : ` — ${taskLine}`}`,
        status,
      ];
      if (child.toolCount !== undefined && child.toolCount > 0) {
        parts.push(`${child.toolCount} ${child.toolCount === 1 ? "tool" : "tools"}`);
      }
      if (child.durationMs !== undefined && child.durationMs > 0) {
        parts.push(formatPiSubagentElapsed(child.durationMs));
      }
      return `- ${parts.join(" · ")}`;
    })
    .join("\n");
}

function classifyPiSubagent(
  toolCallId: string,
  args: unknown,
): PiClassifiedTool | null {
  const parsed = piSubagentArgsSchema.safeParse(args);
  if (!parsed.success) {
    return null;
  }
  const { action, agent, task, tasks, id, message, model } = parsed.data;
  let title: string | undefined;
  let detailParts: string[] = [];
  let label = { pending: "Running subagent", completed: "Subagent finished" };
  const isAsync = parsed.data.async === true;
  if (isAsync) {
    label = { pending: "Launching subagent", completed: "Launched subagent" };
  }
  if (action === "resume") {
    if (id === undefined) {
      return null;
    }
    const messageLine = firstNonEmptyLine(message);
    title =
      messageLine === undefined
        ? `Resume ${id}`
        : `Resume ${id}: ${messageLine}`;
  } else if (action !== undefined) {
    return null;
  } else if (tasks !== undefined) {
    title = formatPiSubagentParallelTitle(tasks.map((entry) => entry.agent));
    const noun = tasks.length === 1 ? "subagent" : "subagents";
    label = isAsync
      ? {
          pending: `Launching ${tasks.length} ${noun}`,
          completed: `Launched ${tasks.length} ${noun}`,
        }
      : {
          pending: `Running ${tasks.length} ${noun}`,
          completed: `Ran ${tasks.length} ${noun}`,
        };
  } else if (agent !== undefined) {
    title = firstNonEmptyLine(task) ?? agent;
    label = isAsync
      ? { pending: `Launching ${agent}`, completed: `Launched ${agent}` }
      : { pending: `Running ${agent}`, completed: `Ran ${agent}` };
    detailParts = [`${agent} agent`];
  } else {
    return null;
  }
  const modelDetail = toOptionalString(model);
  if (modelDetail !== undefined) {
    detailParts.push(`model ${modelDetail}`);
  }
  const base: DeltaPresentation = withTitle(
    {
      label,
      icon: { glyph: "UserRound" },
    },
    presentationTitle(title),
  );
  return {
    shape: {
      type: "delegation",
      childRef: toolCallId,
      label: title,
      background: false,
    },
    presentation:
      detailParts.length === 0
        ? base
        : { ...base, detail: presentationDetail(detailParts.join(" · ")) },
  };
}

function classifyPiToolUse(
  toolName: string,
  args: unknown,
  sessionCwd: string | undefined,
): DeltaItemShape {
  if (PI_COMMAND_TOOL_NAMES.has(toolName)) {
    const parsed = bashArgsSchema.safeParse(args);
    const command = parsed.success
      ? toOptionalString(parsed.data.command)
      : undefined;
    const cwd =
      (parsed.success ? toOptionalString(parsed.data.cwd) : undefined) ??
      toOptionalString(sessionCwd);
    if (!command || !cwd) {
      return { type: "tool", tool: toolName, args };
    }
    return { type: "command", command, cwd };
  }

  if (PI_FILE_CHANGE_TOOL_NAMES.has(toolName)) {
    const parsed = piFileEditArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { type: "tool", tool: toolName, args };
    }
    if (!parsed.data.path) {
      return { type: "tool", tool: toolName, args: parsed.data };
    }
    const path = parsed.data.path;
    const parsedEdits = piFileEditBatchSchema.safeParse(parsed.data.edits);
    if (parsedEdits.success && parsedEdits.data.length > 0) {
      return {
        type: "fileChange",
        changes: parsedEdits.data.map((edit) => ({
          path,
          kind: "update",
          oldText: edit.oldText,
          newText: edit.newText,
        })),
      };
    }

    const newText = parsed.data.newText ?? parsed.data.content;
    return {
      type: "fileChange",
      changes: [
        {
          path,
          kind:
            toolName === "edit" || parsed.data.oldText !== undefined
              ? "update"
              : "add",
          ...(parsed.data.oldText === undefined
            ? {}
            : { oldText: parsed.data.oldText }),
          ...(newText === undefined ? {} : { newText }),
        },
      ],
    };
  }

  return { type: "tool", tool: toolName, args };
}

function resolvePiImageReadPath(
  toolName: string,
  args: unknown,
  sessionCwd: string | undefined,
): string | null {
  if (toolName !== "read") {
    return null;
  }
  const parsed = piReadArgsSchema.safeParse(args);
  if (!parsed.success) {
    return null;
  }
  let path = parsed.data.path.replace(PI_UNICODE_SPACE_PATTERN, " ");
  if (path.startsWith("@")) {
    path = path.slice(1);
  }
  if (path === "~" || path.startsWith("~/")) {
    path = join(homedir(), path.slice(2));
  }
  if (URL_SCHEME_PATTERN.test(path)) {
    return null;
  }
  const absolutePath = isAbsolute(path)
    ? resolve(path)
    : sessionCwd !== undefined && isAbsolute(sessionCwd)
      ? resolve(sessionCwd, path)
      : null;
  return absolutePath !== null && PI_IMAGE_READ_PATH_PATTERN.test(absolutePath)
    ? absolutePath
    : null;
}

function classifyPiToolResultFallback(toolName: string): DeltaItemShape {
  if (PI_FILE_CHANGE_TOOL_NAMES.has(toolName)) {
    return { type: "fileChange", changes: [] };
  }
  return { type: "tool", tool: toolName };
}

interface PiModelContextWindowLookup {
  byCanonicalId: ReadonlyMap<string, number>;
  byModelId: ReadonlyMap<string, number>;
}

export type PiModelContextWindowResolver = (
  lastAssistant: PiAssistantMessage | undefined,
) => number | null;

function buildPiModelContextWindowLookup(
  models: readonly PiContextWindowModel[],
): PiModelContextWindowLookup {
  const byCanonicalId = new Map<string, number>();
  const byModelId = new Map<string, number>();
  for (const model of models) {
    const contextWindow = toPositiveNumber(model.contextWindow);
    if (contextWindow === undefined) {
      continue;
    }
    byCanonicalId.set(
      toCanonicalPiModelId(model.provider, model.id),
      contextWindow,
    );
    byModelId.set(model.id, contextWindow);
  }
  return { byCanonicalId, byModelId };
}

export function createPiModelContextWindowResolverFrom(
  models: readonly PiContextWindowModel[],
): PiModelContextWindowResolver {
  const modelContextWindowLookup = buildPiModelContextWindowLookup(models);
  return (lastAssistant) =>
    resolvePiModelContextWindow(lastAssistant, modelContextWindowLookup);
}

function resolvePiModelContextWindow(
  lastAssistant: PiAssistantMessage | undefined,
  modelContextWindowLookup: PiModelContextWindowLookup,
): number | null {
  const modelId = toOptionalString(lastAssistant?.model);
  if (!modelId) {
    return null;
  }

  const providerId = toOptionalString(lastAssistant?.provider);
  if (providerId) {
    return (
      modelContextWindowLookup.byCanonicalId.get(
        toCanonicalPiModelId(providerId, modelId),
      ) ?? null
    );
  }

  return modelContextWindowLookup.byModelId.get(modelId) ?? null;
}

interface PiDeltaTranslationContext {
  threadId?: string;
  parentToolCallId?: string;
  cwd?: string;
}

export interface PiDetachedRunAssociation {
  readonly candidate: {
    readonly asyncId: string;
    readonly mode: DetachedRunMode;
  };
  readonly toolCallId: string | null;
  readonly eligible: boolean;
  readonly outcome: DetachedRunOutcomeKind | null;
}

export interface PiDetachedRunLifecycleContext {
  readonly threadId: string;
  readonly sessionSerial: number;
  readonly cleanup?: boolean;
}

interface CreatePiDeltaTranslatorOptions {
  resolveModelContextWindow: PiModelContextWindowResolver;
}

const MAX_STARTED_TOOL_SHAPES = 1024;
const MAX_DETACHED_RUN_ROWS = 1024;
const PI_DETACHED_RUN_FAMILY_PREFIX = "pi:detached:";
const PI_DETACHED_TRACKING_LOST_MESSAGE =
  "Tracking lost; the TLH run may still be running.";

interface StartedPiTool {
  shape: DeltaItemShape;
  presentation?: DeltaPresentation;
  deferredImageReadPath: string | null;
}

type DetachedRunSettlement = DetachedRunOutcomeKind | "tracking-lost";

interface DetachedRunFamilyState {
  generation: number;
  reopenable: boolean;
  settledOutcome: DetachedRunSettlement | null;
}

interface DetachedRunRowState {
  sessionSerial: number;
  asyncId: string;
  mode: DetachedRunMode;
  familyId: string;
  description: string;
  toolCallId: string | null;
  providerItemId: string;
  generation: number;
  open: boolean;
  reopenable: boolean;
  settledOutcome: DetachedRunSettlement | null;
}

type DetachedRunTaskShape = Extract<DeltaItemShape, { type: "backgroundTask" }>;

function detachedRunIdentity(asyncId: string): string {
  return encodeURIComponent(asyncId);
}

function detachedRunFamilyId(asyncId: string): string {
  return `${PI_DETACHED_RUN_FAMILY_PREFIX}${detachedRunIdentity(asyncId)}`;
}

function detachedRunDescription(mode: DetachedRunMode): string {
  return mode === "parallel"
    ? "TLH detached parallel subagent run"
    : "TLH detached subagent run";
}

function detachedRunProviderItemId(
  familyId: string,
  generation: number,
): string {
  return `${familyId}:g${generation}`;
}

function detachedRunTaskShape(
  row: DetachedRunRowState,
  outcome: DetachedRunOutcomeKind | "tracking-lost" | null,
): DetachedRunTaskShape {
  if (outcome === null) {
    return {
      type: "backgroundTask",
      familyId: row.familyId,
      taskType: "local_subagent",
      description: row.description,
      status: "pending",
      taskStatus: "running",
      skipTranscript: false,
      foreground: false,
    };
  }
  if (outcome === "completed") {
    return {
      ...detachedRunTaskShape(row, null),
      status: "completed",
      taskStatus: "completed",
      summary: "Detached subagent completed",
    };
  }
  if (outcome === "failed") {
    return {
      ...detachedRunTaskShape(row, null),
      status: "failed",
      taskStatus: "failed",
      error: "Detached subagent failed",
    };
  }
  if (outcome === "cancelled") {
    return {
      ...detachedRunTaskShape(row, null),
      status: "interrupted",
      taskStatus: "stopped",
      summary: "Detached subagent cancelled",
    };
  }
  if (outcome === "paused") {
    return {
      ...detachedRunTaskShape(row, null),
      status: "interrupted",
      taskStatus: "paused",
      summary: "Detached subagent paused",
    };
  }
  return {
    ...detachedRunTaskShape(row, null),
    status: "failed",
    taskStatus: "failed",
    error: PI_DETACHED_TRACKING_LOST_MESSAGE,
  };
}

function detachedRunKey(
  providerItemId: string,
  toolCallId: string | null,
): { providerItemId: string; parentRef?: string } {
  return toolCallId === null
    ? { providerItemId }
    : { providerItemId, parentRef: toolCallId };
}

export function createPiDeltaTranslator(
  options: CreatePiDeltaTranslatorOptions,
) {
  const { resolveModelContextWindow } = options;

  const startedToolShapes = new Map<string, StartedPiTool>();
  const cumulativeTokensByThreadId = new Map<
    string,
    ThreadEventTokenUsageBreakdown
  >();
  const promptCacheTtlMsByThreadId = new Map<string, number>();
  const detachedRunRowsByThreadId = new Map<
    string,
    Map<string, DetachedRunRowState>
  >();
  const detachedRunFamilyStatesByThreadId = new Map<
    string,
    Map<string, DetachedRunFamilyState>
  >();
  const detachedRunGenerationsByThreadId = new Map<
    string,
    Map<string, number>
  >();

  function detachedRunStateKey(
    sessionSerial: number,
    familyId: string,
  ): string {
    return `${sessionSerial}\u0000${familyId}`;
  }

  function rememberDetachedRunFamilyState(
    threadId: string,
    row: DetachedRunRowState,
  ): void {
    const familyStates =
      detachedRunFamilyStatesByThreadId.get(threadId) ??
      new Map<string, DetachedRunFamilyState>();
    detachedRunFamilyStatesByThreadId.set(threadId, familyStates);
    const stateKey = detachedRunStateKey(row.sessionSerial, row.familyId);
    const existing = familyStates.get(stateKey);
    familyStates.set(stateKey, {
      generation: Math.max(existing?.generation ?? 0, row.generation),
      reopenable: row.reopenable,
      settledOutcome: row.settledOutcome,
    });
    const generations =
      detachedRunGenerationsByThreadId.get(threadId) ??
      new Map<string, number>();
    detachedRunGenerationsByThreadId.set(threadId, generations);
    generations.set(
      row.familyId,
      Math.max(generations.get(row.familyId) ?? 0, row.generation),
    );
  }

  function nextDetachedRunProviderItemId(
    threadId: string,
    row: DetachedRunRowState,
  ): string {
    const generations =
      detachedRunGenerationsByThreadId.get(threadId) ??
      new Map<string, number>();
    detachedRunGenerationsByThreadId.set(threadId, generations);
    const generation = (generations.get(row.familyId) ?? 0) + 1;
    generations.set(row.familyId, generation);
    row.generation = generation;
    row.providerItemId = detachedRunProviderItemId(
      row.familyId,
      row.generation,
    );
    return row.providerItemId;
  }

  function detachedRunFamilyState(
    threadId: string,
    sessionSerial: number,
    familyId: string,
  ): DetachedRunFamilyState | undefined {
    return detachedRunFamilyStatesByThreadId
      .get(threadId)
      ?.get(detachedRunStateKey(sessionSerial, familyId));
  }

  function resetThread(threadId: string): void {
    cumulativeTokensByThreadId.delete(threadId);
    promptCacheTtlMsByThreadId.delete(threadId);
    detachedRunRowsByThreadId.delete(threadId);
    detachedRunFamilyStatesByThreadId.delete(threadId);
    detachedRunGenerationsByThreadId.delete(threadId);
    clearThreadToolShapes({ threadId });
  }

  function toolShapeKey(
    context: PiDeltaTranslationContext | undefined,
    toolCallId: string,
  ): string {
    return `${context?.threadId ?? ""} ${toolCallId}`;
  }

  function rememberStartedToolShape(key: string, started: StartedPiTool): void {
    startedToolShapes.set(key, started);
    while (startedToolShapes.size > MAX_STARTED_TOOL_SHAPES) {
      const oldest = startedToolShapes.keys().next();
      if (oldest.done === true) {
        break;
      }
      startedToolShapes.delete(oldest.value);
    }
  }

  function clearThreadToolShapes(
    context: PiDeltaTranslationContext | undefined,
  ): void {
    const prefix = `${context?.threadId ?? ""} `;
    for (const key of [...startedToolShapes.keys()]) {
      if (key.startsWith(prefix)) {
        startedToolShapes.delete(key);
      }
    }
  }

  function toRawEvent(rawEvent: JsonRpcMessage): ProviderRawEvent {
    const parsed = providerRawEventSchema.safeParse(rawEvent);
    if (parsed.success) {
      return parsed.data;
    }
    return {
      jsonrpc: "2.0",
      ...(rawEvent.id !== undefined ? { id: rawEvent.id } : {}),
      method: rawEvent.method,
      params: {
        serializationError:
          "Provider raw event params were not JSON-serializable.",
      },
    };
  }

  function unhandledDeltas(
    rawEvent: JsonRpcMessage,
    parentToolCallId: string | undefined,
  ): ThreadDelta[] {
    const description = piVisibilityMetadata.describeRawEvent(rawEvent);
    if (description.coverage !== "unknown") {
      return [];
    }
    return [
      {
        kind: "unhandled",
        raw: toRawEvent(rawEvent),
        rawType: description.kind,
        vouchedTurn: true,
        ...(parentToolCallId ? { parentRef: parentToolCallId } : {}),
      },
    ];
  }

  function noTurnFallbackFor(
    rawMessage: unknown,
    context: PiDeltaTranslationContext | undefined,
  ): DeltaNoTurnFallback {
    const rawEvent: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        ...(context?.threadId ? { threadId: context.threadId } : {}),
        message: rawMessage,
      },
    };
    return {
      raw: toRawEvent(rawEvent),
      rawType: piVisibilityMetadata.describeRawEvent(rawEvent).kind,
    };
  }

  function unexpectedSdkEventDeltas(
    rawMessage: unknown,
    context: PiDeltaTranslationContext | undefined,
  ): ThreadDelta[] {
    const fallback = noTurnFallbackFor(rawMessage, context);
    return [
      {
        kind: "unhandled",
        raw: fallback.raw,
        rawType: fallback.rawType,
        vouchedTurn: true,
        ...(context?.parentToolCallId
          ? { parentRef: context.parentToolCallId }
          : {}),
      },
    ];
  }

  function translateDetachedRunLifecycle(
    associations: readonly PiDetachedRunAssociation[],
    context: PiDetachedRunLifecycleContext,
  ): ThreadDelta[] {
    const rows =
      detachedRunRowsByThreadId.get(context.threadId) ??
      new Map<string, DetachedRunRowState>();
    detachedRunRowsByThreadId.set(context.threadId, rows);
    const deltas: ThreadDelta[] = [];
    const sessionSerial = context.sessionSerial;

    const closeRow = (
      row: DetachedRunRowState,
      outcome: DetachedRunSettlement,
    ): void => {
      if (!row.open) return;
      const item = detachedRunTaskShape(row, outcome);
      deltas.push({
        kind: "item.close",
        key: detachedRunKey(row.providerItemId, row.toolCallId),
        status: item.status,
        item,
      });
      row.open = false;
      row.settledOutcome = outcome;
      rememberDetachedRunFamilyState(context.threadId, row);
    };

    const emitLateTerminalCorrection = (
      row: DetachedRunRowState,
      outcome: DetachedRunOutcomeKind,
    ): void => {
      nextDetachedRunProviderItemId(context.threadId, row);
      const item = detachedRunTaskShape(row, outcome);
      deltas.push({
        kind: "item.close",
        key: detachedRunKey(row.providerItemId, row.toolCallId),
        status: item.status,
        item,
      });
      row.settledOutcome = outcome;
      row.reopenable = false;
      rememberDetachedRunFamilyState(context.threadId, row);
    };

    if (context.cleanup === true) {
      for (const association of associations) {
        const outcome = association.outcome;
        if (outcome === null) continue;
        const rowKey = detachedRunStateKey(
          sessionSerial,
          association.candidate.asyncId,
        );
        let row = rows.get(rowKey);
        if (row === undefined) {
          const familyId = detachedRunFamilyId(association.candidate.asyncId);
          const familyState = detachedRunFamilyState(
            context.threadId,
            sessionSerial,
            familyId,
          );
          if (
            familyState?.settledOutcome !== "tracking-lost" ||
            !familyState.reopenable
          ) {
            continue;
          }
          row = {
            sessionSerial,
            asyncId: association.candidate.asyncId,
            mode: association.candidate.mode,
            familyId,
            description: detachedRunDescription(association.candidate.mode),
            toolCallId: association.toolCallId,
            providerItemId: detachedRunProviderItemId(
              familyId,
              familyState.generation,
            ),
            generation: familyState.generation,
            open: false,
            reopenable: familyState.reopenable,
            settledOutcome: familyState.settledOutcome,
          };
          rows.set(rowKey, row);
        } else if (row.toolCallId === null && association.toolCallId !== null) {
          row.toolCallId = association.toolCallId;
        }

        if (row.open) {
          closeRow(row, outcome);
          row.reopenable = false;
          rememberDetachedRunFamilyState(context.threadId, row);
        } else if (row.settledOutcome === "tracking-lost" && row.reopenable) {
          emitLateTerminalCorrection(row, outcome);
        } else if (row.settledOutcome === null) {
          row.settledOutcome = outcome;
          row.reopenable = false;
          rememberDetachedRunFamilyState(context.threadId, row);
        }
      }
      for (const row of rows.values()) {
        if (row.sessionSerial !== sessionSerial || !row.open) continue;
        closeRow(row, "tracking-lost");
        row.reopenable = false;
        rememberDetachedRunFamilyState(context.threadId, row);
      }
      return deltas;
    }

    const seenRowKeys = new Set<string>();
    for (const association of associations) {
      const asyncId = association.candidate.asyncId;
      const rowKey = detachedRunStateKey(sessionSerial, asyncId);
      seenRowKeys.add(rowKey);
      let row = rows.get(rowKey);
      if (row === undefined) {
        const familyId = detachedRunFamilyId(asyncId);
        const familyState = detachedRunFamilyState(
          context.threadId,
          sessionSerial,
          familyId,
        );
        row = {
          sessionSerial,
          asyncId,
          mode: association.candidate.mode,
          familyId,
          description: detachedRunDescription(association.candidate.mode),
          toolCallId: association.toolCallId,
          providerItemId: detachedRunProviderItemId(
            familyId,
            familyState?.generation ?? 0,
          ),
          generation: familyState?.generation ?? 0,
          open: false,
          reopenable: familyState?.reopenable ?? true,
          settledOutcome: familyState?.settledOutcome ?? null,
        };
        rows.set(rowKey, row);
      } else if (row.toolCallId === null && association.toolCallId !== null) {
        row.toolCallId = association.toolCallId;
      }

      if (association.outcome !== null) {
        if (row.open) {
          closeRow(row, association.outcome);
          row.reopenable = false;
          rememberDetachedRunFamilyState(context.threadId, row);
        } else if (row.settledOutcome === "tracking-lost" && row.reopenable) {
          emitLateTerminalCorrection(row, association.outcome);
        } else {
          row.settledOutcome = association.outcome;
          row.reopenable = false;
          rememberDetachedRunFamilyState(context.threadId, row);
        }
        continue;
      }

      if (
        association.eligible &&
        row.reopenable &&
        !row.open &&
        row.toolCallId !== null
      ) {
        nextDetachedRunProviderItemId(context.threadId, row);
        row.settledOutcome = null;
        const item = detachedRunTaskShape(row, null);
        deltas.push({
          kind: "item.open",
          key: detachedRunKey(row.providerItemId, row.toolCallId),
          item,
          attach: "currentOrLast",
        });
        row.open = true;
        rememberDetachedRunFamilyState(context.threadId, row);
      }
    }

    for (const [rowKey, row] of rows) {
      if (
        row.sessionSerial === sessionSerial &&
        row.open &&
        !seenRowKeys.has(rowKey)
      ) {
        closeRow(row, "tracking-lost");
      }
    }

    while (rows.size > MAX_DETACHED_RUN_ROWS) {
      const evictable = [...rows].find(([, candidate]) => !candidate.open);
      if (evictable === undefined) break;
      rows.delete(evictable[0]);
    }
    return deltas;
  }

  function translate(
    event: unknown,
    context?: PiDeltaTranslationContext,
  ): ThreadDelta[] {
    const sdkEnvelope = sdkMessageEnvelopeSchema.safeParse(event);
    if (sdkEnvelope.success) {
      if (
        piIgnoredEventSchema.safeParse(sdkEnvelope.data.params.message).success
      ) {
        return [];
      }
      const parentToolCallId =
        sdkEnvelope.data.params.parent_tool_use_id ?? context?.parentToolCallId;
      const translated = translate(sdkEnvelope.data.params.message, {
        ...context,
        ...(parentToolCallId ? { parentToolCallId } : {}),
      });
      return translated.length > 0
        ? translated
        : unhandledDeltas(
            {
              jsonrpc: "2.0",
              method: sdkEnvelope.data.method,
              params: sdkEnvelope.data.params,
            },
            parentToolCallId,
          );
    }

    const promptSettledEnvelope =
      piPromptSettledEnvelopeSchema.safeParse(event);
    if (promptSettledEnvelope.success) {
      clearThreadToolShapes(context);
      return [
        {
          kind: "turn.boundary",
          status: promptSettledEnvelope.data.params.status,
          ...(promptSettledEnvelope.data.params.error !== undefined
            ? { error: { message: promptSettledEnvelope.data.params.error } }
            : {}),
          claimIfIdle: true,
        },
      ];
    }

    const contextWindowUsageEnvelope =
      threadContextWindowUsageEnvelopeSchema.safeParse(event);
    if (contextWindowUsageEnvelope.success) {
      const { contextWindowUsage } = contextWindowUsageEnvelope.data.params;
      const used = contextWindowUsage.usedTokens;
      const size = contextWindowUsage.modelContextWindow;
      return [
        {
          kind: "contextWindow",
          used:
            typeof used === "number" && Number.isFinite(used) && used >= 0
              ? used
              : null,
          size: toPositiveNumber(size) ?? null,
          estimated: contextWindowUsage.estimated,
          attach: "currentOrLast",
        },
      ];
    }

    const statusEnvelope = piStatusUpdatedEnvelopeSchema.safeParse(event);
    if (statusEnvelope.success) {
      return [
        {
          kind: "extension.state",
          extensionKind: PI_STATUS_EXTENSION_KIND,
          payload: statusEnvelope.data.params.status,
        },
      ];
    }

    const errorEnvelope = errorEnvelopeSchema.safeParse(event);
    if (errorEnvelope.success) {
      clearThreadToolShapes(context);
      return [
        {
          kind: "provider.error",
          message: "Provider error",
          detail: errorEnvelope.data.params?.message ?? "unknown error",
          settlesTurn: true,
        },
      ];
    }

    const envelope = jsonRpcEnvelopeSchema.safeParse(event);
    if (envelope.success) {
      return unhandledDeltas(
        {
          jsonrpc: "2.0",
          method: envelope.data.method,
          ...(envelope.data.params ? { params: envelope.data.params } : {}),
        },
        context?.parentToolCallId,
      );
    }

    const eventType = piEventTypeSchema.safeParse(event);
    if (!eventType.success) {
      return [];
    }
    const parentRef = context?.parentToolCallId;
    const parentRefField = parentRef ? { parentRef } : {};

    switch (eventType.data.type) {
      case "agent_start":
        return [{ kind: "turn.open" }];

      case "message_end":
      case "message_start": {
        const piEvent = piCustomMessageBoundaryEventSchema.safeParse(event);
        if (!piEvent.success) {
          return [];
        }
        if (
          piEvent.data.type === "message_end" ||
          !piEvent.data.message.display
        ) {
          return [];
        }
        const text = extractCustomMessageText(piEvent.data.message.content);
        if (text === undefined) {
          return [];
        }
        return [{ kind: "input.provider", text, ...parentRefField }];
      }

      case "compaction_start": {
        const parsed = piCompactionStartEventSchema.safeParse(event);
        if (!parsed.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const open: ThreadDelta = {
          kind: "item.open",
          key: { channel: "compaction" },
          item: { type: "compaction" },
          ...(parsed.data.reason === "manual"
            ? {}
            : { attach: "currentOrLast" }),
          noTurnFallback: noTurnFallbackFor(event, context),
        };
        return parsed.data.reason === "manual"
          ? [{ kind: "turn.open" }, open]
          : [open];
      }

      case "compaction_end": {
        const parsed = piCompactionEndEventSchema.safeParse(event);
        if (!parsed.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const succeeded = !parsed.data.aborted && !parsed.data.errorMessage;
        const compacted: ThreadDelta = {
          kind: "context.compacted",
          noTurnFallback: noTurnFallbackFor(event, context),
        };
        if (parsed.data.reason === "manual") {
          clearThreadToolShapes(context);
          const compactionNoopDetail =
            !parsed.data.aborted &&
            parsed.data.errorMessage !== undefined &&
            isPiCompactionNoop(parsed.data.errorMessage)
              ? parsed.data.errorMessage
              : undefined;
          if (compactionNoopDetail !== undefined) {
            return [
              {
                kind: "provider.warning",
                category: "compaction-skipped",
                summary: "Context compaction skipped",
                details: compactionNoopDetail,
                vouchedTurn: true,
              },
              { kind: "turn.boundary", status: "completed" },
            ];
          }
          return [
            ...(succeeded ? [compacted] : []),
            {
              kind: "turn.boundary",
              status: parsed.data.aborted
                ? "interrupted"
                : parsed.data.errorMessage
                  ? "failed"
                  : "completed",
              ...(parsed.data.errorMessage
                ? { error: { message: parsed.data.errorMessage } }
                : {}),
            },
          ];
        }
        if (succeeded) {
          return [compacted];
        }
        return [
          {
            kind: "provider.error",
            message: parsed.data.aborted
              ? "Context compaction interrupted"
              : "Context compaction failed",
            detail:
              parsed.data.errorMessage ??
              "Automatic context compaction was interrupted",
          },
        ];
      }

      case "agent_end": {
        const piEvent = piAgentEndEventSchema.safeParse(event);
        if (!piEvent.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const lastAssistant = findLastAssistantMessage(piEvent.data.messages);
        if (piEvent.data.willRetry && !piEvent.data.deferSettlement) {
          if (lastAssistant && isPiAssistantError(lastAssistant)) {
            return [
              {
                kind: "provider.error",
                message: "Provider error",
                detail: lastAssistant.errorMessage,
                willRetry: true,
              },
            ];
          }
          return [];
        }
        const settlementError =
          piEvent.data.settlementError ??
          runSettlementError(piEvent.data, piEvent.data.messages);
        if (settlementError && !piEvent.data.deferSettlement) {
          clearThreadToolShapes(context);
          const failure: ThreadDelta[] = [];
          if (!piEvent.data.settlementErrorReported) {
            failure.push({
              kind: "provider.error",
              message: "Provider error",
              detail: settlementError,
            });
          }
          failure.push({
            kind: "turn.boundary",
            status: "failed",
            ...(piEvent.data.providerCheckpointId !== undefined
              ? { providerCheckpointId: piEvent.data.providerCheckpointId }
              : {}),
          });
          return failure;
        }
        if (!piEvent.data.deferSettlement) clearThreadToolShapes(context);
        const deltas: ThreadDelta[] = [];
        if (
          settlementError &&
          piEvent.data.deferSettlement &&
          (piEvent.data.willRetry || piEvent.data.settlementSuperseded)
        ) {
          deltas.push({
            kind: "provider.error",
            message: "Provider error",
            detail: settlementError,
            ...(piEvent.data.willRetry ? { willRetry: true } : {}),
          });
        }
        if (lastAssistant && !piEvent.data.settlementOnly && !settlementError) {
          const text = extractAssistantText(lastAssistant);
          if (text) {
            deltas.push({
              kind: "item.textClose",
              key: { channel: ASSISTANT_STREAM_KEY, ...parentRefField },
              channel: "agentMessage",
              text,
            });
          }
        }
        const usage = piEvent.data.settlementOnly
          ? undefined
          : toAssistantUsageBreakdown(lastAssistant);
        if (usage && !(settlementError && usage.totalTokens === 0)) {
          const threadKey = context?.threadId ?? "";
          const total = addTokenUsage(
            cumulativeTokensByThreadId.get(threadKey) ?? ZERO_TOKEN_USAGE,
            usage,
          );
          cumulativeTokensByThreadId.set(threadKey, total);
          const reportedTtlMs = toPromptCacheTtlMs(lastAssistant);
          if (reportedTtlMs !== undefined) {
            promptCacheTtlMsByThreadId.set(threadKey, reportedTtlMs);
          }
          const promptCacheTtlMs = promptCacheTtlMsByThreadId.get(threadKey);
          deltas.push({
            kind: "usage",
            total,
            last: usage,
            modelContextWindow: resolveModelContextWindow(lastAssistant),
            ...(promptCacheTtlMs === undefined ? {} : { promptCacheTtlMs }),
          });
        }
        if (piEvent.data.deferSettlement) return deltas;
        deltas.push({
          kind: "turn.boundary",
          status: "completed",
          ...(piEvent.data.providerCheckpointId !== undefined
            ? { providerCheckpointId: piEvent.data.providerCheckpointId }
            : {}),
          claimIfIdle: true,
        });
        return deltas;
      }

      case "message_update": {
        const piEvent = piMessageUpdateEventSchema.safeParse(event);
        if (!piEvent.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const assistantEvent = piEvent.data.assistantMessageEvent;
        if (assistantEvent.type === "text_delta") {
          const delta = assistantEvent.delta;
          if (!delta) {
            return [];
          }
          return [
            {
              kind: "item.textDelta",
              key: { channel: ASSISTANT_STREAM_KEY, ...parentRefField },
              channel: "agentMessage",
              text: delta,
            },
          ];
        }
        if (assistantEvent.type === "thinking_delta") {
          const delta = assistantEvent.delta;
          if (!delta) {
            return [];
          }
          if (typeof assistantEvent.contentIndex !== "number") {
            return unexpectedSdkEventDeltas(event, context);
          }
          return [
            {
              kind: "item.textDelta",
              key: {
                channel: thinkingStreamChannel(assistantEvent.contentIndex),
                ...parentRefField,
              },
              channel: "reasoningText",
              text: delta,
            },
          ];
        }
        if (assistantEvent.type === "thinking_end") {
          const content = assistantEvent.content;
          if (!content) {
            return [];
          }
          if (typeof assistantEvent.contentIndex !== "number") {
            return unexpectedSdkEventDeltas(event, context);
          }
          return [
            {
              kind: "item.textClose",
              key: {
                channel: thinkingStreamChannel(assistantEvent.contentIndex),
                ...parentRefField,
              },
              channel: "reasoningText",
              text: content,
            },
          ];
        }
        return [];
      }

      case "tool_execution_start": {
        const piEvent = piToolExecutionStartEventSchema.safeParse(event);
        if (!piEvent.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const subagent =
          piEvent.data.toolName === "subagent"
            ? classifyPiSubagent(piEvent.data.toolCallId, piEvent.data.args)
            : null;
        const shape: DeltaItemShape =
          subagent === null
            ? classifyPiToolUse(
                piEvent.data.toolName,
                piEvent.data.args,
                context?.cwd,
              )
            : subagent.shape;
        const presentation = subagent?.presentation;
        const deferredImageReadPath = resolvePiImageReadPath(
          piEvent.data.toolName,
          piEvent.data.args,
          context?.cwd,
        );
        rememberStartedToolShape(
          toolShapeKey(context, piEvent.data.toolCallId),
          {
            shape,
            deferredImageReadPath,
            ...(presentation === undefined ? {} : { presentation }),
          },
        );
        if (deferredImageReadPath !== null) {
          return [];
        }
        return [
          {
            kind: "item.open",
            key: {
              providerItemId: piEvent.data.toolCallId,
              ...parentRefField,
            },
            item: shape,
            ...(presentation === undefined ? {} : { presentation }),
            noTurnFallback: noTurnFallbackFor(piEvent.data, context),
          },
        ];
      }

      case "tool_execution_end": {
        const piEvent = piToolExecutionEndEventSchema.safeParse(event);
        if (!piEvent.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const resultText = extractResultText(piEvent.data.result);
        const aggregatedOutput = PI_COMMAND_TOOL_NAMES.has(
          piEvent.data.toolName,
        )
          ? extractPiCommandExecutionOutput(piEvent.data.result)
          : undefined;
        const shapeKey = toolShapeKey(context, piEvent.data.toolCallId);
        const started = startedToolShapes.get(shapeKey);
        startedToolShapes.delete(shapeKey);
        const deferredImageReadPath = started?.deferredImageReadPath ?? null;
        const terminalShape: DeltaItemShape =
          deferredImageReadPath !== null &&
          !piEvent.data.isError &&
          hasPiImageContent(piEvent.data.result)
            ? { type: "imageView", path: deferredImageReadPath }
            : (started?.shape ??
              classifyPiToolResultFallback(piEvent.data.toolName));
        const closingShape: DeltaItemShape =
          terminalShape.type === "delegation" &&
          resultText !== undefined &&
          resultText.trim().length > 0
            ? { ...terminalShape, summary: resultText.trim() }
            : terminalShape;
        const key = {
          providerItemId: piEvent.data.toolCallId,
          ...parentRefField,
        };
        const noTurnFallback = noTurnFallbackFor(piEvent.data, context);
        const deferredOpen: ThreadDelta[] =
          deferredImageReadPath === null
            ? []
            : [{ kind: "item.open", key, item: terminalShape, noTurnFallback }];
        return [
          ...deferredOpen,
          {
            kind: "item.close",
            key,
            status: piEvent.data.isError ? "failed" : "completed",
            resultText,
            exitCode: piEvent.data.isError ? 1 : 0,
            ...(aggregatedOutput === undefined ? {} : { aggregatedOutput }),
            item: closingShape,
            ...(started?.presentation === undefined ||
            terminalShape.type !== "delegation"
              ? {}
              : { presentation: started.presentation }),
            noTurnFallback,
          },
        ];
      }

      case "tool_execution_update": {
        const piEvent = piToolExecutionUpdateEventSchema.safeParse(event);
        if (!piEvent.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const started = startedToolShapes.get(
          toolShapeKey(context, piEvent.data.toolCallId),
        );
        if ((started?.deferredImageReadPath ?? null) !== null) {
          return [];
        }
        if (PI_COMMAND_TOOL_NAMES.has(piEvent.data.toolName)) {
          const snapshot = extractPiCommandExecutionOutput(
            piEvent.data.partialResult,
          );
          if (snapshot === undefined) {
            return [];
          }
          return [
            {
              kind: "command.outputSnapshot",
              key: {
                providerItemId: piEvent.data.toolCallId,
                ...parentRefField,
              },
              text: snapshot,
              noTurnFallback: noTurnFallbackFor(piEvent.data, context),
            },
          ];
        }
        return [
          {
            kind: "item.progress",
            key: {
              providerItemId: piEvent.data.toolCallId,
              ...parentRefField,
            },
            message:
              (piEvent.data.toolName === "subagent"
                ? formatPiSubagentProgress(piEvent.data.partialResult)
                : undefined) ?? extractPiToolProgressText(piEvent.data),
            noTurnFallback: noTurnFallbackFor(piEvent.data, context),
          },
        ];
      }

      default:
        return [];
    }
  }

  return { translate, resetThread, translateDetachedRunLifecycle };
}

function findLastAssistantMessage(
  messages: PiConversationMessage[],
): PiAssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const parsedMessage = piAssistantMessageSchema.safeParse(message);
    if (parsedMessage.success) {
      return parsedMessage.data;
    }
  }
  return undefined;
}

function extractAssistantText(message: PiAssistantMessage): string | undefined {
  const content = message.content;
  const chunks: string[] = [];
  for (const block of content) {
    const parsedBlock = textBlockSchema.safeParse(block);
    if (parsedBlock.success) {
      chunks.push(parsedBlock.data.text);
    }
  }
  const text = chunks.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

function extractCustomMessageText(
  content: z.infer<
    typeof piCustomMessageBoundaryEventSchema
  >["message"]["content"],
): string | undefined {
  const text = (
    typeof content === "string"
      ? content
      : content
          .flatMap((block) => {
            const parsedBlock = textBlockSchema.safeParse(block);
            return parsedBlock.success ? [parsedBlock.data.text] : [];
          })
          .join("\n")
  ).trim();
  return text.length > 0 ? text : undefined;
}

function isPiAssistantError(
  message: PiAssistantMessage,
): message is PiAssistantErrorMessage {
  return (
    message.stopReason === "error" &&
    typeof message.errorMessage === "string" &&
    message.errorMessage.trim().length > 0
  );
}

function extractPiCommandExecutionOutput(content: unknown): string | undefined {
  return normalizeProviderCommandOutput({
    text: extractResultText(content),
    emptyPlaceholders: PI_EMPTY_BASH_OUTPUT_PLACEHOLDERS,
  });
}

function extractPiToolProgressText(event: PiToolExecutionUpdateEvent): string {
  const text = extractResultText(event.partialResult).trim();
  return text.length > 0 ? text : `${event.toolName} progress update`;
}

const PI_ONE_HOUR_CACHE_TTL_MS = 60 * 60_000;
const PI_FIVE_MINUTE_CACHE_TTL_MS = 5 * 60_000;

function toPromptCacheTtlMs(
  lastAssistant: PiAssistantMessage | undefined,
): number | undefined {
  const usage = lastAssistant?.usage;
  if (usage?.cacheWrite1h === undefined) return undefined;
  if (usage.cacheWrite1h > 0) return PI_ONE_HOUR_CACHE_TTL_MS;
  if (toNonNegativeNumber(usage.cacheWrite) > 0) {
    return PI_FIVE_MINUTE_CACHE_TTL_MS;
  }
  return undefined;
}

function toAssistantUsageBreakdown(
  lastAssistant: PiAssistantMessage | undefined,
) {
  const typedUsage = lastAssistant?.usage;
  if (!typedUsage) return undefined;

  const inputTokens = toNonNegativeNumber(typedUsage.input);
  const outputTokens = toNonNegativeNumber(typedUsage.output);
  const cachedInputTokens =
    toNonNegativeNumber(typedUsage.cacheRead) +
    toNonNegativeNumber(typedUsage.cacheWrite);
  const totalTokens = toNonNegativeNumber(typedUsage.totalTokens);

  return {
    totalTokens:
      totalTokens > 0
        ? totalTokens
        : inputTokens + outputTokens + cachedInputTokens,
    inputTokens,
    cachedInputTokens,
    ...(typedUsage.cacheRead === undefined
      ? {}
      : { cacheReadInputTokens: typedUsage.cacheRead }),
    ...(typedUsage.cacheWrite === undefined
      ? {}
      : { cacheWriteInputTokens: typedUsage.cacheWrite }),
    outputTokens,
    reasoningOutputTokens: 0,
  };
}
