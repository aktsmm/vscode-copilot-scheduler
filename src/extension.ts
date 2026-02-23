/**
 * Copilot Scheduler - Extension Entry Point
 * Registers commands, initializes components, and starts the scheduler
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ScheduleManager } from "./scheduleManager";
import { CopilotExecutor } from "./copilotExecutor";
import { ScheduledTaskTreeProvider, ScheduledTaskItem } from "./treeProvider";
import { SchedulerWebview } from "./schedulerWebview";
import { messages } from "./i18n";
import { logError } from "./logger";
import {
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

const PROMPT_SYNC_DATE_KEY = "promptSyncDate";
const LAST_VERSION_KEY = "lastKnownVersion";

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

async function maybeShowDisclaimerOnce(task: ScheduledTask): Promise<void> {
  if (!task.enabled) return;
  if (scheduleManager.isDisclaimerAccepted()) return;
  const choice = await vscode.window.showInformationMessage(
    messages.disclaimerMessage(),
    messages.disclaimerAccept(),
    messages.disclaimerDecline(),
  );
  if (choice !== messages.disclaimerAccept()) {
    return;
  }
  await scheduleManager.setDisclaimerAccepted(true);
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
      const latest = await resolvePromptText(task);
      if (latest && latest !== task.prompt) {
        // Avoid syncing empty prompts (would break validation and UX)
        if (latest.trim()) {
          promptUpdates.push({ id: task.id, prompt: latest });
        }
      }
    } catch (error) {
      logError(`Prompt sync failed for task ${task.name}: ${error}`);
    }
  }

  const updated =
    promptUpdates.length > 0
      ? (await scheduleManager.updateTaskPrompts(promptUpdates)) > 0
      : false;

  if (updated) {
    SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
    treeProvider.refresh();
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
  const mode = getNotificationMode();
  if (mode === "silentStatus") {
    vscode.window.setStatusBarMessage(`⚠ ${message}`, timeoutMs);
    logError(message);
    return;
  }
  void vscode.window.showErrorMessage(message);
}

// Global instances
let scheduleManager: ScheduleManager;
let copilotExecutor: CopilotExecutor;
let treeProvider: ScheduledTaskTreeProvider;
let promptSyncInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
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
    logError("[CopilotScheduler] Prompt template sync failed:", error),
  );
  promptSyncInterval = setInterval(
    () => {
      void syncPromptTemplatesIfNeeded(context, false).catch((error) =>
        logError(
          "[CopilotScheduler] Prompt template daily sync failed:",
          error,
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
    if (e.affectsConfiguration("copilotScheduler.enabled")) {
      const cfg = vscode.workspace.getConfiguration("copilotScheduler");
      const enabled = cfg.get<boolean>("enabled", true);
      if (enabled) {
        scheduleManager.startScheduler(async (task) => {
          await executeTask(task);
        });
      } else {
        scheduleManager.stopScheduler();
      }
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
  if (promptSyncInterval) {
    clearInterval(promptSyncInterval);
    promptSyncInterval = undefined;
  }
}

/**
 * Execute a scheduled task
 */
async function executeTask(task: ScheduledTask): Promise<void> {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const showNotifications = config.get<boolean>("showNotifications", true);

  if (showNotifications) {
    notifyInfo(messages.taskExecuting(task.name));
  }

  try {
    // Resolve prompt text
    const promptText = await resolvePromptText(task);

    // Execute the prompt
    await copilotExecutor.executePrompt(promptText, {
      agent: task.agent,
      model: task.model,
    });

    if (showNotifications) {
      notifyInfo(messages.taskExecuted(task.name));
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    notifyError(messages.taskExecutionFailed(task.name, errorMessage));
  }
}

/**
 * Resolve prompt text from task (inline, local, or global)
 */
async function resolvePromptText(task: ScheduledTask): Promise<string> {
  if (task.promptSource === "inline") {
    return task.prompt;
  }

  if (!task.promptPath) {
    return task.prompt;
  }

  // Resolve file path
  let filePath: string | undefined;

  if (task.promptSource === "global") {
    filePath = resolveGlobalPromptPath(getGlobalPromptsRoot(), task.promptPath);
  } else if (task.promptSource === "local") {
    filePath = resolveLocalPromptPath(
      getWorkspaceFolderPaths(),
      task.promptPath,
    );
  }

  if (filePath && fs.existsSync(filePath)) {
    try {
      return await fs.promises.readFile(filePath, "utf-8");
    } catch {
      // Fall back to inline prompt
    }
  }

  return task.prompt;
}

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
        const ok = await scheduleManager.runTaskNow(action.taskId);
        if (!ok) {
          // Fallback: runTaskNow returns false when the execute callback is not set
          // (e.g., scheduler was stopped). Execute directly as a best-effort path.
          await executeTask(runTask);
        }
        SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        treeProvider.refresh();
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

        notifyInfo(
          task.enabled
            ? messages.taskEnabled(task.name)
            : messages.taskDisabled(task.name),
        );
        if (task.enabled) {
          await maybeShowDisclaimerOnce(task);
        }
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
          await maybeShowDisclaimerOnce(task);
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
          const updatedMsg = messages.taskUpdated(task.name);
          notifyInfo(updatedMsg);
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
          SchedulerWebview.switchToList(updatedMsg);
        }
        break;
      }

      case "copy": {
        const copyTask = scheduleManager.getTask(action.taskId);
        if (copyTask) {
          const promptText = await resolvePromptText(copyTask);
          await vscode.env.clipboard.writeText(promptText);
          notifyInfo(messages.promptCopied());
        }
        break;
      }

      case "duplicate": {
        const task = await scheduleManager.duplicateTask(action.taskId);
        if (task) {
          notifyInfo(messages.taskDuplicated(task.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        }
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
          treeProvider.refresh();
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

      try {
        await maybeWarnCronInterval(cronExpression);
        const task = await scheduleManager.createTask({
          name,
          prompt,
          cronExpression,
        });
        notifyInfo(messages.taskCreated(task.name));
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerCreateTaskGuiCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.createTaskGui",
    async () => {
      await SchedulerWebview.show(
        context.extensionUri,
        scheduleManager.getAllTasks(),
        handleTaskAction,
        async (prompt, agent, model) => {
          // Test prompt execution
          try {
            await copilotExecutor.executePrompt(prompt, { agent, model });
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            notifyError(errorMessage);
          }
        },
      );
    },
  );
}

function registerListTasksCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.listTasks",
    async () => {
      await SchedulerWebview.show(
        context.extensionUri,
        scheduleManager.getAllTasks(),
        handleTaskAction,
      );
      SchedulerWebview.switchToList();
    },
  );
}

function registerEditTaskCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.editTask",
    async (item?: ScheduledTaskItem) => {
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
      );
      SchedulerWebview.editTask(taskId);
    },
  );
}

function registerDeleteTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.deleteTask",
    async (item?: ScheduledTaskItem) => {
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

      // Confirm deletion
      const confirm = await vscode.window.showWarningMessage(
        messages.confirmDelete(task.name),
        { modal: true },
        messages.confirmDeleteYes(),
      );

      if (confirm === messages.confirmDeleteYes()) {
        await scheduleManager.deleteTask(task.id);
        notifyInfo(messages.taskDeleted(task.name));
        SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
      }
    },
  );
}

function registerToggleTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.toggleTask",
    async (item?: ScheduledTaskItem) => {
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
        notifyInfo(
          task.enabled
            ? messages.taskEnabled(task.name)
            : messages.taskDisabled(task.name),
        );
        SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
      }
    },
  );
}

function registerEnableTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.enableTask",
    async (item?: ScheduledTaskItem) => {
      if (item instanceof ScheduledTaskItem) {
        const task = await scheduleManager.setTaskEnabled(item.task.id, true);
        if (task) {
          notifyInfo(messages.taskEnabled(task.name));
          await maybeShowDisclaimerOnce(task);
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        }
      }
    },
  );
}

function registerDisableTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.disableTask",
    async (item?: ScheduledTaskItem) => {
      if (item instanceof ScheduledTaskItem) {
        const task = await scheduleManager.setTaskEnabled(item.task.id, false);
        if (task) {
          notifyInfo(messages.taskDisabled(task.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        }
      }
    },
  );
}

function registerRunNowCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.runNow",
    async (item?: ScheduledTaskItem) => {
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
      const ok = await scheduleManager.runTaskNow(task.id);
      if (!ok) {
        await executeTask(task);
      }
      SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
      treeProvider.refresh();
    },
  );
}

function registerCopyPromptCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.copyPrompt",
    async (item?: ScheduledTaskItem) => {
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
            description: t.prompt.substring(0, 50) + "...",
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
    },
  );
}

function registerDuplicateTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.duplicateTask",
    async (item?: ScheduledTaskItem) => {
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
      }
    },
  );
}

function registerMoveToCurrentWorkspaceCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.moveToCurrentWorkspace",
    async (item?: ScheduledTaskItem) => {
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
            description: t.workspacePath ? path.basename(t.workspacePath) : "",
            task: t,
          })),
          { placeHolder: messages.selectTask() },
        );

        if (!selected) return;
        task = selected.task;
      }

      try {
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
        treeProvider.refresh();
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
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:yamapan.copilot-scheduler",
      );
    },
  );
}

function registerShowVersionCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.showVersion",
    async () => {
      const packageJson = context.extension.packageJSON as { version: string };
      const version = packageJson.version || "0.0.0";
      notifyInfo(messages.versionInfo(version));
    },
  );
}
