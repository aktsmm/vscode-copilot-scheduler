import * as vscode from "vscode";

import { sanitizeAbsolutePathDetails } from "./errorSanitizer";
import { logError } from "./logger";

export const EXECUTION_HISTORY_KEY = "executionHistory";
export const EXECUTION_HISTORY_DEFAULT_LIMIT = 50;
const EXECUTION_HISTORY_MIN_LIMIT = 10;
const EXECUTION_HISTORY_MAX_LIMIT = 500;

export type ExecutionTrigger = "auto" | "manual";
export type ExecutionHistoryStatus = "success" | "failed";

export type ExecutionHistoryEntry = {
  taskId: string;
  taskName: string;
  trigger: ExecutionTrigger;
  status: ExecutionHistoryStatus;
  executedAt: string;
  nextRunAt?: string;
  detail?: string;
};

type StoreContext = Pick<vscode.ExtensionContext, "globalState">;

let contextRef: StoreContext | undefined;
let saveQueue: Promise<void> = Promise.resolve();

export function initExecutionHistoryStore(context: StoreContext): void {
  contextRef = context;
}

export function setExecutionHistoryContextForTests(
  context: StoreContext | undefined,
): void {
  contextRef = context;
}

export function resetExecutionHistoryQueueForTests(): void {
  saveQueue = Promise.resolve();
}

export function isExecutionHistoryEntry(
  item: unknown,
): item is ExecutionHistoryEntry {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const record = item as Record<string, unknown>;
  const trigger = record.trigger;
  const status = record.status;
  return (
    typeof record.taskId === "string" &&
    typeof record.taskName === "string" &&
    (trigger === "auto" || trigger === "manual") &&
    (status === "success" || status === "failed") &&
    typeof record.executedAt === "string" &&
    (record.nextRunAt === undefined || typeof record.nextRunAt === "string") &&
    (record.detail === undefined || typeof record.detail === "string")
  );
}

export function getExecutionHistoryLimit(): number {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const raw = config.get<number>(
    "executionHistoryLimit",
    EXECUTION_HISTORY_DEFAULT_LIMIT,
  );
  const n = Number.isFinite(raw)
    ? Math.floor(raw)
    : EXECUTION_HISTORY_DEFAULT_LIMIT;
  return Math.min(
    Math.max(n, EXECUTION_HISTORY_MIN_LIMIT),
    EXECUTION_HISTORY_MAX_LIMIT,
  );
}

export function getExecutionHistoryEntries(): ExecutionHistoryEntry[] {
  if (!contextRef) {
    return [];
  }
  const raw = contextRef.globalState.get<unknown[]>(EXECUTION_HISTORY_KEY, []);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isExecutionHistoryEntry);
}

async function appendExecutionHistoryEntry(
  entry: ExecutionHistoryEntry,
): Promise<void> {
  if (!contextRef) {
    return;
  }
  const raw = contextRef.globalState.get<unknown[]>(EXECUTION_HISTORY_KEY, []);
  const existing = Array.isArray(raw)
    ? raw.filter(isExecutionHistoryEntry)
    : [];
  const limit = getExecutionHistoryLimit();
  // Newest-first ordering, matching the previous inline implementation.
  const next = [entry, ...existing].slice(0, limit);
  await contextRef.globalState.update(EXECUTION_HISTORY_KEY, next);
}

export function enqueueExecutionHistoryEntry(
  entry: ExecutionHistoryEntry,
): Promise<void> {
  const op = saveQueue.then(() => appendExecutionHistoryEntry(entry));
  saveQueue = op.catch((error) => {
    const errorMessage =
      error instanceof Error ? error.message : String(error ?? "");
    logError(
      "[CopilotScheduler] Failed to persist execution history:",
      sanitizeAbsolutePathDetails(errorMessage),
    );
  });
  return op;
}

export async function recordExecutionHistoryBestEffort(
  entry: ExecutionHistoryEntry,
): Promise<void> {
  try {
    await enqueueExecutionHistoryEntry(entry);
  } catch {
    // enqueueExecutionHistoryEntry already logs and recovers the queue.
  }
}
