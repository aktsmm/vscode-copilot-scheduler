/**
 * Copilot Scheduler - Scheduler Webview
 * Provides GUI for task creation, editing, and listing
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { notifyInfo, notifyError } from "./extension";
import type {
  ScheduledTask,
  CreateTaskInput,
  TaskAction,
  AgentInfo,
  ModelInfo,
  PromptTemplate,
  TaskScope,
  PromptSource,
  CronPreset,
  WebviewToExtensionMessage,
} from "./types";
import { CopilotExecutor } from "./copilotExecutor";
import { messages, isJapanese, getCronPresets } from "./i18n";
import { logError } from "./logger";
import { validateTemplateLoadRequest } from "./templateValidation";
import { resolveGlobalPromptsRoot } from "./promptResolver";

type OutgoingWebviewMessage = { type: string; [key: string]: unknown };

/**
 * Manages the Webview panel for task management
 */
export class SchedulerWebview {
  private static panel: vscode.WebviewPanel | undefined;
  private static cachedAgents: AgentInfo[] = [];
  private static cachedModels: ModelInfo[] = [];
  private static cachedPromptTemplates: PromptTemplate[] = [];
  private static onTaskActionCallback:
    | ((action: TaskAction) => void)
    | undefined;
  private static onTestPromptCallback:
    | ((prompt: string, agent?: string, model?: string) => void)
    | undefined;
  private static extensionUri: vscode.Uri;
  private static currentTasks: ScheduledTask[] = [];
  private static webviewReady = false;
  private static pendingMessages: OutgoingWebviewMessage[] = [];

  private static resetWebviewReadyState(): void {
    this.webviewReady = false;
    this.pendingMessages = [];
  }

  private static enqueueMessage(message: OutgoingWebviewMessage): void {
    const existingIndex = this.pendingMessages.findIndex(
      (m) => m.type === message.type,
    );
    if (existingIndex >= 0) {
      this.pendingMessages[existingIndex] = message;
      return;
    }
    this.pendingMessages.push(message);
  }

  private static postMessage(message: OutgoingWebviewMessage): void {
    if (!this.panel) return;
    if (!this.webviewReady) {
      this.enqueueMessage(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private static flushPendingMessages(): void {
    if (!this.panel || !this.webviewReady) return;
    if (this.pendingMessages.length === 0) return;
    const queue = this.pendingMessages;
    this.pendingMessages = [];
    for (const message of queue) {
      void this.panel.webview.postMessage(message);
    }
  }

  /**
   * Show or reveal the webview panel
   */
  static async show(
    extensionUri: vscode.Uri,
    tasks: ScheduledTask[],
    onTaskAction: (action: TaskAction) => void,
    onTestPrompt?: (prompt: string, agent?: string, model?: string) => void,
  ): Promise<void> {
    this.extensionUri = extensionUri;
    this.currentTasks = tasks;
    this.onTaskActionCallback = onTaskAction;
    this.onTestPromptCallback = onTestPrompt;

    // Ensure we have baseline data for the first render (do not block the UI)
    if (this.cachedAgents.length === 0) {
      this.cachedAgents = CopilotExecutor.getBuiltInAgents();
    }
    if (this.cachedModels.length === 0) {
      this.cachedModels = CopilotExecutor.getFallbackModels();
    }

    const refreshInBackground = (): void => {
      void this.refreshAgentsAndModels(true)
        .then(() => {
          this.postMessage({
            type: "updateAgents",
            agents: this.cachedAgents,
          });
          this.postMessage({
            type: "updateModels",
            models: this.cachedModels,
          });
        })
        .catch((error) => {
          logError(
            "[CopilotScheduler] Failed to refresh agents/models:",
            error,
          );
        });

      void this.refreshPromptTemplates(true)
        .then(() => {
          this.postMessage({
            type: "updatePromptTemplates",
            templates: this.cachedPromptTemplates,
          });
        })
        .catch((error) => {
          logError(
            "[CopilotScheduler] Failed to refresh prompt templates:",
            error,
          );
        });
    };

    if (this.panel) {
      // Reveal existing panel — send cached data only (no heavy re-scan)
      this.panel.reveal(vscode.ViewColumn.One);
      this.updateTasks(tasks);
      // Send already-cached agents/models/templates without rescanning
      this.postMessage({
        type: "updateAgents",
        agents: this.cachedAgents,
      });
      this.postMessage({
        type: "updateModels",
        models: this.cachedModels,
      });
      this.postMessage({
        type: "updatePromptTemplates",
        templates: this.cachedPromptTemplates,
      });
    } else {
      // Create new panel
      this.panel = vscode.window.createWebviewPanel(
        "copilotScheduler",
        messages.webviewTitle(),
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(extensionUri, "media"),
            vscode.Uri.joinPath(extensionUri, "images"),
          ],
        },
      );

      // New webview instance (or re-created panel) starts as not-ready.
      this.resetWebviewReadyState();

      // Set icon
      this.panel.iconPath = {
        light: vscode.Uri.joinPath(extensionUri, "images", "sidebar-icon.svg"),
        dark: vscode.Uri.joinPath(extensionUri, "images", "sidebar-icon.svg"),
      };

      // Set HTML content
      const htmlContent = this.getWebviewContent(
        this.panel.webview,
        tasks,
        this.cachedAgents,
        this.cachedModels,
        this.cachedPromptTemplates,
      );

      // Handle messages from webview (register before setting HTML to avoid races)
      this.panel.webview.onDidReceiveMessage(
        async (message: WebviewToExtensionMessage) => {
          try {
            await this.handleMessage(message);
          } catch (error) {
            const details =
              error instanceof Error
                ? error.stack || error.message
                : String(error ?? "");
            logError("[CopilotScheduler] Webview message handling failed:", {
              type: (message as { type?: unknown } | undefined)?.type,
              error: details,
            });
            this.showError(messages.webviewMessageHandlingFailed(details));
          }
        },
      );

      // Set HTML content
      this.panel.webview.html = htmlContent;

      // Handle panel disposal
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.resetWebviewReadyState();
      });

      refreshInBackground();
    }
  }

  /**
   * Update tasks in the webview
   */
  static updateTasks(tasks: ScheduledTask[]): void {
    this.currentTasks = tasks;
    this.postMessage({
      type: "updateTasks",
      tasks: tasks,
    });
  }

  /**
   * Show an error message inside the webview
   */
  static showError(errorMessage: string): void {
    this.postMessage({
      type: "showError",
      text: errorMessage,
    });
  }

  /**
   * Refresh language in the webview
   */
  static refreshLanguage(tasks: ScheduledTask[]): void {
    if (this.panel) {
      // Re-rendering HTML resets the webview context; wait for the new instance to become ready.
      this.resetWebviewReadyState();
      // Regenerate HTML with new language
      this.panel.webview.html = this.getWebviewContent(
        this.panel.webview,
        tasks,
        this.cachedAgents,
        this.cachedModels,
        this.cachedPromptTemplates,
      );

      // Re-send cached data once the webview is ready again.
      this.postMessage({
        type: "updateAgents",
        agents: this.cachedAgents,
      });
      this.postMessage({
        type: "updateModels",
        models: this.cachedModels,
      });
      this.postMessage({
        type: "updatePromptTemplates",
        templates: this.cachedPromptTemplates,
      });
    }
  }

  /**
   * Refresh cached agents/models/templates and notify the webview without rebuilding HTML.
   * Use this for settings changes (e.g., global paths) to avoid resetting form state.
   */
  static async refreshCachesAndNotifyPanel(force = true): Promise<void> {
    try {
      await this.refreshAgentsAndModels(force);
    } catch {
      this.cachedAgents = CopilotExecutor.getBuiltInAgents();
      this.cachedModels = CopilotExecutor.getFallbackModels();
    }

    try {
      await this.refreshPromptTemplates(force);
    } catch {
      this.cachedPromptTemplates = [];
    }

    if (!this.panel) return;

    this.postMessage({
      type: "updateAgents",
      agents: this.cachedAgents,
    });
    this.postMessage({
      type: "updateModels",
      models: this.cachedModels,
    });
    this.postMessage({
      type: "updatePromptTemplates",
      templates: this.cachedPromptTemplates,
    });
  }

  /**
   * Switch to the list tab, optionally showing a success toast
   */
  static switchToList(successMessage?: string): void {
    this.postMessage({ type: "switchToList", successMessage });
  }

  /**
   * Focus on a specific task
   */
  static focusTask(taskId: string): void {
    if (!taskId) return;
    this.postMessage({
      type: "focusTask",
      taskId: taskId,
    });
  }

  /**
   * Start editing a specific task (opens edit mode in the webview)
   */
  static editTask(taskId?: string): void {
    if (!taskId) return;
    this.postMessage({
      type: "editTask",
      taskId: taskId,
    });
  }

  /**
   * Handle messages from webview
   */
  private static async handleMessage(
    message: WebviewToExtensionMessage,
  ): Promise<void> {
    switch (message.type) {
      case "createTask":
        if (this.onTaskActionCallback) {
          // Use a special action for create
          this.onTaskActionCallback({
            action: "edit",
            taskId: "__create__",
            data: message.data,
          });
        }
        break;

      case "updateTask":
        if (this.onTaskActionCallback) {
          this.onTaskActionCallback({
            action: "edit",
            taskId: message.taskId,
            data: message.data,
          });
        }
        break;

      case "testPrompt":
        if (this.onTestPromptCallback) {
          this.onTestPromptCallback(
            message.prompt,
            message.agent,
            message.model,
          );
        }
        break;

      case "copyPrompt":
        await vscode.env.clipboard.writeText(message.prompt);
        notifyInfo(messages.promptCopied());
        break;

      case "refreshAgents":
        await this.refreshAgentsAndModels(true);
        this.postMessage({
          type: "updateAgents",
          agents: this.cachedAgents,
        });
        this.postMessage({
          type: "updateModels",
          models: this.cachedModels,
        });
        break;

      case "refreshPrompts":
        await this.refreshPromptTemplates(true);
        this.postMessage({
          type: "updatePromptTemplates",
          templates: this.cachedPromptTemplates,
        });
        break;

      case "runTask":
        if (this.onTaskActionCallback) {
          this.onTaskActionCallback({
            action: "run",
            taskId: message.taskId,
          });
        }
        break;

      case "toggleTask":
        if (this.onTaskActionCallback) {
          this.onTaskActionCallback({
            action: "toggle",
            taskId: message.taskId,
          });
        }
        break;

      case "deleteTask":
        if (this.onTaskActionCallback) {
          this.onTaskActionCallback({
            action: "delete",
            taskId: message.taskId,
          });
        }
        break;

      case "duplicateTask":
        if (this.onTaskActionCallback) {
          this.onTaskActionCallback({
            action: "duplicate",
            taskId: message.taskId,
          });
        }
        break;

      case "moveTaskToCurrentWorkspace":
        if (this.onTaskActionCallback) {
          this.onTaskActionCallback({
            action: "moveToCurrentWorkspace",
            taskId: message.taskId,
          });
        }
        break;

      case "loadPromptTemplate":
        await this.loadPromptTemplateContent(message.path, message.source);
        break;

      case "webviewReady":
        this.webviewReady = true;
        // Send initial data
        this.postMessage({
          type: "updateAgents",
          agents: this.cachedAgents,
        });
        this.postMessage({
          type: "updateModels",
          models: this.cachedModels,
        });
        this.postMessage({
          type: "updatePromptTemplates",
          templates: this.cachedPromptTemplates,
        });
        this.flushPendingMessages();
        break;
    }
  }

  /**
   * Refresh agents and models cache
   */
  private static async refreshAgentsAndModels(force = false): Promise<void> {
    if (
      !force &&
      this.cachedAgents.length > 0 &&
      this.cachedModels.length > 0
    ) {
      return;
    }

    try {
      this.cachedAgents = await CopilotExecutor.getAllAgents();
    } catch {
      this.cachedAgents = CopilotExecutor.getBuiltInAgents();
    }

    try {
      this.cachedModels = await CopilotExecutor.getAvailableModels();
    } catch {
      this.cachedModels = CopilotExecutor.getFallbackModels();
    }

    // Ensure we always have at least fallback data
    if (this.cachedAgents.length === 0) {
      this.cachedAgents = CopilotExecutor.getBuiltInAgents();
    }
    if (this.cachedModels.length === 0) {
      this.cachedModels = CopilotExecutor.getFallbackModels();
    }
  }

  /**
   * Refresh prompt templates cache
   */
  private static async refreshPromptTemplates(force = false): Promise<void> {
    if (!force && this.cachedPromptTemplates.length > 0) {
      return;
    }

    this.cachedPromptTemplates = await this.getPromptTemplates();
  }

  /**
   * Get prompt templates from local and global locations
   */
  private static async getPromptTemplates(): Promise<PromptTemplate[]> {
    const templates: PromptTemplate[] = [];

    // Get local templates (.github/prompts/*.md)
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of workspaceFolders) {
      const localPromptDir = path.join(folder.uri.fsPath, ".github", "prompts");
      try {
        const entries = await vscode.workspace.fs.readDirectory(
          vscode.Uri.file(localPromptDir),
        );
        for (const [file, fileType] of entries) {
          if (fileType !== vscode.FileType.File) continue;
          if (!file.endsWith(".md")) continue;
          templates.push({
            path: path.join(localPromptDir, file),
            name: file.replace(".md", ""),
            source: "local",
          });
        }
      } catch {
        // Ignore errors
      }
    }

    // Get global templates
    const globalPath = this.getGlobalPromptsPath();
    if (globalPath) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(
          vscode.Uri.file(globalPath),
        );
        for (const [file, fileType] of entries) {
          if (fileType !== vscode.FileType.File) continue;
          if (!file.endsWith(".md")) continue;
          templates.push({
            path: path.join(globalPath, file),
            name: file.replace(".md", ""),
            source: "global",
          });
        }
      } catch {
        // Ignore errors
      }
    }

    return templates;
  }

  /**
   * Get global prompts path
   */
  private static getGlobalPromptsPath(): string | undefined {
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    return resolveGlobalPromptsRoot(
      config.get<string>("globalPromptsPath", ""),
    );
  }

  /**
   * Load prompt template content
   */
  private static async loadPromptTemplateContent(
    templatePath: string,
    source: PromptSource,
  ): Promise<void> {
    try {
      const validation = validateTemplateLoadRequest({
        templatePath,
        source,
        cachedTemplates: this.cachedPromptTemplates,
        workspaceFolderPaths: (vscode.workspace.workspaceFolders ?? [])
          .map((f) => f.uri.fsPath)
          .filter(Boolean),
        globalPromptsPath: this.getGlobalPromptsPath(),
      });

      if (!validation.ok) {
        throw new Error("Template load rejected");
      }

      const content = await fs.promises.readFile(templatePath, "utf-8");
      this.postMessage({
        type: "promptTemplateLoaded",
        content: content,
        path: templatePath,
      });
    } catch {
      notifyError(messages.templateLoadError());
    }
  }

  /**
   * Generate nonce for CSP
   */
  private static getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private static serializeForWebview(value: unknown): string {
    const json = JSON.stringify(value ?? null) ?? "null";
    // Escape < and U+2028/U+2029 to avoid breaking the surrounding <script>
    return json
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }

  private static escapeHtmlAttr(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  /**
   * Generate webview HTML content
   */
  private static getWebviewContent(
    webview: vscode.Webview,
    tasks: ScheduledTask[],
    agents: AgentInfo[],
    models: ModelInfo[],
    promptTemplates: PromptTemplate[],
  ): string {
    const nonce = this.getNonce();
    const isJa = isJapanese();
    const presets = getCronPresets();
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const defaultScope = config.get<TaskScope>("defaultScope", "workspace");
    const defaultJitterSeconds = config.get<number>("jitterSeconds", 600);
    const initialTasks = Array.isArray(tasks) ? tasks : [];
    const initialAgents = Array.isArray(agents) ? agents : [];
    const initialModels = Array.isArray(models) ? models : [];
    const initialTemplates = Array.isArray(promptTemplates)
      ? promptTemplates
      : [];

    // Localized strings
    const strings = {
      title: messages.webviewTitle(),
      tabCreate: messages.tabCreate(),
      tabEdit: messages.tabEdit(),
      tabList: messages.tabList(),
      labelTaskName: messages.labelTaskName(),
      labelPromptType: messages.labelPromptType(),
      labelPromptInline: messages.labelPromptInline(),
      labelPromptLocal: messages.labelPromptLocal(),
      labelPromptGlobal: messages.labelPromptGlobal(),
      labelPrompt: messages.labelPrompt(),
      labelSchedule: messages.labelSchedule(),
      labelCronExpression: messages.labelCronExpression(),
      labelPreset: messages.labelPreset(),
      labelCustom: messages.labelCustom(),
      labelAgent: messages.labelAgent(),
      labelModel: messages.labelModel(),
      labelModelNote: isJa
        ? "モデルの選択はプレビュー機能で、環境によって反映されない場合があります。Copilot Chat パネルのモデルも確認してください。"
        : "Model selection is a preview feature and may not apply in all environments. If needed, pick the model directly in the Copilot Chat panel.",
      labelScope: messages.labelScope(),
      labelScopeGlobal: messages.labelScopeGlobal(),
      labelScopeWorkspace: messages.labelScopeWorkspace(),
      labelEnabled: messages.labelEnabled(),
      labelDisabled: messages.labelDisabled(),
      labelStatus: messages.labelStatus(),
      labelNextRun: messages.labelNextRun(),
      labelLastRun: messages.labelLastRun(),
      labelNever: messages.labelNever(),
      labelRunFirstInOneMinute: messages.labelRunFirstInOneMinute(),
      labelJitterSeconds: messages.labelJitterSeconds(),
      placeholderTaskName: messages.placeholderTaskName(),
      placeholderPrompt: messages.placeholderPrompt(),
      placeholderCron: messages.placeholderCron(),
      invalidCronExpression: messages.invalidCronExpression(),
      taskNameRequired: messages.taskNameRequired(),
      promptRequired: messages.promptRequired(),
      cronExpressionRequired: messages.cronExpressionRequired(),
      actionCreate: messages.actionCreate(),
      actionSave: messages.actionSave(),
      actionNewTask: messages.actionNewTask(),
      actionTestRun: messages.actionTestRun(),
      actionRun: messages.actionRun(),
      actionEdit: messages.actionEdit(),
      actionDelete: messages.actionDelete(),
      actionRefresh: messages.actionRefresh(),
      actionCopyPrompt: messages.actionCopyPrompt(),
      actionDuplicate: messages.actionDuplicate(),
      actionMoveToCurrentWorkspace: messages.actionMoveToCurrentWorkspace(),
      noTasksFound: messages.noTasksFound(),
      confirmDeleteTemplate: messages.confirmDelete("{name}"),
      labelAdvanced: messages.labelAdvanced(),
      labelFrequency: messages.labelFrequency(),
      labelFrequencyMinute: messages.labelFrequencyMinute(),
      labelFrequencyHourly: messages.labelFrequencyHourly(),
      labelFrequencyDaily: messages.labelFrequencyDaily(),
      labelFrequencyWeekly: messages.labelFrequencyWeekly(),
      labelFrequencyMonthly: messages.labelFrequencyMonthly(),
      labelSelectDays: messages.labelSelectDays(),
      labelSelectTime: messages.labelSelectTime(),
      labelInterval: messages.labelInterval(),
      daySun: isJa ? "日" : "Sun",
      dayMon: isJa ? "月" : "Mon",
      dayTue: isJa ? "火" : "Tue",
      dayWed: isJa ? "水" : "Wed",
      dayThu: isJa ? "木" : "Thu",
      dayFri: isJa ? "金" : "Fri",
      daySat: isJa ? "土" : "Sat",
      labelFriendlyBuilder: isJa ? "かんたんCron" : "Friendly cron builder",
      labelFriendlyGenerate: isJa ? "生成する" : "Generate",
      labelFriendlyPreview: isJa ? "プレビュー" : "Preview",
      labelFriendlyFallback: isJa
        ? "このCronの説明はありません"
        : "Preview unavailable for this expression",
      labelFriendlySelect: isJa ? "頻度を選択" : "Select frequency",
      labelEveryNMinutes: isJa ? "N分ごと" : "Every N minutes",
      labelHourlyAtMinute: isJa ? "毎時 指定分" : "Hourly at minute",
      labelDailyAtTime: isJa ? "毎日 時刻" : "Daily at time",
      labelWeeklyAtTime: isJa ? "毎週 曜日+時刻" : "Weekly at day/time",
      labelMonthlyAtTime: isJa ? "毎月 日付+時刻" : "Monthly on day/time",
      labelMinute: isJa ? "分" : "Minute",
      labelHour: isJa ? "時" : "Hour",
      labelDayOfMonth: isJa ? "実行日" : "Day of month",
      labelDayOfWeek: isJa ? "曜日" : "Day of week",
      labelOpenInGuru: isJa ? "crontab.guruを開く" : "Open in crontab.guru",
      placeholderSelectAgent: messages.webviewSelectAgentPlaceholder(),
      placeholderNoAgents: messages.webviewNoAgentsAvailable(),
      placeholderSelectModel: messages.webviewSelectModelPlaceholder(),
      placeholderNoModels: messages.webviewNoModelsAvailable(),
      placeholderSelectTemplate: messages.webviewSelectTemplatePlaceholder(),

      labelThisWorkspaceShort: messages.labelThisWorkspaceShort(),
      labelOtherWorkspaceShort: messages.labelOtherWorkspaceShort(),
    };

    const allPresets = presets;

    const serializeForWebview = this.serializeForWebview;
    const escapeHtmlAttr = this.escapeHtmlAttr;

    const initialData = {
      tasks: initialTasks,
      agents: initialAgents,
      models: initialModels,
      promptTemplates: initialTemplates,
      workspacePaths: (vscode.workspace.workspaceFolders || [])
        .map((f) => f.uri.fsPath)
        .filter(Boolean),
      defaultJitterSeconds,
      strings,
    };

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "schedulerWebview.js"),
    );

    const rawHtml = `<!DOCTYPE html>
<html lang="${isJa ? "ja" : "en"}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource}; font-src ${webview.cspSource};">
  <title>${escapeHtmlAttr(strings.title)}</title>
  <style>
    * {
      box-sizing: border-box;
    }
    
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
    }
    
    .tabs {
      display: flex;
      gap: 0;
      margin-bottom: 20px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    
    .tab-button {
      padding: 10px 20px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      font-size: 14px;
    }
    
    .tab-button:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    
    .tab-button.active {
      border-bottom-color: var(--vscode-focusBorder);
      color: var(--vscode-textLink-foreground);
    }
    
    .tab-content {
      display: none;
    }
    
    .tab-content.active {
      display: block;
    }
    
    .form-group {
      margin-bottom: 16px;
    }
    
    .form-group label {
      display: block;
      margin-bottom: 6px;
      font-weight: 500;
    }
    
    input[type="text"],
    textarea,
    select {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--vscode-input-border);
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: inherit;
      font-size: 13px;
    }
    
    textarea {
      min-height: 120px;
      resize: vertical;
    }
    
    input:focus,
    textarea:focus,
    select:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .checkbox-group input[type="checkbox"] {
      width: auto;
    }
    
    .button-group {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    
    button {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
    }
    
    .btn-primary {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    
    .btn-primary:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    
    .btn-secondary {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    
    .btn-secondary:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }
    
    .btn-danger {
      background-color: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
    }
    
    .btn-icon {
      padding: 6px 8px;
      background: transparent;
      color: var(--vscode-foreground);
    }
    
    .btn-icon:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    
    .task-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .task-card {
      padding: 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background-color: var(--vscode-editor-background);
    }

    .task-card.other-workspace {
      border-left-width: 4px;
      border-left-color: var(--vscode-inputValidation-warningBorder);
    }
    
    .task-card.disabled {
      opacity: 0.6;
    }
    
    .task-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    
    .task-name {
      font-weight: 600;
      font-size: 15px;
    }
    
    .task-name.clickable, .task-status {
      cursor: pointer;
      transition: opacity 0.2s;
    }
    
    .task-name.clickable:hover, .task-status:hover {
      opacity: 0.7;
    }
    
    .task-status {
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
    }
    
    .task-status.enabled {
      background-color: var(--vscode-testing-iconPassed);
      color: white;
    }
    
    .task-status.disabled {
      background-color: var(--vscode-disabledForeground);
      color: white;
    }
    
    .task-info {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    
    .task-info span {
      margin-right: 16px;
    }
    
    .task-prompt {
      padding: 8px;
      background-color: var(--vscode-textBlockQuote-background);
      border-radius: 4px;
      font-size: 12px;
      white-space: pre-wrap;
      max-height: 60px;
      overflow: hidden;
      margin-bottom: 8px;
    }
    
    .task-actions {
      display: flex;
      gap: 8px;
    }
    
    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
    }
    
    .radio-group {
      display: flex;
      gap: 16px;
    }
    
    .radio-group label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: normal;
    }
    
    .preset-select {
      margin-bottom: 8px;
    }
    
    .section-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--vscode-foreground);
    }
    
    .inline-group {
      display: flex;
      gap: 16px;
    }
    
    .inline-group .form-group {
      flex: 1;
    }

    .template-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .template-row select {
      flex: 1;
      min-width: 0;
    }

    .friendly-cron {
      margin-top: 10px;
      padding: 12px;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 6px;
      background-color: var(--vscode-editorWidget-background);
    }

    .friendly-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }

    .friendly-grid .form-group {
      flex: 1 1 160px;
      margin-bottom: 8px;
    }

    .friendly-field {
      display: none;
    }

    .friendly-field.visible {
      display: block;
    }

    .friendly-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 6px;
    }

    .cron-preview {
      margin-top: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      flex-wrap: wrap;
    }

    .cron-preview strong {
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <div class="tabs">
    <button type="button" class="tab-button active" data-tab="create">${strings.tabCreate}</button>
    <button type="button" class="tab-button" data-tab="list">${strings.tabList}</button>
  </div>
  
  <div id="create-tab" class="tab-content active">
    <form id="task-form">
      <div id="form-error" style="display:none; background:var(--vscode-inputValidation-errorBackground); color:var(--vscode-inputValidation-errorForeground); padding:8px 12px; border-radius:4px; margin-bottom:12px; font-size:13px;"></div>
      <input type="hidden" id="edit-task-id" value="">
      
      <div class="form-group">
        <label for="task-name">${strings.labelTaskName}</label>
        <input type="text" id="task-name" placeholder="${strings.placeholderTaskName}" required>
      </div>
      
      <div class="form-group">
        <label>${strings.labelPromptType}</label>
        <div class="radio-group">
          <label>
            <input type="radio" name="prompt-source" value="inline" checked>
            ${strings.labelPromptInline}
          </label>
          <label>
            <input type="radio" name="prompt-source" value="local">
            ${strings.labelPromptLocal}
          </label>
          <label>
            <input type="radio" name="prompt-source" value="global">
            ${strings.labelPromptGlobal}
          </label>
        </div>
      </div>
      
      <div class="form-group" id="template-select-group" style="display: none;">
        <label for="template-select">${strings.labelPrompt}</label>
        <div class="template-row">
          <select id="template-select">
            <option value="">${escapeHtmlAttr(strings.placeholderSelectTemplate)}</option>
          </select>
          <button type="button" class="btn-secondary" id="template-refresh-btn">${strings.actionRefresh}</button>
        </div>
      </div>
      
      <div class="form-group" id="prompt-group">
        <label for="prompt-text">${strings.labelPrompt}</label>
        <textarea id="prompt-text" placeholder="${strings.placeholderPrompt}" required></textarea>
      </div>
      
      <div class="form-group">
        <label>${strings.labelSchedule}</label>
        <div class="preset-select">
          <select id="cron-preset">
            <option value="">${escapeHtmlAttr(strings.labelCustom)}</option>
            ${allPresets.map((p) => `<option value="${escapeHtmlAttr(p.expression)}">${escapeHtmlAttr(p.name)}</option>`).join("")}
          </select>
        </div>
        <input type="text" id="cron-expression" placeholder="${escapeHtmlAttr(strings.placeholderCron)}" required>
        <div class="cron-preview">
          <strong>${strings.labelFriendlyPreview}:</strong>
          <span id="cron-preview-text">${strings.labelFriendlyFallback}</span>
          <button type="button" class="btn-secondary btn-icon" id="open-guru-btn">${strings.labelOpenInGuru}</button>
        </div>
        <div class="friendly-cron">
          <div class="section-title">${strings.labelFriendlyBuilder}</div>
          <div class="friendly-grid">
            <div class="form-group">
              <label for="friendly-frequency">${strings.labelFrequency}</label>
              <select id="friendly-frequency">
                <option value="">-- ${strings.labelFriendlySelect} --</option>
                <option value="every-n">${strings.labelEveryNMinutes}</option>
                <option value="hourly">${strings.labelHourlyAtMinute}</option>
                <option value="daily">${strings.labelDailyAtTime}</option>
                <option value="weekly">${strings.labelWeeklyAtTime}</option>
                <option value="monthly">${strings.labelMonthlyAtTime}</option>
              </select>
            </div>
            <div class="form-group friendly-field" data-field="interval">
              <label for="friendly-interval">${strings.labelInterval}</label>
              <input type="number" id="friendly-interval" min="1" max="59" value="5">
            </div>
            <div class="form-group friendly-field" data-field="minute">
              <label for="friendly-minute">${strings.labelMinute}</label>
              <input type="number" id="friendly-minute" min="0" max="59" value="0">
            </div>
            <div class="form-group friendly-field" data-field="hour">
              <label for="friendly-hour">${strings.labelHour}</label>
              <input type="number" id="friendly-hour" min="0" max="23" value="9">
            </div>
            <div class="form-group friendly-field" data-field="dow">
              <label for="friendly-dow">${strings.labelDayOfWeek}</label>
              <select id="friendly-dow">
                <option value="0">${strings.daySun}</option>
                <option value="1">${strings.dayMon}</option>
                <option value="2">${strings.dayTue}</option>
                <option value="3">${strings.dayWed}</option>
                <option value="4">${strings.dayThu}</option>
                <option value="5">${strings.dayFri}</option>
                <option value="6">${strings.daySat}</option>
              </select>
            </div>
            <div class="form-group friendly-field" data-field="dom">
              <label for="friendly-dom">${strings.labelDayOfMonth}</label>
              <input type="number" id="friendly-dom" min="1" max="31" value="1">
            </div>
          </div>
          <div class="friendly-actions">
            <button type="button" class="btn-secondary" id="friendly-generate">${strings.labelFriendlyGenerate}</button>
          </div>
        </div>
      </div>
      
      <div class="inline-group">
        <div class="form-group">
          <label for="agent-select">${strings.labelAgent}</label>
          <select id="agent-select">
            ${initialAgents.length > 0 ? `<option value="">${escapeHtmlAttr(strings.placeholderSelectAgent)}</option>` + initialAgents.map((a) => `<option value="${escapeHtmlAttr(a.id || "")}">${escapeHtmlAttr(a.name || "")}</option>`).join("") : `<option value="">${escapeHtmlAttr(strings.placeholderNoAgents)}</option>`}
          </select>
        </div>
        
        <div class="form-group">
          <label for="model-select">${strings.labelModel}</label>
          <select id="model-select">
            ${initialModels.length > 0 ? `<option value="">${escapeHtmlAttr(strings.placeholderSelectModel)}</option>` + initialModels.map((m) => `<option value="${escapeHtmlAttr(m.id || "")}">${escapeHtmlAttr(m.name || "")}</option>`).join("") : `<option value="">${escapeHtmlAttr(strings.placeholderNoModels)}</option>`}
          </select>
          <p class="note">${strings.labelModelNote}</p>
        </div>
      </div>
      
      <div class="form-group">
        <label>${strings.labelScope}</label>
        <div class="radio-group">
          <label>
            <input type="radio" name="scope" value="workspace" ${defaultScope === "workspace" ? "checked" : ""}>
            ${strings.labelScopeWorkspace}
          </label>
          <label>
            <input type="radio" name="scope" value="global" ${defaultScope === "global" ? "checked" : ""}>
            ${strings.labelScopeGlobal}
          </label>
        </div>
      </div>
      
      <div class="form-group">
        <div class="checkbox-group">
          <input type="checkbox" id="run-first">
          <label for="run-first">${strings.labelRunFirstInOneMinute}</label>
        </div>
      </div>

      <div class="form-group">
        <label for="jitter-seconds">${strings.labelJitterSeconds}</label>
        <input type="number" id="jitter-seconds" min="0" max="1800" value="${escapeHtmlAttr(String(defaultJitterSeconds))}">
        <p class="note" style="margin-top:4px;">0 ${isJa ? "で無効。値を入れると0〜その秒数でランダム遅延します。" : "disables jitter. Adds a random delay between 0 and the specified seconds before execution."}</p>
      </div>
      
      <div class="button-group">
        <button type="submit" class="btn-primary" id="submit-btn">${strings.actionCreate}</button>
        <button type="button" class="btn-secondary" id="new-task-btn" style="display:none;">${strings.actionNewTask}</button>
        <button type="button" class="btn-secondary" id="test-btn">${strings.actionTestRun}</button>
      </div>
    </form>
  </div>
  
  <div id="list-tab" class="tab-content">
    <div id="success-toast" style="display:none; background:var(--vscode-notificationsInfoIcon-foreground, #3794ff); color:#fff; padding:8px 14px; border-radius:4px; margin-bottom:12px; font-size:13px; opacity:1; transition:opacity 0.5s ease-out;"></div>
    <div class="button-group" style="margin-bottom: 16px;">
      <button class="btn-secondary" id="refresh-btn">${strings.actionRefresh}</button>
    </div>
    <div id="task-list" class="task-list">
      <div class="empty-state">${strings.noTasksFound}</div>
    </div>
  </div>
  
  <script nonce="${nonce}" id="initial-data" type="application/json">${serializeForWebview(initialData)}</script>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;

    return rawHtml;
  }
}
