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
  const treeView = vscode.window.createTreeView("promptPilotTasks", {
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
  const config = vscode.workspace.getConfiguration("promptPilot");
  const logLevel = config.get<string>("logLevel", "info");
  if (logLevel === "info" || logLevel === "debug") {
    vscode.window.showInformationMessage(messages.extensionActive());
  }

  // Register subscriptions
  context.subscriptions.push(treeView, ...commands);
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
  const config = vscode.workspace.getConfiguration("promptPilot");
  const showNotifications = config.get<boolean>("showNotifications", true);

  if (showNotifications) {
    vscode.window.showInformationMessage(messages.taskExecuting(task.name));
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
      vscode.window.showInformationMessage(messages.taskExecuted(task.name));
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      messages.taskExecutionFailed(task.name, errorMessage),
    );
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
  const config = vscode.workspace.getConfiguration("promptPilot");
  const customPath = config.get<string>("globalPromptsPath", "");

  let globalRoot: string | undefined;

  if (customPath) {
    globalRoot = customPath;
  } else {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (homeDir) {
      const appData = process.env.APPDATA;
      if (appData) {
        const vscodePromptsPath = path.join(appData, "Code", "User", "prompts");
        if (fs.existsSync(vscodePromptsPath)) {
          globalRoot = vscodePromptsPath;
        }
      }
      if (!globalRoot) {
        globalRoot = path.join(homeDir, ".github", "prompts");
      }
    }
  }

  if (!globalRoot) {
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
  switch (action.action) {
    case "run":
      const runTask = scheduleManager.getTask(action.taskId);
      if (runTask) {
        executeTask(runTask);
      }
      break;

    case "toggle":
      scheduleManager.toggleTask(action.taskId).then((task) => {
        if (task) {
          vscode.window.showInformationMessage(
            task.enabled
              ? messages.taskEnabled(task.name)
              : messages.taskDisabled(task.name),
          );
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        }
      });
      break;

    case "delete":
      const deleteTask = scheduleManager.getTask(action.taskId);
      if (deleteTask) {
        scheduleManager.deleteTask(action.taskId).then(() => {
          vscode.window.showInformationMessage(
            messages.taskDeleted(deleteTask.name),
          );
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        });
      }
      break;

    case "edit":
      if (action.taskId === "__create__" && action.data) {
        // Create new task
        scheduleManager
          .createTask(action.data as CreateTaskInput)
          .then((task) => {
            vscode.window.showInformationMessage(
              messages.taskCreated(task.name),
            );
            SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
            SchedulerWebview.switchToList();
          });
      } else if (action.data) {
        // Update existing task
        scheduleManager.updateTask(action.taskId, action.data).then((task) => {
          if (task) {
            vscode.window.showInformationMessage(
              messages.taskUpdated(task.name),
            );
            SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
            SchedulerWebview.switchToList();
          }
        });
      }
      break;

    case "copy":
      const copyTask = scheduleManager.getTask(action.taskId);
      if (copyTask) {
        vscode.env.clipboard.writeText(copyTask.prompt);
        vscode.window.showInformationMessage(messages.promptCopied());
      }
      break;
  }
}

// ==================== Command Registrations ====================

function registerCreateTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "promptPilot.createTask",
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
        vscode.window.showInformationMessage(messages.taskCreated(task.name));
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(errorMessage);
      }
    },
  );
}

function registerCreateTaskGuiCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "promptPilot.createTaskGui",
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
            vscode.window.showErrorMessage(errorMessage);
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
    "promptPilot.listTasks",
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
    "promptPilot.editTask",
    async (item?: ScheduledTaskItem) => {
      let taskId: string | undefined;

      if (item instanceof ScheduledTaskItem) {
        taskId = item.task.id;
      } else {
        // Show quick pick to select task
        const tasks = scheduleManager.getAllTasks();
        if (tasks.length === 0) {
          vscode.window.showInformationMessage(messages.noTasksFound());
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
    "promptPilot.deleteTask",
    async (item?: ScheduledTaskItem) => {
      let task: ScheduledTask | undefined;

      if (item instanceof ScheduledTaskItem) {
        task = item.task;
      } else {
        // Show quick pick to select task
        const tasks = scheduleManager.getAllTasks();
        if (tasks.length === 0) {
          vscode.window.showInformationMessage(messages.noTasksFound());
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
        vscode.window.showInformationMessage(messages.taskDeleted(task.name));
      }
    },
  );
}

function registerToggleTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "promptPilot.toggleTask",
    async (item?: ScheduledTaskItem) => {
      let taskId: string | undefined;

      if (item instanceof ScheduledTaskItem) {
        taskId = item.task.id;
      } else {
        // Show quick pick to select task
        const tasks = scheduleManager.getAllTasks();
        if (tasks.length === 0) {
          vscode.window.showInformationMessage(messages.noTasksFound());
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
        vscode.window.showInformationMessage(
          task.enabled
            ? messages.taskEnabled(task.name)
            : messages.taskDisabled(task.name),
        );
      }
    },
  );
}

function registerRunNowCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "promptPilot.runNow",
    async (item?: ScheduledTaskItem) => {
      let task: ScheduledTask | undefined;

      if (item instanceof ScheduledTaskItem) {
        task = item.task;
      } else {
        // Show quick pick to select task
        const tasks = scheduleManager.getAllTasks();
        if (tasks.length === 0) {
          vscode.window.showInformationMessage(messages.noTasksFound());
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
    "promptPilot.copyPrompt",
    async (item?: ScheduledTaskItem) => {
      let task: ScheduledTask | undefined;

      if (item instanceof ScheduledTaskItem) {
        task = item.task;
      } else {
        // Show quick pick to select task
        const tasks = scheduleManager.getAllTasks();
        if (tasks.length === 0) {
          vscode.window.showInformationMessage(messages.noTasksFound());
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
      vscode.window.showInformationMessage(messages.promptCopied());
    },
  );
}

function registerDuplicateTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "promptPilot.duplicateTask",
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
          vscode.window.showInformationMessage(messages.noTasksFound());
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
        vscode.window.showInformationMessage(
          messages.taskDuplicated(duplicated.name),
        );
      }
    },
  );
}

function registerOpenSettingsCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "promptPilot.openSettings",
    async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:yamapan.prompt-pilot",
      );
    },
  );
}

function registerShowVersionCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "promptPilot.showVersion",
    async () => {
      const packageJson = context.extension.packageJSON as { version: string };
      const version = packageJson.version || "0.0.0";
      vscode.window.showInformationMessage(messages.versionInfo(version));
    },
  );
}

