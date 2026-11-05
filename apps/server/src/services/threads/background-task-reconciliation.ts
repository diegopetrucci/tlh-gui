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
}

type SettleDanglingBackgroundTasksDeps = Pick<AppDeps, "db" | "hub" | "logger">;
type SettleDanglingBackgroundTasksTransactionDeps = {
  db: DbTransaction;
  hub: DbNotifier;
  logger: AppDeps["logger"];
};

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
    const parsed = storedBackgroundTaskEventDataSchema.safeParse(
      JSON.parse(row.data),
    );
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
  const rows = listOpenBackgroundTaskItemRowsForHost(deps.db, {
    hostId: args.hostId,
  });
  if (rows.length === 0) {
    return;
  }

  const settledThreadIds = new Set<string>();
  deps.db.transaction(
    (tx) => {
      for (const threadId of appendDanglingBackgroundTaskCompletions(
        { db: tx, logger: deps.logger },
        rows,
      )) {
        settledThreadIds.add(threadId);
      }
    },
    { behavior: "immediate" },
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
  const settledThreadIds = appendDanglingBackgroundTaskCompletions(
    deps,
    selectedRows,
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

  const taskStatus = isSettledBackgroundTaskStatus(item.taskStatus)
    ? item.taskStatus
    : "stopped";
  return {
    ...item,
    status: backgroundTaskItemStatus(taskStatus),
    taskStatus,
  };
}

function appendDanglingBackgroundTaskCompletions(
  deps: Pick<SettleDanglingBackgroundTasksTransactionDeps, "db" | "logger">,
  rows: readonly OpenBackgroundTaskItemRow[],
): Set<string> {
  const settledThreadIds = new Set<string>();
  for (const row of rows) {
    const item = parseStoredBackgroundTaskItem(row);
    if (!item) {
      deps.logger.warn(
        { itemId: row.itemId, threadId: row.threadId },
        "Skipping dangling background task with unparsable item payload",
      );
      continue;
    }
    const providerThreadId = row.providerThreadId ?? "";
    const settledItem = reconcileDanglingBackgroundTaskItem(item);
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
