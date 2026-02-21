/**
 * Copilot Scheduler - Schedule Manager
 * Handles task CRUD operations, cron scheduling, and persistence
 */

import * as vscode from "vscode";
import { parseExpression } from "cron-parser";
import type { ScheduledTask, CreateTaskInput, TaskScope } from "./types";
import { messages } from "./i18n";
import { logDebug, logError } from "./logger";

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
const DAILY_EXEC_COUNT_KEY = "dailyExecCount";
const DAILY_EXEC_DATE_KEY = "dailyExecDate";
const DAILY_LIMIT_NOTIFIED_DATE_KEY = "dailyLimitNotifiedDate";
const DISCLAIMER_ACCEPTED_KEY = "disclaimerAccepted";

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
  private context: vscode.ExtensionContext;
  private onTasksChangedCallback: (() => void) | undefined;
  private onExecuteCallback:
    | ((task: ScheduledTask) => Promise<void>)
    | undefined;
  private dailyExecCount = 0;
  private dailyExecDate = "";
  private dailyLimitNotifiedDate = "";

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.loadDailyExecCount();
    this.dailyLimitNotifiedDate = this.context.globalState.get<string>(
      DAILY_LIMIT_NOTIFIED_DATE_KEY,
      "",
    );
    this.loadTasks();
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
    await this.context.globalState.update(
      DAILY_EXEC_COUNT_KEY,
      this.dailyExecCount,
    );
    await this.context.globalState.update(DAILY_EXEC_DATE_KEY, today);
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

    let needsSave = false;

    for (const task of savedTasks) {
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
          logError(
          "[CopilotScheduler] Failed to save migrated tasks:",
          error,
        ),
      );
    }
  }

  /**
   * Save tasks to globalState
   */
  private async saveTasks(): Promise<void> {
    const tasksArray = Array.from(this.tasks.values());

    const timeoutMs = 10000;
    let timedOut = false;

    const updateThenable = this.context.globalState.update(
      STORAGE_KEY,
      tasksArray,
    );
    const updatePromise = Promise.resolve(updateThenable);
    const guarded = updatePromise.catch((error) => {
      if (timedOut) {
        logError(
          "[CopilotScheduler] Task save failed after timeout:",
          error,
        );
        return;
      }
      throw error;
    });

    const result = await Promise.race([
      guarded.then(() => "ok" as const),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), timeoutMs),
      ),
    ]);

    if (result === "timeout") {
      timedOut = true;
      void updatePromise.catch(() => undefined);
      throw new Error(messages.storageWriteTimeout());
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

    // Calculate next run
    let nextRun: Date | undefined;
    if (input.runFirstInOneMinute) {
      // Run in 1 minute
      nextRun = new Date(now.getTime() + 60 * 1000);
    } else {
      nextRun = this.getNextRun(input.cronExpression, now);
    }

    // Get default scope from configuration
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const defaultScope = config.get<TaskScope>("defaultScope", "workspace");
    const defaultJitter = config.get<number>("jitterSeconds", 600);

    const task: ScheduledTask = {
      id,
      name: input.name,
      cronExpression: input.cronExpression,
      prompt: input.prompt,
      enabled: input.enabled !== false,
      agent: input.agent,
      model: input.model,
      scope: input.scope || defaultScope,
      workspacePath:
        input.scope === "workspace"
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
    let nextRunWasSet = false;

    // Apply updates
    if (updates.name !== undefined) {
      task.name = updates.name;
    }
    if (updates.cronExpression !== undefined) {
      task.cronExpression = updates.cronExpression;
      task.nextRun = this.getNextRun(updates.cronExpression, now);
      nextRunWasSet = true;
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

    // One-time immediate scheduling on update
    if (updates.runFirstInOneMinute) {
      task.nextRun = new Date(now.getTime() + 60 * 1000);
      nextRunWasSet = true;
    }

    // Ensure nextRun exists after updates that didn't set it
    if (!nextRunWasSet && !task.nextRun) {
      task.nextRun = this.getNextRun(task.cronExpression, now);
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

    // Recalculate nextRun if being enabled
    if (task.enabled) {
      task.nextRun = this.getNextRun(task.cronExpression);
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

    // Recalculate nextRun if being enabled
    if (task.enabled) {
      task.nextRun = this.getNextRun(task.cronExpression);
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
   * Check if task should run in current workspace
   */
  shouldTaskRunInCurrentWorkspace(task: ScheduledTask): boolean {
    // Global tasks run in all workspaces
    if (task.scope === "global") {
      return true;
    }

    // Workspace-specific tasks only run in their workspace
    const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!currentWorkspace) {
      return false;
    }

    return task.workspacePath === currentWorkspace;
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
      this.checkAndExecuteTasks();

      // Then run every minute
      this.schedulerInterval = setInterval(() => {
        this.checkAndExecuteTasks();
      }, 60 * 1000);
    }, msToNextMinute);
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
          const config = vscode.workspace.getConfiguration("copilotScheduler");
          const rawMax = config.get<number>("maxDailyExecutions", 24);
          const maxDaily =
            rawMax === 0 ? 0 : Math.min(Math.max(rawMax, 1), 100);
            logDebug(
            `[CopilotScheduler] Daily limit (${maxDaily}) reached, skipping task: ${task.name}`,
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
              messages.dailyLimitReached(maxDaily),
            );
          }
          // Still advance nextRun so it doesn't keep retrying
          task.nextRun = this.getNextRun(task.cronExpression, now);
          await this.saveTasks();
          continue;
        }

        // Safety: Apply jitter (random delay)
        const config = vscode.workspace.getConfiguration("copilotScheduler");
        const maxJitterSeconds =
          task.jitterSeconds ?? config.get<number>("jitterSeconds", 0);
        await this.applyJitter(maxJitterSeconds ?? 0);

        // Execute
        if (this.onExecuteCallback) {
          try {
            await this.onExecuteCallback(task);
            // Track daily execution count
            await this.incrementDailyExecCount();
          } catch (error) {
              logError(`Task execution error: ${error}`);
          }
        }

        // Update lastRun and nextRun
        task.lastRun = now;
        task.nextRun = this.getNextRun(task.cronExpression, now);
        await this.saveTasks();
      }
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
