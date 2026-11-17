import { z } from "zod";
import {
  getLatestThreadSequence,
  listOpenBackgroundTaskItemRowsForHost,
  listOpenBackgroundTaskItemRowsForThread,
  type DbNotifier,
  type DbQueryConnection,
  type DbTransaction,
  type OpenBackgroundTaskItemRow,
} from "@bb/db";
import {
  backgroundTaskItemStatus,
  convertLegacyStoredThreadEvent,
  isSettledBackgroundTaskStatus,
  LOCAL_SUBAGENT_TASK_TYPE,
  threadEventBackgroundTaskItemSchema,
  threadScope,
} from "@bb/domain";
import type { ThreadEventBackgroundTaskItem } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { appendThreadEventsInTransaction } from "./thread-events.js";

interface SettleDanglingBackgroundTasksArgs {
  hostId: string;
  reason:
    | "host-connection-lost"
    | "host-daemon-no-longer-runs-task"
    | "host-daemon-restarted"
    | "host-removed";
}

type SettleDanglingBackgroundTasksDeps = Pick<AppDeps, "db" | "hub" | "logger">;
type SettleDanglingBackgroundTasksTransactionDeps = {
  db: DbTransaction;
  hub: DbNotifier;
  logger: AppDeps["logger"];
};

const storedEventDataSchema = z.record(z.string(), z.unknown());

const storedBackgroundTaskEventDataSchema = z.object({
  item: threadEventBackgroundTaskItemSchema,
});
const TLH_DETACHED_RUN_FAMILY_PREFIX = "pi:detached:";
const TLH_TRACKING_LOST_ERROR =
  "Tracking lost; the TLH run may still be running.";
const TLH_PAUSED_SUMMARY = "Detached subagent paused";

function parseStoredBackgroundTaskItem(
  row: OpenBackgroundTaskItemRow,
): ThreadEventBackgroundTaskItem | null {
  try {
    const data = storedEventDataSchema.safeParse(JSON.parse(row.data));
    if (!data.success) {
      return null;
    }
    const stored = convertLegacyStoredThreadEvent({
      type: row.type,
      data: data.data,
    });
    const parsed = storedBackgroundTaskEventDataSchema.safeParse(stored.data);
    return parsed.success ? parsed.data.item : null;
  } catch {
    return null;
  }
}

export function isTlhDetachedBackgroundTaskItem(
  item: Pick<ThreadEventBackgroundTaskItem, "familyId" | "taskType">,
): boolean {
  return (
    item.taskType === LOCAL_SUBAGENT_TASK_TYPE &&
    item.familyId?.startsWith(TLH_DETACHED_RUN_FAMILY_PREFIX) === true
  );
}

export function hasKnownActiveTlhDetachedBackgroundTask(
  db: DbQueryConnection,
  args: { threadId: string },
): boolean {
  return listOpenBackgroundTaskItemRowsForThread(db, args).some((row) => {
    const item = parseStoredBackgroundTaskItem(row);
    return (
      item !== null &&
      isTlhDetachedBackgroundTaskItem(item) &&
      (item.taskStatus === "pending" || item.taskStatus === "running")
    );
  });
}

export function hasBackgroundTaskWorkRequiringStop(
  db: SettleDanglingBackgroundTasksDeps["db"],
  args: { threadId: string },
): boolean {
  return listOpenBackgroundTaskItemRowsForThread(db, args).some((row) => {
    const item = parseStoredBackgroundTaskItem(row);
    if (
      item !== null &&
      isTlhDetachedBackgroundTaskItem(item) &&
      item.taskStatus !== "pending" &&
      item.taskStatus !== "running"
    ) {
      return false;
    }
    return true;
  });
}

export function settleDanglingBackgroundTasks(
  deps: SettleDanglingBackgroundTasksDeps,
  args: SettleDanglingBackgroundTasksArgs,
): void {
  settleBackgroundTaskRows(
    deps,
    args,
    listOpenBackgroundTaskItemRowsForHost(deps.db, { hostId: args.hostId }),
  );
}

export function settleBackgroundTasksTheDaemonNoLongerRuns(
  deps: SettleDanglingBackgroundTasksDeps,
  args: {
    hostId: string;
    openItemIdsByThreadId: ReadonlyMap<string, ReadonlySet<string>>;
    unsettledThreadIds: ReadonlySet<string>;
  },
): void {
  settleBackgroundTaskRows(
    deps,
    { hostId: args.hostId, reason: "host-daemon-no-longer-runs-task" },
    listOpenBackgroundTaskItemRowsForHost(deps.db, {
      hostId: args.hostId,
    }).filter(
      (row) =>
        !args.unsettledThreadIds.has(row.threadId) &&
        !args.openItemIdsByThreadId.get(row.threadId)?.has(row.itemId),
    ),
  );
}

function settleBackgroundTaskRows(
  deps: SettleDanglingBackgroundTasksDeps,
  args: SettleDanglingBackgroundTasksArgs,
  rows: readonly OpenBackgroundTaskItemRow[],
): void {
  if (rows.length === 0) {
    return;
  }

  const settledThreadIds = new Set<string>();
  deps.db.transaction(
    (tx) => {
      for (const threadId of appendDanglingBackgroundTaskCompletions(
        { db: tx, logger: deps.logger },
        { ownerStopped: true, rows },
      )) {
        settledThreadIds.add(threadId);
      }
    },
    { behavior: "immediate" },
  );

  if (settledThreadIds.size === 0) {
    return;
  }
  deps.logger.info(
    {
      hostId: args.hostId,
      reason: args.reason,
      threadIds: [...settledThreadIds],
    },
    "Settled background tasks left open on the host",
  );
  for (const threadId of settledThreadIds) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      timelineSequence: getLatestThreadSequence(deps.db, {
        threadId: threadId,
      }),
      eventTypes: ["item/backgroundTask/completed"],
    });
  }
}

export function settleDanglingBackgroundTasksForStoppedThreadInTransaction(
  deps: SettleDanglingBackgroundTasksTransactionDeps,
  args: { threadId: string },
  options: { onlyTlhDetached?: boolean } = {},
): void {
  const rows = listOpenBackgroundTaskItemRowsForThread(deps.db, args);
  const selectedRows = options.onlyTlhDetached
    ? rows.filter((row) => {
        const item = parseStoredBackgroundTaskItem(row);
        return item !== null && isTlhDetachedBackgroundTaskItem(item);
      })
    : rows;
  const settledThreadIds = appendDanglingBackgroundTaskCompletions(deps, {
    ownerStopped: false,
    rows: selectedRows,
  });
  for (const threadId of settledThreadIds) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      timelineSequence: getLatestThreadSequence(deps.db, {
        threadId: threadId,
      }),
      eventTypes: ["item/backgroundTask/completed"],
    });
  }
}

export function settleDanglingBackgroundTasksForThread(
  deps: SettleDanglingBackgroundTasksDeps,
  args: { threadId: string },
  options: { onlyTlhDetached?: boolean } = {},
): void {
  const notificationBuffer = new NotificationBuffer();
  deps.db.transaction(
    (tx) =>
      settleDanglingBackgroundTasksForStoppedThreadInTransaction(
        { db: tx, hub: notificationBuffer, logger: deps.logger },
        args,
        options,
      ),
    { behavior: "immediate" },
  );
  notificationBuffer.flushInto(deps.hub);
}

function reconcileDanglingBackgroundTaskItem(
  item: ThreadEventBackgroundTaskItem,
  ownerStopped: boolean,
): ThreadEventBackgroundTaskItem {
  if (isTlhDetachedBackgroundTaskItem(item)) {
    if (item.taskStatus === "paused") {
      return {
        ...item,
        status: "interrupted",
        taskStatus: "paused",
        summary: item.summary ?? TLH_PAUSED_SUMMARY,
      };
    }
    if (isSettledBackgroundTaskStatus(item.taskStatus)) {
      return item;
    }
    return {
      ...item,
      status: "failed",
      taskStatus: "failed",
      error: TLH_TRACKING_LOST_ERROR,
    };
  }

  const forcedStop = !isSettledBackgroundTaskStatus(item.taskStatus);
  const taskStatus = forcedStop ? "stopped" : item.taskStatus;
  return {
    ...item,
    ...(forcedStop && ownerStopped ? { ownerStopped: true as const } : {}),
    status: backgroundTaskItemStatus(taskStatus),
    taskStatus,
  };
}

function appendDanglingBackgroundTaskCompletions(
  deps: Pick<SettleDanglingBackgroundTasksTransactionDeps, "db" | "logger">,
  args: { ownerStopped: boolean; rows: readonly OpenBackgroundTaskItemRow[] },
): Set<string> {
  const settledThreadIds = new Set<string>();
  for (const row of args.rows) {
    const item = parseStoredBackgroundTaskItem(row);
    if (!item) {
      deps.logger.warn(
        { itemId: row.itemId, threadId: row.threadId },
        "Skipping dangling background task with unparsable item payload",
      );
      continue;
    }
    const providerThreadId = row.providerThreadId ?? "";
    const settledItem = reconcileDanglingBackgroundTaskItem(
      item,
      args.ownerStopped,
    );
    appendThreadEventsInTransaction(deps.db, [
      {
        threadId: row.threadId,
        environmentId: row.environmentId,
        providerThreadId,
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        data: {
          providerThreadId,
          item: settledItem,
        },
      },
    ]);
    settledThreadIds.add(row.threadId);
  }
  return settledThreadIds;
}
