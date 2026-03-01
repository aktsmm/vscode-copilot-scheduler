/**
 * Copilot Scheduler - Extension Entry Point
 * Registers commands, initializes components, and starts the scheduler
 */

import * as vscode from "vscode";
import * as path from "path";
import { parseExpression } from "cron-parser";
import { ScheduleManager } from "./scheduleManager";
import { CopilotExecutor } from "./copilotExecutor";
import { ScheduledTaskTreeProvider, ScheduledTaskItem } from "./treeProvider";
import { SchedulerWebview } from "./schedulerWebview";
import { messages } from "./i18n";
import { logDebug, logError } from "./logger";
import { sanitizeAbsolutePathDetails } from "./errorSanitizer";
import {
  normalizeForCompare,
  resolveGlobalPromptPath,
  resolveLocalPromptPath,
  resolveGlobalPromptsRoot,
} from "./promptResolver";
import type {
  ScheduledTask,
  CreateTaskInput,
  TaskAction,
  PromptSource,
} from "./types";

type NotificationMode = "sound" | "silentToast" | "silentStatus";
type ExecutionTrigger = "auto" | "manual";
type ExecutionHistoryStatus = "success" | "failed";

type ExecutionHistoryEntry = {
  taskId: string;
  taskName: string;
  trigger: ExecutionTrigger;
  status: ExecutionHistoryStatus;
  executedAt: string;
  nextRunAt?: string;
  detail?: string;
};

const PROMPT_SYNC_DATE_KEY = "promptSyncDate";
const LAST_VERSION_KEY = "lastKnownVersion";
const EXECUTION_HISTORY_KEY = "executionHistory";
const EXECUTION_HISTORY_DEFAULT_LIMIT = 50;

function sanitizeErrorDetailsForLog(message: string): string {
  const sanitized = sanitizeAbsolutePathDetails(
    message,
    messages.redactedPlaceholder(),
  );
  return sanitized.trim() ? sanitized : messages.webviewUnknown();
}

function shouldNotify(): boolean {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  return config.get<boolean>("showNotifications", true);
}

function getNotificationMode(): NotificationMode {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const mode = config.get<NotificationMode>("notificationMode", "sound");
  // Legacy: if notifications were disabled, honor that as silentStatus
  if (config.get<boolean>("showNotifications", true) === false) {
    return "silentStatus";
  }
  return mode || "sound";
}

function resolveDisplayErrorMessage(message: string): string {
  const safeMessage = sanitizeErrorDetailsForLog(message);
  return resolveDisplayErrorMessageFromSanitized(safeMessage);
}

function resolveDisplayErrorMessageFromSanitized(safeMessage: string): string {
  const firstLine = safeMessage.split(/\r?\n/)[0] ?? "";
  return firstLine.trim() ? firstLine : messages.webviewUnknown();
}

async function maybeWarnCronInterval(cronExpression?: string): Promise<void> {
  if (!cronExpression) return;
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const enabled = config.get<boolean>("minimumIntervalWarning", true);
  if (!enabled) return;
  const warning = scheduleManager.checkMinimumInterval(cronExpression);
  if (warning) {
    // Non-blocking warning: do not stall create/update until the user dismisses
    void vscode.window.showInformationMessage(warning);
  }
}

async function maybeShowDisclaimerOnce(task: ScheduledTask): Promise<boolean> {
  if (!task.enabled) return true;
  if (scheduleManager.isDisclaimerAccepted()) return true;
  const choice = await vscode.window.showInformationMessage(
    messages.disclaimerMessage(),
    messages.disclaimerAccept(),
    messages.disclaimerDecline(),
  );
  if (choice !== messages.disclaimerAccept()) {
    return false;
  }
  await scheduleManager.setDisclaimerAccepted(true);
  return true;
}

async function ensureTaskEnabledAfterDisclaimer(
  task: ScheduledTask,
): Promise<boolean> {
  if (!task.enabled) return true;
  const accepted = await maybeShowDisclaimerOnce(task);
  if (accepted) {
    return true;
  }

  const disabled = await scheduleManager.setTaskEnabled(task.id, false);
  if (disabled) {
    SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
    notifyInfo(messages.disclaimerDeclinedTaskDisabled(task.name));
    return false;
  }
  notifyError(messages.taskNotFound());
  return false;
}

async function syncPromptTemplatesIfNeeded(
  context: vscode.ExtensionContext,
  force = false,
): Promise<void> {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (!force) {
    const last = context.globalState.get<string>(PROMPT_SYNC_DATE_KEY, "");
    if (last === todayKey) {
      return;
    }
  }

  const tasks = scheduleManager.getAllTasks();
  const promptUpdates: Array<{ id: string; prompt: string }> = [];

  for (const task of tasks) {
    if (task.promptSource === "inline") continue;
    if (!task.promptPath) continue;
    try {
      // Background sync should only read persisted file contents.
      const latest = await resolvePromptText(task, false);
      if (latest && latest !== task.prompt) {
        // Avoid syncing empty prompts (would break validation and UX)
        if (latest.trim()) {
          promptUpdates.push({ id: task.id, prompt: latest });
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error ?? "");
      logError(
        `[CopilotScheduler] Prompt sync failed for task "${task.name}": ${sanitizeErrorDetailsForLog(errorMessage)}`,
      );
    }
  }

  const updated =
    promptUpdates.length > 0
      ? (await scheduleManager.updateTaskPrompts(promptUpdates)) > 0
      : false;

  if (updated) {
    // updateTaskPrompts -> saveTasks -> notifyTasksChanged callback already
    // refreshes both TreeView and Webview. Avoid duplicate task-list pushes.
  }

  await context.globalState.update(PROMPT_SYNC_DATE_KEY, todayKey);
}

export function notifyInfo(message: string, timeoutMs = 4000): void {
  if (!shouldNotify()) return;
  const mode = getNotificationMode();
  switch (mode) {
    case "silentStatus":
      vscode.window.setStatusBarMessage(message, timeoutMs);
      break;
    case "silentToast":
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: message },
        () => new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      );
      break;
    default:
      void vscode.window.showInformationMessage(message);
  }
}

export function notifyError(message: string, timeoutMs = 6000): void {
  const safeMessage = sanitizeErrorDetailsForLog(message);
  const displayMessage = resolveDisplayErrorMessageFromSanitized(safeMessage);
  const mode = getNotificationMode();
  logError(safeMessage);
  if (mode === "silentStatus") {
    vscode.window.setStatusBarMessage(`⚠ ${displayMessage}`, timeoutMs);
    return;
  }
  if (mode === "silentToast") {
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `⚠ ${displayMessage}`,
      },
      () => new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    );
    return;
  }
  void vscode.window.showErrorMessage(displayMessage);
}

function getExecutionHistoryLimit(): number {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const raw = config.get<number>(
    "executionHistoryLimit",
    EXECUTION_HISTORY_DEFAULT_LIMIT,
  );
  const n = Number.isFinite(raw)
    ? Math.floor(raw)
    : EXECUTION_HISTORY_DEFAULT_LIMIT;
  return Math.min(Math.max(n, 10), 500);
}

function getNotificationNextRun(
  task: ScheduledTask,
  baseTime = new Date(),
): Date | undefined {
  const tz = vscode.workspace
    .getConfiguration("copilotScheduler")
    .get<string>("timezone", "");
  const currentDate = baseTime;
  try {
    const options: { currentDate: Date; tz?: string } = { currentDate };
    if (tz) {
      options.tz = tz;
    }
    const interval = parseExpression(task.cronExpression, options);
    return interval.next().toDate();
  } catch {
    if (tz) {
      try {
        const interval = parseExpression(task.cronExpression, { currentDate });
        return interval.next().toDate();
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function formatNextRunText(date?: Date): string {
  if (!date || Number.isNaN(date.getTime())) {
    return messages.labelNever();
  }
  return messages.formatDateTime(date);
}

function buildExecutionSummary(
  taskName: string,
  status: ExecutionHistoryStatus,
  nextRunDate?: Date,
): string {
  const resultLabel =
    status === "success"
      ? messages.executionResultSuccess()
      : messages.executionResultFailed();
  return messages.taskExecutionSummary(
    taskName,
    resultLabel,
    formatNextRunText(nextRunDate),
  );
}

async function appendExecutionHistory(
  entry: ExecutionHistoryEntry,
): Promise<void> {
  if (!extensionContextRef) {
    return;
  }
  const limit = getExecutionHistoryLimit();
  const current = extensionContextRef.globalState.get<unknown[]>(
    EXECUTION_HISTORY_KEY,
    [],
  );
  const safeCurrent = Array.isArray(current)
    ? current.filter(
        (item): item is ExecutionHistoryEntry =>
          !!item &&
          typeof item === "object" &&
          typeof (item as ExecutionHistoryEntry).taskId === "string" &&
          typeof (item as ExecutionHistoryEntry).taskName === "string" &&
          typeof (item as ExecutionHistoryEntry).status === "string" &&
          typeof (item as ExecutionHistoryEntry).executedAt === "string",
      )
    : [];

  const next = [entry, ...safeCurrent].slice(0, limit);
  await extensionContextRef.globalState.update(EXECUTION_HISTORY_KEY, next);
}

function enqueueExecutionHistory(entry: ExecutionHistoryEntry): Promise<void> {
  const op = executionHistorySaveQueue.then(() =>
    appendExecutionHistory(entry),
  );
  executionHistorySaveQueue = op.catch((error) => {
    const errorMessage =
      error instanceof Error ? error.message : String(error ?? "");
    logError(
      "[CopilotScheduler] Failed to persist execution history:",
      sanitizeErrorDetailsForLog(errorMessage),
    );
  });
  return executionHistorySaveQueue;
}

function getExecutionHistoryEntries(): ExecutionHistoryEntry[] {
  if (!extensionContextRef) {
    return [];
  }
  const current = extensionContextRef.globalState.get<unknown[]>(
    EXECUTION_HISTORY_KEY,
    [],
  );
  if (!Array.isArray(current)) {
    return [];
  }
  return current.filter(
    (item): item is ExecutionHistoryEntry =>
      !!item &&
      typeof item === "object" &&
      typeof (item as ExecutionHistoryEntry).taskId === "string" &&
      typeof (item as ExecutionHistoryEntry).taskName === "string" &&
      typeof (item as ExecutionHistoryEntry).status === "string" &&
      typeof (item as ExecutionHistoryEntry).executedAt === "string",
  );
}

async function showExecutionHistoryView(): Promise<void> {
  const history = getExecutionHistoryEntries();
  if (history.length === 0) {
    notifyInfo(messages.executionHistoryEmpty());
    return;
  }

  const picks = history.map((entry) => {
    const icon = entry.status === "success" ? "✅" : "❌";
    const statusLabel =
      entry.status === "success"
        ? messages.executionResultSuccess()
        : messages.executionResultFailed();
    const triggerLabel =
      entry.trigger === "manual"
        ? messages.executionTriggerManual()
        : messages.executionTriggerAuto();
    const executedAt = new Date(entry.executedAt);
    const nextRun = entry.nextRunAt ? new Date(entry.nextRunAt) : undefined;
    const description = `${messages.formatDateTime(executedAt)} · ${triggerLabel} · ${statusLabel} · ${messages.labelNextRun()}: ${formatNextRunText(nextRun)}`;
    return {
      label: `${icon} ${entry.taskName}`,
      description,
      detail: entry.detail || "",
    };
  });

  await vscode.window.showQuickPick(picks, {
    placeHolder: messages.executionHistoryPickPlaceholder(),
    matchOnDescription: true,
    matchOnDetail: true,
  });
}

// Global instances
let scheduleManager: ScheduleManager;
let copilotExecutor: CopilotExecutor;
let treeProvider: ScheduledTaskTreeProvider;
let promptSyncInterval: ReturnType<typeof setInterval> | undefined;
let extensionContextRef: vscode.ExtensionContext | undefined;
const manualRunInFlightTaskIds = new Set<string>();
let executionHistorySaveQueue: Promise<void> = Promise.resolve();

type PromptExecutionPayload = {
  prompt: string;
  agent?: string;
  model?: string;
};

type ManualRunFailureResult = {
  ok: false;
  reason:
    | "taskNotFound"
    | "executorUnavailable"
    | "executionFailed"
    | "saveFailed";
  errorMessage?: string;
  userNotified?: boolean;
};

const USER_NOTIFIED_EXECUTION_ERROR_FLAG = "copilotSchedulerUserNotified";

function markExecutionErrorAsUserNotified(error: unknown): void {
  if (!error || typeof error !== "object") {
    return;
  }

  try {
    (error as Record<string, unknown>)[USER_NOTIFIED_EXECUTION_ERROR_FLAG] =
      true;
  } catch {
    // best-effort marker only
  }
}

function handleManualRunFailure(
  taskName: string,
  runResult: ManualRunFailureResult,
  options?: { showWebviewError?: boolean },
): void {
  const showWebviewError = options?.showWebviewError === true;

  if (runResult.reason === "executionFailed") {
    if (runResult.userNotified) {
      return;
    }
    const msg = messages.taskExecutionFailed(
      taskName,
      runResult.errorMessage || messages.webviewUnknown(),
    );
    notifyError(msg);
    if (showWebviewError) {
      SchedulerWebview.showError(msg);
    }
    return;
  }

  if (runResult.reason === "saveFailed") {
    const msg = messages.manualRunSaveFailed(
      taskName,
      runResult.errorMessage || messages.webviewUnknown(),
    );
    if (getNotificationMode() !== "silentStatus") {
      vscode.window.setStatusBarMessage(
        `⚠ ${messages.manualRunSaveFailedStatus(taskName)}`,
        6000,
      );
    }
    notifyError(msg);
    if (showWebviewError) {
      SchedulerWebview.showError(msg);
    }
    return;
  }

  if (runResult.reason === "executorUnavailable") {
    const msg = messages.manualRunUnavailable();
    notifyError(msg);
    if (showWebviewError) {
      SchedulerWebview.showError(msg);
    }
    return;
  }

  const msg = messages.taskNotFound();
  notifyError(msg);
  if (showWebviewError) {
    SchedulerWebview.showError(msg);
  }
}

async function appendManualRunHistory(
  task: ScheduledTask,
  runResult: { ok: true } | ManualRunFailureResult,
): Promise<void> {
  if (runResult.ok) {
    const latestTask = scheduleManager.getTask(task.id) ?? task;
    const nextRunDate =
      latestTask.nextRun instanceof Date &&
      !Number.isNaN(latestTask.nextRun.getTime())
        ? latestTask.nextRun
        : undefined;
    notifyInfo(buildExecutionSummary(task.name, "success", nextRunDate));
    const nextRunAt =
      latestTask.nextRun instanceof Date &&
      !Number.isNaN(latestTask.nextRun.getTime())
        ? latestTask.nextRun.toISOString()
        : undefined;
    await enqueueExecutionHistory({
      taskId: task.id,
      taskName: task.name,
      trigger: "manual",
      status: "success",
      executedAt: new Date().toISOString(),
      nextRunAt,
    });
    return;
  }

  const detail =
    runResult.reason === "executionFailed" || runResult.reason === "saveFailed"
      ? runResult.errorMessage || messages.webviewUnknown()
      : runResult.reason === "executorUnavailable"
        ? messages.manualRunUnavailable()
        : messages.taskNotFound();
  await enqueueExecutionHistory({
    taskId: task.id,
    taskName: task.name,
    trigger: "manual",
    status: "failed",
    executedAt: new Date().toISOString(),
    nextRunAt: undefined,
    detail: resolveDisplayErrorMessage(detail),
  });
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
  extensionContextRef = context;

  // Prompt reload when the extension has been updated
  {
    const currentVersion =
      (context.extension.packageJSON as { version?: string }).version ??
      "0.0.0";
    const lastVersion = context.globalState.get<string>(LAST_VERSION_KEY);
    if (lastVersion && lastVersion !== currentVersion) {
      void vscode.window
        .showInformationMessage(
          messages.reloadAfterUpdate(currentVersion),
          messages.reloadNow(),
        )
        .then((choice) => {
          if (choice === messages.reloadNow()) {
            void vscode.commands.executeCommand(
              "workbench.action.reloadWindow",
            );
          }
        });
    }
    void context.globalState.update(LAST_VERSION_KEY, currentVersion);
  }

  // Initialize components
  scheduleManager = new ScheduleManager(context);
  copilotExecutor = new CopilotExecutor();
  treeProvider = new ScheduledTaskTreeProvider(scheduleManager);
  scheduleManager.addOnTasksChangedCallback(() => {
    SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
  });

  // Register TreeView
  const treeView = vscode.window.createTreeView("copilotSchedulerTasks", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // Register commands
  const commands = [
    registerCreateTaskCommand(),
    registerCreateTaskGuiCommand(context),
    registerListTasksCommand(context),
    registerEditTaskCommand(context),
    registerDeleteTaskCommand(),
    registerToggleTaskCommand(),
    registerEnableTaskCommand(),
    registerDisableTaskCommand(),
    registerRunNowCommand(),
    registerCopyPromptCommand(),
    registerDuplicateTaskCommand(),
    registerMoveToCurrentWorkspaceCommand(),
    registerOpenSettingsCommand(),
    registerShowVersionCommand(context),
    registerShowExecutionHistoryCommand(),
  ];

  // Start scheduler
  scheduleManager.startScheduler(async (task) => {
    await executeTask(task);
  });

  // If disabled in settings, stop the timer immediately (callback stays set for manual runs)
  {
    const cfg = vscode.workspace.getConfiguration("copilotScheduler");
    if (cfg.get<boolean>("enabled", true) === false) {
      scheduleManager.stopScheduler();
    }
  }

  // Sync prompt templates to tasks (startup and daily)
  void syncPromptTemplatesIfNeeded(context, true).catch((error) =>
    logError(
      "[CopilotScheduler] Prompt template sync failed:",
      sanitizeErrorDetailsForLog(
        error instanceof Error ? error.message : String(error ?? ""),
      ),
    ),
  );
  promptSyncInterval = setInterval(
    () => {
      void syncPromptTemplatesIfNeeded(context, false).catch((error) =>
        logError(
          "[CopilotScheduler] Prompt template daily sync failed:",
          sanitizeErrorDetailsForLog(
            error instanceof Error ? error.message : String(error ?? ""),
          ),
        ),
      );
    },
    24 * 60 * 60 * 1000,
  );

  context.subscriptions.push({
    dispose: () => {
      if (promptSyncInterval) {
        clearInterval(promptSyncInterval);
        promptSyncInterval = undefined;
      }
    },
  });

  // Show activation message
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const logLevel = config.get<string>("logLevel", "info");
  if (logLevel === "info" || logLevel === "debug") {
    notifyInfo(messages.extensionActive());
  }

  // React to language changes so the webview can be re-rendered in the selected locale
  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("copilotScheduler.language")) {
      SchedulerWebview.refreshLanguage(scheduleManager.getAllTasks());
      treeProvider.refresh();
    }
    if (
      e.affectsConfiguration("copilotScheduler.globalPromptsPath") ||
      e.affectsConfiguration("copilotScheduler.globalAgentsPath")
    ) {
      void SchedulerWebview.refreshCachesAndNotifyPanel(true);
    }
    // Consolidate timezone / enabled recalculation to avoid duplicate
    // recalculateAllNextRuns() when both change in one event (U22/U24).
    let needsRecalculate = false;
    if (e.affectsConfiguration("copilotScheduler.timezone")) {
      needsRecalculate = true;
    }
    if (e.affectsConfiguration("copilotScheduler.enabled")) {
      const cfg = vscode.workspace.getConfiguration("copilotScheduler");
      const enabled = cfg.get<boolean>("enabled", true);
      if (enabled) {
        scheduleManager.startScheduler(async (task) => {
          await executeTask(task);
        });
        needsRecalculate = true;
      } else {
        scheduleManager.stopScheduler();
      }
    }
    if (needsRecalculate) {
      // recalculateAllNextRuns → saveTasks → notifyTasksChanged already
      // refreshes the tree via the callback; only Webview needs explicit update.
      void scheduleManager
        .recalculateAllNextRuns()
        .then(() => {
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        })
        .catch((error) => {
          const errorMessage =
            error instanceof Error ? error.message : String(error ?? "");
          logError(
            "[CopilotScheduler] Failed to recalculate nextRun after config change:",
            sanitizeErrorDetailsForLog(errorMessage),
          );
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        });
    }
    if (e.affectsConfiguration("copilotScheduler.maxDailyExecutions")) {
      const cfg = vscode.workspace.getConfiguration("copilotScheduler");
      if (cfg.get<number>("maxDailyExecutions", 24) === 0) {
        void vscode.window.showWarningMessage(messages.unlimitedDailyWarning());
      }
    }
  });

  // Register subscriptions
  context.subscriptions.push(treeView, configWatcher, ...commands);
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  scheduleManager?.stopScheduler();
  SchedulerWebview.dispose();
  extensionContextRef = undefined;
  manualRunInFlightTaskIds.clear();
  executionHistorySaveQueue = Promise.resolve();
  // promptSyncInterval is cleared by the disposable registered in context.subscriptions.
}

/**
 * Execute a scheduled task
 */
async function executeTask(task: ScheduledTask): Promise<void> {
  const trigger: ExecutionTrigger = manualRunInFlightTaskIds.has(task.id)
    ? "manual"
    : "auto";
  // notifyInfo already checks shouldNotify() internally — no need for an outer guard.
  notifyInfo(messages.taskExecuting(task.name));

  try {
    const resolved = await resolvePromptExecution(task);

    // Execute the prompt
    try {
      await copilotExecutor.executePrompt(resolved.prompt, {
        agent: resolved.agent,
        model: resolved.model,
      });
    } catch (error) {
      // executePrompt displays its own warning on failure.
      markExecutionErrorAsUserNotified(error);
      throw error;
    }

    if (trigger === "auto") {
      const nextRunDate = getNotificationNextRun(task, new Date());
      notifyInfo(buildExecutionSummary(task.name, "success", nextRunDate));
      void enqueueExecutionHistory({
        taskId: task.id,
        taskName: task.name,
        trigger,
        status: "success",
        executedAt: new Date().toISOString(),
        nextRunAt: nextRunDate?.toISOString(),
      });
    }
  } catch (error) {
    // executePrompt already shows a warning with copy-to-clipboard option,
    // so only log the error here to avoid double notification.
    // Re-throw so callers (checkAndExecuteTasks / runTaskNow) can distinguish
    // success from failure and avoid recording lastRun on failure (U15).
    const errorMessage = error instanceof Error ? error.message : String(error);
    const safeErrorMessage = sanitizeErrorDetailsForLog(errorMessage);
    logError(messages.taskExecutionFailed(task.name, safeErrorMessage));

    if (trigger === "auto") {
      const nextRunDate = getNotificationNextRun(task, new Date());
      const summary = buildExecutionSummary(task.name, "failed", nextRunDate);
      vscode.window.setStatusBarMessage(`⚠ ${summary}`, 6000);
      void enqueueExecutionHistory({
        taskId: task.id,
        taskName: task.name,
        trigger,
        status: "failed",
        executedAt: new Date().toISOString(),
        nextRunAt: nextRunDate?.toISOString(),
        detail: resolveDisplayErrorMessageFromSanitized(safeErrorMessage),
      });
    }

    throw error;
  }
}

/**
 * Resolve prompt text from task (inline, local, or global)
 */
async function resolvePromptText(
  task: ScheduledTask,
  preferOpenDocument = true,
): Promise<string> {
  if (task.promptSource === "inline") {
    logDebug(`[CopilotScheduler] resolvePromptText: inline (task=${task.id})`);
    return task.prompt;
  }

  if (!task.promptPath) {
    logDebug(
      `[CopilotScheduler] resolvePromptText: missing promptPath (source=${task.promptSource}, task=${task.id})`,
    );
    return task.prompt;
  }

  const promptPath = task.promptPath.trim();
  if (!promptPath) {
    logDebug(
      `[CopilotScheduler] resolvePromptText: empty promptPath (source=${task.promptSource}, task=${task.id})`,
    );
    return task.prompt;
  }

  // Resolve file path
  let filePath: string | undefined;

  if (task.promptSource === "global") {
    filePath = resolveGlobalPromptPath(getGlobalPromptsRoot(), promptPath);
  } else if (task.promptSource === "local") {
    filePath = resolveLocalPromptPath(getWorkspaceFolderPaths(), promptPath);
  }

  if (filePath) {
    if (preferOpenDocument) {
      // Prefer in-memory document text when the file is open (supports unsaved edits).
      const normalizedTarget = normalizeForCompare(filePath);
      const openDoc = vscode.workspace.textDocuments.find(
        (d) =>
          d.uri.scheme === "file" &&
          normalizeForCompare(d.uri.fsPath) === normalizedTarget,
      );
      if (openDoc) {
        const text = openDoc.getText();
        if (text.trim()) {
          logDebug(
            `[CopilotScheduler] resolvePromptText: openDocument (file=${path.basename(filePath)}, dirty=${openDoc.isDirty}, task=${task.id})`,
          );
          return text;
        }
      }
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(filePath),
      );
      const content = Buffer.from(bytes).toString("utf8");
      // If the template file is empty, fall back to the task's stored prompt.
      if (content.trim()) {
        logDebug(
          `[CopilotScheduler] resolvePromptText: file (file=${path.basename(filePath)}, task=${task.id})`,
        );
        return content;
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error ?? "");
      logDebug(
        `[CopilotScheduler] resolvePromptText: readFile failed (file=${path.basename(filePath)}, task=${task.id})`,
        sanitizeErrorDetailsForLog(errorMessage),
      );
      // Fall back to inline prompt (file may not exist or be unreadable)
    }
  } else {
    logDebug(
      `[CopilotScheduler] resolvePromptText: path resolution failed (source=${task.promptSource}, file=${path.basename(promptPath)}, task=${task.id})`,
    );
  }

  logDebug(
    `[CopilotScheduler] resolvePromptText: fallback to stored prompt (source=${task.promptSource}, task=${task.id})`,
  );
  return task.prompt;
}

function parsePromptFrontmatter(promptText: string): PromptExecutionPayload {
  const match = promptText.match(
    /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/,
  );
  if (!match) {
    return { prompt: promptText };
  }

  const frontmatter = match[1];
  const body = promptText.slice(match[0].length);
  let agent: string | undefined;
  let model: string | undefined;

  for (const line of frontmatter.split(/\r?\n/)) {
    const parsed = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!parsed) continue;

    const key = parsed[1].toLowerCase();
    let value = parsed[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (!value) continue;

    if (key === "agent") {
      agent = value;
      continue;
    }
    if (key === "model") {
      model = value;
    }
  }

  if (!agent && !model) {
    return { prompt: promptText };
  }

  return {
    prompt: body,
    agent,
    model,
  };
}

function resolveExecutionOption(
  taskValue: string | undefined,
  frontmatterValue: string | undefined,
): string | undefined {
  const normalizedTaskValue =
    typeof taskValue === "string" ? taskValue.trim() : "";
  if (normalizedTaskValue) {
    return normalizedTaskValue;
  }

  const normalizedFrontmatterValue =
    typeof frontmatterValue === "string" ? frontmatterValue.trim() : "";
  if (normalizedFrontmatterValue) {
    return normalizedFrontmatterValue;
  }

  return undefined;
}

const AUTO_MODE_HINT =
  "[auto] Proceed autonomously. Apply all changes directly without asking for confirmation.";

function hasAutoModeHint(promptText: string): boolean {
  if (promptText.toLowerCase().includes(AUTO_MODE_HINT.toLowerCase())) {
    return true;
  }

  return /(?:^|\r?\n)\s*(?:\[auto\]|auto)\s*(?:\r?\n|$)/i.test(promptText);
}

function applyAutoModeHint(promptText: string, enabled: boolean): string {
  if (!enabled) {
    return promptText;
  }

  if (hasAutoModeHint(promptText)) {
    return promptText;
  }

  const fmMatch = promptText.match(
    /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n?/,
  );
  if (fmMatch) {
    const after = promptText.slice(fmMatch[0].length);
    return `${fmMatch[0]}${AUTO_MODE_HINT}\n\n${after}`;
  }

  return `${AUTO_MODE_HINT}\n\n${promptText}`;
}

async function resolvePromptExecution(
  task: ScheduledTask,
  preferOpenDocument = true,
): Promise<PromptExecutionPayload> {
  const promptText = await resolvePromptText(task, preferOpenDocument);
  const parsed = parsePromptFrontmatter(promptText);

  return {
    prompt: applyAutoModeHint(parsed.prompt, task.autoMode === true),
    agent: resolveExecutionOption(task.agent, parsed.agent),
    model: resolveExecutionOption(task.model, parsed.model),
  };
}

export const __testOnly = {
  resolvePromptText,
  parsePromptFrontmatter,
  resolveExecutionOption,
  applyAutoModeHint,
  resolvePromptExecution,
  sanitizeErrorDetailsForLog,
  resolveDisplayErrorMessage,
};

function getWorkspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .map((f) => f.uri.fsPath)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}

function getGlobalPromptsRoot(): string | undefined {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  return resolveGlobalPromptsRoot(config.get<string>("globalPromptsPath", ""));
}

/**
 * Handle task actions from Webview
 */
function handleTaskAction(action: TaskAction): void {
  void handleTaskActionAsync(action);
}

async function confirmManualRunIfWorkspaceMismatch(
  task: ScheduledTask,
): Promise<boolean> {
  if (task.scope !== "workspace") {
    return true;
  }
  if (scheduleManager.shouldTaskRunInCurrentWorkspace(task)) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    messages.confirmRunOutsideWorkspace(task.name),
    { modal: true },
    messages.confirmRunAnyway(),
    messages.actionCancel(),
  );
  return choice === messages.confirmRunAnyway();
}

async function handleTaskActionAsync(action: TaskAction): Promise<void> {
  try {
    switch (action.action) {
      case "run": {
        const runTask = scheduleManager.getTask(action.taskId);
        if (!runTask) {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }

        const confirmed = await confirmManualRunIfWorkspaceMismatch(runTask);
        if (!confirmed) {
          break;
        }

        // Manual run: no jitter / no daily limit. Persist lastRun when possible.
        // On execution failure, executePrompt already shows a warning with copy option.
        manualRunInFlightTaskIds.add(action.taskId);
        const runResult = await scheduleManager
          .runTaskNowDetailed(action.taskId)
          .finally(() => {
            manualRunInFlightTaskIds.delete(action.taskId);
          });
        if (!runResult.ok) {
          await appendManualRunHistory(runTask, runResult);
          handleManualRunFailure(runTask.name, runResult, {
            showWebviewError: true,
          });
          break;
        }
        await appendManualRunHistory(runTask, runResult);
        // Success path already persists via saveTasks(), which triggers
        // onTasksChanged callback → SchedulerWebview.updateTasks once.
        // Avoid sending a duplicate full task list here.
        break;
      }

      case "toggle": {
        const task = await scheduleManager.toggleTask(action.taskId);
        if (!task) {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }

        if (task.enabled) {
          const accepted = await ensureTaskEnabledAfterDisclaimer(task);
          if (!accepted) {
            break;
          }
        }
        notifyInfo(
          task.enabled
            ? messages.taskEnabled(task.name)
            : messages.taskDisabled(task.name),
        );
        SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        break;
      }

      case "delete": {
        const deleteTask = scheduleManager.getTask(action.taskId);
        if (!deleteTask) {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }

        if (
          deleteTask.scope === "workspace" &&
          !scheduleManager.shouldTaskRunInCurrentWorkspace(deleteTask)
        ) {
          const msg = messages.cannotDeleteOtherWorkspaceTask(deleteTask.name);
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }

        // Show confirmation dialog
        const confirm = await vscode.window.showWarningMessage(
          messages.confirmDelete(deleteTask.name),
          { modal: true },
          messages.confirmDeleteYes(),
        );

        if (confirm === messages.confirmDeleteYes()) {
          const deleted = await scheduleManager.deleteTask(action.taskId);
          if (!deleted) {
            const msg = messages.taskNotFound();
            notifyError(msg);
            SchedulerWebview.showError(msg);
            break;
          }
          notifyInfo(messages.taskDeleted(deleteTask.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        }
        break;
      }

      case "edit": {
        if (action.taskId === "__create__" && action.data) {
          await maybeWarnCronInterval(action.data.cronExpression);
          const task = await scheduleManager.createTask(
            action.data as CreateTaskInput,
          );
          const accepted = await ensureTaskEnabledAfterDisclaimer(task);
          if (!accepted) {
            SchedulerWebview.switchToList();
            break;
          }
          const createdMsg = messages.taskCreated(task.name);
          notifyInfo(createdMsg);
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
          SchedulerWebview.switchToList(createdMsg);
        } else if (action.data) {
          await maybeWarnCronInterval(action.data.cronExpression);
          const task = await scheduleManager.updateTask(
            action.taskId,
            action.data,
          );
          if (!task) {
            const msg = messages.taskNotFound();
            notifyError(msg);
            SchedulerWebview.showError(msg);
            break;
          }
          if (task.enabled) {
            const accepted = await ensureTaskEnabledAfterDisclaimer(task);
            if (!accepted) {
              SchedulerWebview.switchToList();
              break;
            }
          }
          const updatedMsg = messages.taskUpdated(task.name);
          notifyInfo(updatedMsg);
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
          SchedulerWebview.switchToList(updatedMsg);
        }
        break;
      }

      case "copy": {
        const copyTask = scheduleManager.getTask(action.taskId);
        if (!copyTask) {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }
        const promptText = await resolvePromptText(copyTask);
        await vscode.env.clipboard.writeText(promptText);
        notifyInfo(messages.promptCopied());
        break;
      }

      case "duplicate": {
        const task = await scheduleManager.duplicateTask(action.taskId);
        if (!task) {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }
        notifyInfo(messages.taskDuplicated(task.name));
        SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        break;
      }

      case "moveToCurrentWorkspace": {
        const task = scheduleManager.getTask(action.taskId);
        if (!task) {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }

        const confirm = await vscode.window.showWarningMessage(
          messages.confirmMoveToCurrentWorkspace(task.name),
          { modal: true },
          messages.confirmMoveYes(),
          messages.actionCancel(),
        );
        if (confirm !== messages.confirmMoveYes()) {
          break;
        }

        const moved = await scheduleManager.moveTaskToCurrentWorkspace(task.id);
        if (moved) {
          notifyInfo(messages.taskMovedToCurrentWorkspace(moved.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        }
        break;
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error ?? "");
    notifyError(errorMessage);
    SchedulerWebview.showError(errorMessage);
  }
}

// ==================== Command Registrations ====================

function registerCreateTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.createTask",
    async () => {
      try {
        // CLI-style task creation using InputBox
        const name = await vscode.window.showInputBox({
          prompt: messages.enterTaskName(),
          placeHolder: messages.placeholderTaskName(),
        });
        if (!name) return;

        const prompt = await vscode.window.showInputBox({
          prompt: messages.enterPrompt(),
          placeHolder: messages.placeholderPrompt(),
        });
        if (!prompt) return;

        const cronExpression = await vscode.window.showInputBox({
          prompt: messages.enterCronExpression(),
          placeHolder: messages.placeholderCron(),
          value: "0 9 * * 1-5",
        });
        if (!cronExpression) return;

        await maybeWarnCronInterval(cronExpression);
        const task = await scheduleManager.createTask({
          name,
          prompt,
          cronExpression,
        });
        const accepted = await ensureTaskEnabledAfterDisclaimer(task);
        if (!accepted) {
          return;
        }
        notifyInfo(messages.taskCreated(task.name));
        SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

async function handleTestPromptAction(
  prompt: string,
  agent?: string,
  model?: string,
): Promise<void> {
  // Test prompt execution
  // executePrompt already shows a user-facing warning with copy-to-clipboard
  // on failure, so we only log the error here to avoid double notification (U20).
  try {
    await copilotExecutor.executePrompt(prompt, { agent, model });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const safeErrorMessage = sanitizeErrorDetailsForLog(errorMessage);
    logError(`[CopilotScheduler] Test prompt failed: ${safeErrorMessage}`);
  }
}

function registerCreateTaskGuiCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.createTaskGui",
    async () => {
      try {
        await SchedulerWebview.show(
          context.extensionUri,
          scheduleManager.getAllTasks(),
          handleTaskAction,
          handleTestPromptAction,
        );

        // Ensure the '+' command always opens the webview in "new task" mode.
        SchedulerWebview.startCreateTask();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerListTasksCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.listTasks",
    async () => {
      try {
        await SchedulerWebview.show(
          context.extensionUri,
          scheduleManager.getAllTasks(),
          handleTaskAction,
          handleTestPromptAction,
        );
        SchedulerWebview.switchToList();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerEditTaskCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.editTask",
    async (item?: ScheduledTaskItem) => {
      try {
        let taskId: string | undefined;

        if (item instanceof ScheduledTaskItem) {
          taskId = item.task.id;
        } else {
          // Show quick pick to select task
          const tasks = scheduleManager.getAllTasks();
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              label: t.name,
              description: t.cronExpression,
              id: t.id,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          taskId = selected.id;
        }

        await SchedulerWebview.show(
          context.extensionUri,
          scheduleManager.getAllTasks(),
          handleTaskAction,
          handleTestPromptAction,
        );
        SchedulerWebview.editTask(taskId);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerDeleteTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.deleteTask",
    async (item?: ScheduledTaskItem) => {
      try {
        let task: ScheduledTask | undefined;

        if (item instanceof ScheduledTaskItem) {
          task = item.task;
        } else {
          // Show quick pick to select task
          const tasks = scheduleManager
            .getAllTasks()
            .filter(
              (t) =>
                t.scope === "global" ||
                scheduleManager.shouldTaskRunInCurrentWorkspace(t),
            );
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              label: t.name,
              description: t.cronExpression,
              task: t,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          task = selected.task;
        }

        if (
          task.scope === "workspace" &&
          !scheduleManager.shouldTaskRunInCurrentWorkspace(task)
        ) {
          notifyError(messages.cannotDeleteOtherWorkspaceTask(task.name));
          return;
        }

        // Confirm deletion
        const confirm = await vscode.window.showWarningMessage(
          messages.confirmDelete(task.name),
          { modal: true },
          messages.confirmDeleteYes(),
        );

        if (confirm === messages.confirmDeleteYes()) {
          const deleted = await scheduleManager.deleteTask(task.id);
          if (!deleted) {
            notifyError(messages.taskNotFound());
            return;
          }
          notifyInfo(messages.taskDeleted(task.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerToggleTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.toggleTask",
    async (item?: ScheduledTaskItem) => {
      try {
        let taskId: string | undefined;

        if (item instanceof ScheduledTaskItem) {
          taskId = item.task.id;
        } else {
          // Show quick pick to select task
          const tasks = scheduleManager.getAllTasks();
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              label: `${t.enabled ? "✅" : "⏸️"} ${t.name}`,
              description: t.cronExpression,
              id: t.id,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          taskId = selected.id;
        }

        const task = await scheduleManager.toggleTask(taskId);
        if (task) {
          if (task.enabled) {
            const accepted = await ensureTaskEnabledAfterDisclaimer(task);
            if (!accepted) {
              return;
            }
          }
          notifyInfo(
            task.enabled
              ? messages.taskEnabled(task.name)
              : messages.taskDisabled(task.name),
          );
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        } else {
          notifyError(messages.taskNotFound());
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerEnableTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.enableTask",
    async (item?: ScheduledTaskItem) => {
      try {
        let taskId: string | undefined;

        if (item instanceof ScheduledTaskItem) {
          taskId = item.task.id;
        } else {
          // Show quick pick to select a disabled task
          const tasks = scheduleManager.getAllTasks().filter((t) => !t.enabled);
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              label: `⏸️ ${t.name}`,
              description: t.cronExpression,
              id: t.id,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          taskId = selected.id;
        }

        const task = await scheduleManager.setTaskEnabled(taskId, true);
        if (task) {
          const accepted = await ensureTaskEnabledAfterDisclaimer(task);
          if (!accepted) {
            return;
          }
          notifyInfo(messages.taskEnabled(task.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        } else {
          notifyError(messages.taskNotFound());
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerDisableTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.disableTask",
    async (item?: ScheduledTaskItem) => {
      try {
        let taskId: string | undefined;

        if (item instanceof ScheduledTaskItem) {
          taskId = item.task.id;
        } else {
          // Show quick pick to select an enabled task
          const tasks = scheduleManager.getAllTasks().filter((t) => t.enabled);
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              label: `✅ ${t.name}`,
              description: t.cronExpression,
              id: t.id,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          taskId = selected.id;
        }

        const task = await scheduleManager.setTaskEnabled(taskId, false);
        if (task) {
          notifyInfo(messages.taskDisabled(task.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        } else {
          notifyError(messages.taskNotFound());
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerRunNowCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.runNow",
    async (item?: ScheduledTaskItem) => {
      try {
        let task: ScheduledTask | undefined;

        if (item instanceof ScheduledTaskItem) {
          task = item.task;
        } else {
          // Show quick pick to select task
          const tasks = scheduleManager.getAllTasks();
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              label: t.name,
              description: t.cronExpression,
              task: t,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          task = selected.task;
        }

        const confirmed = await confirmManualRunIfWorkspaceMismatch(task);
        if (!confirmed) {
          return;
        }

        // Manual run: no jitter / no daily limit. Persist lastRun when possible.
        manualRunInFlightTaskIds.add(task.id);
        const runResult = await scheduleManager
          .runTaskNowDetailed(task.id)
          .finally(() => {
            manualRunInFlightTaskIds.delete(task.id);
          });
        if (!runResult.ok) {
          await appendManualRunHistory(task, runResult);
          handleManualRunFailure(task.name, runResult);
          return;
        }
        await appendManualRunHistory(task, runResult);
        // Success path already persists via saveTasks(), which triggers
        // onTasksChanged callback → SchedulerWebview.updateTasks once.
        // Avoid sending a duplicate full task list here.
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerCopyPromptCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.copyPrompt",
    async (item?: ScheduledTaskItem) => {
      try {
        let task: ScheduledTask | undefined;

        if (item instanceof ScheduledTaskItem) {
          task = item.task;
        } else {
          // Show quick pick to select task
          const tasks = scheduleManager.getAllTasks();
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              label: t.name,
              description:
                t.prompt.length > 50
                  ? t.prompt.substring(0, 50) + "..."
                  : t.prompt,
              task: t,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          task = selected.task;
        }

        const promptText = await resolvePromptText(task);
        await vscode.env.clipboard.writeText(promptText);
        notifyInfo(messages.promptCopied());
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerDuplicateTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.duplicateTask",
    async (item?: ScheduledTaskItem) => {
      try {
        let taskId: string | undefined;

        if (item instanceof ScheduledTaskItem) {
          taskId = item.task.id;
        } else {
          // Show quick pick to select task
          const tasks = scheduleManager.getAllTasks();
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              label: t.name,
              description: t.cronExpression,
              id: t.id,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          taskId = selected.id;
        }

        const duplicated = await scheduleManager.duplicateTask(taskId);
        if (duplicated) {
          notifyInfo(messages.taskDuplicated(duplicated.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        } else {
          notifyError(messages.taskNotFound());
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerMoveToCurrentWorkspaceCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.moveToCurrentWorkspace",
    async (item?: ScheduledTaskItem) => {
      try {
        let task: ScheduledTask | undefined;

        if (item instanceof ScheduledTaskItem) {
          task = item.task;
        } else {
          const tasks = scheduleManager
            .getAllTasks()
            .filter((t) => t.scope === "workspace");
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              label: t.name,
              description: t.workspacePath
                ? path.basename(t.workspacePath)
                : "",
              task: t,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          task = selected.task;
        }

        if (!task) {
          notifyError(messages.taskNotFound());
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          messages.confirmMoveToCurrentWorkspace(task.name),
          { modal: true },
          messages.confirmMoveYes(),
          messages.actionCancel(),
        );
        if (confirm !== messages.confirmMoveYes()) {
          return;
        }

        const moved = await scheduleManager.moveTaskToCurrentWorkspace(task.id);
        if (!moved) {
          notifyError(messages.taskNotFound());
          return;
        }
        notifyInfo(messages.taskMovedToCurrentWorkspace(moved.name));
        SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error ?? "");
        notifyError(errorMessage);
        SchedulerWebview.showError(errorMessage);
      }
    },
  );
}

function registerOpenSettingsCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.openSettings",
    async () => {
      try {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@ext:yamapan.copilot-scheduler",
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerShowVersionCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.showVersion",
    async () => {
      try {
        const packageJson = context.extension.packageJSON as {
          version: string;
        };
        const version = packageJson.version || "0.0.0";
        notifyInfo(messages.versionInfo(version));
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerShowExecutionHistoryCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.showExecutionHistory",
    async () => {
      try {
        await showExecutionHistoryView();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error ?? "");
        notifyError(errorMessage);
      }
    },
  );
}
