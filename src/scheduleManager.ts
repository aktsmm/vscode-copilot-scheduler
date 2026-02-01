/**
 * Copilot Scheduler - Schedule Manager
 * Handles task CRUD operations, cron scheduling, and persistence
 */

import * as vscode from "vscode";
import { parseExpression } from "cron-parser";
import type { ScheduledTask, CreateTaskInput, TaskScope } from "./types";
import { messages } from "./i18n";

// Node.js globals
declare const setTimeout: (callback: () => void, ms: number) => NodeJS.Timeout;
declare const setInterval: (callback: () => void, ms: number) => NodeJS.Timeout;
declare const clearInterval: (intervalId: NodeJS.Timeout) => void;
declare const console: {
  error: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
};

const STORAGE_KEY = "scheduledTasks";

/**
 * Manages scheduled tasks including CRUD operations, cron parsing, and persistence
 */
export class ScheduleManager {
  private tasks: Map<string, ScheduledTask> = new Map();
  private schedulerInterval: ReturnType<typeof setInterval> | undefined;
  private context: vscode.ExtensionContext;
  private onTasksChangedCallback: (() => void) | undefined;
  private onExecuteCallback:
    | ((task: ScheduledTask) => Promise<void>)
    | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.loadTasks();
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

      // Recalculate nextRun
      task.nextRun = this.getNextRun(task.cronExpression);

      this.tasks.set(task.id, task);
    }
  }

  /**
   * Save tasks to globalState
   */
  private async saveTasks(): Promise<void> {
    const tasksArray = Array.from(this.tasks.values());
    await this.context.globalState.update(STORAGE_KEY, tasksArray);
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
    const config = vscode.workspace.getConfiguration("promptPilot");
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
    const config = vscode.workspace.getConfiguration("promptPilot");
    const defaultScope = config.get<TaskScope>("defaultScope", "workspace");

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

    // Validate cron expression if being updated
    if (updates.cronExpression) {
      this.validateCronExpression(updates.cronExpression);
    }

    const now = new Date();

    // Apply updates
    if (updates.name !== undefined) {
      task.name = updates.name;
    }
    if (updates.cronExpression !== undefined) {
      task.cronExpression = updates.cronExpression;
      task.nextRun = this.getNextRun(updates.cronExpression, now);
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
      task.scope = updates.scope;
      if (updates.scope === "workspace") {
        task.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      } else {
        task.workspacePath = undefined;
      }
    }
    if (updates.promptSource !== undefined) {
      task.promptSource = updates.promptSource;
    }
    if (updates.promptPath !== undefined) {
      task.promptPath = updates.promptPath;
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
    setTimeout(() => {
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
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = undefined;
    }
  }

  /**
   * Check and execute tasks that are due
   */
  private async checkAndExecuteTasks(): Promise<void> {
    const config = vscode.workspace.getConfiguration("promptPilot");
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
        // Execute
        if (this.onExecuteCallback) {
          try {
            await this.onExecuteCallback(task);
          } catch (error) {
            console.error(`Task execution error: ${error}`);
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

