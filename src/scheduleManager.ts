/**
 * Copilot Scheduler - Schedule Manager
 * Handles task CRUD operations, cron scheduling, and persistence
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { parseExpression } from "cron-parser";
import type { ScheduledTask, CreateTaskInput, TaskScope } from "./types";
import { messages } from "./i18n";
import { logDebug, logError } from "./logger";
import { selectTaskStore } from "./taskStoreSelection";

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
const STORAGE_REVISION_KEY = "scheduledTasksRevision";
const STORAGE_SAVED_AT_KEY = "scheduledTasksSavedAt";
const DAILY_EXEC_COUNT_KEY = "dailyExecCount";
const DAILY_EXEC_DATE_KEY = "dailyExecDate";
const DAILY_LIMIT_NOTIFIED_DATE_KEY = "dailyLimitNotifiedDate";
const DISCLAIMER_ACCEPTED_KEY = "disclaimerAccepted";

type TaskStorageMeta = {
  revision: number;
  savedAt: string; // ISO string
};

function getLocalDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Manages scheduled tasks including CRUD operations, cron parsing, and persistence
 */
export class ScheduleManager {
  private tasks: Map<string, ScheduledTask> = new Map();
  private schedulerInterval: ReturnType<typeof setInterval> | undefined;
  private schedulerTimeout: ReturnType<typeof setTimeout> | undefined;
  private schedulerTickInProgress = false;
  private schedulerTickPending = false;
  private context: vscode.ExtensionContext;
  private storageFilePath: string;
  private storageMetaFilePath: string;
  private onTasksChangedCallback: (() => void) | undefined;
  private onExecuteCallback:
    | ((task: ScheduledTask) => Promise<void>)
    | undefined;
  private dailyExecCount = 0;
  private dailyExecDate = "";
  private dailyLimitNotifiedDate = "";

  private storageRevision = 0;
  private saveQueue: Promise<void> = Promise.resolve();

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
    this.loadDailyExecCount();
    this.dailyLimitNotifiedDate = this.context.globalState.get<string>(
      DAILY_LIMIT_NOTIFIED_DATE_KEY,
      "",
    );
    this.loadTasks();
  }

  private normalizeFsPath(fsPath: string | undefined): string {
    if (!fsPath) return "";
    const normalized = path
      .normalize(path.resolve(fsPath))
      .replace(/[\\/]+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  private loadMetaFromFile(): TaskStorageMeta | undefined {
    try {
      if (!this.storageMetaFilePath) return undefined;
      if (!fs.existsSync(this.storageMetaFilePath)) return undefined;
      const raw = fs.readFileSync(this.storageMetaFilePath, "utf8");
      if (!raw.trim()) return undefined;
      const parsed = JSON.parse(raw) as Partial<TaskStorageMeta>;
      const revision =
        typeof parsed.revision === "number" ? parsed.revision : 0;
      const savedAt = typeof parsed.savedAt === "string" ? parsed.savedAt : "";
      return { revision, savedAt };
    } catch {
      return undefined;
    }
  }

  private loadMetaFromGlobalState(): TaskStorageMeta {
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

  private async saveMetaToFile(meta: TaskStorageMeta): Promise<void> {
    const dir = path.dirname(this.storageMetaFilePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      this.storageMetaFilePath,
      JSON.stringify(meta),
      "utf8",
    );
  }

  private async saveMetaToGlobalState(meta: TaskStorageMeta): Promise<void> {
    await this.context.globalState.update(STORAGE_REVISION_KEY, meta.revision);
    await this.context.globalState.update(STORAGE_SAVED_AT_KEY, meta.savedAt);
  }

  private loadTasksFromFile(): { tasks: ScheduledTask[]; ok: boolean } {
    try {
      if (!this.storageFilePath) return { tasks: [], ok: false };
      if (!fs.existsSync(this.storageFilePath)) return { tasks: [], ok: false };
      const raw = fs.readFileSync(this.storageFilePath, "utf8");
      if (!raw.trim()) return { tasks: [], ok: true };
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { tasks: [], ok: false };
      return { tasks: parsed as ScheduledTask[], ok: true };
    } catch (error) {
      logDebug("[CopilotScheduler] Failed to load tasks from file:", error);
      return { tasks: [], ok: false };
    }
  }

  private async saveTasksToFile(tasksArray: ScheduledTask[]): Promise<void> {
    const dir = path.dirname(this.storageFilePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      this.storageFilePath,
      JSON.stringify(tasksArray),
      "utf8",
    );
  }

  private async saveTasksToGlobalState(
    tasksArray: ScheduledTask[],
  ): Promise<void> {
    const timeoutMs = 10000;

    const updateThenable = this.context.globalState.update(
      STORAGE_KEY,
      tasksArray,
    );
    const updatePromise = Promise.resolve(updateThenable);

    let timerId: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      updatePromise.then(() => "ok" as const),
      new Promise<"timeout">((resolve) => {
        timerId = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);

    if (timerId !== undefined) {
      clearTimeout(timerId);
    }

    if (result === "timeout") {
      void updatePromise.catch(() => undefined);
      throw new Error(messages.storageWriteTimeout());
    }
  }

  // ==================== Safety: Daily Execution Limit ====================

  /**
   * Load daily execution count from globalState
   */
  private loadDailyExecCount(): void {
    const today = getLocalDateKey();
    const savedDate = this.context.globalState.get<string>(
      DAILY_EXEC_DATE_KEY,
      "",
    );
    if (savedDate === today) {
      this.dailyExecCount = this.context.globalState.get<number>(
        DAILY_EXEC_COUNT_KEY,
        0,
      );
    } else {
      // New day, reset counter
      this.dailyExecCount = 0;
      this.dailyExecDate = today;
      void this.context.globalState
        .update(DAILY_EXEC_COUNT_KEY, 0)
        .then(undefined, (error: unknown) =>
          logError(
            "[CopilotScheduler] Failed to reset daily execution count:",
            error,
          ),
        );
      void this.context.globalState
        .update(DAILY_EXEC_DATE_KEY, today)
        .then(undefined, (error: unknown) =>
          logError(
            "[CopilotScheduler] Failed to reset daily execution date:",
            error,
          ),
        );
    }
    this.dailyExecDate = today;
  }

  private incrementDailyExecCountInMemory(date = new Date()): void {
    const today = getLocalDateKey(date);
    if (this.dailyExecDate !== today) {
      this.dailyExecCount = 0;
      this.dailyExecDate = today;
    }
    this.dailyExecCount++;
  }

  private async persistDailyExecCount(): Promise<void> {
    const today = this.dailyExecDate || getLocalDateKey();
    await this.context.globalState.update(
      DAILY_EXEC_COUNT_KEY,
      this.dailyExecCount,
    );
    await this.context.globalState.update(DAILY_EXEC_DATE_KEY, today);
  }

  /**
   * Increment daily execution count
   */
  private async incrementDailyExecCount(): Promise<void> {
    const today = getLocalDateKey();
    if (this.dailyExecDate !== today) {
      this.dailyExecCount = 0;
      this.dailyExecDate = today;
    }
    this.dailyExecCount++;
    await this.persistDailyExecCount();
  }

  /**
   * Bulk update task prompts (used by template sync) and save once.
   */
  async updateTaskPrompts(
    updates: Array<{ id: string; prompt: string }>,
  ): Promise<number> {
    if (!Array.isArray(updates) || updates.length === 0) {
      return 0;
    }

    const now = new Date();
    let changed = 0;

    for (const item of updates) {
      if (!item || typeof item.id !== "string") continue;
      const nextPrompt = typeof item.prompt === "string" ? item.prompt : "";
      if (!nextPrompt.trim()) continue;

      const task = this.tasks.get(item.id);
      if (!task) continue;
      if (task.prompt === nextPrompt) continue;
      task.prompt = nextPrompt;
      task.updatedAt = now;
      changed++;
    }

    if (changed > 0) {
      await this.saveTasks();
    }

    return changed;
  }

  /**
   * Check if daily execution limit has been reached
   */
  private isDailyLimitReached(): boolean {
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const rawMax = config.get<number>("maxDailyExecutions", 24);
    // 0 = unlimited (no daily limit, use at your own risk)
    if (rawMax === 0) {
      return false;
    }
    const maxDaily = Math.min(Math.max(rawMax, 1), 100); // enforce 1–100
    const today = getLocalDateKey();
    if (this.dailyExecDate !== today) {
      this.dailyExecCount = 0;
      this.dailyExecDate = today;
    }
    return this.dailyExecCount >= maxDaily;
  }

  /**
   * Get current daily execution count and limit
   */
  getDailyExecInfo(): { count: number; limit: number } {
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const rawMax = config.get<number>("maxDailyExecutions", 24);
    // 0 = unlimited
    const maxDaily = rawMax === 0 ? 0 : Math.min(Math.max(rawMax, 1), 100); // enforce 0 or 1–100
    return { count: this.dailyExecCount, limit: maxDaily };
  }

  // ==================== Safety: Jitter (Random Delay) ====================

  /**
   * Apply random jitter delay to reduce machine-like patterns
   */
  private async applyJitter(maxJitterSeconds: number): Promise<void> {
    if (maxJitterSeconds <= 0) return;

    const jitterMs = Math.floor(Math.random() * maxJitterSeconds * 1000);
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
    try {
      const options: { currentDate: Date; tz?: string } = {
        currentDate: new Date(),
      };
      const tz = this.getTimeZone();
      if (tz) options.tz = tz;

      const interval = parseExpression(cronExpression, options);
      const first = interval.next().toDate();
      const second = interval.next().toDate();
      const diffMinutes = (second.getTime() - first.getTime()) / (1000 * 60);

      if (diffMinutes < 30) {
        return messages.minimumIntervalWarning();
      }
    } catch {
      // If parsing fails, skip interval check
    }
    return undefined;
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
    this.onTasksChangedCallback = callback;
  }

  /**
   * Notify that tasks have changed
   */
  private notifyTasksChanged(): void {
    if (this.onTasksChangedCallback) {
      this.onTasksChangedCallback();
    }
  }

  /**
   * Load tasks from globalState
   */
  private loadTasks(): void {
    const savedTasks = this.context.globalState.get<ScheduledTask[]>(
      STORAGE_KEY,
      [],
    );
    const fileLoad = this.loadTasksFromFile();
    const fileTasks = fileLoad.tasks;

    const globalMeta = this.loadMetaFromGlobalState();
    const fileMeta = this.loadMetaFromFile() || { revision: 0, savedAt: "" };

    const globalStoreExists =
      (Array.isArray(savedTasks) && savedTasks.length > 0) ||
      (typeof globalMeta.revision === "number" && globalMeta.revision > 0);

    const fileStoreExists =
      fileLoad.ok ||
      fs.existsSync(this.storageMetaFilePath) ||
      (typeof fileMeta.revision === "number" && fileMeta.revision > 0);

    const selection = selectTaskStore<ScheduledTask>(
      {
        kind: "globalState",
        exists: globalStoreExists,
        ok: true,
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

    let needsSave = false;

    for (const task of tasksToLoad) {
      // Restore Date objects from JSON serialization
      task.createdAt = new Date(task.createdAt);
      task.updatedAt = new Date(task.updatedAt);
      if (task.lastRun) {
        task.lastRun = new Date(task.lastRun);
      }
      if (task.nextRun) {
        task.nextRun = new Date(task.nextRun);
      }

      // Migration: add missing fields for older tasks
      if (!task.scope) {
        task.scope = "global";
      }
      if (!task.promptSource) {
        task.promptSource = "inline";
      }

      // Migration: add jitterSeconds if missing
      if (task.jitterSeconds === undefined) {
        task.jitterSeconds = 0;
      }

      // Recalculate nextRun for enabled tasks (always use current time)
      if (task.enabled) {
        const newNextRun = this.getNextRun(task.cronExpression);
        if (
          newNextRun &&
          (!task.nextRun || task.nextRun.getTime() !== newNextRun.getTime())
        ) {
          task.nextRun = newNextRun;
          needsSave = true;
        }
      } else {
        if (task.nextRun !== undefined) {
          task.nextRun = undefined;
          needsSave = true;
        }
      }

      this.tasks.set(task.id, task);
    }

    // Save if any changes were made
    if (needsSave) {
      void this.saveTasks().catch((error) =>
        logError("[CopilotScheduler] Failed to save migrated tasks:", error),
      );
    } else {
      // Heal the other store if needed (best effort, do not bump revision)
      if (selection.shouldHealFile || selection.shouldHealGlobalState) {
        void this.saveTasks({ bumpRevision: false }).catch((error) =>
          logDebug("[CopilotScheduler] Failed to sync task stores:", error),
        );
      }
    }
  }

  /**
   * Save tasks to globalState
   */
  private async saveTasks(options?: { bumpRevision?: boolean }): Promise<void> {
    // Serialize saves to avoid last-write-wins races across concurrent callers.
    this.saveQueue = this.saveQueue.then(() => this.saveTasksInternal(options));
    return this.saveQueue;
  }

  private async saveTasksInternal(options?: {
    bumpRevision?: boolean;
  }): Promise<void> {
    const bumpRevision = options?.bumpRevision !== false;
    const tasksArray = Array.from(this.tasks.values());

    const nextRevision = bumpRevision
      ? this.storageRevision + 1
      : this.storageRevision;
    const meta: TaskStorageMeta = {
      revision: nextRevision,
      savedAt: new Date().toISOString(),
    };

    // Prefer file persistence for responsiveness and reliability.
    // If file save succeeds, return immediately and sync globalState in background.
    try {
      await this.saveTasksToFile(tasksArray);
      await this.saveMetaToFile(meta);
      this.storageRevision = meta.revision;

      void Promise.all([
        this.saveTasksToGlobalState(tasksArray),
        this.saveMetaToGlobalState(meta),
      ]).catch((error) =>
        logDebug(
          "[CopilotScheduler] Task save to globalState failed (file succeeded):",
          error,
        ),
      );

      this.notifyTasksChanged();
      return;
    } catch (fileError) {
      // If file persistence fails, fall back to globalState (await so at least one store succeeds).
      try {
        await this.saveTasksToGlobalState(tasksArray);
        await this.saveMetaToGlobalState(meta);
        this.storageRevision = meta.revision;
      } catch (globalStateError) {
        throw globalStateError instanceof Error
          ? globalStateError
          : new Error(String(globalStateError ?? ""));
      }

      // Best-effort background file sync for future reliability.
      void Promise.all([
        this.saveTasksToFile(tasksArray),
        this.saveMetaToFile(meta),
      ]).catch((error) =>
        logDebug(
          "[CopilotScheduler] Task save to file failed (globalState succeeded):",
          { fileError, error },
        ),
      );
    }

    this.notifyTasksChanged();
  }

  /**
   * Generate unique task ID
   */
  private generateId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `task_${timestamp}_${random}`;
  }

  /**
   * Get timezone from configuration
   */
  private getTimeZone(): string | undefined {
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const tz = config.get<string>("timezone", "");
    return tz || undefined;
  }

  /**
   * Calculate next run time from cron expression
   */
  private getNextRun(
    cronExpression: string,
    baseTime?: Date,
  ): Date | undefined {
    try {
      const options: {
        currentDate: Date;
        tz?: string;
      } = {
        currentDate: baseTime || new Date(),
      };

      const tz = this.getTimeZone();
      if (tz) {
        options.tz = tz;
      }

      const interval = parseExpression(cronExpression, options);
      return interval.next().toDate();
    } catch {
      return undefined;
    }
  }

  /**
   * Validate cron expression
   * @throws Error if invalid
   */
  validateCronExpression(expression: string): boolean {
    if (!expression || !expression.trim()) {
      throw new Error(messages.invalidCronExpression());
    }

    try {
      const options: {
        currentDate: Date;
        tz?: string;
      } = {
        currentDate: new Date(),
      };

      const tz = this.getTimeZone();
      if (tz) {
        options.tz = tz;
      }

      parseExpression(expression, options);
      return true;
    } catch {
      throw new Error(messages.invalidCronExpression());
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

    // Validate cron expression
    this.validateCronExpression(input.cronExpression);

    const now = new Date();
    const id = this.generateId();

    // Get defaults from configuration
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const defaultScope = config.get<TaskScope>("defaultScope", "workspace");
    const defaultJitter = config.get<number>("jitterSeconds", 600);

    const enabled = input.enabled !== false;
    const effectiveScope = input.scope || defaultScope;

    // Calculate next run (disabled tasks must not keep nextRun)
    let nextRun: Date | undefined;
    if (enabled) {
      if (input.runFirstInOneMinute) {
        nextRun = new Date(now.getTime() + 60 * 1000);
      } else {
        nextRun = this.getNextRun(input.cronExpression, now);
      }
    }

    const task: ScheduledTask = {
      id,
      name: input.name,
      cronExpression: input.cronExpression,
      prompt: input.prompt,
      enabled,
      agent: input.agent,
      model: input.model,
      scope: effectiveScope,
      workspacePath:
        effectiveScope === "workspace"
          ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          : undefined,
      promptSource: input.promptSource || "inline",
      promptPath: input.promptPath,
      jitterSeconds:
        input.jitterSeconds !== undefined
          ? input.jitterSeconds
          : defaultJitter > 0
            ? defaultJitter
            : 0,
      nextRun,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(id, task);
    await this.saveTasks();

    return task;
  }

  /**
   * Get a task by ID
   */
  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
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

    // Validate cron expression if being updated (including empty string)
    if (updates.cronExpression !== undefined) {
      this.validateCronExpression(updates.cronExpression);
    }

    const now = new Date();
    const enabledBefore = task.enabled;
    let cronChanged = false;

    // Apply updates
    if (updates.name !== undefined) {
      task.name = updates.name;
    }
    if (updates.cronExpression !== undefined) {
      task.cronExpression = updates.cronExpression;
      cronChanged = true;
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
    if (updates.model !== undefined) {
      task.model = updates.model;
    }
    if (updates.scope !== undefined) {
      const nextScope = updates.scope;

      // Only adjust workspacePath when scope actually changes (or workspacePath is missing).
      // Webview submits scope on every save; we must not overwrite workspacePath on edits.
      if (nextScope !== task.scope) {
        task.scope = nextScope;
        if (nextScope === "workspace") {
          task.workspacePath =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        } else {
          task.workspacePath = undefined;
        }
      } else if (nextScope === "workspace" && !task.workspacePath) {
        task.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      }
    }
    if (updates.promptSource !== undefined) {
      task.promptSource = updates.promptSource;
    }
    if (updates.promptPath !== undefined) {
      task.promptPath = updates.promptPath;
    }
    if (updates.jitterSeconds !== undefined) {
      task.jitterSeconds = updates.jitterSeconds;
    }

    const enabledAfter = task.enabled;

    // Keep nextRun consistent with enabled state
    if (!enabledAfter) {
      task.nextRun = undefined;
    } else {
      // One-time immediate scheduling on update (only for enabled tasks)
      if (updates.runFirstInOneMinute) {
        task.nextRun = new Date(now.getTime() + 60 * 1000);
      } else if (cronChanged || (!enabledBefore && enabledAfter)) {
        task.nextRun = this.getNextRun(task.cronExpression, now);
      } else if (!task.nextRun) {
        // Ensure nextRun exists for enabled tasks
        task.nextRun = this.getNextRun(task.cronExpression, now);
      }
    }

    task.updatedAt = now;

    await this.saveTasks();

    return task;
  }

  /**
   * Delete a task
   */
  async deleteTask(id: string): Promise<boolean> {
    const deleted = this.tasks.delete(id);
    if (deleted) {
      await this.saveTasks();
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

    task.enabled = !task.enabled;
    task.updatedAt = new Date();

    // Keep nextRun consistent with enabled state
    if (task.enabled) {
      task.nextRun = this.getNextRun(task.cronExpression, new Date());
    } else {
      task.nextRun = undefined;
    }

    await this.saveTasks();

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

    task.enabled = enabled;
    task.updatedAt = new Date();

    // Keep nextRun consistent with enabled state
    if (task.enabled) {
      task.nextRun = this.getNextRun(task.cronExpression, new Date());
    } else {
      task.nextRun = undefined;
    }

    await this.saveTasks();

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
      name: `${original.name} (Copy)`,
      cronExpression: original.cronExpression,
      prompt: original.prompt,
      enabled: false, // Start disabled
      agent: original.agent,
      model: original.model,
      scope: original.scope,
      promptSource: original.promptSource,
      promptPath: original.promptPath,
    };

    return this.createTask(input);
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

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error(messages.noWorkspaceOpen());
    }

    task.workspacePath = workspaceRoot;
    task.updatedAt = new Date();
    await this.saveTasks();
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

    const a = this.normalizeFsPath(task.workspacePath);
    if (a === "") return false;
    return workspacePaths.some((p) => this.normalizeFsPath(p) === a);
  }

  /**
   * Start the scheduler
   */
  startScheduler(onExecute: (task: ScheduledTask) => Promise<void>): void {
    this.onExecuteCallback = onExecute;

    // Stop existing scheduler if running
    this.stopScheduler();

    // Align to next minute boundary
    const now = new Date();
    const msToNextMinute =
      (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

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
      logError("[CopilotScheduler] Scheduler tick failed:", error);
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
  private async checkAndExecuteTasks(): Promise<void> {
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const enabled = config.get<boolean>("enabled", true);

    if (!enabled) {
      return;
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
    const maxDailyLimit =
      rawMaxDaily === 0 ? 0 : Math.min(Math.max(rawMaxDaily, 1), 100);
    const defaultJitterSeconds = config.get<number>("jitterSeconds", 0);

    let needsSave = false;
    let executedCount = 0;

    for (const task of this.tasks.values()) {
      if (!task.enabled || !task.nextRun) {
        continue;
      }

      // Check if task should run in current workspace
      if (!this.shouldTaskRunInCurrentWorkspace(task)) {
        continue;
      }

      // Truncate nextRun to minute
      const nextRunMinute = new Date(
        task.nextRun.getFullYear(),
        task.nextRun.getMonth(),
        task.nextRun.getDate(),
        task.nextRun.getHours(),
        task.nextRun.getMinutes(),
      );

      // Check if due
      if (nextRunMinute.getTime() <= nowMinute.getTime()) {
        // Safety: Check daily execution limit
        if (this.isDailyLimitReached()) {
          logDebug(
            `[CopilotScheduler] Daily limit (${maxDailyLimit}) reached, skipping task: ${task.name}`,
          );
          const todayKey = getLocalDateKey();
          if (this.dailyLimitNotifiedDate !== todayKey) {
            this.dailyLimitNotifiedDate = todayKey;
            void this.context.globalState
              .update(DAILY_LIMIT_NOTIFIED_DATE_KEY, todayKey)
              .then(undefined, (error: unknown) =>
                logError(
                  "[CopilotScheduler] Failed to persist daily limit notified date:",
                  error,
                ),
              );
            void vscode.window.showInformationMessage(
              messages.dailyLimitReached(maxDailyLimit),
            );
          }
          // Still advance nextRun so it doesn't keep retrying
          task.nextRun = this.getNextRun(task.cronExpression, now);
          needsSave = true;
          continue;
        }

        // Safety: Apply jitter (random delay)
        const maxJitterSeconds = task.jitterSeconds ?? defaultJitterSeconds;
        await this.applyJitter(maxJitterSeconds ?? 0);

        // Execute
        if (this.onExecuteCallback) {
          try {
            await this.onExecuteCallback(task);
            // Track daily execution count
            this.incrementDailyExecCountInMemory(new Date());
            executedCount++;
          } catch (error) {
            const details =
              error instanceof Error
                ? error.stack || error.message
                : String(error ?? "");
            logError("[CopilotScheduler] Task execution error:", {
              taskId: task.id,
              taskName: task.name,
              error: details,
            });
          }
        }

        // Update lastRun and nextRun
        const executedAt = new Date();
        task.lastRun = executedAt;
        task.nextRun = this.getNextRun(task.cronExpression, executedAt);
        needsSave = true;
      }
    }

    // Persist once per tick to reduce I/O overhead.
    if (executedCount > 0) {
      try {
        await this.persistDailyExecCount();
      } catch (error) {
        logError(
          "[CopilotScheduler] Failed to persist daily execution count:",
          error,
        );
      }
    }

    if (needsSave) {
      await this.saveTasks();
    }
  }

  /**
   * Force run a task immediately
   */
  async runTaskNow(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task || !this.onExecuteCallback) {
      return false;
    }

    try {
      await this.onExecuteCallback(task);

      // Update lastRun
      task.lastRun = new Date();
      await this.saveTasks();

      return true;
    } catch {
      return false;
    }
  }
}
