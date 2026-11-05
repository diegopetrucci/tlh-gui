import { z } from "zod";

const asyncIdSchema = z.string().trim().min(1);
const detachedRunModeSchema = z.enum(["single", "parallel"]);
const detachedRunCandidateSchema = z
  .object({
    asyncId: asyncIdSchema,
    mode: detachedRunModeSchema,
  })
  .strict();

const detachedResultDetailsSchema = z
  .object({
    asyncId: asyncIdSchema,
    mode: detachedRunModeSchema,
    results: z.array(z.unknown()),
    awaited: z.boolean().optional(),
  })
  .passthrough();

const detachedActivitySnapshotSchema = z
  .object({
    type: z.literal("tlh:effective-activity").optional(),
    activeAsyncJobIds: z.array(asyncIdSchema),
  })
  .passthrough();

const detachedRunOutcomeSchema = z
  .object({
    type: z.literal("subagent:async-complete").optional(),
    runId: asyncIdSchema.optional(),
    id: asyncIdSchema.optional(),
    state: z.string(),
  })
  .passthrough();

export type DetachedRunMode = z.infer<typeof detachedRunModeSchema>;

export interface DetachedRunCandidate {
  readonly asyncId: string;
  readonly mode: DetachedRunMode;
}

export type DetachedRunOutcomeKind =
  | "cancelled"
  | "completed"
  | "failed"
  | "paused";

export interface DetachedRunOutcome {
  readonly asyncId: string;
  readonly outcome: DetachedRunOutcomeKind;
}

const TERMINAL_OUTCOMES = new Map<string, DetachedRunOutcomeKind>([
  ["cancelled", "cancelled"],
  ["complete", "completed"],
  ["completed", "completed"],
  ["continued", "completed"],
  ["failed", "failed"],
  ["paused", "paused"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractDetachedResultDetails(value: unknown): unknown {
  let current = value;
  const visited = new Set<Record<string, unknown>>();

  while (isRecord(current)) {
    if (visited.has(current)) {
      return null;
    }
    visited.add(current);

    if (Object.hasOwn(current, "toolName") && current.toolName !== "subagent") {
      return null;
    }
    if (Object.hasOwn(current, "isError")) {
      if (typeof current.isError !== "boolean" || current.isError) {
        return null;
      }
    }
    if (Object.hasOwn(current, "error")) {
      return null;
    }
    if (Object.hasOwn(current, "asyncId")) {
      return current;
    }
    if (Object.hasOwn(current, "details")) {
      current = current.details;
      continue;
    }
    if (Object.hasOwn(current, "result")) {
      current = current.result;
      continue;
    }
    return current;
  }

  return null;
}

export function classifyDetachedResultCandidate(
  value: unknown,
): DetachedRunCandidate | null {
  const details = extractDetachedResultDetails(value);
  const parsed = detachedResultDetailsSchema.safeParse(details);
  if (!parsed.success) {
    return null;
  }
  const result = parsed.data;
  if (result.awaited === true || result.results.length !== 0) {
    return null;
  }
  return { asyncId: result.asyncId, mode: result.mode };
}

export function parseDetachedActivitySnapshot(
  value: unknown,
): readonly string[] | null {
  const parsed = detachedActivitySnapshotSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return [...new Set(parsed.data.activeAsyncJobIds)];
}

export function parseDetachedRunOutcome(
  value: unknown,
): DetachedRunOutcome | null {
  const parsed = detachedRunOutcomeSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const asyncId = parsed.data.runId ?? parsed.data.id;
  if (asyncId === undefined) {
    return null;
  }
  const outcome = TERMINAL_OUTCOMES.get(parsed.data.state);
  if (outcome === undefined) {
    return null;
  }
  return { asyncId, outcome };
}

export interface DetachedRunReconciler {
  recordCandidate(value: unknown): boolean;
  recordResult(value: unknown): DetachedRunCandidate | null;
  recordActivitySnapshot(value: unknown): boolean;
  recordOutcome(value: unknown): boolean;
  isEligible(asyncId: string): boolean;
  getOutcome(asyncId: string): DetachedRunOutcomeKind | null;
  getEligibleCandidates(): readonly DetachedRunCandidate[];
  reset(): void;
  dispose(): void;
}

export function createDetachedRunReconciler(): DetachedRunReconciler {
  const candidates = new Map<string, DetachedRunCandidate>();
  const terminalOutcomes = new Map<string, DetachedRunOutcomeKind>();
  let activeAsyncJobIds: ReadonlySet<string> | null = null;
  let disposed = false;

  function recordCandidate(value: unknown): boolean {
    if (disposed) {
      return false;
    }
    const parsed = detachedRunCandidateSchema.safeParse(value);
    if (!parsed.success) {
      return false;
    }
    const candidate: DetachedRunCandidate = {
      asyncId: parsed.data.asyncId,
      mode: parsed.data.mode,
    };
    const previous = candidates.get(candidate.asyncId);
    if (previous !== undefined && previous.mode !== candidate.mode) {
      return false;
    }
    candidates.set(candidate.asyncId, candidate);
    return true;
  }

  function recordResult(value: unknown): DetachedRunCandidate | null {
    const candidate = classifyDetachedResultCandidate(value);
    return candidate !== null && recordCandidate(candidate) ? candidate : null;
  }

  function recordActivitySnapshot(value: unknown): boolean {
    if (disposed) {
      return false;
    }
    const snapshot = parseDetachedActivitySnapshot(value);
    if (snapshot === null) {
      return false;
    }
    activeAsyncJobIds = new Set(snapshot);
    return true;
  }

  function recordOutcome(value: unknown): boolean {
    if (disposed) {
      return false;
    }
    const outcome = parseDetachedRunOutcome(value);
    if (outcome === null) {
      return false;
    }
    terminalOutcomes.set(outcome.asyncId, outcome.outcome);
    return true;
  }

  function isEligible(asyncId: string): boolean {
    const parsed = asyncIdSchema.safeParse(asyncId);
    if (!parsed.success || activeAsyncJobIds === null) {
      return false;
    }
    return (
      candidates.has(parsed.data) &&
      activeAsyncJobIds.has(parsed.data) &&
      !terminalOutcomes.has(parsed.data)
    );
  }

  function getOutcome(asyncId: string): DetachedRunOutcomeKind | null {
    const parsed = asyncIdSchema.safeParse(asyncId);
    if (!parsed.success) {
      return null;
    }
    return terminalOutcomes.get(parsed.data) ?? null;
  }

  function getEligibleCandidates(): readonly DetachedRunCandidate[] {
    if (disposed || activeAsyncJobIds === null) {
      return [];
    }
    return [...candidates.values()]
      .filter(
        (candidate) =>
          activeAsyncJobIds?.has(candidate.asyncId) === true &&
          !terminalOutcomes.has(candidate.asyncId),
      )
      .map((candidate) => ({ ...candidate }));
  }

  function reset(): void {
    candidates.clear();
    terminalOutcomes.clear();
    activeAsyncJobIds = null;
  }

  function dispose(): void {
    reset();
    disposed = true;
  }

  return {
    recordCandidate,
    recordResult,
    recordActivitySnapshot,
    recordOutcome,
    isEligible,
    getOutcome,
    getEligibleCandidates,
    reset,
    dispose,
  };
}
