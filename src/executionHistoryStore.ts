import * as vscode from "vscode";

import { sanitizeAbsolutePathDetails } from "./errorSanitizer";
import { logError } from "./logger";

export const EXECUTION_HISTORY_KEY = "executionHistory";
export const EXECUTION_HISTORY_DEFAULT_LIMIT = 50;
const EXECUTION_HISTORY_MIN_LIMIT = 10;
const EXECUTION_HISTORY_MAX_LIMIT = 500;
const ISO_TIMESTAMP_WITH_TIMEZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export type ExecutionTrigger = "auto" | "manual";
export type ExecutionHistoryStatus = "success" | "failed" | "blocked";

/** How the prompt text actually sent to Copilot was obtained. */
export type ExecutionPromptSource =
  | "inline"
  | "openDocument"
  | "file"
  | "snapshotFallback";

export type ExecutionHistoryEntry = {
  taskId: string;
  taskName: string;
  trigger: ExecutionTrigger;
  status: ExecutionHistoryStatus;
  executedAt: string;
  /** True when a legacy executedAt value could not be parsed. */
  executedAtInvalid?: true;
  nextRunAt?: string;
  /** True when a malformed legacy nextRunAt value was omitted. */
  nextRunAtInvalid?: true;
  detail?: string;
  /** Where the executed prompt text came from. */
  promptSource?: ExecutionPromptSource;
  /** Sanitized display path of the prompt file that was read. */
  promptPathDisplay?: string;
  /** Short hash of the executed prompt text. */
  promptHash?: string;
  /** ISO timestamp of when the prompt text was resolved. */
  promptResolvedAt?: string;
  /** Why the stored snapshot was used instead of the file. */
  promptFallbackReason?: string;
  /** Number of files attached to the executed request. */
  attachmentCount?: number;
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
  const isOptionalString = (value: unknown): boolean =>
    value === undefined || typeof value === "string";
  return (
    typeof record.taskId === "string" &&
    typeof record.taskName === "string" &&
    (trigger === "auto" || trigger === "manual") &&
    (status === "success" || status === "failed" || status === "blocked") &&
    typeof record.executedAt === "string" &&
    (record.executedAtInvalid === undefined ||
      record.executedAtInvalid === true) &&
    (record.nextRunAt === undefined || typeof record.nextRunAt === "string") &&
    (record.nextRunAtInvalid === undefined ||
      record.nextRunAtInvalid === true) &&
    (record.detail === undefined || typeof record.detail === "string") &&
    isOptionalString(record.promptSource) &&
    isOptionalString(record.promptPathDisplay) &&
    isOptionalString(record.promptHash) &&
    isOptionalString(record.promptResolvedAt) &&
    isOptionalString(record.promptFallbackReason)
  );
}

function normalizeHistoryTimestamp(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const match = value.match(ISO_TIMESTAMP_WITH_TIMEZONE);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "0").padEnd(3, "0"));
  const zone = match[8];
  const offsetSign = match[9];
  const offsetHour = Number(match[10] ?? "0");
  const offsetMinute = Number(match[11] ?? "0");
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (zone !== "Z" && (offsetHour > 23 || offsetMinute > 59))
  ) {
    return undefined;
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  const offsetMilliseconds = (offsetHour * 60 + offsetMinute) * 60 * 1000;
  const utcTimestamp =
    local.getTime() +
    (zone === "Z"
      ? 0
      : offsetSign === "+"
        ? -offsetMilliseconds
        : offsetMilliseconds);
  if (Number.isNaN(utcTimestamp)) return undefined;
  const utcDate = new Date(utcTimestamp);
  const utcYear = utcDate.getUTCFullYear();
  return utcYear < 0 || utcYear > 9999 ? undefined : utcDate.toISOString();
}

function normalizeExecutionHistoryEntry(
  entry: ExecutionHistoryEntry,
): ExecutionHistoryEntry {
  const normalizedExecutedAt = normalizeHistoryTimestamp(entry.executedAt);
  const executedAtInvalid = normalizedExecutedAt ? undefined : true;
  const executedAt = normalizedExecutedAt ?? entry.executedAt;
  const normalizedNextRunAt = normalizeHistoryTimestamp(entry.nextRunAt);
  const nextRunAtInvalid =
    entry.nextRunAt !== undefined && !normalizedNextRunAt
      ? true
      : entry.nextRunAt === undefined && entry.nextRunAtInvalid === true
        ? true
        : undefined;
  const nextRunAt = normalizedNextRunAt;
  const promptSource =
    entry.promptSource === "inline" ||
    entry.promptSource === "openDocument" ||
    entry.promptSource === "file" ||
    entry.promptSource === "snapshotFallback"
      ? entry.promptSource
      : undefined;
  const promptHash =
    typeof entry.promptHash === "string" &&
    /^[a-f0-9]{12}$/i.test(entry.promptHash)
      ? entry.promptHash.toLowerCase()
      : undefined;
  const promptResolvedAt =
    typeof entry.promptResolvedAt === "string"
      ? normalizeHistoryTimestamp(entry.promptResolvedAt)
      : undefined;
  const promptFallbackReason =
    entry.promptFallbackReason === "noPromptPath" ||
    entry.promptFallbackReason === "pathUnresolved" ||
    entry.promptFallbackReason === "readFailed"
      ? entry.promptFallbackReason
      : undefined;
  const promptPathDisplay = entry.promptPathDisplay?.trim()
    ? sanitizeAbsolutePathDetails(entry.promptPathDisplay.trim())
    : undefined;
  const attachmentCount =
    typeof entry.attachmentCount === "number" &&
    Number.isInteger(entry.attachmentCount) &&
    entry.attachmentCount > 0
      ? entry.attachmentCount
      : undefined;

  return {
    taskId: entry.taskId,
    taskName: entry.taskName,
    trigger: entry.trigger,
    status: entry.status,
    executedAt,
    executedAtInvalid,
    nextRunAt,
    nextRunAtInvalid,
    detail: entry.detail?.trim()
      ? sanitizeAbsolutePathDetails(entry.detail.trim())
      : undefined,
    promptSource,
    promptPathDisplay,
    promptHash,
    promptResolvedAt,
    promptFallbackReason,
    attachmentCount,
  };
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
  return raw
    .filter(isExecutionHistoryEntry)
    .map(normalizeExecutionHistoryEntry);
}

async function appendExecutionHistoryEntry(
  entry: ExecutionHistoryEntry,
): Promise<void> {
  if (!contextRef) {
    return;
  }
  const existing = getExecutionHistoryEntries();
  const normalizedEntry = normalizeExecutionHistoryEntry(entry);
  const limit = getExecutionHistoryLimit();
  // Newest-first ordering, matching the previous inline implementation.
  const next = [normalizedEntry, ...existing].slice(0, limit);
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
