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
import type {
  ScheduledTask,
  CreateTaskInput,
  TaskAction,
  PromptSource,
} from "./types";

type NotificationMode = "sound" | "silentToast" | "silentStatus";

function shouldNotify(): boolean {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  return config.get<boolean>("showNotifications", true);
}

function getNotificationMode(): NotificationMode {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const mode = config.get<NotificationMode>("notificationMode", "sound");
  // Legacy: if notifications were disabled, honor that as silentStatus
  if (shouldNotify() === false) {
    return "silentStatus";
  }
  return mode || "sound";
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
        async () => {},
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
    console.error(message);
    return;
  }
  void vscode.window.showErrorMessage(message);
}

// Global instances
let scheduleManager: ScheduleManager;
let copilotExecutor: CopilotExecutor;
let treeProvider: ScheduledTaskTreeProvider;

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
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
    registerOpenSettingsCommand(),
    registerShowVersionCommand(context),
  ];

  // Start scheduler
  scheduleManager.startScheduler(async (task) => {
    await executeTask(task);
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
      SchedulerWebview.refreshLanguage(scheduleManager.getAllTasks());
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
    filePath = resolveGlobalPromptPath(task.promptPath);
  } else if (task.promptSource === "local") {
    filePath = resolveLocalPromptPath(task.promptPath);
  }

  if (filePath && fs.existsSync(filePath)) {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      // Fall back to inline prompt
    }
  }

  return task.prompt;
}

/**
 * Resolve global prompt file path
 */
function resolveGlobalPromptPath(promptPath: string): string | undefined {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const customPath = config.get<string>("globalPromptsPath", "");

  const defaultRoot = process.env.APPDATA
    ? path.join(process.env.APPDATA, "Code", "User", "prompts")
    : "";

  const globalRoot = customPath || defaultRoot;

  if (!globalRoot || !fs.existsSync(globalRoot)) {
    return undefined;
  }

  return resolveAllowedPromptPath(globalRoot, promptPath);
}

/**
 * Resolve local prompt file path
 */
function resolveLocalPromptPath(promptPath: string): string | undefined {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return undefined;
  }

  return resolveAllowedPromptPath(workspaceRoot, promptPath);
}

/**
 * Resolve prompt path with security checks
 */
function resolveAllowedPromptPath(
  baseDir: string,
  promptPath: string,
): string | undefined {
  // Prevent path traversal attacks
  const resolvedTarget = path.resolve(baseDir, promptPath);
  const normalizedBase = path.normalize(baseDir);

  if (
    resolvedTarget.startsWith(normalizedBase + path.sep) ||
    resolvedTarget === normalizedBase
  ) {
    return resolvedTarget;
  }

  return undefined;
}

/**
 * Handle task actions from Webview
 */
function handleTaskAction(action: TaskAction): void {
  void handleTaskActionAsync(action);
}

async function handleTaskActionAsync(action: TaskAction): Promise<void> {
  try {
    switch (action.action) {
      case "run": {
        const runTask = scheduleManager.getTask(action.taskId);
        if (runTask) {
          await executeTask(runTask);
        }
        break;
      }

      case "toggle": {
        const task = await scheduleManager.toggleTask(action.taskId);
        if (task) {
          notifyInfo(
            task.enabled
              ? messages.taskEnabled(task.name)
              : messages.taskDisabled(task.name),
          );
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        }
        break;
      }

      case "delete": {
        const deleteTask = scheduleManager.getTask(action.taskId);
        if (deleteTask) {
          // Show confirmation dialog
          const confirm = await vscode.window.showWarningMessage(
            messages.confirmDelete(deleteTask.name),
            { modal: true },
            messages.confirmDeleteYes(),
          );

          if (confirm === messages.confirmDeleteYes()) {
            await scheduleManager.deleteTask(action.taskId);
            notifyInfo(messages.taskDeleted(deleteTask.name));
            SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
          }
        }
        break;
      }

      case "edit": {
        if (action.taskId === "__create__" && action.data) {
          const task = await scheduleManager.createTask(
            action.data as CreateTaskInput,
          );
          notifyInfo(messages.taskCreated(task.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
          SchedulerWebview.switchToList();
        } else if (action.data) {
          const task = await scheduleManager.updateTask(
            action.taskId,
            action.data,
          );
          if (task) {
            notifyInfo(messages.taskUpdated(task.name));
            SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
            SchedulerWebview.switchToList();
          }
        }
        break;
      }

      case "copy": {
        const copyTask = scheduleManager.getTask(action.taskId);
        if (copyTask) {
          await vscode.env.clipboard.writeText(copyTask.prompt);
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
      SchedulerWebview.focusTask(taskId);
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

      await executeTask(task);
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
      let taskName: string | undefined;

      if (item instanceof ScheduledTaskItem) {
        taskId = item.task.id;
        taskName = item.task.name;
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
            name: t.name,
          })),
          { placeHolder: messages.selectTask() },
        );

        if (!selected) return;
        taskId = selected.id;
        taskName = selected.name;
      }

      const duplicated = await scheduleManager.duplicateTask(taskId);
      if (duplicated) {
        notifyInfo(messages.taskDuplicated(duplicated.name));
        SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
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
