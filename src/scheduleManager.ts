/**
 * Copilot Scheduler - Schedule Manager
 * Handles task CRUD operations, cron scheduling, and persistence
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type {
  ScheduledTask,
  CreateTaskInput,
  TaskAttachment,
  TaskScope,
  ModelInfo,
  ModelSelectionFields,
  AgentHostTurnOutcome,
} from "./types";
import { messages } from "./i18n";
import { logDebug, logError } from "./logger";
import { sanitizeAbsolutePathDetails } from "./errorSanitizer";
import { selectTaskStore } from "./taskStoreSelection";
import {
  cleanupOrphanedAtomicWriteTemps,
  writeFileAtomically,
} from "./atomic-file-write";
import { TaskStoreLockBusyError, withTaskStoreLock } from "./task-store-lock";
import { migrateLegacyModelConfiguration } from "./model-configuration";
import {
  supportsConfiguredModelExecution,
  supportsSystemMessageForwarding,
} from "./configured-model-provider";
import {
  areModelSelectionsEqual,
  findBestMatchingModel,
  hasModelSelection,
  modelInfoToSelection,
  normalizeModelSelection,
  type NormalizedModelSelection,
} from "./modelSelection";
import {
  getFirstDistinctCronRuns,
  getNextCronRun,
  splitCronExpressions,
  validateCronExpressions,
} from "./cronExpressions";
import {
  normalizeForCompare,
  resolveGlobalPromptPath,
  resolveGlobalPromptsRoot,
  resolveLocalPromptPath,
} from "./promptResolver";
import {
  MAX_TASK_ATTACHMENTS,
  normalizeAttachments,
  type AttachmentRejection,
} from "./attachmentResolver";
import { getPreferredWorkspaceRootPath } from "./workspaceRoots";
import {
  createPromptBlockedError,
  getAgentHostTurnFailure,
  getPromptBlockedReason,
  isPromptBlockedError,
} from "./promptExecutionErrors";
import { normalizeSkillRef } from "./skillResolver";

// Node.js globals
declare const setTimeout: (callback: () => void, ms: number) => NodeJS.Timeout;
declare const clearTimeout: (timeoutId: NodeJS.Timeout) => void;
declare const setInterval: (callback: () => void, ms: number) => NodeJS.Timeout;
declare const clearInterval: (intervalId: NodeJS.Timeout) => void;
declare const console: {
  error: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
};

const STORAGE_KEY = "scheduledTasks";
const STORAGE_FILE_NAME = "scheduledTasks.json";
const STORAGE_META_FILE_NAME = "scheduledTasks.meta.json";
const STORAGE_FALLBACK_FILE_NAME = "scheduledTasks.fallback.json";
const STORAGE_REVISION_KEY = "scheduledTasksRevision";
const STORAGE_SAVED_AT_KEY = "scheduledTasksSavedAt";
const STORAGE_SNAPSHOT_KEY = "scheduledTasksSnapshot";
const STORAGE_SNAPSHOT_INTENT_KEY = "scheduledTasksSnapshotIntent";
const DAILY_EXEC_COUNT_KEY = "dailyExecCount";
const DAILY_EXEC_DATE_KEY = "dailyExecDate";
const DAILY_TASK_EXEC_COUNTS_KEY = "dailyTaskExecCounts";
const DAILY_TASK_EXEC_DATE_KEY = "dailyTaskExecDate";
const DAILY_LIMIT_NOTIFIED_DATE_KEY = "dailyLimitNotifiedDate";
const DISCLAIMER_ACCEPTED_KEY = "disclaimerAccepted";

type TaskStorageMeta = {
  revision: number;
  savedAt: string; // ISO string
  commitId?: string;
  tasksSnapshot?: unknown[];
};

type TaskStorageSnapshot = TaskStorageMeta & { tasksSnapshot: unknown[] };

class TaskStoreConflictError extends Error {}

type ManualRunNextRunPolicy = "advance" | "fromNow";
type MissedRunPolicy = "runOnce" | "skip";
type ManualRunFailureReason =
  | "taskNotFound"
  | "executorUnavailable"
  | "alreadyRunning"
  | "taskChanged"
  | "oneTimeCompleted"
  | "claimFailed"
  | "promptBlocked"
  | "executionFailed"
  | "saveFailed";
export type ManualRunExecutionInfo = {
  name: string;
  runAt?: string;
  afterRun?: ScheduledTask["afterRun"];
  attachmentCount?: number;
};
type ManualRunResult =
  | { ok: true; claimId?: string; executionInfo?: ManualRunExecutionInfo }
  | {
      ok: false;
      reason: ManualRunFailureReason;
      errorMessage?: string;
      userNotified?: boolean;
      turnOutcome?: Exclude<AgentHostTurnOutcome, "completed">;
      executionInfo?: ManualRunExecutionInfo;
    };

const USER_NOTIFIED_EXECUTION_ERROR_FLAG = "copilotSchedulerUserNotified";

function getLocalDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Wall-clock date and minute-of-day in the scheduler timezone.
 * Cron already runs on that timezone, so the daily counters and the allowed
 * time window have to read the same clock or they mean a different day and a
 * different hour than the schedule they gate. An invalid timezone falls back to
 * local time (U9).
 */
function getZonedWallClock(
  date: Date,
  timeZone?: string,
): { dateKey: string; minutes: number } {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date);
      const get = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((part) => part.type === type)?.value ?? "";
      const year = get("year");
      const month = get("month");
      const day = get("day");
      const hour = Number(get("hour"));
      const minute = Number(get("minute"));
      if (
        year &&
        month &&
        day &&
        Number.isInteger(hour) &&
        Number.isInteger(minute)
      ) {
        return {
          dateKey: `${year}-${month}-${day}`,
          minutes: hour * 60 + minute,
        };
      }
    } catch {
      logDebug(
        `[CopilotScheduler] Invalid timezone "${timeZone}", falling back to local time`,
      );
    }
  }

  return {
    dateKey: getLocalDateKey(date),
    minutes: date.getHours() * 60 + date.getMinutes(),
  };
}

function toSafeErrorDetails(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const sanitized = sanitizeAbsolutePathDetails(
    raw,
    messages.redactedPlaceholder(),
  );
  return sanitized.trim() ? sanitized : messages.webviewUnknown();
}

function normalizeTimeWindowHHMM(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return undefined;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeWindowToMinutes(value: string): number {
  const normalized = normalizeTimeWindowHHMM(value);
  if (!normalized) {
    return -1;
  }
  const [hour, minute] = normalized.split(":").map(Number);
  return hour * 60 + minute;
}

function isNowWithinAllowedTimeWindow(
  now: Date,
  start?: string,
  end?: string,
  timeZone?: string,
): boolean {
  const startNormalized = normalizeTimeWindowHHMM(start);
  const endNormalized = normalizeTimeWindowHHMM(end);
  if (!startNormalized && !endNormalized) {
    return true;
  }

  const nowMinutes = getZonedWallClock(now, timeZone).minutes;
  const startMinutes = startNormalized
    ? timeWindowToMinutes(startNormalized)
    : undefined;
  const endMinutes = endNormalized
    ? timeWindowToMinutes(endNormalized)
    : undefined;

  if (startMinutes !== undefined && endMinutes !== undefined) {
    if (startMinutes === endMinutes) {
      return true;
    }
    if (startMinutes < endMinutes) {
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }

  if (startMinutes !== undefined) {
    return nowMinutes >= startMinutes;
  }
  if (endMinutes !== undefined) {
    return nowMinutes < endMinutes;
  }
  return true;
}

export const __testOnly = {
  toSafeErrorDetails,
  normalizeTimeWindowHHMM,
  isNowWithinAllowedTimeWindow,
  getZonedWallClock,
  splitCronExpressions,
};

function describeAttachmentRejection(rejection: AttachmentRejection): string {
  switch (rejection.reason) {
    case "localOnGlobalScope":
      return messages.attachmentLocalOnGlobalScope();
    case "denied":
      return messages.attachmentDenied(rejection.path);
    case "tooMany":
      return messages.attachmentLimitExceeded(MAX_TASK_ATTACHMENTS);
    case "absolutePath":
    case "traversal":
      return messages.attachmentOutsideRoot(rejection.path);
    default:
      return messages.attachmentInvalidPath(rejection.path);
  }
}

function normalizeAttachmentsOrThrow(
  value: unknown,
  scope: TaskScope,
): TaskAttachment[] {
  const result = normalizeAttachments(value, scope);
  const rejection = result.rejected[0];
  if (rejection) {
    throw new Error(describeAttachmentRejection(rejection));
  }
  return result.attachments;
}

function applyModelSelectionToTask(
  target: ModelSelectionFields,
  selection: NormalizedModelSelection,
): boolean {
  const normalizedSelection = normalizeModelSelection(selection);
  let alreadyEqual = false;
  try {
    alreadyEqual = areModelSelectionsEqual(target, normalizedSelection);
  } catch {
    alreadyEqual = false;
  }
  if (alreadyEqual) return false;

  target.model = normalizedSelection.model;
  target.modelName = normalizedSelection.modelName;
  target.modelVendor = normalizedSelection.modelVendor;
  target.modelFamily = normalizedSelection.modelFamily;
  target.modelVersion = normalizedSelection.modelVersion;
  target.modelReasoningEffort = normalizedSelection.modelReasoningEffort;
  target.modelConfiguration = normalizedSelection.modelConfiguration;
  return true;
}

/** A due occurrence reserved on disk before it is executed. */
interface TaskRunClaim {
  taskId: string;
  claimId?: string;
  dueAt: Date;
  nextRun: Date | undefined;
  runAt: string | undefined;
  cronExpression: string;
  expectedNextRun: number | undefined;
  expectedUpdatedAt: number;
  expectedEnabled: boolean;
  deleteAfterRun?: boolean;
}

interface TaskRunSkip {
  taskId: string;
  runAt: string | undefined;
  cronExpression: string;
  expectedNextRun: number | undefined;
  expectedEnabled: boolean;
  expectedLastFiredDueAt: number | undefined;
  expectedAllowedTimeStart: string | undefined;
  expectedAllowedTimeEnd: string | undefined;
  expectedMaxExecutionsPerDay: number | undefined;
  expectedScope: TaskScope;
  expectedWorkspacePath: string | undefined;
  evaluatedAt: Date;
}

export type TaskExecutionCallbackResult = {
  retainOneTimeTask?: boolean;
};

/**
 * Manages scheduled tasks including CRUD operations, cron parsing, and persistence
 */
export class ScheduleManager {
  private tasks: Map<string, ScheduledTask> = new Map();
  private schedulerInterval: ReturnType<typeof setInterval> | undefined;
  private schedulerTimeout: ReturnType<typeof setTimeout> | undefined;
  private schedulerTickInProgress = false;
  private schedulerTickPending = false;
  private schedulerStartedAt: Date | undefined;
  private automaticRunsInFlight = 0;
  private detachedRuns: Set<Promise<void>> = new Set();
  private context: vscode.ExtensionContext;
  private storageFilePath: string;
  private storageMetaFilePath: string;
  private storageFallbackFilePath: string;
  private storageLockFilePath: string;
  private onTasksChangedCallbacks: Array<() => void> = [];
  private onExecuteCallback:
    | ((
        task: ScheduledTask,
        trigger: "manual" | "auto",
        dispatchGuard?: (dispatch: () => void) => Promise<void>,
      ) => Promise<void | TaskExecutionCallbackResult>)
    | undefined;
  private dailyExecCount = 0;
  private dailyExecDate = "";
  private dailyTaskExecCounts: Record<string, number> = {};
  private dailyTaskExecDate = "";
  private dailyLimitNotifiedDate = "";
  private inFlightTaskIds: Set<string> = new Set();

  private storageRevision = 0;
  private storageCommitId: string | undefined;
  private storageSnapshotFingerprint: string | undefined;
  private taskStoreReadError: string | undefined;
  private taskStoreWarningShown = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private globalStateWriteQueue: Promise<void> = Promise.resolve();
  private fileWriteQueue: Promise<void> = Promise.resolve();

  private static readonly FIRST_RUN_DELAY_MINUTES = 3;

  private static readonly RUN_CLAIM_MAX_ATTEMPTS = 3;

  private static millisecondsUntilNextMinute(now: Date): number {
    const elapsedMsInMinute = now.getSeconds() * 1000 + now.getMilliseconds();
    if (elapsedMsInMinute === 0) {
      return 0;
    }
    return 60 * 1000 - elapsedMsInMinute;
  }

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.storageFilePath = path.join(
      this.context.globalStorageUri.fsPath,
      STORAGE_FILE_NAME,
    );
    this.storageMetaFilePath = path.join(
      this.context.globalStorageUri.fsPath,
      STORAGE_META_FILE_NAME,
    );
    this.storageFallbackFilePath = path.join(
      this.context.globalStorageUri.fsPath,
      STORAGE_FALLBACK_FILE_NAME,
    );
    this.storageLockFilePath = path.join(
      this.context.globalStorageUri.fsPath,
      "scheduledTasks.lock",
    );
    void Promise.all([
      cleanupOrphanedAtomicWriteTemps(this.storageFilePath),
      cleanupOrphanedAtomicWriteTemps(this.storageMetaFilePath),
      cleanupOrphanedAtomicWriteTemps(this.storageFallbackFilePath),
    ])
      .then((counts) => {
        const removed = counts.reduce((sum, count) => sum + count, 0);
        if (removed > 0) {
          logDebug(
            `[CopilotScheduler] Removed ${removed} orphaned task-store temporary file(s).`,
          );
        }
      })
      .catch((error) => {
        logError(
          "[CopilotScheduler] Failed to clean orphaned task-store temporary files:",
          toSafeErrorDetails(error),
        );
      });
    this.loadDailyExecCount();
    this.loadDailyTaskExecCounts();
    this.dailyLimitNotifiedDate = this.context.globalState.get<string>(
      DAILY_LIMIT_NOTIFIED_DATE_KEY,
      "",
    );
    this.loadTasks();
  }

  private loadMetaFromFile(
    metadataPath = this.storageMetaFilePath,
  ): TaskStorageMeta | undefined {
    try {
      if (!metadataPath) return undefined;
      if (!fs.existsSync(metadataPath)) return undefined;
      const raw = fs.readFileSync(metadataPath, "utf8");
      if (!raw.trim()) return undefined;
      const parsed = JSON.parse(raw) as Partial<TaskStorageMeta>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid task store metadata");
      }
      if (
        !Number.isSafeInteger(parsed.revision) ||
        (parsed.revision ?? -1) < 0 ||
        typeof parsed.savedAt !== "string" ||
        (parsed.commitId !== undefined &&
          (typeof parsed.commitId !== "string" || !parsed.commitId)) ||
        (parsed.tasksSnapshot !== undefined &&
          (!Array.isArray(parsed.tasksSnapshot) ||
            parsed.revision === undefined ||
            typeof parsed.savedAt !== "string"))
      ) {
        throw new Error("Invalid task store snapshot");
      }
      const revision =
        typeof parsed.revision === "number" ? parsed.revision : 0;
      const savedAt = typeof parsed.savedAt === "string" ? parsed.savedAt : "";
      return {
        revision,
        savedAt,
        ...(parsed.commitId ? { commitId: parsed.commitId } : {}),
        ...(parsed.tasksSnapshot !== undefined
          ? { tasksSnapshot: parsed.tasksSnapshot }
          : {}),
      };
    } catch (error) {
      logError(
        "[CopilotScheduler] Failed to load task store metadata:",
        error instanceof SyntaxError ? "Invalid JSON" : toSafeErrorDetails(error),
      );
      return undefined;
    }
  }

  private loadLegacyMetaFromGlobalState(): TaskStorageMeta {
    const revision = this.context.globalState.get<number>(
      STORAGE_REVISION_KEY,
      0,
    );
    const savedAt = this.context.globalState.get<string>(
      STORAGE_SAVED_AT_KEY,
      "",
    );
    return { revision: typeof revision === "number" ? revision : 0, savedAt };
  }

  private loadGlobalStateSnapshot(): TaskStorageSnapshot | undefined {
    const raw = this.context.globalState.get<unknown>(STORAGE_SNAPSHOT_KEY);
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      logError("[CopilotScheduler] Invalid global task store snapshot.");
      return undefined;
    }
    const candidate = raw as Partial<TaskStorageSnapshot>;
    if (
      typeof candidate.revision !== "number" ||
      !Number.isSafeInteger(candidate.revision) ||
      candidate.revision < 0 ||
      typeof candidate.savedAt !== "string" ||
      (candidate.commitId !== undefined &&
        (typeof candidate.commitId !== "string" || !candidate.commitId)) ||
      !Array.isArray(candidate.tasksSnapshot)
    ) {
      logError("[CopilotScheduler] Invalid global task store snapshot.");
      return undefined;
    }
    return {
      revision: candidate.revision,
      savedAt: candidate.savedAt,
      ...(candidate.commitId ? { commitId: candidate.commitId } : {}),
      tasksSnapshot: candidate.tasksSnapshot,
    };
  }

  private hasFileMetadata(metadataPath = this.storageMetaFilePath): boolean {
    try {
      fs.statSync(metadataPath);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  private loadSharedFileMetadata(): {
    meta: TaskStorageMeta | undefined;
    primary: TaskStorageMeta | undefined;
    exists: boolean;
    error?: string;
  } {
    const primary = this.loadMetaFromFile();
    const fallback = this.loadMetaFromFile(this.storageFallbackFilePath);
    const primaryExists = this.hasFileMetadata();
    const fallbackExists = this.hasFileMetadata(this.storageFallbackFilePath);
    const globalSnapshot = this.loadGlobalStateSnapshot();
    const payload = !primary?.tasksSnapshot ? this.loadTasksFromFile() : undefined;
    const oneTimeTasks = (tasks: unknown[]) =>
      tasks.filter(
        (task) =>
          !!task &&
          typeof task === "object" &&
          typeof (task as Record<string, unknown>).runAt === "string",
      );
    const payloadHasOneTimeClaim =
      !primary?.tasksSnapshot &&
      !fallback?.tasksSnapshot &&
      payload!.tasks.some(
        (task) =>
          !!task &&
          typeof task === "object" &&
          typeof (task as Record<string, unknown>).runAt === "string" &&
          !!(task as Record<string, unknown>).lastFiredClaimId,
      );
    let error: string | undefined;
    if (primaryExists && !primary) {
      error = "Cannot safely recover the invalid file task store metadata";
    } else if (
      fallbackExists &&
      (!fallback?.tasksSnapshot || !fallback.commitId)
    ) {
      error = "Cannot safely recover the invalid fallback task store snapshot";
    } else if (
      !primary?.tasksSnapshot &&
      fallback?.tasksSnapshot &&
      (!payload!.ok ||
        JSON.stringify(oneTimeTasks(payload!.tasks)) !==
          JSON.stringify(oneTimeTasks(fallback.tasksSnapshot)))
    ) {
      error = "Cannot verify the latest one-time task store snapshot";
    } else if (
      !primary?.tasksSnapshot &&
      ((globalSnapshot?.commitId &&
        (!fallback?.tasksSnapshot || fallback.revision < globalSnapshot.revision)) ||
        payloadHasOneTimeClaim)
    ) {
      error = "Cannot safely recover missing committed task store metadata";
    } else if (
      primary?.tasksSnapshot &&
      fallback?.tasksSnapshot &&
      this.snapshotsConflict(primary, {
        ...fallback,
        tasksSnapshot: fallback.tasksSnapshot,
      })
    ) {
      error = "Task store snapshots have conflicting commits";
    }
    return {
      primary,
      meta:
        fallback && (!primary || fallback.revision > primary.revision)
          ? fallback
          : primary,
      exists: primaryExists || fallbackExists,
      error,
    };
  }

  private canRecoverInvalidGlobalSnapshot(
    fileMeta: TaskStorageMeta | undefined,
  ): boolean {
    const raw = this.context.globalState.get<unknown>(STORAGE_SNAPSHOT_INTENT_KEY);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const intent = raw as Partial<TaskStorageMeta>;
    if (
      !fileMeta?.tasksSnapshot ||
      !fileMeta.commitId ||
      this.loadLegacyMetaFromGlobalState().revision > fileMeta.revision ||
      !Number.isSafeInteger(intent.revision) ||
      (intent.revision ?? -1) < 0 ||
      typeof intent.commitId !== "string" ||
      !intent.commitId
    ) {
      return false;
    }
    return (
      fileMeta.revision > intent.revision! ||
      (fileMeta.revision === intent.revision && fileMeta.commitId === intent.commitId)
    );
  }

  private snapshotsConflict(
    fileMeta: TaskStorageMeta | undefined,
    globalSnapshot: TaskStorageSnapshot | undefined,
  ): boolean {
    return !!(
      fileMeta?.tasksSnapshot &&
      globalSnapshot &&
      fileMeta.revision === globalSnapshot.revision &&
      ((fileMeta.commitId &&
        globalSnapshot.commitId &&
        fileMeta.commitId !== globalSnapshot.commitId) ||
        JSON.stringify(fileMeta.tasksSnapshot) !==
          JSON.stringify(globalSnapshot.tasksSnapshot))
    );
  }

  private loadMetaFromGlobalState(): TaskStorageMeta {
    const legacy = this.loadLegacyMetaFromGlobalState();
    const snapshot = this.loadGlobalStateSnapshot();
    return snapshot && snapshot.revision >= legacy.revision ? snapshot : legacy;
  }

  private async saveMetaToFile(meta: TaskStorageMeta): Promise<void> {
    await writeFileAtomically(this.storageMetaFilePath, JSON.stringify(meta));
  }

  private async saveMetaToGlobalState(meta: TaskStorageMeta): Promise<void> {
    await this.context.globalState.update(STORAGE_REVISION_KEY, meta.revision);
    await this.context.globalState.update(STORAGE_SAVED_AT_KEY, meta.savedAt);
  }

  private loadTasksFromFile(): { tasks: unknown[]; ok: boolean } {
    try {
      if (!this.storageFilePath) return { tasks: [], ok: false };
      if (!fs.existsSync(this.storageFilePath)) return { tasks: [], ok: false };
      const raw = fs.readFileSync(this.storageFilePath, "utf8");
      if (!raw.trim()) return { tasks: [], ok: false };
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { tasks: [], ok: false };
      return { tasks: parsed as unknown[], ok: true };
    } catch (error) {
      logDebug(
        "[CopilotScheduler] Failed to load tasks from file:",
        error instanceof SyntaxError ? "Invalid JSON" : toSafeErrorDetails(error),
      );
      return { tasks: [], ok: false };
    }
  }

  private async saveTasksToFile(tasksArray: ScheduledTask[]): Promise<void> {
    await writeFileAtomically(this.storageFilePath, JSON.stringify(tasksArray));
  }

  private async saveTasksToGlobalState(
    tasksArray: ScheduledTask[],
  ): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, tasksArray);
  }

  // ==================== Safety: Daily Execution Limit ====================

  /**
   * Load daily execution count from globalState
   */
  private loadDailyExecCount(): void {
    const today = this.getSchedulerDateKey();
    const savedDate = this.context.globalState.get<string>(
      DAILY_EXEC_DATE_KEY,
      "",
    );
    if (savedDate === today) {
      const savedCount = this.context.globalState.get<unknown>(
        DAILY_EXEC_COUNT_KEY,
        0,
      );
      const normalizedCount = Number(savedCount);
      this.dailyExecCount = Number.isFinite(normalizedCount)
        ? Math.max(Math.floor(normalizedCount), 0)
        : 0;
    } else {
      // New day, reset counter
      this.dailyExecCount = 0;
      void this.context.globalState
        .update(DAILY_EXEC_COUNT_KEY, 0)
        .then(undefined, (error: unknown) =>
          logError(
            "[CopilotScheduler] Failed to reset daily execution count:",
            toSafeErrorDetails(error),
          ),
        );
      void this.context.globalState
        .update(DAILY_EXEC_DATE_KEY, today)
        .then(undefined, (error: unknown) =>
          logError(
            "[CopilotScheduler] Failed to reset daily execution date:",
            toSafeErrorDetails(error),
          ),
        );
    }
    this.dailyExecDate = today;
  }

  private loadDailyTaskExecCounts(): void {
    const today = this.getSchedulerDateKey();
    const savedDate = this.context.globalState.get<string>(
      DAILY_TASK_EXEC_DATE_KEY,
      "",
    );
    if (savedDate === today) {
      const saved = this.context.globalState.get<unknown>(
        DAILY_TASK_EXEC_COUNTS_KEY,
        {},
      );
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        const normalized: Record<string, number> = {};
        for (const [taskId, count] of Object.entries(
          saved as Record<string, unknown>,
        )) {
          const value = Number(count);
          if (!Number.isFinite(value)) {
            continue;
          }
          const integer = Math.floor(value);
          if (integer > 0) {
            normalized[taskId] = integer;
          }
        }
        this.dailyTaskExecCounts = normalized;
      } else {
        this.dailyTaskExecCounts = {};
      }
    } else {
      this.dailyTaskExecCounts = {};
      void this.context.globalState
        .update(DAILY_TASK_EXEC_COUNTS_KEY, {})
        .then(undefined, (error: unknown) =>
          logError(
            "[CopilotScheduler] Failed to reset task daily execution counts:",
            toSafeErrorDetails(error),
          ),
        );
      void this.context.globalState
        .update(DAILY_TASK_EXEC_DATE_KEY, today)
        .then(undefined, (error: unknown) =>
          logError(
            "[CopilotScheduler] Failed to reset task daily execution date:",
            toSafeErrorDetails(error),
          ),
        );
    }
    this.dailyTaskExecDate = today;
  }

  private ensureDailyCountersDate(date = new Date()): void {
    const today = this.getSchedulerDateKey(date);
    if (this.dailyExecDate !== today) {
      this.dailyExecCount = 0;
      this.dailyExecDate = today;
    }
    if (this.dailyTaskExecDate !== today) {
      this.dailyTaskExecCounts = {};
      this.dailyTaskExecDate = today;
    }
  }

  private incrementDailyExecCountInMemory(date = new Date()): void {
    this.ensureDailyCountersDate(date);
    this.dailyExecCount++;
  }

  private incrementTaskDailyExecCountInMemory(
    taskId: string,
    date = new Date(),
  ): void {
    this.ensureDailyCountersDate(date);
    const current = this.dailyTaskExecCounts[taskId] ?? 0;
    this.dailyTaskExecCounts[taskId] = current + 1;
  }

  private getTaskDailyExecCount(taskId: string, date = new Date()): number {
    this.ensureDailyCountersDate(date);
    return this.dailyTaskExecCounts[taskId] ?? 0;
  }

  private tryStartTaskRun(taskId: string): boolean {
    if (!taskId) {
      return false;
    }
    if (this.inFlightTaskIds.has(taskId)) {
      return false;
    }
    this.inFlightTaskIds.add(taskId);
    return true;
  }

  private finishTaskRun(taskId: string): void {
    if (!taskId) {
      return;
    }
    this.inFlightTaskIds.delete(taskId);
  }

  private async persistDailyExecCount(): Promise<void> {
    this.ensureDailyCountersDate();
    const today = this.dailyExecDate || this.getSchedulerDateKey();
    await this.context.globalState.update(
      DAILY_EXEC_COUNT_KEY,
      this.dailyExecCount,
    );
    await this.context.globalState.update(DAILY_EXEC_DATE_KEY, today);
    await this.context.globalState.update(
      DAILY_TASK_EXEC_COUNTS_KEY,
      this.dailyTaskExecCounts,
    );
    await this.context.globalState.update(DAILY_TASK_EXEC_DATE_KEY, today);
  }

  /**
   * Bulk update task prompts (used by template sync) and save once.
   */
  async updateTaskPrompts(
    updates: Array<{ id: string; prompt: string; expectedSnapshot?: string }>,
  ): Promise<number> {
    if (!Array.isArray(updates) || updates.length === 0) {
      return 0;
    }

    if (updates.some((item) => item?.expectedSnapshot !== undefined)) {
      await this.refreshPersistedTasksIfChanged(false);
    }

    const now = new Date();
    let changed = 0;

    for (const item of updates) {
      if (!item || typeof item.id !== "string") continue;
      const nextPrompt = typeof item.prompt === "string" ? item.prompt : "";
      if (!nextPrompt.trim()) continue;

      const task = this.tasks.get(item.id);
      if (!task) continue;
      if (
        item.expectedSnapshot !== undefined &&
        JSON.stringify(task) !== item.expectedSnapshot
      ) continue;
      if (task.prompt === nextPrompt) continue;
      task.prompt = nextPrompt;
      task.updatedAt = now;
      changed++;
    }

    if (changed > 0) {
      await this.saveTasksOrRestore();
    }

    return changed;
  }

  /**
   * Check if daily execution limit has been reached.
   * @param maxDailyLimit - Pre-computed limit (0 = unlimited). Pass from caller to avoid redundant config reads.
   */
  private isDailyLimitReached(maxDailyLimit: number): boolean {
    // 0 = unlimited (no daily limit, use at your own risk)
    if (maxDailyLimit === 0) {
      return false;
    }
    this.ensureDailyCountersDate();
    return this.dailyExecCount >= maxDailyLimit;
  }

  // ==================== Safety: Jitter (Random Delay) ====================

  private clampJitterSeconds(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return 0;
    const i = Math.floor(n);
    return Math.min(Math.max(i, 0), 1800);
  }

  private clampTaskMaxExecutionsPerDay(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return undefined;
    const i = Math.floor(n);
    return Math.min(Math.max(i, 0), 100);
  }

  private normalizeTimeWindowOrThrow(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    const normalized = normalizeTimeWindowHHMM(value);
    if (!normalized) {
      throw new Error(messages.invalidTimeWindowFormat());
    }
    return normalized;
  }

  private isTaskDailyLimitReached(task: ScheduledTask, now: Date): boolean {
    const limit = this.clampTaskMaxExecutionsPerDay(task.maxExecutionsPerDay);
    if (limit === undefined || limit === 0) {
      return false;
    }
    return this.getTaskDailyExecCount(task.id, now) >= limit;
  }

  /**
   * Apply random jitter delay to reduce machine-like patterns
   */
  private async applyJitter(maxJitterSeconds: number): Promise<void> {
    const clamped = this.clampJitterSeconds(maxJitterSeconds);
    if (clamped <= 0) return;

    const jitterMs = Math.floor(Math.random() * clamped * 1000);
    const jitterSec = Math.round(jitterMs / 1000);
    if (jitterSec > 0) {
      logDebug(`[CopilotScheduler] Jitter: waiting ${jitterSec}s`);
      await new Promise<void>((resolve) => setTimeout(resolve, jitterMs));
    }
  }

  // ==================== Safety: Minimum Interval Warning ====================

  /**
   * Check if a cron expression has a short interval and return warning if so
   */
  checkMinimumInterval(cronExpression: string): string | undefined {
    const currentDate = new Date();
    const tz = this.getTimeZone();

    const check = (options: {
      currentDate: Date;
      tz?: string;
    }): string | undefined => {
      const [first, second] = getFirstDistinctCronRuns(
        cronExpression,
        options,
        2,
      );
      if (!first || !second) {
        return undefined;
      }
      const diffMinutes = (second.getTime() - first.getTime()) / (1000 * 60);

      if (diffMinutes < 30) {
        return messages.minimumIntervalWarning();
      }
      return undefined;
    };

    try {
      return check(tz ? { currentDate, tz } : { currentDate });
    } catch {
      // If parsing fails with the configured timezone, fall back to local time (U9).
      if (tz) {
        try {
          return check({ currentDate });
        } catch {
          // If parsing fails, skip interval check
        }
      }
      return undefined;
    }
  }

  // ==================== Safety: Disclaimer ====================

  /**
   * Check if the user has accepted the disclaimer
   */
  isDisclaimerAccepted(): boolean {
    return this.context.globalState.get<boolean>(
      DISCLAIMER_ACCEPTED_KEY,
      false,
    );
  }

  /**
   * Set disclaimer accepted state
   */
  async setDisclaimerAccepted(accepted: boolean): Promise<void> {
    await this.context.globalState.update(DISCLAIMER_ACCEPTED_KEY, accepted);
  }

  /**
   * Set callback for when tasks change
   */
  setOnTasksChangedCallback(callback: () => void): void {
    this.onTasksChangedCallbacks = [callback];
  }

  /**
   * Add callback for when tasks change
   */
  addOnTasksChangedCallback(callback: () => void): void {
    if (this.onTasksChangedCallbacks.includes(callback)) {
      return;
    }
    this.onTasksChangedCallbacks.push(callback);
  }

  /**
   * Notify that tasks have changed
   */
  private notifyTasksChanged(): void {
    for (const callback of this.onTasksChangedCallbacks) {
      try {
        callback();
      } catch (error) {
        logError(
          "[CopilotScheduler] onTasksChanged callback failed:",
          toSafeErrorDetails(error),
        );
      }
    }
  }

  private hasMinimumPersistedTaskShape(
    value: unknown,
  ): value is Record<string, unknown> &
    Pick<ScheduledTask, "id" | "name" | "prompt" | "cronExpression"> {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.id === "string" &&
      candidate.id.trim().length > 0 &&
      typeof candidate.name === "string" &&
      typeof candidate.prompt === "string" &&
      typeof candidate.cronExpression === "string"
    );
  }

  /**
   * Load tasks from globalState
   */
  private loadTasks(): void {
    const rawSavedTasks = this.context.globalState.get<unknown>(STORAGE_KEY);
    const legacyGlobalMeta = this.loadLegacyMetaFromGlobalState();
    const globalSnapshot = this.loadGlobalStateSnapshot();
    const hasGlobalSnapshot =
      this.context.globalState.get<unknown>(STORAGE_SNAPSHOT_KEY) !== undefined;
    const useGlobalSnapshot =
      globalSnapshot && globalSnapshot.revision >= legacyGlobalMeta.revision;
    const savedTasks = useGlobalSnapshot
      ? globalSnapshot.tasksSnapshot
      : Array.isArray(rawSavedTasks)
        ? rawSavedTasks
        : [];
    const globalTasksOk = Boolean(
      (!hasGlobalSnapshot || globalSnapshot) &&
      (useGlobalSnapshot ||
        rawSavedTasks === undefined ||
        Array.isArray(rawSavedTasks)),
    );
    const filePayload = this.loadTasksFromFile();
    const sharedFile = this.loadSharedFileMetadata();
    const rawFileMeta = sharedFile.meta;
    const hasFileMeta = sharedFile.exists;
    const fileMeta = rawFileMeta || { revision: 0, savedAt: "" };
    const fileLoad = rawFileMeta?.tasksSnapshot
      ? { tasks: rawFileMeta.tasksSnapshot, ok: true }
      : hasFileMeta && !rawFileMeta
        ? { tasks: [], ok: false }
        : filePayload;
    const fileTasks = fileLoad.tasks;
    const filePayloadNeedsRepair =
      rawFileMeta?.tasksSnapshot !== undefined &&
      (!filePayload.ok ||
        JSON.stringify(filePayload.tasks) !==
          JSON.stringify(rawFileMeta.tasksSnapshot) ||
        (sharedFile.primary?.revision ?? -1) < rawFileMeta.revision);
    const globalMeta = useGlobalSnapshot ? globalSnapshot : legacyGlobalMeta;
    this.taskStoreReadError = sharedFile.error
      ? sharedFile.error
      : this.snapshotsConflict(rawFileMeta, globalSnapshot)
        ? "Task store snapshots have conflicting commits"
        : hasGlobalSnapshot &&
            !globalSnapshot &&
            !this.canRecoverInvalidGlobalSnapshot(rawFileMeta)
          ? "Cannot safely recover the invalid global task store snapshot"
          : undefined;
    if (this.taskStoreReadError) {
      logError(`[CopilotScheduler] ${this.taskStoreReadError}.`);
      this.notifyTaskStoreIssue();
    }

    const globalStoreExists =
      (Array.isArray(savedTasks) && savedTasks.length > 0) ||
      (typeof globalMeta.revision === "number" && globalMeta.revision > 0);

    const fileStoreExists =
      fileLoad.ok ||
      hasFileMeta ||
      (typeof fileMeta.revision === "number" && fileMeta.revision > 0);

    const selection = selectTaskStore<unknown>(
      {
        kind: "globalState",
        exists: globalStoreExists,
        ok: globalTasksOk,
        tasks: savedTasks,
        revision: globalMeta.revision,
      },
      {
        kind: "file",
        exists: fileStoreExists,
        ok: fileLoad.ok,
        tasks: fileTasks,
        revision: fileMeta.revision,
      },
    );

    // Choose newer store by revision (handles deletes correctly).
    // IMPORTANT: an empty task array can still be the newest state (e.g., deleting the last task).
    const tasksToLoad = selection.chosenTasks;
    this.storageRevision = selection.chosenRevision || 0;
    const chosenMeta =
      selection.chosenKind === "file" ? rawFileMeta : globalMeta;
    this.storageCommitId = chosenMeta?.commitId;
    this.storageSnapshotFingerprint = JSON.stringify(tasksToLoad);

    let needsSave = false;
    const needsStoreHealing =
      !globalTasksOk ||
      (selection.chosenKind !== "none" && fileStoreExists && !fileLoad.ok);

    for (const rawTask of tasksToLoad) {
      if (!this.hasMinimumPersistedTaskShape(rawTask)) {
        needsSave = true;
        continue;
      }

      const task = rawTask as unknown as ScheduledTask;
      // Restore Date objects from JSON serialization
      task.createdAt = new Date(task.createdAt);
      task.updatedAt = new Date(task.updatedAt);
      if (task.lastRun !== undefined) {
        task.lastRun = new Date(task.lastRun);
      }
      if (task.nextRun !== undefined) {
        task.nextRun = new Date(task.nextRun);
      }
      if (task.lastFiredDueAt !== undefined) {
        task.lastFiredDueAt = new Date(task.lastFiredDueAt);
      }

      // Recovery: avoid keeping Invalid Date objects (would break JSON serialization).
      // When dates are corrupted/missing, heal them and persist once.
      const healedNow = new Date();
      if (Number.isNaN(task.createdAt.getTime())) {
        task.createdAt = healedNow;
        needsSave = true;
      }
      if (Number.isNaN(task.updatedAt.getTime())) {
        task.updatedAt = task.createdAt;
        needsSave = true;
      }
      if (task.lastRun && Number.isNaN(task.lastRun.getTime())) {
        task.lastRun = undefined;
        needsSave = true;
      }
      if (task.nextRun && Number.isNaN(task.nextRun.getTime())) {
        task.nextRun = undefined;
        needsSave = true;
      }
      if (task.lastFiredDueAt && Number.isNaN(task.lastFiredDueAt.getTime())) {
        task.lastFiredDueAt = undefined;
        needsSave = true;
      }
      if (task.runAt && (task.lastFiredDueAt || task.lastFiredClaimId) && task.enabled) {
        task.enabled = false;
        needsSave = true;
      }

      // Migration/Safety: normalize persisted enabled flag.
      // Corrupted values like "false" (string) are truthy at runtime and may
      // accidentally execute tasks, so coerce non-boolean values to false.
      if (typeof task.enabled !== "boolean") {
        task.enabled = false;
        needsSave = true;
      }

      // Migration: add missing fields for older tasks
      if (!task.scope) {
        task.scope = "global";
        needsSave = true;
      } else if (task.scope !== "global" && task.scope !== "workspace") {
        // Safety-first recovery for invalid scope values from corrupted storage.
        // Normalize to a known value and disable to avoid unintended execution.
        task.scope = "global";
        if (task.enabled) {
          task.enabled = false;
        }
        needsSave = true;
      }
      {
        const promptPath =
          typeof task.promptPath === "string" ? task.promptPath.trim() : "";
        const hasPromptPath = promptPath.length > 0;

        const inferPromptSource = (): "inline" | "local" | "global" => {
          if (!hasPromptPath) return "inline";

          const workspaceFolderPaths = (vscode.workspace.workspaceFolders ?? [])
            .map((f) => f.uri.fsPath)
            .filter(
              (p): p is string => typeof p === "string" && p.trim().length > 0,
            );

          // Prefer global if it matches the configured (or default) global prompts root.
          const cfg = vscode.workspace.getConfiguration("copilotScheduler");
          const globalRoot = resolveGlobalPromptsRoot(
            cfg.get<string>("globalPromptsPath", ""),
          );
          if (resolveGlobalPromptPath(globalRoot, promptPath)) {
            return "global";
          }

          if (resolveLocalPromptPath(workspaceFolderPaths, promptPath)) {
            return "local";
          }

          return "inline";
        };

        // Migration: promptSource was introduced later; infer it from promptPath.
        // Also heal inconsistent data where promptSource is inline but promptPath exists.
        const isKnownSource =
          task.promptSource === "inline" ||
          task.promptSource === "local" ||
          task.promptSource === "global";

        if (!task.promptSource || !isKnownSource) {
          task.promptSource = inferPromptSource();
          if (task.promptSource === "inline" && !hasPromptPath) {
            task.promptPath = undefined;
          }
          needsSave = true;
        } else if (task.promptSource === "inline" && hasPromptPath) {
          const inferred = inferPromptSource();
          if (inferred !== "inline") {
            task.promptSource = inferred;
            needsSave = true;
          }
        }
      }

      {
        try {
          const normalizedModelSelection = normalizeModelSelection(task);
          if (!areModelSelectionsEqual(task, normalizedModelSelection)) {
            applyModelSelectionToTask(task, normalizedModelSelection);
            needsSave = true;
          }
        } catch {
          logError(
            "[CopilotScheduler] Invalid model configuration retained without migration; execution requires valid settings.",
          );
        }
      }

      // Migration: preserve undefined jitterSeconds so configured defaults
      // continue to apply for legacy tasks.
      if (task.jitterSeconds !== undefined) {
        const normalizedJitter = this.clampJitterSeconds(task.jitterSeconds);
        if (task.jitterSeconds !== normalizedJitter) {
          task.jitterSeconds = normalizedJitter;
          needsSave = true;
        }
      }

      if (task.maxExecutionsPerDay !== undefined) {
        const normalizedMax = this.clampTaskMaxExecutionsPerDay(
          task.maxExecutionsPerDay,
        );
        if (task.maxExecutionsPerDay !== normalizedMax) {
          task.maxExecutionsPerDay = normalizedMax;
          needsSave = true;
        }
      }

      if (task.allowedTimeStart !== undefined) {
        const normalizedStart = normalizeTimeWindowHHMM(task.allowedTimeStart);
        if (task.allowedTimeStart !== normalizedStart) {
          task.allowedTimeStart = normalizedStart;
          needsSave = true;
        }
      }

      if (task.allowedTimeEnd !== undefined) {
        const normalizedEnd = normalizeTimeWindowHHMM(task.allowedTimeEnd);
        if (task.allowedTimeEnd !== normalizedEnd) {
          task.allowedTimeEnd = normalizedEnd;
          needsSave = true;
        }
      }

      if (task.autoMode !== undefined && typeof task.autoMode !== "boolean") {
        task.autoMode = false;
        needsSave = true;
      }

      if (
        task.modelFallback !== undefined &&
        typeof task.modelFallback !== "boolean"
      ) {
        task.modelFallback = false;
        needsSave = true;
      }

      if (
        task.useCopilotCli !== undefined &&
        typeof task.useCopilotCli !== "boolean"
      ) {
        task.useCopilotCli = undefined;
        needsSave = true;
      }

      if (task.skillRef !== undefined) {
        const cleanSkillRef = normalizeSkillRef(task.skillRef);
        if (JSON.stringify(cleanSkillRef) !== JSON.stringify(task.skillRef)) {
          task.skillRef = cleanSkillRef;
          needsSave = true;
        }
      }

      if (
        task.chatSession !== undefined &&
        task.chatSession !== "new" &&
        task.chatSession !== "continue"
      ) {
        task.chatSession = undefined;
        needsSave = true;
      }

      if (task.attachments !== undefined) {
        const normalizedAttachments = normalizeAttachments(
          task.attachments,
          task.scope,
        );
        if (normalizedAttachments.changed) {
          needsSave = true;
        }
        task.attachments =
          normalizedAttachments.attachments.length > 0
            ? normalizedAttachments.attachments
            : undefined;
      }

      // Safety: if a stored task has an invalid schedule (e.g., manual edits or corruption),
      // disable it to prevent runaway execution loops.
      try {
        if (task.runAt !== undefined) {
          task.runAt = this.parseRunAt(task.runAt).toISOString();
          if (task.afterRun !== "delete" && task.afterRun !== "disable") {
            task.afterRun = "disable";
            needsSave = true;
          }
        } else {
          this.validateCronExpression(task.cronExpression);
        }
      } catch {
        if (task.enabled) {
          task.enabled = false;
          needsSave = true;
        }
        if (task.nextRun !== undefined) {
          task.nextRun = undefined;
          needsSave = true;
        }
        logError(
          "[CopilotScheduler] Invalid cron expression found in stored task; disabling:",
          {
            taskId: task.id,
            taskName: task.name,
            cronExpression: task.cronExpression,
          },
        );
      }

      // Keep persisted nextRun to allow catch-up execution after reload.
      // Only compute nextRun when it's missing or invalid.
      if (task.enabled) {
        const hasValidNextRun =
          task.nextRun instanceof Date && !Number.isNaN(task.nextRun.getTime());
        if (!hasValidNextRun) {
          const now = new Date();
          task.nextRun = task.runAt
            ? task.lastFiredDueAt || task.lastFiredClaimId
              ? undefined
              : new Date(task.runAt)
            : this.getNextRunForTask(task.cronExpression, now);
          needsSave = true;
        }
      } else if (task.nextRun !== undefined) {
        task.nextRun = undefined;
        needsSave = true;
      }

      this.tasks.set(task.id, task);
    }

    // Save if any changes were made
    if (this.taskStoreReadError) {
      return;
    }
    if (needsSave) {
      void this.saveTasks().catch((error) =>
        logError(
          "[CopilotScheduler] Failed to save migrated tasks:",
          toSafeErrorDetails(error),
        ),
      );
    } else {
      // Heal the other store if needed (best effort, do not bump revision)
      if (
        needsStoreHealing ||
        filePayloadNeedsRepair ||
        selection.shouldHealFile ||
        selection.shouldHealGlobalState
      ) {
        void this.saveTasks({ bumpRevision: false }).catch((error) =>
          logDebug(
            "[CopilotScheduler] Failed to sync task stores:",
            toSafeErrorDetails(error),
          ),
        );
      }
    }
  }

  /**
   * Save tasks to globalState
   */
  private async saveTasks(options?: {
    bumpRevision?: boolean;
    requireFile?: boolean;
  }): Promise<void> {
    return this.enqueueSave(() => this.saveTasksInternal(options));
  }

  private notifyTaskStoreIssue(): void {
    if (this.taskStoreWarningShown) return;
    this.taskStoreWarningShown = true;
    void vscode.window.showWarningMessage(messages.taskStoreReservationFailed());
  }

  private enqueueSave<T>(operation: () => Promise<T>): Promise<T> {
    const op = this.saveQueue.then(operation);
    // Recover the chain so that a failed save does not block all subsequent saves.
    this.saveQueue = op.then(
      () => undefined,
      (error) => {
        logError(
          "[CopilotScheduler] Save failed (chain recovered):",
          toSafeErrorDetails(error),
        );
      },
    );
    return op;
  }

  private async saveTasksOrRestore(): Promise<void> {
    try {
      await this.saveTasks();
    } catch (error) {
      this.tasks.clear();
      this.loadTasks();
      this.notifyTasksChanged();
      throw error;
    }
  }

  private async saveTasksInternal(options?: {
    bumpRevision?: boolean;
    requireFile?: boolean;
  }, tasksOverride?: ScheduledTask[]): Promise<void> {
    try {
      await withTaskStoreLock(this.storageLockFilePath, () =>
        this.saveTasksWhileLocked(options, tasksOverride),
      );
    } catch (error) {
      if (
        error instanceof TaskStoreConflictError ||
        error instanceof TaskStoreLockBusyError
      ) {
        this.tasks.clear();
        this.loadTasks();
        this.notifyTasksChanged();
        throw new Error(
          error instanceof TaskStoreConflictError
            ? messages.taskStoreChangedExternally()
            : messages.taskStoreBusy(),
        );
      }
      throw error;
    }
  }

  private async saveTasksWhileLocked(options?: {
    bumpRevision?: boolean;
    requireFile?: boolean;
  }, tasksOverride?: ScheduledTask[]): Promise<void> {
    if (this.taskStoreReadError) {
      throw new Error(this.taskStoreReadError);
    }
    const sharedFile = this.loadSharedFileMetadata();
    const fileMeta = sharedFile.meta;
    const globalSnapshot = this.loadGlobalStateSnapshot();
    if (sharedFile.error) {
      throw new Error(sharedFile.error);
    }
    if (this.snapshotsConflict(fileMeta, globalSnapshot)) {
      throw new Error("Task store snapshots have conflicting commits");
    }
    if (
      this.context.globalState.get<unknown>(STORAGE_SNAPSHOT_KEY) !== undefined &&
      !globalSnapshot &&
      !this.canRecoverInvalidGlobalSnapshot(fileMeta)
    ) {
      throw new Error("Cannot safely recover the invalid global task store snapshot");
    }
    const globalMeta = this.loadMetaFromGlobalState();
    const latestPersistedRevision = Math.max(
      fileMeta?.revision ?? 0,
      globalMeta.revision,
    );
    if (latestPersistedRevision > this.storageRevision) {
      throw new TaskStoreConflictError();
    }
    const latestMeta =
      (fileMeta?.revision ?? -1) >= globalMeta.revision ? fileMeta : globalMeta;
    if (
      latestPersistedRevision === this.storageRevision &&
      latestMeta?.tasksSnapshot &&
      this.storageSnapshotFingerprint !== undefined &&
      JSON.stringify(latestMeta.tasksSnapshot) !== this.storageSnapshotFingerprint
    ) {
      throw new TaskStoreConflictError();
    }

    const bumpRevision = options?.bumpRevision !== false;
    const tasksArray = this.cloneTasksForMirror(
      tasksOverride ?? Array.from(this.tasks.values()),
    );

    const nextRevision = bumpRevision
      ? this.storageRevision + 1
      : this.storageRevision;
    const meta: TaskStorageMeta = {
      revision: nextRevision,
      savedAt: new Date().toISOString(),
      commitId: bumpRevision ? randomUUID() : (this.storageCommitId ?? randomUUID()),
    };

    // Prefer file persistence for responsiveness and reliability.
    // If file save succeeds, return immediately and sync globalState in background.
    try {
      await this.queueFileWrite(tasksArray, meta);
      this.storageRevision = meta.revision;
      this.storageCommitId = meta.commitId;
      this.storageSnapshotFingerprint = JSON.stringify(tasksArray);

      await this.queueGlobalStateWrite(tasksArray, meta, true).catch((error) => {
        logDebug(
          "[CopilotScheduler] Task save to globalState failed (file succeeded):",
          toSafeErrorDetails(error),
        );
      });

      this.notifyTasksChanged();
      return;
    } catch (fileError) {
      if (options?.requireFile) {
        throw fileError;
      }
      // The shared fallback is authoritative when the primary file cannot be
      // committed; a cached globalState alone cannot prove cross-window freshness.
      await writeFileAtomically(
        this.storageFallbackFilePath,
        JSON.stringify({ ...meta, tasksSnapshot: tasksArray }),
      );
      this.storageRevision = meta.revision;
      this.storageCommitId = meta.commitId;
      this.storageSnapshotFingerprint = JSON.stringify(tasksArray);
      try {
        await this.queueGlobalStateWrite(tasksArray, meta, true);
      } catch (globalStateError) {
        logError(
          "[CopilotScheduler] Task save to globalState failed (fallback file succeeded):",
          toSafeErrorDetails(globalStateError),
        );
      }

      // Repair the primary pair when possible, preserving payload-before-meta.
      await this.queueFileWrite(tasksArray, meta).catch((error) => {
        logDebug(
          "[CopilotScheduler] Task save to file failed (globalState succeeded):",
          {
            fileError: toSafeErrorDetails(fileError),
            syncError: toSafeErrorDetails(error),
          },
        );
      });
    }

    this.notifyTasksChanged();
  }

  private cloneTasksForMirror(tasksArray: ScheduledTask[]): ScheduledTask[] {
    return JSON.parse(JSON.stringify(tasksArray)) as ScheduledTask[];
  }

  private queueGlobalStateWrite(
    tasksArray: ScheduledTask[],
    meta: TaskStorageMeta,
    fileCommitted = false,
  ): Promise<void> {
    const tasksSnapshot = this.cloneTasksForMirror(tasksArray);
    const metaSnapshot = { ...meta };
    const op = this.globalStateWriteQueue.then(async () => {
      const previousSnapshot = this.loadGlobalStateSnapshot();
      const rawSnapshot =
        this.context.globalState.get<unknown>(STORAGE_SNAPSHOT_KEY);
      const previousMeta = this.loadLegacyMetaFromGlobalState();
      if (rawSnapshot !== undefined && !previousSnapshot && !fileCommitted) {
        throw new Error("Cannot replace an invalid global task store snapshot");
      }
      if (
        rawSnapshot === undefined ||
        (previousSnapshot && previousSnapshot.revision < previousMeta.revision)
      ) {
        const previous = this.context.globalState.get<unknown>(STORAGE_KEY);
        if (
          previous !== undefined &&
          !Array.isArray(previous) &&
          !fileCommitted
        ) {
          throw new Error("Cannot snapshot an invalid global task store");
        }
        await this.context.globalState.update(STORAGE_SNAPSHOT_KEY, {
          ...previousMeta,
          tasksSnapshot: Array.isArray(previous) ? previous : [],
        });
      }
      await this.context.globalState.update(STORAGE_SNAPSHOT_INTENT_KEY, {
        revision: metaSnapshot.revision,
        commitId: metaSnapshot.commitId,
      });
      await this.saveTasksToGlobalState(tasksSnapshot);
      await this.context.globalState.update(STORAGE_SNAPSHOT_KEY, {
        ...metaSnapshot,
        tasksSnapshot,
      });
      await this.saveMetaToGlobalState(metaSnapshot);
    });
    this.globalStateWriteQueue = op.catch(() => undefined);
    return op;
  }

  private queueFileWrite(
    tasksArray: ScheduledTask[],
    meta: TaskStorageMeta,
  ): Promise<void> {
    const tasksSnapshot = this.cloneTasksForMirror(tasksArray);
    const metaSnapshot = { ...meta };
    const op = this.fileWriteQueue.then(async () => {
      const previousMeta = this.loadMetaFromFile();
      if (this.hasFileMetadata() && !previousMeta) {
        throw new Error("Cannot replace invalid task store metadata");
      }
      if (previousMeta?.tasksSnapshot === undefined) {
        const previousPayload = this.loadTasksFromFile();
        const legacyGlobal = this.context.globalState.get<unknown>(STORAGE_KEY);
        const legacyGlobalMeta = this.loadLegacyMetaFromGlobalState();
        const globalSnapshot = this.loadGlobalStateSnapshot();
        const hasInvalidGlobalSnapshot =
          this.context.globalState.get<unknown>(STORAGE_SNAPSHOT_KEY) !==
            undefined && !globalSnapshot;
        const useGlobalSnapshot =
          globalSnapshot && globalSnapshot.revision >= legacyGlobalMeta.revision;
        const globalTasks = useGlobalSnapshot
          ? globalSnapshot.tasksSnapshot
          : hasInvalidGlobalSnapshot
            ? undefined
            : legacyGlobal;
        const globalMeta = useGlobalSnapshot
          ? globalSnapshot
          : legacyGlobalMeta;
        const baseline = previousPayload.ok
          ? {
              ...(previousMeta ?? { revision: 0, savedAt: "" }),
              tasksSnapshot: previousPayload.tasks,
            }
          : Array.isArray(globalTasks)
            ? { ...globalMeta, tasksSnapshot: globalTasks }
            : !fs.existsSync(this.storageFilePath) &&
                !fs.existsSync(this.storageMetaFilePath)
              ? { revision: 0, savedAt: "", tasksSnapshot: [] }
              : undefined;
        if (!baseline) {
          throw new Error("Cannot establish a committed task store snapshot");
        }
        await this.saveMetaToFile(baseline);
      }
      await this.saveTasksToFile(tasksSnapshot);
      await this.saveMetaToFile({ ...metaSnapshot, tasksSnapshot });
    });
    this.fileWriteQueue = op.catch(() => undefined);
    return op;
  }

  /**
   * Generate unique task ID
   */
  private generateId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `task_${timestamp}_${random}`;
  }

  /** Workspace folder a newly created workspace-scoped task is bound to. */
  getPreferredWorkspaceRootPath(): string | undefined {
    return getPreferredWorkspaceRootPath();
  }

  /**
   * Get timezone from configuration
   */
  private getTimeZone(): string | undefined {
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const tz = config.get<string>("timezone", "");
    return tz || undefined;
  }

  /** Calendar day the schedule runs on, used by the daily counters. */
  private getSchedulerDateKey(date = new Date()): string {
    return getZonedWallClock(date, this.getTimeZone()).dateKey;
  }

  private getManualRunNextRunPolicy(): ManualRunNextRunPolicy {
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const policy = config.get<string>("manualRunNextRunPolicy", "fromNow");
    return policy === "advance" ? "advance" : "fromNow";
  }

  private getMissedRunPolicy(): MissedRunPolicy {
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    return config.get<string>("missedRunPolicy", "runOnce") === "skip"
      ? "skip"
      : "runOnce";
  }

  private getMaxConcurrentAutomaticRuns(): number {
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const value = config.get<number>("maxConcurrentAutomaticRuns", 1);
    return Number.isFinite(value)
      ? Math.min(Math.max(Math.floor(value), 1), 10)
      : 1;
  }

  /**
   * Calculate next run time from cron expression
   */
  private getNextRun(
    cronExpression: string,
    baseTime?: Date,
  ): Date | undefined {
    const currentDate = baseTime || new Date();
    const tz = this.getTimeZone();

    try {
      const options: { currentDate: Date; tz?: string } = { currentDate };
      if (tz) {
        options.tz = tz;
      }

      return getNextCronRun(cronExpression, options);
    } catch {
      // If the configured timezone is invalid, fall back to local time (U9).
      if (tz) {
        logDebug(
          `[CopilotScheduler] Invalid timezone "${tz}", falling back to local time`,
        );
        try {
          return getNextCronRun(cronExpression, { currentDate });
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
  }

  private truncateToMinute(date: Date): Date {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
    );
  }

  private getNextRunForTask(cronExpression: string, baseTime: Date): Date {
    // Always use cron-parser to stay aligned with the cron grid.
    // A previous "*/N" fixed-interval optimisation was removed because it
    // drifted from the grid when jitter or execution time shifted baseTime
    // away from a grid-aligned minute (e.g., */5 starting at :03 → :08
    // instead of :05, compounding on every subsequent execution).
    const parsed = this.getNextRun(cronExpression, baseTime);
    if (parsed) {
      return parsed;
    }

    // Fallback: if cron parsing fails unexpectedly, schedule 60 min in the
    // future instead of "now" to prevent rapid-fire execution loops.
    logError(
      `[CopilotScheduler] Failed to parse cron "${cronExpression}"; falling back to +60 min`,
    );
    return this.truncateToMinute(new Date(baseTime.getTime() + 60 * 60 * 1000));
  }

  /**
   * Validate cron expression
   * @throws Error if invalid
   */
  validateCronExpression(expression: string): void {
    if (!expression || !expression.trim()) {
      throw new Error(messages.invalidCronExpression());
    }

    const currentDate = new Date();
    const tz = this.getTimeZone();

    // First, validate with timezone if configured.
    try {
      const options: { currentDate: Date; tz?: string } = { currentDate };
      if (tz) {
        options.tz = tz;
      }
      validateCronExpressions(expression, options);
      return;
    } catch {
      // If timezone is invalid, retry without tz.
      if (tz) {
        try {
          validateCronExpressions(expression, { currentDate });
          return;
        } catch {
          // Fall through to throw
        }
      }
      throw new Error(messages.invalidCronExpression());
    }
  }

  private parseRunAt(value: string): Date {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      )
    ) {
      throw new Error(
        "runAt must be an ISO 8601 date-time with a timezone offset.",
      );
    }
    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime())) {
      throw new Error("runAt must be a valid date-time.");
    }
    const offset = value.endsWith("Z")
      ? 0
      : (value.slice(-6, -5) === "+" ? 1 : -1) *
        (Number(value.slice(-5, -3)) * 60 + Number(value.slice(-2))) *
        60000;
    if (
      (!value.endsWith("Z") &&
        (Number(value.slice(-5, -3)) > 23 || Number(value.slice(-2)) > 59)) ||
      new Date(timestamp.getTime() + offset).toISOString().slice(0, 19) !==
        value.slice(0, 19)
    ) {
      throw new Error("runAt must be a valid date-time.");
    }
    return timestamp;
  }

  private nextRunForTask(task: ScheduledTask, now: Date): Date | undefined {
    return task.runAt
      ? task.lastFiredDueAt || task.lastFiredClaimId
        ? undefined
        : new Date(task.runAt)
      : this.getNextRunForTask(task.cronExpression, now);
  }

  private skipDueTask(task: ScheduledTask, now: Date): void {
    task.nextRun = this.nextRunForTask(task, now);
    if (task.runAt) {
      task.enabled = false;
      task.nextRun = undefined;
    }
  }

  /**
   * Create a new task
   */
  async createTask(input: CreateTaskInput): Promise<ScheduledTask> {
    if (!input.name || !input.name.trim()) {
      throw new Error(messages.taskNameRequired());
    }
    if (!input.prompt || !input.prompt.trim()) {
      throw new Error(messages.promptRequired());
    }
    if (input.promptPath?.includes("\0")) {
      throw new Error(messages.templateLoadError());
    }

    if (input.runAt !== undefined) {
      this.parseRunAt(input.runAt);
      if (input.cronExpression.trim() || input.runFirstInOneMinute) {
        throw new Error(
          "runAt cannot be combined with cronExpression or runFirstInOneMinute.",
        );
      }
    } else {
      this.validateCronExpression(input.cronExpression);
    }
    if (
      input.afterRun !== undefined &&
      (!input.runAt || !["disable", "delete"].includes(input.afterRun))
    ) {
      throw new Error("afterRun requires runAt and must be disable or delete.");
    }

    const maxExecutionsPerDay = this.clampTaskMaxExecutionsPerDay(
      input.maxExecutionsPerDay,
    );
    const allowedTimeStart = this.normalizeTimeWindowOrThrow(
      input.allowedTimeStart,
    );
    const allowedTimeEnd = this.normalizeTimeWindowOrThrow(
      input.allowedTimeEnd,
    );

    const now = new Date();
    const id = this.generateId();

    // Get defaults from configuration
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const defaultScope = config.get<TaskScope>("defaultScope", "workspace");
    const defaultAutoMode = config.get<boolean>("autoModeDefault", false);
    const defaultJitter = this.clampJitterSeconds(
      config.get<number>("jitterSeconds", 600),
    );

    const enabled = input.enabled !== false;
    const effectiveScope = input.scope || defaultScope;
    const workspaceRoot = this.getPreferredWorkspaceRootPath();
    if (effectiveScope === "workspace" && !workspaceRoot) {
      throw new Error(messages.noWorkspaceOpen());
    }

    const attachments = normalizeAttachmentsOrThrow(
      input.attachments,
      effectiveScope,
    );

    // Calculate next run (disabled tasks must not keep nextRun)
    let nextRun: Date | undefined;
    if (enabled) {
      if (input.runAt) {
        nextRun = this.parseRunAt(input.runAt);
      } else if (input.runFirstInOneMinute) {
        nextRun = this.truncateToMinute(
          new Date(
            now.getTime() + ScheduleManager.FIRST_RUN_DELAY_MINUTES * 60 * 1000,
          ),
        );
      } else {
        nextRun = this.getNextRunForTask(input.cronExpression, now);
      }
    }

    const task: ScheduledTask = {
      id,
      name: input.name,
      cronExpression: input.cronExpression,
      runAt: input.runAt
        ? this.parseRunAt(input.runAt).toISOString()
        : undefined,
      afterRun: input.runAt ? (input.afterRun ?? "disable") : undefined,
      prompt: input.prompt,
      enabled,
      agent: input.agent,
      ...normalizeModelSelection(input),
      scope: effectiveScope,
      workspacePath: effectiveScope === "workspace" ? workspaceRoot : undefined,
      promptSource: input.promptSource || "inline",
      promptPath: input.promptPath,
      attachments: attachments.length > 0 ? attachments : undefined,
      autoMode:
        input.autoMode !== undefined
          ? Boolean(input.autoMode)
          : defaultAutoMode,
      modelFallback: input.modelFallback === true ? true : undefined,
      useCopilotCli: input.useCopilotCli === true ? true : undefined,
      skillRef: normalizeSkillRef(input.skillRef),
      chatSession:
        input.chatSession === "new" || input.chatSession === "continue"
          ? input.chatSession
          : undefined,
      jitterSeconds:
        input.jitterSeconds !== undefined
          ? this.clampJitterSeconds(input.jitterSeconds)
          : defaultJitter,
      maxExecutionsPerDay,
      allowedTimeStart,
      allowedTimeEnd,
      nextRun,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(id, task);
    await this.saveTasksOrRestore();

    return task;
  }

  /**
   * Get a task by ID
   */
  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  async getTaskForRun(id: string): Promise<ScheduledTask | undefined> {
    try {
      await this.refreshPersistedTasksIfChanged(false);
    } catch (error) {
      logError(
        "[CopilotScheduler] Could not refresh the task before confirmation:",
        toSafeErrorDetails(error),
      );
      throw error;
    }
    return this.tasks.get(id);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  async healTaskModelSelections(
    availableModels: readonly ModelInfo[],
  ): Promise<number> {
    const selectableModels = availableModels.filter(
      (model) =>
        !!model && typeof model.id === "string" && model.id.trim().length > 0,
    );
    if (selectableModels.length === 0) {
      return 0;
    }

    let changed = 0;
    for (const task of this.tasks.values()) {
      let currentSelection: NormalizedModelSelection;
      try {
        currentSelection = normalizeModelSelection(task);
      } catch {
        continue;
      }
      if (!hasModelSelection(currentSelection)) {
        continue;
      }

      const matched = findBestMatchingModel(currentSelection, selectableModels);
      if (!matched) {
        continue;
      }

      const matchedSelection = {
        ...modelInfoToSelection(matched),
        modelConfiguration: currentSelection.modelConfiguration,
        modelReasoningEffort: currentSelection.modelReasoningEffort,
      };
      const nextSelection = supportsConfiguredModelExecution()
        ? migrateLegacyModelConfiguration(
            matchedSelection,
            matched,
            supportsSystemMessageForwarding(),
          )
        : matchedSelection;
      if (applyModelSelectionToTask(task, nextSelection)) {
        task.updatedAt = new Date();
        changed += 1;
      }
    }

    if (changed > 0) {
      await this.saveTasksOrRestore();
    }

    return changed;
  }

  /**
   * Recalculate nextRun for all enabled tasks.
   * Call when timezone configuration changes so that persisted nextRun values
   * (computed under the old timezone) are recomputed under the new one.
   */
  async recalculateAllNextRuns(): Promise<void> {
    const now = new Date();
    let changed = false;
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;
      const newNextRun = this.nextRunForTask(task, now);
      if (task.nextRun?.getTime() !== newNextRun?.getTime()) {
        task.nextRun = newNextRun;
        changed = true;
      }
    }
    if (changed) {
      await this.saveTasksOrRestore();
    }
  }

  /**
   * Get tasks by scope
   */
  getTasksByScope(scope: TaskScope): ScheduledTask[] {
    return this.getAllTasks().filter((task) => task.scope === scope);
  }

  /**
   * Update a task
   */
  async updateTask(
    id: string,
    updates: Partial<CreateTaskInput>,
  ): Promise<ScheduledTask | undefined> {
    const task = this.tasks.get(id);
    if (!task) {
      return undefined;
    }

    if (updates.name !== undefined && !updates.name.trim()) {
      throw new Error(messages.taskNameRequired());
    }
    if (updates.prompt !== undefined && !updates.prompt.trim()) {
      throw new Error(messages.promptRequired());
    }
    if (updates.promptPath?.includes("\0")) {
      throw new Error(messages.templateLoadError());
    }

    const nextRunAt =
      updates.runAt === "" ? undefined : (updates.runAt ?? task.runAt);
    if (updates.runAt && updates.cronExpression?.trim()) {
      throw new Error("runAt cannot be combined with cronExpression.");
    }
    const effectiveRunAt = updates.cronExpression?.trim()
      ? undefined
      : nextRunAt;
    const normalizedRunAt = effectiveRunAt
      ? this.parseRunAt(effectiveRunAt).toISOString()
      : undefined;
    const nextCronExpression = effectiveRunAt
      ? ""
      : (updates.cronExpression ?? task.cronExpression);
    if (normalizedRunAt) {
      if (updates.runFirstInOneMinute) {
        throw new Error("runAt cannot be combined with runFirstInOneMinute.");
      }
    } else {
      this.validateCronExpression(nextCronExpression);
    }
    if (
      updates.afterRun !== undefined &&
      (!effectiveRunAt || !["disable", "delete"].includes(updates.afterRun))
    ) {
      throw new Error("afterRun requires runAt and must be disable or delete.");
    }
    if (updates.allowedTimeStart !== undefined) {
      this.normalizeTimeWindowOrThrow(updates.allowedTimeStart);
    }
    if (updates.allowedTimeEnd !== undefined) {
      this.normalizeTimeWindowOrThrow(updates.allowedTimeEnd);
    }

    // Safety: when re-enabling a task, validate the effective cron expression.
    // This prevents invalid persisted cron values from being re-enabled via
    // update paths that do not edit cronExpression directly.
    const nextEnabled = updates.enabled ?? task.enabled;
    if (
      !task.enabled &&
      nextEnabled &&
      normalizedRunAt &&
      (task.lastFiredDueAt || task.lastFiredClaimId) &&
      normalizedRunAt === task.runAt
    ) {
      throw new Error(
        "A completed one-time task must be rescheduled before enabling.",
      );
    }

    const nextScope = updates.scope ?? task.scope;
    const workspaceRoot =
      updates.scope !== undefined
        ? this.getPreferredWorkspaceRootPath()
        : undefined;
    if (updates.scope === "workspace" && !workspaceRoot) {
      throw new Error(messages.noWorkspaceOpen());
    }
    const shouldUpdateAttachments =
      updates.attachments !== undefined || (task.attachments?.length ?? 0) > 0;
    const nextAttachments = shouldUpdateAttachments
      ? normalizeAttachmentsOrThrow(
          updates.attachments !== undefined
            ? updates.attachments
            : task.attachments,
          nextScope,
        )
      : undefined;

    const hasModelUpdates =
      updates.model !== undefined ||
      updates.modelName !== undefined ||
      updates.modelVendor !== undefined ||
      updates.modelFamily !== undefined ||
      updates.modelVersion !== undefined ||
      updates.modelReasoningEffort !== undefined ||
      updates.modelConfiguration !== undefined;
    const nextModelSelection = hasModelUpdates
      ? normalizeModelSelection(
          updates.model !== undefined && updates.model.trim() === ""
            ? {}
            : {
                model: updates.model ?? task.model,
                modelName: updates.modelName ?? task.modelName,
                modelVendor: updates.modelVendor ?? task.modelVendor,
                modelFamily: updates.modelFamily ?? task.modelFamily,
                modelVersion: updates.modelVersion ?? task.modelVersion,
                modelReasoningEffort:
                  updates.modelReasoningEffort ??
                  (updates.modelConfiguration !== undefined
                    ? undefined
                    : task.modelReasoningEffort),
                modelConfiguration:
                  updates.modelConfiguration !== undefined
                    ? updates.modelConfiguration
                    : updates.model === ""
                      ? undefined
                      : task.modelConfiguration !== undefined &&
                          ((updates.model !== undefined &&
                            updates.model !== task.model) ||
                            (updates.modelVendor !== undefined &&
                              updates.modelVendor !== task.modelVendor))
                        ? {}
                        : task.modelConfiguration,
              },
        )
      : undefined;
    if (
      nextModelSelection?.modelConfiguration !== undefined &&
      nextModelSelection.modelReasoningEffort
    ) {
      throw new Error(
        "modelConfiguration conflicts with legacy reasoning effort",
      );
    }
    const now = new Date();
    const enabledBefore = task.enabled;
    let cronChanged = false;

    // Apply updates
    if (updates.name !== undefined) {
      task.name = updates.name;
    }
    if (updates.cronExpression !== undefined || updates.runAt !== undefined) {
      cronChanged =
        nextCronExpression !== task.cronExpression ||
        normalizedRunAt !== task.runAt;
      task.cronExpression = nextCronExpression;
      task.runAt = normalizedRunAt;
      task.afterRun = task.runAt
        ? (updates.afterRun ?? task.afterRun ?? "disable")
        : undefined;
    } else if (updates.afterRun !== undefined) {
      task.afterRun = updates.afterRun;
    }
    if (updates.prompt !== undefined) {
      task.prompt = updates.prompt;
    }
    if (updates.enabled !== undefined) {
      task.enabled = updates.enabled;
    }
    if (updates.agent !== undefined) {
      task.agent = updates.agent;
    }
    if (nextModelSelection) applyModelSelectionToTask(task, nextModelSelection);
    if (updates.scope !== undefined) {
      // Only adjust workspacePath when scope actually changes (or workspacePath is missing).
      // Webview submits scope on every save; we must not overwrite workspacePath on edits.
      if (nextScope !== task.scope) {
        task.scope = nextScope;
        if (nextScope === "workspace") {
          task.workspacePath = workspaceRoot;
        } else {
          task.workspacePath = undefined;
        }
      } else if (nextScope === "workspace" && !task.workspacePath) {
        task.workspacePath = workspaceRoot;
      }
    }
    if (updates.promptSource !== undefined) {
      task.promptSource = updates.promptSource;
    }
    if (updates.promptPath !== undefined) {
      task.promptPath = updates.promptPath;
    }
    if (nextAttachments) {
      task.attachments =
        nextAttachments.length > 0 ? nextAttachments : undefined;
    }
    if (updates.autoMode !== undefined) {
      task.autoMode = Boolean(updates.autoMode);
    }
    if (updates.modelFallback !== undefined) {
      task.modelFallback = updates.modelFallback === true ? true : undefined;
    }
    if (updates.useCopilotCli !== undefined) {
      task.useCopilotCli = updates.useCopilotCli === true ? true : undefined;
    }
    if (updates.skillRef !== undefined) {
      task.skillRef = normalizeSkillRef(updates.skillRef);
    }
    if (updates.chatSession !== undefined) {
      task.chatSession =
        updates.chatSession === "new" || updates.chatSession === "continue"
          ? updates.chatSession
          : undefined;
    }
    if (updates.jitterSeconds !== undefined) {
      task.jitterSeconds = this.clampJitterSeconds(updates.jitterSeconds);
    }
    if (updates.maxExecutionsPerDay !== undefined) {
      task.maxExecutionsPerDay = this.clampTaskMaxExecutionsPerDay(
        updates.maxExecutionsPerDay,
      );
    }
    if (updates.allowedTimeStart !== undefined) {
      task.allowedTimeStart = this.normalizeTimeWindowOrThrow(
        updates.allowedTimeStart,
      );
    }
    if (updates.allowedTimeEnd !== undefined) {
      task.allowedTimeEnd = this.normalizeTimeWindowOrThrow(
        updates.allowedTimeEnd,
      );
    }

    const enabledAfter = task.enabled;

    // Keep nextRun consistent with enabled state
    if (!enabledAfter) {
      task.nextRun = undefined;
    } else {
      // One-time immediate scheduling on update (only for enabled tasks)
      if (task.runAt) {
        task.nextRun =
          cronChanged || !(task.lastFiredDueAt || task.lastFiredClaimId)
            ? new Date(task.runAt)
            : undefined;
      } else if (updates.runFirstInOneMinute) {
        task.nextRun = this.truncateToMinute(
          new Date(
            now.getTime() + ScheduleManager.FIRST_RUN_DELAY_MINUTES * 60 * 1000,
          ),
        );
      } else if (cronChanged || (!enabledBefore && enabledAfter)) {
        task.nextRun = this.getNextRunForTask(task.cronExpression, now);
      } else if (!task.nextRun) {
        // Ensure nextRun exists for enabled tasks
        task.nextRun = this.getNextRunForTask(task.cronExpression, now);
      }
    }

    // A rescheduled task must not inherit the previous schedule's duplicate-run guard.
    if (cronChanged || updates.runFirstInOneMinute) {
      task.lastFiredDueAt = undefined;
      task.lastFiredClaimId = undefined;
    }

    task.updatedAt = now;

    await this.saveTasksOrRestore();

    return task;
  }

  /**
   * Delete a task
   */
  async deleteTask(id: string): Promise<boolean> {
    const deleted = this.tasks.delete(id);
    if (deleted) {
      await this.saveTasksOrRestore();
    }
    return deleted;
  }

  /**
   * Toggle task enabled/disabled
   */
  async toggleTask(id: string): Promise<ScheduledTask | undefined> {
    const task = this.tasks.get(id);
    if (!task) {
      return undefined;
    }

    const nextEnabled = !task.enabled;
    if (nextEnabled && !task.runAt) {
      this.validateCronExpression(task.cronExpression);
    } else if (nextEnabled && (task.lastFiredDueAt || task.lastFiredClaimId)) {
      throw new Error(
        "A completed one-time task must be rescheduled before enabling.",
      );
    }

    task.enabled = nextEnabled;
    task.updatedAt = new Date();

    // Keep nextRun consistent with enabled state
    if (task.enabled) {
      task.nextRun = this.nextRunForTask(task, new Date());
    } else {
      task.nextRun = undefined;
    }

    await this.saveTasksOrRestore();

    return task;
  }

  /**
   * Set task enabled state explicitly
   */
  async setTaskEnabled(
    id: string,
    enabled: boolean,
  ): Promise<ScheduledTask | undefined> {
    const task = this.tasks.get(id);
    if (!task) {
      return undefined;
    }

    if (enabled && !task.runAt) {
      this.validateCronExpression(task.cronExpression);
    } else if (enabled && (task.lastFiredDueAt || task.lastFiredClaimId)) {
      throw new Error(
        "A completed one-time task must be rescheduled before enabling.",
      );
    }

    task.enabled = enabled;
    task.updatedAt = new Date();

    // Keep nextRun consistent with enabled state
    if (task.enabled) {
      task.nextRun = this.nextRunForTask(task, new Date());
    } else {
      task.nextRun = undefined;
    }

    await this.saveTasksOrRestore();

    return task;
  }

  /**
   * Duplicate a task
   */
  async duplicateTask(id: string): Promise<ScheduledTask | undefined> {
    const original = this.tasks.get(id);
    if (!original) {
      return undefined;
    }

    const input: CreateTaskInput = {
      name: `${original.name} ${messages.taskCopySuffix()}`,
      cronExpression: original.cronExpression,
      runAt: original.runAt,
      afterRun: original.afterRun,
      prompt: original.prompt,
      enabled: false, // Start disabled
      agent: original.agent,
      model: original.model,
      modelName: original.modelName,
      modelVendor: original.modelVendor,
      modelFamily: original.modelFamily,
      modelVersion: original.modelVersion,
      modelReasoningEffort: original.modelReasoningEffort,
      modelConfiguration: original.modelConfiguration,
      scope: original.scope,
      promptSource: original.promptSource,
      promptPath: original.promptPath,
      attachments: original.attachments,
      autoMode: original.autoMode,
      modelFallback: original.modelFallback,
      useCopilotCli: original.useCopilotCli,
      skillRef: original.skillRef,
      chatSession: original.chatSession,
      jitterSeconds: original.jitterSeconds,
      maxExecutionsPerDay: original.maxExecutionsPerDay,
      allowedTimeStart: original.allowedTimeStart,
      allowedTimeEnd: original.allowedTimeEnd,
    };

    const duplicated = await this.createTask(input);

    if (
      original.scope === "workspace" &&
      duplicated.scope === "workspace" &&
      original.workspacePath
    ) {
      const originalWorkspacePath = original.workspacePath;
      const sameWorkspacePath =
        duplicated.workspacePath !== undefined &&
        normalizeForCompare(duplicated.workspacePath) ===
          normalizeForCompare(originalWorkspacePath);

      if (!sameWorkspacePath) {
        duplicated.workspacePath = originalWorkspacePath;
        duplicated.updatedAt = new Date();
        await this.saveTasksOrRestore();
      }
    }

    return duplicated;
  }

  /**
   * Move a workspace-scoped task to the current workspace (updates workspacePath).
   */
  async moveTaskToCurrentWorkspace(
    id: string,
  ): Promise<ScheduledTask | undefined> {
    const task = this.tasks.get(id);
    if (!task) {
      return undefined;
    }

    if (task.scope !== "workspace") {
      throw new Error(messages.moveOnlyWorkspaceTasks());
    }

    const workspaceRoot = this.getPreferredWorkspaceRootPath();
    if (!workspaceRoot) {
      throw new Error(messages.noWorkspaceOpen());
    }

    // The same relative path in another workspace resolves to a different file.
    const movesToAnotherWorkspace =
      !task.workspacePath ||
      normalizeForCompare(task.workspacePath) !==
        normalizeForCompare(workspaceRoot);
    if (
      movesToAnotherWorkspace &&
      (task.attachments ?? []).some(
        (attachment) => attachment.source === "local",
      )
    ) {
      throw new Error(messages.attachmentBlocksWorkspaceMove());
    }

    task.workspacePath = workspaceRoot;
    task.updatedAt = new Date();
    await this.saveTasksOrRestore();
    return task;
  }

  /**
   * Check if task should run in current workspace
   */
  shouldTaskRunInCurrentWorkspace(task: ScheduledTask): boolean {
    // Global tasks run in all workspaces
    if (task.scope === "global") {
      return true;
    }

    // Workspace-specific tasks only run in their workspace
    const workspacePaths = (vscode.workspace.workspaceFolders || [])
      .map((f) => f.uri.fsPath)
      .filter(Boolean);
    if (workspacePaths.length === 0) {
      return false;
    }

    const a = task.workspacePath ? normalizeForCompare(task.workspacePath) : "";
    if (a === "") return false;
    return workspacePaths.some((p) => normalizeForCompare(p) === a);
  }

  /**
   * Start the scheduler
   */
  startScheduler(
    onExecute: (
      task: ScheduledTask,
      trigger: "manual" | "auto",
      dispatchGuard?: (dispatch: () => void) => Promise<void>,
    ) => Promise<void | TaskExecutionCallbackResult>,
  ): void {
    this.onExecuteCallback = onExecute;

    // Stop existing scheduler if running
    this.stopScheduler();

    // Align to next minute boundary
    const now = new Date();
    this.schedulerStartedAt = now;
    const msToNextMinute = ScheduleManager.millisecondsUntilNextMinute(now);

    // Start after alignment
    this.schedulerTimeout = setTimeout(() => {
      this.schedulerTimeout = undefined;
      // Execute immediately on first aligned minute
      void this.runSchedulerTick();

      // Then run every minute
      this.schedulerInterval = setInterval(() => {
        void this.runSchedulerTick();
      }, 60 * 1000);
    }, msToNextMinute);
  }

  private async runSchedulerTick(): Promise<void> {
    if (this.schedulerTickInProgress) {
      this.schedulerTickPending = true;
      return;
    }

    this.schedulerTickInProgress = true;
    try {
      do {
        this.schedulerTickPending = false;
        await this.checkAndExecuteTasks();
      } while (this.schedulerTickPending);
    } catch (error) {
      logError(
        "[CopilotScheduler] Scheduler tick failed:",
        toSafeErrorDetails(error),
      );
    } finally {
      this.schedulerTickInProgress = false;
    }
  }

  /**
   * Stop the scheduler
   */
  stopScheduler(): void {
    if (this.schedulerTimeout) {
      clearTimeout(this.schedulerTimeout);
      this.schedulerTimeout = undefined;
    }
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = undefined;
    }
    this.schedulerTickPending = false;
  }

  /**
   * Check and execute tasks that are due
   */
  private async checkAndExecuteTasks(
    excludedOneTimeTaskIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const enabled = config.get<boolean>("enabled", true);

    if (!enabled) {
      return;
    }

    if (this.taskStoreReadError) {
      try {
        await this.refreshPersistedTasksIfChanged(false);
      } catch {
        this.notifyTaskStoreIssue();
        return;
      }
    }

    const now = new Date();
    // Truncate to minute for comparison
    const nowMinute = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
    );

    // Read config values once per tick (avoid redundant reads inside the loop)
    const rawMaxDaily = config.get<number>("maxDailyExecutions", 24);
    const safeMaxDaily = Number.isFinite(rawMaxDaily)
      ? Math.floor(rawMaxDaily)
      : 24;
    const maxDailyLimit =
      safeMaxDaily === 0 ? 0 : Math.min(Math.max(safeMaxDaily, 1), 100);
    const defaultJitterSeconds = config.get<number>("jitterSeconds", 600);
    const missedRunPolicy = this.getMissedRunPolicy();
    const maxConcurrentAutomaticRuns = this.getMaxConcurrentAutomaticRuns();
    const schedulerStartedAt = this.schedulerStartedAt;

    let executedCount = 0;
    const claims: TaskRunClaim[] = [];
    const skips: TaskRunSkip[] = [];
    const runResults = new Map<string, Date>();
    const skipTask = (task: ScheduledTask): void => {
      skips.push({
        taskId: task.id,
        runAt: task.runAt,
        cronExpression: task.cronExpression,
        expectedNextRun: task.nextRun?.getTime(),
        expectedEnabled: task.enabled,
        expectedLastFiredDueAt: task.lastFiredDueAt?.getTime(),
        expectedAllowedTimeStart: task.allowedTimeStart,
        expectedAllowedTimeEnd: task.allowedTimeEnd,
        expectedMaxExecutionsPerDay: task.maxExecutionsPerDay,
        expectedScope: task.scope,
        expectedWorkspacePath: task.workspacePath,
        evaluatedAt: now,
      });
    };

    const candidates = Array.from(this.tasks.values()).sort(
      (left, right) =>
        (left.nextRun?.getTime() ?? Infinity) -
        (right.nextRun?.getTime() ?? Infinity),
    );
    for (const task of candidates) {
      if (task.runAt && excludedOneTimeTaskIds.has(task.id)) {
        continue;
      }
      if (!task.enabled || !task.nextRun) {
        continue;
      }

      // Check if task should run in current workspace
      if (!this.shouldTaskRunInCurrentWorkspace(task)) {
        continue;
      }

      // Truncate nextRun to minute
      const nextRunMinute = task.runAt
        ? task.nextRun
        : new Date(
            task.nextRun.getFullYear(),
            task.nextRun.getMonth(),
            task.nextRun.getDate(),
            task.nextRun.getHours(),
            task.nextRun.getMinutes(),
          );

      // Check if due
      if (nextRunMinute.getTime() <= (task.runAt ? now : nowMinute).getTime()) {
        if (
          missedRunPolicy === "skip" &&
          schedulerStartedAt &&
          task.nextRun.getTime() < schedulerStartedAt.getTime()
        ) {
          logDebug(
            `[CopilotScheduler] Skipping missed run from before scheduler startup: ${task.name}`,
          );
          skipTask(task);
          continue;
        }

        // Another window may have already run this occurrence and rolled our
        // in-memory state back, so never fire the same due time twice.
        if (
          task.lastFiredDueAt &&
          !Number.isNaN(task.lastFiredDueAt.getTime()) &&
          nextRunMinute.getTime() <= task.lastFiredDueAt.getTime()
        ) {
          logDebug(
            `[CopilotScheduler] Due time already executed, skipping duplicate run: ${task.name}`,
          );
          skipTask(task);
          continue;
        }

        if (
          !isNowWithinAllowedTimeWindow(
            now,
            task.allowedTimeStart,
            task.allowedTimeEnd,
            this.getTimeZone(),
          )
        ) {
          logDebug(
            `[CopilotScheduler] Outside allowed time window, skipping task: ${task.name}`,
          );
          skipTask(task);
          continue;
        }

        if (this.isTaskDailyLimitReached(task, now)) {
          logDebug(
            `[CopilotScheduler] Per-task daily limit reached, skipping task: ${task.name}`,
          );
          skipTask(task);
          continue;
        }

        if (this.automaticRunsInFlight >= maxConcurrentAutomaticRuns) {
          continue;
        }

        // Safety: Check daily execution limit
        if (this.isDailyLimitReached(maxDailyLimit)) {
          logDebug(
            `[CopilotScheduler] Daily limit (${maxDailyLimit}) reached, skipping task: ${task.name}`,
          );
          const todayKey = this.getSchedulerDateKey();
          if (this.dailyLimitNotifiedDate !== todayKey) {
            this.dailyLimitNotifiedDate = todayKey;
            void this.context.globalState
              .update(DAILY_LIMIT_NOTIFIED_DATE_KEY, todayKey)
              .then(undefined, (error: unknown) =>
                logError(
                  "[CopilotScheduler] Failed to persist daily limit notified date:",
                  toSafeErrorDetails(error),
                ),
              );
            void vscode.window.showInformationMessage(
              messages.dailyLimitReached(maxDailyLimit),
            );
          }
          // Still advance nextRun so it doesn't keep retrying
          skipTask(task);
          continue;
        }

        if (
          maxDailyLimit > 0 &&
          this.dailyExecCount + this.automaticRunsInFlight >= maxDailyLimit
        ) {
          continue;
        }

        if (!this.tryStartTaskRun(task.id)) {
          logDebug(
            `[CopilotScheduler] Task already running, skipping overlapping execution: ${task.name}`,
          );
          if (!task.runAt) {
            skipTask(task);
          }
          continue;
        }

        claims.push({
          taskId: task.id,
          ...(task.runAt ? { claimId: randomUUID() } : {}),
          dueAt: nextRunMinute,
          nextRun: task.runAt
            ? undefined
            : this.getNextRunForTask(task.cronExpression, now),
          runAt: task.runAt,
          cronExpression: task.cronExpression,
          expectedNextRun: task.nextRun?.getTime(),
          expectedUpdatedAt: task.updatedAt.getTime(),
          expectedEnabled: task.enabled,
        });
        this.automaticRunsInFlight++;
      }
    }

    if (claims.length > 0 || skips.length > 0) {
      // Reserve the occurrence on disk first: a conflicting save can roll the
      // in-memory schedule back, and an unclaimed run would fire again next tick.
      const claimResult = await this.persistRunClaims(claims, skips);
      const accepted = new Set(claimResult.claimed);
      for (const claim of claims) {
        if (!accepted.has(claim)) {
          this.automaticRunsInFlight--;
          this.finishTaskRun(claim.taskId);
        }
      }
      if (!claimResult.failed) {
        // A Copilot CLI run lasts minutes, not milliseconds like a chat dispatch.
        // Waiting for it here would hold up the whole tick, including recording
        // the results of the quick runs of the same batch.
        const awaitedClaims = claimResult.claimed.filter(
          (claim) => !this.isLongRunningClaim(claim),
        );
        for (const claim of claimResult.claimed) {
          if (this.isLongRunningClaim(claim)) {
            this.startDetachedClaim(claim, defaultJitterSeconds);
          }
        }
        await Promise.allSettled(
          awaitedClaims.map((claim) =>
            this.executeClaimedTask(claim, defaultJitterSeconds).then(
              (executedAt) => {
                if (executedAt) {
                  executedCount++;
                  runResults.set(claim.taskId, executedAt);
                }
              },
            ),
          ),
        );
      } else {
        logDebug(
          "[CopilotScheduler] Could not claim due tasks, retrying on the next tick.",
        );
        this.notifyTaskStoreIssue();
        const excluded = new Set(excludedOneTimeTaskIds);
        for (const task of candidates) {
          if (task.runAt) excluded.add(task.id);
        }
        if (excluded.size > excludedOneTimeTaskIds.size) {
          await this.checkAndExecuteTasks(excluded);
        }
        return;
      }
      if (excludedOneTimeTaskIds.size === 0) {
        this.taskStoreWarningShown = false;
      }
    }

    // Persist once per tick to reduce I/O overhead.
    if (executedCount > 0) {
      try {
        await this.persistDailyExecCount();
      } catch (error) {
        logError(
          "[CopilotScheduler] Failed to persist daily execution count:",
          toSafeErrorDetails(error),
        );
      }
    }

    if (runResults.size > 0) {
      await this.persistRunResults(
        runResults,
        new Map(claims.map((claim) => [claim.taskId, claim])),
      );
    }
  }

  private isLongRunningClaim(claim: TaskRunClaim): boolean {
    // Agent Host runs wait for the whole turn, like a CLI run, so they must not hold up the tick.
    return (
      this.tasks.get(claim.taskId)?.useCopilotCli === true ||
      vscode.workspace
        .getConfiguration("copilotScheduler")
        .get<string>("executionRoute", "agentHost") !== "chat"
    );
  }

  /**
   * Runs a claimed occurrence without holding up the tick, then records its result.
   * The automatic-run slot stays taken until the run ends (executeClaimedTask frees it).
   */
  private startDetachedClaim(
    claim: TaskRunClaim,
    defaultJitterSeconds: number,
  ): void {
    const run: Promise<void> = this.executeClaimedTask(
      claim,
      defaultJitterSeconds,
    )
      .then(async (executedAt) => {
        if (!executedAt) {
          return;
        }
        try {
          await this.persistDailyExecCount();
        } catch (error) {
          logError(
            "[CopilotScheduler] Failed to persist daily execution count:",
            toSafeErrorDetails(error),
          );
        }
        await this.persistRunResults(
          new Map([[claim.taskId, executedAt]]),
          new Map([[claim.taskId, claim]]),
        );
      })
      .catch((error) => {
        logError(
          "[CopilotScheduler] Detached run failed:",
          toSafeErrorDetails(error),
        );
      })
      .finally(() => {
        this.detachedRuns.delete(run);
      });
    this.detachedRuns.add(run);
  }

  /** Resolves when every detached (long-running) run has finished. Used by tests and shutdown. */
  async waitForDetachedRuns(): Promise<void> {
    while (this.detachedRuns.size > 0) {
      await Promise.allSettled([...this.detachedRuns]);
    }
  }

  private claimMatchesTask(claim: TaskRunClaim, task: ScheduledTask): boolean {
    return (
      task.runAt === claim.runAt &&
      task.cronExpression === claim.cronExpression &&
      task.enabled === claim.expectedEnabled &&
      task.nextRun?.getTime() === claim.expectedNextRun &&
      task.updatedAt.getTime() === claim.expectedUpdatedAt &&
      (!task.lastFiredDueAt ||
        task.lastFiredDueAt.getTime() < claim.dueAt.getTime())
    );
  }

  private ownsOneTimeClaim(claim: TaskRunClaim, task: ScheduledTask): boolean {
    return (
      !!claim.runAt &&
      task.runAt === claim.runAt &&
      task.enabled === false &&
      task.nextRun === undefined &&
      !!claim.claimId &&
      task.lastFiredClaimId === claim.claimId &&
      task.lastFiredDueAt?.getTime() === claim.dueAt.getTime()
    );
  }

  private claimedDispatchGuard(
    claim: TaskRunClaim,
    task: ScheduledTask,
  ): (dispatch: () => void) => Promise<void> {
    const snapshot = JSON.stringify(task);
    return async (dispatch) => {
      try {
        await this.saveQueue;
        await withTaskStoreLock(this.storageLockFilePath, async () => {
          const shared = this.loadSharedFileMetadata();
          const current = this.tasks.get(claim.taskId);
          const stored = shared.meta?.tasksSnapshot?.find(
            (item) =>
              !!item &&
              typeof item === "object" &&
              (item as Record<string, unknown>).id === claim.taskId,
          );
          if (
            shared.error ||
            !current ||
            !(claim.runAt
              ? this.ownsOneTimeClaim(claim, current)
              : this.ownsRecurringClaim(claim, current)) ||
            JSON.stringify(current) !== snapshot ||
            JSON.stringify(stored) !== snapshot
          ) {
            throw new Error("The claimed task changed before dispatch");
          }
          dispatch();
        });
      } catch (error) {
        logError(
          "[CopilotScheduler] Could not verify the claimed task before dispatch:",
          toSafeErrorDetails(error),
        );
        throw createPromptBlockedError(
          claim.runAt
            ? messages.manualRunChangedAfterClaim()
            : messages.taskStoreChangedExternally(),
          "taskClaimChanged",
        );
      }
    };
  }

  private ownsRecurringClaim(claim: TaskRunClaim, task: ScheduledTask): boolean {
    return (
      !claim.runAt &&
      !task.runAt &&
      task.cronExpression === claim.cronExpression &&
      task.enabled === claim.expectedEnabled &&
      task.nextRun?.getTime() === claim.nextRun?.getTime() &&
      task.lastFiredDueAt?.getTime() === claim.dueAt.getTime()
    );
  }

  private skipMatchesTask(skip: TaskRunSkip, task: ScheduledTask): boolean {
    return (
      task.runAt === skip.runAt &&
      task.cronExpression === skip.cronExpression &&
      task.enabled === skip.expectedEnabled &&
      task.nextRun?.getTime() === skip.expectedNextRun &&
      task.lastFiredDueAt?.getTime() === skip.expectedLastFiredDueAt &&
      task.allowedTimeStart === skip.expectedAllowedTimeStart &&
      task.allowedTimeEnd === skip.expectedAllowedTimeEnd &&
      task.maxExecutionsPerDay === skip.expectedMaxExecutionsPerDay &&
      task.scope === skip.expectedScope &&
      task.workspacePath === skip.expectedWorkspacePath
    );
  }

  private async refreshPersistedTasksIfChanged(
    requireFileSnapshot: boolean,
  ): Promise<void> {
    await this.saveQueue;
    await withTaskStoreLock(this.storageLockFilePath, async () => {
      const sharedFile = this.loadSharedFileMetadata();
      const fileMeta = sharedFile.meta;
      const globalSnapshot = this.loadGlobalStateSnapshot();
      if (sharedFile.error) {
        throw new Error(sharedFile.error);
      }
      if (this.snapshotsConflict(fileMeta, globalSnapshot)) {
        throw new Error("Task store snapshots have conflicting commits");
      }
      if (
        this.context.globalState.get<unknown>(STORAGE_SNAPSHOT_KEY) !== undefined &&
        !globalSnapshot &&
        !this.canRecoverInvalidGlobalSnapshot(fileMeta)
      ) {
        throw new Error("Cannot safely recover the invalid global task store snapshot");
      }
      if (requireFileSnapshot && !fileMeta?.tasksSnapshot) {
        throw new Error("Cannot verify the committed one-time task claim");
      }
      const globalMeta = this.loadMetaFromGlobalState();
      const latestRevision = Math.max(
        fileMeta?.revision ?? 0,
        globalMeta.revision,
      );
      const latestMeta =
        (fileMeta?.revision ?? -1) >= globalMeta.revision ? fileMeta : globalMeta;
      if (
        this.taskStoreReadError ||
        latestRevision > this.storageRevision ||
        (latestRevision === this.storageRevision &&
          latestMeta?.tasksSnapshot &&
          this.storageSnapshotFingerprint !== undefined &&
          JSON.stringify(latestMeta.tasksSnapshot) !== this.storageSnapshotFingerprint)
      ) {
        this.tasks.clear();
        this.loadTasks();
        this.notifyTasksChanged();
        if (this.taskStoreReadError) {
          throw new Error(this.taskStoreReadError);
        }
      }
    });
  }

  private async persistRunClaims(
    claims: TaskRunClaim[],
    skips: TaskRunSkip[] = [],
  ): Promise<{ claimed: TaskRunClaim[]; failed?: true }> {
    for (
      let attempt = 1;
      attempt <= ScheduleManager.RUN_CLAIM_MAX_ATTEMPTS;
      attempt++
    ) {
      try {
        return await this.enqueueSave(async () => {
          const draftTasks = Array.from(this.tasks.values(), (task) => ({
            ...task,
          }));
          const drafts = new Map(draftTasks.map((task) => [task.id, task]));
          const applied: Array<{
            claim: TaskRunClaim;
            original: ScheduledTask;
            draft: ScheduledTask;
          }> = [];
          const skipped: Array<{
            skip: TaskRunSkip;
            original: ScheduledTask;
            draft: ScheduledTask;
          }> = [];
          for (const skip of skips) {
            const original = this.tasks.get(skip.taskId);
            const draft = drafts.get(skip.taskId);
            if (!original || !draft || !this.skipMatchesTask(skip, draft)) {
              continue;
            }
            this.skipDueTask(draft, skip.evaluatedAt);
            skipped.push({
              skip,
              original,
              draft,
            });
          }
          for (const claim of claims) {
            const original = this.tasks.get(claim.taskId);
            const draft = drafts.get(claim.taskId);
            if (!original || !draft || !this.claimMatchesTask(claim, draft)) {
              continue;
            }
            draft.lastFiredDueAt = claim.dueAt;
            draft.lastFiredClaimId = claim.claimId;
            draft.nextRun = claim.nextRun;
            if (claim.runAt) {
              draft.enabled = false;
            }
            applied.push({ claim, original, draft });
          }
          if (applied.length === 0 && skipped.length === 0) {
            return { claimed: [] };
          }
          await this.saveTasksInternal(
            {
              requireFile:
                applied.some(({ claim }) => !!claim.runAt) ||
                skipped.some(({ skip }) => !!skip.runAt),
            },
            draftTasks,
          );
          const accepted: TaskRunClaim[] = [];
          for (const { claim, original, draft } of applied) {
            const current = this.tasks.get(claim.taskId);
            if (current !== original || !this.claimMatchesTask(claim, current)) {
              continue;
            }
            current.lastFiredDueAt = draft.lastFiredDueAt;
            current.lastFiredClaimId = draft.lastFiredClaimId;
            current.nextRun = draft.nextRun;
            current.enabled = draft.enabled;
            accepted.push(claim);
          }
          for (const { skip, original, draft } of skipped) {
            const current = this.tasks.get(skip.taskId);
            if (
              current !== original ||
              !this.skipMatchesTask(skip, current)
            ) {
              continue;
            }
            current.nextRun = draft.nextRun;
            current.enabled = draft.enabled;
          }
          this.notifyTasksChanged();
          return { claimed: accepted };
        });
      } catch (error) {
        logDebug(
          `[CopilotScheduler] Failed to claim due tasks (attempt ${attempt}/${ScheduleManager.RUN_CLAIM_MAX_ATTEMPTS}):`,
          toSafeErrorDetails(error),
        );
      }
    }
    return { claimed: [], failed: true };
  }

  /**
   * Persist the results of executed runs, re-applying them when a conflicting
   * save reloads the store, so lastRun is not rolled back by another window.
   */
  private async persistRunResults(
    results: Map<string, Date>,
    claims: Map<string, TaskRunClaim>,
  ): Promise<void> {
    for (
      let attempt = 1;
      attempt <= ScheduleManager.RUN_CLAIM_MAX_ATTEMPTS;
      attempt++
    ) {
      let applied = 0;
      for (const [taskId, executedAt] of results) {
        const task = this.tasks.get(taskId);
        if (!task) {
          continue;
        }
        const claim = claims.get(taskId);
        if (
          !claim ||
          (claim.runAt
            ? !this.ownsOneTimeClaim(claim, task)
            : !this.ownsRecurringClaim(claim, task))
        ) {
          continue;
        }
        task.lastRun = executedAt;
        if (
          claim.runAt &&
          task.afterRun === "delete" &&
          claim.deleteAfterRun === true
        ) {
          this.tasks.delete(taskId);
        }
        applied++;
      }
      if (applied === 0) {
        return;
      }

      try {
        await this.saveTasks();
        return;
      } catch (error) {
        logDebug(
          `[CopilotScheduler] Failed to persist run results (attempt ${attempt}/${ScheduleManager.RUN_CLAIM_MAX_ATTEMPTS}):`,
          toSafeErrorDetails(error),
        );
        if ([...results.keys()].some((taskId) => !this.tasks.has(taskId))) {
          this.tasks.clear();
          this.loadTasks();
          this.notifyTasksChanged();
        }
      }
    }
  }

  /**
   * Run a claimed occurrence. nextRun is already advanced by the claim,
   * so this only reports when the task actually executed.
   */
  private async executeClaimedTask(
    claim: TaskRunClaim,
    defaultJitterSeconds: number,
  ): Promise<Date | undefined> {
    try {
      const claimedTask = this.tasks.get(claim.taskId);
      if (!claimedTask) {
        return undefined;
      }

      await this.applyJitter(claimedTask.jitterSeconds ?? defaultJitterSeconds);

      try {
        await this.refreshPersistedTasksIfChanged(!!claim.runAt);
      } catch (error) {
        logError(
          "[CopilotScheduler] Could not verify the claimed task; dispatch skipped:",
          toSafeErrorDetails(error),
        );
        return undefined;
      }

      const task = this.tasks.get(claim.taskId);
      if (!task) {
        return undefined;
      }
      if (
        claim.runAt
          ? !this.ownsOneTimeClaim(claim, task)
          : !this.ownsRecurringClaim(claim, task)
      ) {
        return undefined;
      }

      if (
        !isNowWithinAllowedTimeWindow(
          new Date(),
          task.allowedTimeStart,
          task.allowedTimeEnd,
          this.getTimeZone(),
        )
      ) {
        logDebug(
          `[CopilotScheduler] Outside allowed time window after jitter, skipping task: ${task.name}`,
        );
        return undefined;
      }

      if (!this.onExecuteCallback) {
        return undefined;
      }

      const executionTask = { ...task };
      let callbackResult: void | TaskExecutionCallbackResult;
      try {
        callbackResult = await this.onExecuteCallback(
          executionTask,
          "auto",
          this.claimedDispatchGuard(claim, executionTask),
        );
      } catch (error) {
        logError("[CopilotScheduler] Task execution error:", {
          taskId: task.id,
          taskName: task.name,
          error: toSafeErrorDetails(error),
        });
        return undefined;
      }

      const executedAt = new Date();
      this.incrementDailyExecCountInMemory(executedAt);
      this.incrementTaskDailyExecCountInMemory(task.id, executedAt);
      if (claim.runAt) {
        claim.deleteAfterRun =
          executionTask.afterRun === "delete" &&
          callbackResult?.retainOneTimeTask !== true;
      }
      return executedAt;
    } finally {
      this.automaticRunsInFlight--;
      this.finishTaskRun(claim.taskId);
    }
  }

  /**
   * Force run a task immediately
   */
  async runTaskNow(id: string): Promise<boolean> {
    const result = await this.runTaskNowDetailed(id);
    return result.ok;
  }

  async deleteCompletedOneTimeTask(
    taskId: string,
    runAt: string,
    claimId: string,
  ): Promise<boolean> {
    await this.refreshPersistedTasksIfChanged(true);
    const task = this.tasks.get(taskId);
    if (
      !task ||
      task.runAt !== runAt ||
      task.afterRun !== "delete" ||
      task.enabled ||
      !claimId ||
      task.lastFiredClaimId !== claimId ||
      task.lastFiredDueAt?.getTime() !== new Date(runAt).getTime()
    ) {
      return false;
    }
    return this.deleteTask(taskId);
  }

  /**
   * Force run a task immediately and return a classified result.
   */
  async runTaskNowDetailed(
    id: string,
    confirmedTaskSnapshot?: string,
  ): Promise<ManualRunResult> {
    if (!this.tasks.has(id)) {
      return { ok: false, reason: "taskNotFound" };
    }
    if (!this.onExecuteCallback) {
      return { ok: false, reason: "executorUnavailable" };
    }
    if (!this.tryStartTaskRun(id)) {
      return { ok: false, reason: "alreadyRunning" };
    }

    try {
      try {
        await this.refreshPersistedTasksIfChanged(false);
      } catch (error) {
        logError(
          "[CopilotScheduler] Could not verify the task before manual dispatch:",
          toSafeErrorDetails(error),
        );
        return {
          ok: false,
          reason: "claimFailed",
          errorMessage: messages.manualRunClaimFailed(),
        };
      }
      const task = this.tasks.get(id);
      if (!task) return { ok: false, reason: "taskNotFound" };
      if (
        confirmedTaskSnapshot !== undefined &&
        JSON.stringify(task) !== confirmedTaskSnapshot
      ) {
        return { ok: false, reason: "taskChanged" };
      }
      if (task.runAt && (task.lastFiredDueAt || task.lastFiredClaimId)) {
        return { ok: false, reason: "oneTimeCompleted" };
      }
      const previousNextRun =
        task.nextRun instanceof Date && !Number.isNaN(task.nextRun.getTime())
          ? new Date(task.nextRun.getTime())
          : undefined;
      const previousLastRun =
        task.lastRun instanceof Date && !Number.isNaN(task.lastRun.getTime())
          ? new Date(task.lastRun.getTime())
          : undefined;
      const oneTimeRunAt = task.runAt;
      const originalCronExpression = task.cronExpression;
      const originalEnabled = task.enabled;
      let oneTimeClaim: TaskRunClaim | undefined;
      let executingTask = task;
      if (oneTimeRunAt) {
        oneTimeClaim = {
          taskId: task.id,
          claimId: randomUUID(),
          dueAt: new Date(oneTimeRunAt),
          nextRun: undefined,
          runAt: oneTimeRunAt,
          cronExpression: task.cronExpression,
          expectedNextRun: task.nextRun?.getTime(),
          expectedUpdatedAt: task.updatedAt.getTime(),
          expectedEnabled: task.enabled,
        };
        const claimedTaskSnapshot = confirmedTaskSnapshot === undefined
          ? undefined
          : JSON.stringify({
              ...task,
              lastFiredDueAt: oneTimeClaim.dueAt,
              lastFiredClaimId: oneTimeClaim.claimId,
              nextRun: undefined,
              enabled: false,
            });
        const claimed = await this.persistRunClaims([oneTimeClaim]);
        if (!claimed.claimed.includes(oneTimeClaim)) {
          const latest = this.tasks.get(task.id);
          if (!latest) return { ok: false, reason: "taskNotFound" };
          if (
            latest.runAt === oneTimeRunAt &&
            (latest.lastFiredDueAt || latest.lastFiredClaimId)
          ) {
            return { ok: false, reason: "oneTimeCompleted" };
          }
          return {
            ok: false,
            reason: "claimFailed",
            errorMessage: messages.manualRunClaimFailed(),
          };
        }
        try {
          await this.refreshPersistedTasksIfChanged(true);
        } catch (error) {
          logError(
            "[CopilotScheduler] Could not verify the claimed task; dispatch skipped:",
            toSafeErrorDetails(error),
          );
          return {
            ok: false,
            reason: "claimFailed",
            errorMessage: messages.manualRunClaimFailed(),
          };
        }
        const latest = this.tasks.get(task.id);
        if (!latest || !this.ownsOneTimeClaim(oneTimeClaim, latest)) {
          return {
            ok: false,
            reason: "claimFailed",
            errorMessage: messages.manualRunClaimFailed(),
          };
        }
        if (
          claimedTaskSnapshot !== undefined &&
          JSON.stringify(latest) !== claimedTaskSnapshot
        ) {
          return {
            ok: false,
            reason: "taskChanged",
            errorMessage: messages.manualRunChangedAfterClaim(),
          };
        }
        executingTask = latest;
      }

      const executionInfo: ManualRunExecutionInfo = {
        name: executingTask.name,
        runAt: executingTask.runAt,
        afterRun: executingTask.afterRun,
        attachmentCount: executingTask.attachments?.length,
      };
      try {
        await this.onExecuteCallback(
          { ...executingTask },
          "manual",
          oneTimeClaim
            ? this.claimedDispatchGuard(oneTimeClaim, executingTask)
            : undefined,
        );
      } catch (error) {
        const details = toSafeErrorDetails(error);
        if (getPromptBlockedReason(error) === "taskClaimChanged") {
          return {
            ok: false,
            reason: "taskChanged",
            errorMessage: messages.manualRunChangedAfterClaim(),
          };
        }
        if (isPromptBlockedError(error)) {
          logError("[CopilotScheduler] runTaskNow blocked:", details);
          const turnOutcome = getAgentHostTurnFailure(error);
          return {
            ok: false,
            reason: "promptBlocked",
            errorMessage: details,
            executionInfo,
            ...(turnOutcome ? { turnOutcome } : {}),
          };
        }
        const userNotified =
          !!error &&
          typeof error === "object" &&
          (error as Record<string, unknown>)[
            USER_NOTIFIED_EXECUTION_ERROR_FLAG
          ] === true;
        logError("[CopilotScheduler] runTaskNow failed:", details);
        return {
          ok: false,
          reason: "executionFailed",
          errorMessage: details,
          userNotified,
          executionInfo,
        };
      }

      // Update lastRun and nextRun after manual execution
      const executedAt = new Date();
      if (oneTimeClaim) {
        let lastError = "";
        for (
          let attempt = 1;
          attempt <= ScheduleManager.RUN_CLAIM_MAX_ATTEMPTS;
          attempt++
        ) {
          const latest = this.tasks.get(task.id);
          if (!latest || !this.ownsOneTimeClaim(oneTimeClaim, latest)) {
            return { ok: true, claimId: oneTimeClaim.claimId, executionInfo };
          }
          const oldLastRun = latest.lastRun;
          latest.lastRun = executedAt;
          try {
            await this.saveTasks();
            return { ok: true, claimId: oneTimeClaim.claimId, executionInfo };
          } catch (error) {
            if (this.tasks.get(task.id) === latest) {
              latest.lastRun = oldLastRun;
            }
            lastError = toSafeErrorDetails(error);
            logError("[CopilotScheduler] runTaskNow save failed:", lastError);
          }
        }
        return {
          ok: false,
          reason: "saveFailed",
          errorMessage: lastError,
          executionInfo,
        };
      }

      const latest = this.tasks.get(task.id);
      if (
        !latest ||
        latest.runAt !== oneTimeRunAt ||
        latest.cronExpression !== originalCronExpression ||
        latest.enabled !== originalEnabled ||
        latest.nextRun?.getTime() !== previousNextRun?.getTime()
      ) {
        return { ok: true, executionInfo };
      }
      latest.lastRun = executedAt;
      if (latest.enabled) {
        const policy = this.getManualRunNextRunPolicy();
        const shouldAdvanceFromExisting =
          policy === "advance" &&
          previousNextRun &&
          previousNextRun.getTime() >= executedAt.getTime();
        const nextRunBase = shouldAdvanceFromExisting
          ? previousNextRun
          : executedAt;
        latest.nextRun = this.getNextRunForTask(latest.cronExpression, nextRunBase);
      }

      try {
        await this.saveTasks();
      } catch (error) {
        if (this.tasks.get(task.id) === latest) {
          latest.lastRun = previousLastRun
            ? new Date(previousLastRun.getTime())
            : undefined;
          latest.nextRun = previousNextRun
            ? new Date(previousNextRun.getTime())
            : undefined;
        }
        const details = toSafeErrorDetails(error);
        logError("[CopilotScheduler] runTaskNow save failed:", details);
        return {
          ok: false,
          reason: "saveFailed",
          errorMessage: details,
          executionInfo,
        };
      }

      return { ok: true, executionInfo };
    } finally {
      this.finishTaskRun(id);
    }
  }
}
