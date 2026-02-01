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

    // Refresh agents and models
    await this.refreshAgentsAndModels();
    await this.refreshPromptTemplates();

    if (this.panel) {
      // Reveal existing panel
      this.panel.reveal(vscode.ViewColumn.One);
      this.updateTasks(tasks);
    } else {
      // Create new panel
      this.panel = vscode.window.createWebviewPanel(
        "copilotScheduler",
        "Copilot Scheduler",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [extensionUri],
        },
      );

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

      this.panel.webview.html = htmlContent;

      // Handle messages from webview
      this.panel.webview.onDidReceiveMessage(
        async (message: WebviewToExtensionMessage) => {
          await this.handleMessage(message);
        },
      );

      // Handle panel disposal
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }
  }

  /**
   * Update tasks in the webview
   */
  static updateTasks(tasks: ScheduledTask[]): void {
    this.currentTasks = tasks;
    if (this.panel) {
      this.panel.webview.postMessage({
        type: "updateTasks",
        tasks: tasks,
      });
    }
  }

  /**
   * Show an error message inside the webview
   */
  static showError(errorMessage: string): void {
    if (this.panel) {
      this.panel.webview.postMessage({
        type: "showError",
        text: errorMessage,
      });
    }
  }

  /**
   * Refresh language in the webview
   */
  static refreshLanguage(tasks: ScheduledTask[]): void {
    if (this.panel) {
      // Regenerate HTML with new language
      this.panel.webview.html = this.getWebviewContent(
        this.panel.webview,
        tasks,
        this.cachedAgents,
        this.cachedModels,
        this.cachedPromptTemplates,
      );
    }
  }

  /**
   * Switch to the list tab
   */
  static switchToList(): void {
    if (this.panel) {
      this.panel.webview.postMessage({ type: "switchToList" });
    }
  }

  /**
   * Focus on a specific task
   */
  static focusTask(taskId: string): void {
    if (this.panel) {
      this.panel.webview.postMessage({
        type: "focusTask",
        taskId: taskId,
      });
    }
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
          const action: TaskAction = {
            action: "edit",
            taskId: "",
            data: message.data,
          };
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
        if (this.panel) {
          this.panel.webview.postMessage({
            type: "updateAgents",
            agents: this.cachedAgents,
          });
          this.panel.webview.postMessage({
            type: "updateModels",
            models: this.cachedModels,
          });
        }
        break;

      case "refreshPrompts":
        await this.refreshPromptTemplates(true);
        if (this.panel) {
          this.panel.webview.postMessage({
            type: "updatePromptTemplates",
            templates: this.cachedPromptTemplates,
          });
        }
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

      case "loadPromptTemplate":
        await this.loadPromptTemplateContent(message.path, message.source);
        break;

      case "webviewReady":
        // Send initial data
        if (this.panel) {
          this.panel.webview.postMessage({
            type: "updateAgents",
            agents: this.cachedAgents,
          });
          this.panel.webview.postMessage({
            type: "updateModels",
            models: this.cachedModels,
          });
          this.panel.webview.postMessage({
            type: "updatePromptTemplates",
            templates: this.cachedPromptTemplates,
          });
        }
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
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      const localPromptDir = path.join(workspaceRoot, ".github", "prompts");
      try {
        if (fs.existsSync(localPromptDir)) {
          const files = fs.readdirSync(localPromptDir);
          for (const file of files) {
            if (file.endsWith(".md")) {
              templates.push({
                path: path.join(localPromptDir, file),
                name: file.replace(".md", ""),
                source: "local",
              });
            }
          }
        }
      } catch {
        // Ignore errors
      }
    }

    // Get global templates
    const globalPath = this.getGlobalPromptsPath();
    if (globalPath) {
      try {
        const files = fs.readdirSync(globalPath);
        for (const file of files) {
          if (file.endsWith(".md")) {
            templates.push({
              path: path.join(globalPath, file),
              name: file.replace(".md", ""),
              source: "global",
            });
          }
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
    const customPath = config.get<string>("globalPromptsPath", "");
    const defaultPath = process.env.APPDATA
      ? path.join(process.env.APPDATA, "Code", "User", "prompts")
      : "";

    const targetPath = customPath || defaultPath;
    if (!targetPath) {
      return undefined;
    }

    return fs.existsSync(targetPath) ? targetPath : undefined;
  }

  /**
   * Load prompt template content
   */
  private static async loadPromptTemplateContent(
    templatePath: string,
    source: PromptSource,
  ): Promise<void> {
    try {
      const content = fs.readFileSync(templatePath, "utf-8");
      if (this.panel) {
        this.panel.webview.postMessage({
          type: "promptTemplateLoaded",
          content: content,
          path: templatePath,
        });
      }
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
    const initialTasks = Array.isArray(tasks) ? tasks : [];
    const initialAgents = Array.isArray(agents) ? agents : [];
    const initialModels = Array.isArray(models) ? models : [];
    const initialTemplates = Array.isArray(promptTemplates)
      ? promptTemplates
      : [];

    // Localized strings
    const strings = {
      tabCreate: messages.tabCreate(),
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
      placeholderTaskName: messages.placeholderTaskName(),
      placeholderPrompt: messages.placeholderPrompt(),
      placeholderCron: messages.placeholderCron(),
      invalidCronExpression: messages.invalidCronExpression(),
      actionCreate: messages.actionCreate(),
      actionSave: messages.actionSave(),
      actionTestRun: messages.actionTestRun(),
      actionRun: messages.actionRun(),
      actionEdit: messages.actionEdit(),
      actionDelete: messages.actionDelete(),
      actionRefresh: messages.actionRefresh(),
      actionCopyPrompt: messages.actionCopyPrompt(),
      actionDuplicate: messages.actionDuplicate(),
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
    };

    const extraPresets: CronPreset[] = [
      {
        id: "extra-hourly-00",
        expression: "0 * * * *",
        name: isJa ? "毎時" : "Every hour",
        description: isJa ? "毎時 00 分" : "Top of every hour",
      },
      {
        id: "extra-daily-9",
        expression: "0 9 * * *",
        name: isJa ? "毎日 09:00" : "Daily 09:00",
        description: isJa ? "毎日 09:00 に実行" : "Run every day at 09:00",
      },
      {
        id: "extra-weekday-9",
        expression: "0 9 * * 1-5",
        name: isJa ? "平日 09:00" : "Weekdays 09:00",
        description: isJa ? "平日 09:00" : "Weekdays at 09:00",
      },
      {
        id: "extra-monthly-1st-9",
        expression: "0 9 1 * *",
        name: isJa ? "毎月1日 09:00" : "Monthly 1st 09:00",
        description: isJa
          ? "毎月1日に実行"
          : "Run on the 1st each month at 09:00",
      },
    ];

    const allPresets = presets.concat(extraPresets);

    const serializeForWebview = (value: unknown): string => {
      const json = JSON.stringify(value ?? null) ?? "null";
      // Escape < and U+2028/U+2029 to avoid breaking the surrounding <script> via document.write
      return json
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
    };

    // Helper to escape HTML attributes
    const escapeHtmlAttr = (str: string): string => {
      return str
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    };

    const initialData = {
      tasks: initialTasks,
      agents: initialAgents,
      models: initialModels,
      promptTemplates: initialTemplates,
      strings,
    };

    return `<!DOCTYPE html>
<html lang="${isJa ? "ja" : "en"}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https:; font-src ${webview.cspSource};">
  <title>Copilot Scheduler</title>
  <style>
    :root {
      --vscode-font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    }
    
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
        <select id="template-select">
          <option value="">-- Select Template --</option>
        </select>
      </div>
      
      <div class="form-group" id="prompt-group">
        <label for="prompt-text">${strings.labelPrompt}</label>
        <textarea id="prompt-text" placeholder="${strings.placeholderPrompt}"></textarea>
      </div>
      
      <div class="form-group">
        <label>${strings.labelSchedule}</label>
        <div class="preset-select">
          <select id="cron-preset">
            <option value="">${escapeHtmlAttr(strings.labelCustom)}</option>
            ${allPresets.map((p) => `<option value="${escapeHtmlAttr(p.expression)}">${escapeHtmlAttr(p.name)}</option>`).join("")}
          </select>
        </div>
        <input type="text" id="cron-expression" placeholder="${escapeHtmlAttr(strings.placeholderCron)}">
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
            ${initialAgents.length > 0 ? '<option value="">-- Select Agent --</option>' + initialAgents.map((a) => `<option value="${escapeHtmlAttr(a.id || "")}">${escapeHtmlAttr(a.name || "")}</option>`).join("") : '<option value="">Loading...</option>'}
          </select>
        </div>
        
        <div class="form-group">
          <label for="model-select">${strings.labelModel}</label>
          <select id="model-select">
            ${initialModels.length > 0 ? '<option value="">-- Select Model --</option>' + initialModels.map((m) => `<option value="${escapeHtmlAttr(m.id || "")}">${escapeHtmlAttr(m.name || "")}</option>`).join("") : '<option value="">Loading...</option>'}
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
      
      <div class="button-group">
        <button type="submit" class="btn-primary" id="submit-btn">${strings.actionCreate}</button>
        <button type="button" class="btn-secondary" id="test-btn">${strings.actionTestRun}</button>
      </div>
    </form>
  </div>
  
  <div id="list-tab" class="tab-content">
    <div class="button-group" style="margin-bottom: 16px;">
      <button class="btn-secondary" id="refresh-btn">${strings.actionRefresh}</button>
    </div>
    <div id="task-list" class="task-list">
      <div class="empty-state">${strings.noTasksFound}</div>
    </div>
  </div>
  
  <script id="initial-data" type="application/json">${serializeForWebview(initialData)}</script>

  <script nonce="${nonce}">
    (function() {
      var vscode = acquireVsCodeApi();
      
      // Initial data (JSON from inline script tag)
      var initialData = {};
      try {
        var initialScript = document.getElementById('initial-data');
        if (initialScript && initialScript.textContent) {
          initialData = JSON.parse(initialScript.textContent) || {};
        }
      } catch (e) {
        initialData = {};
      }

      var tasks = Array.isArray(initialData.tasks) ? initialData.tasks : [];
      var agents = Array.isArray(initialData.agents) ? initialData.agents : [];
      var models = Array.isArray(initialData.models) ? initialData.models : [];
      var promptTemplates = Array.isArray(initialData.promptTemplates)
        ? initialData.promptTemplates
        : [];
      var editingTaskId = null;

      var strings = initialData.strings || {};
      var lastRenderedTasksHtml = '';
      
      // DOM elements - with null safety
      var taskForm = document.getElementById('task-form');
      var taskList = document.getElementById('task-list');
      var editTaskIdInput = document.getElementById('edit-task-id');
      var submitBtn = document.getElementById('submit-btn');
      var testBtn = document.getElementById('test-btn');
      var refreshBtn = document.getElementById('refresh-btn');
      var cronPreset = document.getElementById('cron-preset');
      var cronExpression = document.getElementById('cron-expression');
      var agentSelect = document.getElementById('agent-select');
      var modelSelect = document.getElementById('model-select');
      var templateSelect = document.getElementById('template-select');
      var templateSelectGroup = document.getElementById('template-select-group');
      var promptGroup = document.getElementById('prompt-group');
      var friendlyFrequency = document.getElementById('friendly-frequency');
      var friendlyInterval = document.getElementById('friendly-interval');
      var friendlyMinute = document.getElementById('friendly-minute');
      var friendlyHour = document.getElementById('friendly-hour');
      var friendlyDow = document.getElementById('friendly-dow');
      var friendlyDom = document.getElementById('friendly-dom');
      var friendlyGenerate = document.getElementById('friendly-generate');
      var openGuruBtn = document.getElementById('open-guru-btn');
      var cronPreviewText = document.getElementById('cron-preview-text');
      
      // Tab switching function
      function switchTab(tabName) {
        document.querySelectorAll('.tab-button').forEach(function(b) { 
          b.classList.remove('active'); 
        });
        document.querySelectorAll('.tab-content').forEach(function(c) { 
          c.classList.remove('active'); 
        });
        var targetBtn = document.querySelector('.tab-button[data-tab="' + tabName + '"]');
        var targetContent = document.getElementById(tabName + '-tab');
        if (targetBtn) targetBtn.classList.add('active');
        if (targetContent) targetContent.classList.add('active');
      }
      
      // Use event delegation for tab buttons (more reliable)
      document.addEventListener('click', function(e) {
        var target = e.target;
        if (target && target.classList && target.classList.contains('tab-button')) {
          e.preventDefault();
          e.stopPropagation();
          var tabName = target.getAttribute('data-tab');
          if (tabName) {
            switchTab(tabName);
          }
        }
      });
      
      // Use event delegation for prompt source radio buttons
      document.addEventListener('change', function(e) {
        var target = e.target;
        if (target && target.name === 'prompt-source' && target.checked) {
          applyPromptSource(target.value);
        }
      });
      
      // Cron preset handling with null check
      if (cronPreset && cronExpression) {
        cronPreset.addEventListener('change', function() {
          if (cronPreset.value) {
            cronExpression.value = cronPreset.value;
          }
          updateCronPreview();
        });
        
        cronExpression.addEventListener('input', function() {
          cronPreset.value = '';
          updateCronPreview();
        });
      }

      if (friendlyFrequency) {
        friendlyFrequency.addEventListener('change', function() {
          updateFriendlyVisibility();
        });
      }

      if (friendlyGenerate) {
        friendlyGenerate.addEventListener('click', function() {
          generateCronFromFriendly();
        });
      }

      if (openGuruBtn) {
        openGuruBtn.addEventListener('click', function() {
          var expression = cronExpression ? cronExpression.value.trim() : '';
          if (!expression) {
            expression = '* * * * *';
          }
          var targetUrl = 'https://crontab.guru/#' + encodeURIComponent(expression);
          window.open(targetUrl, '_blank');
        });
      }
      
      // Template selection with null check
      if (templateSelect) {
        templateSelect.addEventListener('change', function() {
          var selectedPath = templateSelect.value;
          if (selectedPath) {
            var sourceEl = document.querySelector('input[name="prompt-source"]:checked');
            var source = sourceEl ? sourceEl.value : 'inline';
            vscode.postMessage({
              type: 'loadPromptTemplate',
              path: selectedPath,
              source: source
            });
          }
        });
      }
      
      // Form submission with null checks
      if (taskForm) {
        taskForm.addEventListener('submit', function(e) {
          e.preventDefault();
          
          var taskNameEl = document.getElementById('task-name');
          var promptTextEl = document.getElementById('prompt-text');
          var scopeEl = document.querySelector('input[name="scope"]:checked');
          var promptSourceEl = document.querySelector('input[name="prompt-source"]:checked');
          var runFirstEl = document.getElementById('run-first');
          
          var taskData = {
            name: taskNameEl ? taskNameEl.value : '',
            prompt: promptTextEl ? promptTextEl.value : '',
            cronExpression: cronExpression ? cronExpression.value : '',
            agent: agentSelect ? agentSelect.value : '',
            model: modelSelect ? modelSelect.value : '',
            scope: scopeEl ? scopeEl.value : 'workspace',
            promptSource: promptSourceEl ? promptSourceEl.value : 'inline',
            promptPath: templateSelect ? templateSelect.value : '',
            runFirstInOneMinute: runFirstEl ? runFirstEl.checked : false,
            enabled: true
          };

          var cronValue = (taskData.cronExpression || '').trim();
          if (!cronValue) {
            window.alert(strings.invalidCronExpression || 'Invalid cron expression');
            return;
          }
          
          if (editingTaskId) {
            vscode.postMessage({
              type: 'updateTask',
              taskId: editingTaskId,
              data: taskData
            });
          } else {
            vscode.postMessage({
              type: 'createTask',
              data: taskData
            });
          }
          
          // Reset form and switch to list tab
          resetForm();
          switchTab('list');
        });
      }
      
      // Test button with null check
      if (testBtn) {
        testBtn.addEventListener('click', function() {
          var promptTextEl = document.getElementById('prompt-text');
          var prompt = promptTextEl ? promptTextEl.value : '';
          var agent = agentSelect ? agentSelect.value : '';
          var model = modelSelect ? modelSelect.value : '';
          
          if (prompt) {
            vscode.postMessage({
              type: 'testPrompt',
              prompt: prompt,
              agent: agent,
              model: model
            });
          }
        });
      }
      
      // Refresh button with null check
      if (refreshBtn) {
        refreshBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'refreshAgents' });
          vscode.postMessage({ type: 'refreshPrompts' });
        });
      }
      
      // Task action delegation (single listener)
      function resolveActionTarget(node) {
        var el = node && node.nodeType === 3 ? node.parentElement : node;
        while (el && el !== document.body) {
          if (el.hasAttribute && el.hasAttribute('data-action') && el.hasAttribute('data-id')) {
            return el;
          }
          el = el.parentElement;
        }
        return null;
      }

      document.addEventListener('click', function(e) {
        var actionTarget = resolveActionTarget(e.target);
        if (!actionTarget) {
          return;
        }

        if (!taskList || !taskList.isConnected) {
          taskList = document.getElementById('task-list');
        }
        if (taskList && !taskList.contains(actionTarget)) {
          return;
        }

        var action = actionTarget.getAttribute('data-action');
        var taskId = actionTarget.getAttribute('data-id');
        if (!action || !taskId) {
          return;
        }

        var actionHandlers = {
          toggle: window.toggleTask,
          run: window.runTask,
          edit: window.editTask,
          copy: window.copyPrompt,
          duplicate: window.duplicateTask,
          delete: window.deleteTask
        };

        var handler = actionHandlers[action];
        if (typeof handler === 'function') {
          e.preventDefault();
          handler(taskId);
        }
      });
      
      // Render task list
      function renderTaskList(nextTasks) {
        if (Array.isArray(nextTasks)) {
          tasks = nextTasks.filter(Boolean);
        }

        if (!taskList || !taskList.isConnected) {
          taskList = document.getElementById('task-list');
        }
        if (!taskList) return;

        var taskItems = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
        var renderedTasks = '';

        if (taskItems.length === 0) {
          renderedTasks = '<div class="empty-state">' + strings.noTasksFound + '</div>';
        } else {
          renderedTasks = taskItems.map(function(task) {
            if (!task || !task.id) {
              return '';
            }

            var enabled = task.enabled || false;
            var statusClass = enabled ? 'enabled' : 'disabled';
            var statusText = enabled ? strings.labelEnabled : strings.labelDisabled;
            var toggleIcon = enabled ? '⏸️' : '▶️';
            var toggleTitle = enabled ? 'Disable' : 'Enable';
            var nextRun = task.nextRun ? new Date(task.nextRun).toLocaleString() : strings.labelNever;
            var promptText = typeof task.prompt === 'string' ? task.prompt : '';
            var promptPreview = promptText.length > 100 ? promptText.substring(0, 100) + '...' : promptText;
            var cronText = escapeHtml(task.cronExpression || '');
            var taskName = escapeHtml(task.name || '');

            // Escape for HTML attributes to avoid broken inline handlers
            var taskIdEscaped = escapeAttr(task.id || '');

            return '<div class="task-card ' + (enabled ? '' : 'disabled') + '" data-id="' + taskIdEscaped + '">' +
              '<div class="task-header">' +
                '<span class="task-name clickable" data-action="toggle" data-id="' + taskIdEscaped + '">' + taskName + '</span>' +
                '<span class="task-status ' + statusClass + '" data-action="toggle" data-id="' + taskIdEscaped + '">' + statusText + '</span>' +
              '</div>' +
              '<div class="task-info">' +
                '<span>⏰ ' + cronText + '</span>' +
                '<span>' + strings.labelNextRun + ': ' + nextRun + '</span>' +
              '</div>' +
              '<div class="task-prompt">' + escapeHtml(promptPreview) + '</div>' +
              '<div class="task-actions">' +
                '<button class="btn-secondary btn-icon" data-action="toggle" data-id="' + taskIdEscaped + '" title="' + toggleTitle + '">' + toggleIcon + '</button>' +
                '<button class="btn-secondary btn-icon" data-action="run" data-id="' + taskIdEscaped + '" title="' + strings.actionRun + '">🚀</button>' +
                '<button class="btn-secondary btn-icon" data-action="edit" data-id="' + taskIdEscaped + '" title="' + strings.actionEdit + '">✏️</button>' +
                '<button class="btn-secondary btn-icon" data-action="copy" data-id="' + taskIdEscaped + '" title="' + strings.actionCopyPrompt + '">📋</button>' +
                '<button class="btn-secondary btn-icon" data-action="duplicate" data-id="' + taskIdEscaped + '" title="' + strings.actionDuplicate + '">📄</button>' +
                '<button class="btn-danger btn-icon" data-action="delete" data-id="' + taskIdEscaped + '" title="' + strings.actionDelete + '">🗑️</button>' +
              '</div>' +
            '</div>';
          }).filter(Boolean).join('');

          if (!renderedTasks) {
            renderedTasks = '<div class="empty-state">' + strings.noTasksFound + '</div>';
          }
        }

        if (renderedTasks === lastRenderedTasksHtml) {
          return;
        }

        lastRenderedTasksHtml = renderedTasks;
        taskList.innerHTML = renderedTasks;
      }
      
      // Helper functions
      function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }
      
      function escapeAttr(text) {
        if (typeof text !== 'string') text = String(text || '');
        return text
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      var dayNames = [
        strings.daySun || 'Sun',
        strings.dayMon || 'Mon',
        strings.dayTue || 'Tue',
        strings.dayWed || 'Wed',
        strings.dayThu || 'Thu',
        strings.dayFri || 'Fri',
        strings.daySat || 'Sat'
      ];

      function padNumber(value) {
        var num = parseInt(String(value), 10);
        if (isNaN(num)) num = 0;
        return num < 10 ? '0' + num : String(num);
      }

      function boundedNumber(value, min, max, fallback) {
        var num = parseInt(String(value), 10);
        if (isNaN(num)) {
          num = fallback;
        }
        num = Math.max(min, Math.min(max, num));
        return num;
      }

      function normalizeDow(value) {
        var normalized = String(value || '').trim().toLowerCase();
        if (/^\\d+$/.test(normalized)) {
          var asNumber = parseInt(normalized, 10);
          if (asNumber === 7) asNumber = 0;
          if (asNumber >= 0 && asNumber <= 6) return asNumber;
        }

        var map = {
          sun: 0,
          mon: 1,
          tue: 2,
          wed: 3,
          thu: 4,
          fri: 5,
          sat: 6
        };

        if (map.hasOwnProperty(normalized)) {
          return map[normalized];
        }

        return null;
      }

      function formatTime(hour, minute) {
        return padNumber(hour) + ':' + padNumber(minute);
      }

      function getCronSummary(expression) {
        var fallback = strings.labelFriendlyFallback || 'Preview unavailable for this expression';
        var expr = (expression || '').trim();
        if (!expr) return fallback;

        var parts = expr.split(/\\s+/);
        if (parts.length !== 5) {
          return fallback + ' (' + expr + ')';
        }

        var minute = parts[0];
        var hour = parts[1];
        var dom = parts[2];
        var mon = parts[3];
        var dow = parts[4];

        var isNumber = function(value) { return /^\\d+$/.test(String(value)); };
        var dowLower = String(dow || '').toLowerCase();
        var isWeekdays = dowLower === '1-5' || dowLower === 'mon-fri';
        var everyN = /^\\*\\/(\\d+)$/.exec(minute);

        if (everyN && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
          return 'Every ' + everyN[1] + ' minutes';
        }

        if (isNumber(minute) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
          return 'Hourly at minute ' + minute;
        }

        if (isNumber(minute) && isNumber(hour) && dom === '*' && mon === '*' && dow === '*') {
          return 'Daily at ' + formatTime(hour, minute);
        }

        if (isNumber(minute) && isNumber(hour) && dom === '*' && mon === '*' && isWeekdays) {
          return 'Weekdays at ' + formatTime(hour, minute);
        }

        var dowValue = normalizeDow(dow);
        if (isNumber(minute) && isNumber(hour) && dom === '*' && mon === '*' && dowValue !== null) {
          var dayLabel = dayNames[dowValue] || ('Day ' + dowValue);
          return 'Weekly on ' + dayLabel + ' at ' + formatTime(hour, minute);
        }

        if (isNumber(minute) && isNumber(hour) && isNumber(dom) && mon === '*' && dow === '*') {
          return 'Monthly on day ' + dom + ' at ' + formatTime(hour, minute);
        }

        return fallback + ' (' + expr + ')';
      }

      function updateCronPreview() {
        if (!cronPreviewText || !cronExpression) return;
        cronPreviewText.textContent = getCronSummary(cronExpression.value || '');
      }

      function updateFriendlyVisibility() {
        var selection = friendlyFrequency ? friendlyFrequency.value : '';
        var fields = [];
        switch (selection) {
          case 'every-n':
            fields = ['interval'];
            break;
          case 'hourly':
            fields = ['minute'];
            break;
          case 'daily':
            fields = ['hour', 'minute'];
            break;
          case 'weekly':
            fields = ['dow', 'hour', 'minute'];
            break;
          case 'monthly':
            fields = ['dom', 'hour', 'minute'];
            break;
          default:
            fields = [];
        }

        var friendlyFields = document.querySelectorAll('.friendly-field');
        friendlyFields.forEach(function(el) {
          if (!el || !el.getAttribute) return;
          var fieldName = el.getAttribute('data-field');
          if (fields.indexOf(fieldName) !== -1) {
            el.classList.add('visible');
          } else {
            el.classList.remove('visible');
          }
        });
      }

      function generateCronFromFriendly() {
        if (!friendlyFrequency || !cronExpression) return;
        var selection = friendlyFrequency.value;
        var expr = '';

        switch (selection) {
          case 'every-n': {
            var interval = boundedNumber(friendlyInterval ? friendlyInterval.value : '', 1, 59, 5);
            expr = '*/' + interval + ' * * * *';
            break;
          }
          case 'hourly': {
            var minuteValue = boundedNumber(friendlyMinute ? friendlyMinute.value : '', 0, 59, 0);
            expr = minuteValue + ' * * * *';
            break;
          }
          case 'daily': {
            var dailyMinute = boundedNumber(friendlyMinute ? friendlyMinute.value : '', 0, 59, 0);
            var dailyHour = boundedNumber(friendlyHour ? friendlyHour.value : '', 0, 23, 9);
            expr = dailyMinute + ' ' + dailyHour + ' * * *';
            break;
          }
          case 'weekly': {
            var weeklyMinute = boundedNumber(friendlyMinute ? friendlyMinute.value : '', 0, 59, 0);
            var weeklyHour = boundedNumber(friendlyHour ? friendlyHour.value : '', 0, 23, 9);
            var dowValue = boundedNumber(friendlyDow ? friendlyDow.value : '', 0, 6, 1);
            expr = weeklyMinute + ' ' + weeklyHour + ' * * ' + dowValue;
            break;
          }
          case 'monthly': {
            var monthlyMinute = boundedNumber(friendlyMinute ? friendlyMinute.value : '', 0, 59, 0);
            var monthlyHour = boundedNumber(friendlyHour ? friendlyHour.value : '', 0, 23, 9);
            var domValue = boundedNumber(friendlyDom ? friendlyDom.value : '', 1, 31, 1);
            expr = monthlyMinute + ' ' + monthlyHour + ' ' + domValue + ' * *';
            break;
          }
          default:
            expr = '';
        }

        if (expr) {
          cronExpression.value = expr;
          if (cronPreset) cronPreset.value = '';
          updateCronPreview();
        }
      }
      
      function resetForm() {
        if (taskForm) taskForm.reset();
        editingTaskId = null;
        if (editTaskIdInput) editTaskIdInput.value = '';
        if (submitBtn) submitBtn.textContent = strings.actionCreate;
        applyPromptSource('inline');
        if (friendlyFrequency) friendlyFrequency.value = '';
        updateFriendlyVisibility();
        updateCronPreview();
      }
      
      function updateAgentOptions() {
        if (!agentSelect) return;
        var items = Array.isArray(agents) ? agents : [];
        if (items.length === 0) {
          agentSelect.innerHTML = '<option value="">-- No agents available --</option>';
        } else {
          var placeholder = '<option value="">-- Select Agent --</option>';
          agentSelect.innerHTML = placeholder + items.map(function(a) { 
            return '<option value="' + escapeAttr(a.id) + '">' + escapeHtml(a.name) + '</option>';
          }).join('');
        }
      }
      
      function updateModelOptions() {
        if (!modelSelect) return;
        var items = Array.isArray(models) ? models : [];
        if (items.length === 0) {
          modelSelect.innerHTML = '<option value="">-- No models available --</option>';
        } else {
          var placeholder = '<option value="">-- Select Model --</option>';
          modelSelect.innerHTML = placeholder + items.map(function(m) { 
            return '<option value="' + escapeAttr(m.id) + '">' + escapeHtml(m.name) + '</option>';
          }).join('');
        }
      }
      
      function updateTemplateOptions(source, selectedPath) {
        if (!templateSelect) return;
        selectedPath = selectedPath || '';
        var templates = Array.isArray(promptTemplates) ? promptTemplates : [];
        var filtered = templates.filter(function(t) { return t.source === source; });
        var placeholder = '<option value="">-- Select Template --</option>';
        templateSelect.innerHTML = placeholder +
          filtered.map(function(t) { return '<option value="' + escapeAttr(t.path) + '">' + escapeHtml(t.name) + '</option>'; }).join('');

        if (selectedPath && templateSelect.querySelector('option[value="' + selectedPath + '"]')) {
          templateSelect.value = selectedPath;
        } else {
          templateSelect.value = '';
        }
      }

      function applyPromptSource(source, keepSelection) {
        var effectiveSource = source || 'inline';
        var selectedPath = keepSelection && templateSelect ? templateSelect.value : '';

        if (effectiveSource === 'inline') {
          if (templateSelectGroup) templateSelectGroup.style.display = 'none';
          if (promptGroup) promptGroup.style.display = 'block';
          if (!keepSelection && templateSelect) {
            templateSelect.value = '';
          }
          return;
        }

        if (templateSelectGroup) {
          templateSelectGroup.style.display = 'block';
        } else {
          console.warn('[CopilotScheduler] Template select group missing; template selection is disabled.');
        }
        if (promptGroup) promptGroup.style.display = 'block';
        updateTemplateOptions(effectiveSource, selectedPath);
      }

      // Initialize dropdowns with cached data
      updateAgentOptions();
      updateModelOptions();
      var initialPromptSource = document.querySelector('input[name="prompt-source"]:checked');
      if (initialPromptSource) {
        applyPromptSource(initialPromptSource.value);
      }
      updateFriendlyVisibility();
      updateCronPreview();
      
      // Global functions for onclick handlers
      window.runTask = function(id) {
        vscode.postMessage({ type: 'runTask', taskId: id });
      };
      
      window.editTask = function(id) {
        var taskListArray = Array.isArray(tasks) ? tasks : [];
        var task = taskListArray.find(function(t) { return t && t.id === id; });
        if (!task) return;
        
        editingTaskId = id;
        var taskNameEl = document.getElementById('task-name');
        var promptTextEl = document.getElementById('prompt-text');
        if (taskNameEl) taskNameEl.value = task.name || '';
        if (promptTextEl) promptTextEl.value = typeof task.prompt === 'string' ? task.prompt : '';
        if (cronExpression) cronExpression.value = task.cronExpression || '';
        if (cronPreset) cronPreset.value = '';
        updateCronPreview();
        
        if (task.agent && agentSelect) agentSelect.value = task.agent;
        if (task.model && modelSelect) modelSelect.value = task.model;
        var scopeValue = task.scope || 'workspace';
        var scopeRadio = document.querySelector('input[name="scope"][value="' + scopeValue + '"]');
        if (scopeRadio) {
          scopeRadio.checked = true;
        }
        var sourceValue = task.promptSource || 'inline';
        var sourceRadio = document.querySelector('input[name="prompt-source"][value="' + sourceValue + '"]');
        if (sourceRadio) {
          sourceRadio.checked = true;
        }

        applyPromptSource(sourceValue, true);
        if (task.promptPath && templateSelect) templateSelect.value = task.promptPath;
        
        // Clear "run first" checkbox in edit mode (not applicable for existing tasks)
        var runFirstEl = document.getElementById('run-first');
        if (runFirstEl) runFirstEl.checked = false;
        
        if (submitBtn) submitBtn.textContent = strings.actionSave;
        
        // Switch to create tab
        switchTab('create');
      };
      
      window.copyPrompt = function(id) {
        var task = tasks.find(function(t) { return t && t.id === id; });
        if (task) {
          vscode.postMessage({ type: 'copyPrompt', prompt: task.prompt || '' });
        }
      };

      window.duplicateTask = function(id) {
        vscode.postMessage({ type: 'duplicateTask', taskId: id });
      };
      
      window.toggleTask = function(id) {
        vscode.postMessage({ type: 'toggleTask', taskId: id });
      };
      
      window.deleteTask = function(id) {
        var task = tasks.find(function(t) { return t && t.id === id; });
        if (!task) {
          return;
        }

        // Send delete request to extension (confirmation will be handled there)
        vscode.postMessage({ type: 'deleteTask', taskId: id, taskName: task.name });
      };
      
      // Handle messages from extension
      window.addEventListener('message', function(event) {
        var message = event.data;
        
        switch (message.type) {
          case 'updateTasks':
            renderTaskList(message.tasks);
            break;
          case 'updateAgents':
            {
              var currentAgentValue = agentSelect ? agentSelect.value : '';
              agents = Array.isArray(message.agents) ? message.agents : [];
              updateAgentOptions();
              if (agentSelect && currentAgentValue && agentSelect.querySelector('option[value="' + currentAgentValue + '"]')) {
                agentSelect.value = currentAgentValue;
              }
            }
            break;
          case 'updateModels':
            {
              var currentModelValue = modelSelect ? modelSelect.value : '';
              models = Array.isArray(message.models) ? message.models : [];
              updateModelOptions();
              if (modelSelect && currentModelValue && modelSelect.querySelector('option[value="' + currentModelValue + '"]')) {
                modelSelect.value = currentModelValue;
              }
            }
            break;
          case 'updatePromptTemplates':
            promptTemplates = Array.isArray(message.templates) ? message.templates : [];
            {
              var sourceElement = document.querySelector('input[name="prompt-source"]:checked');
              var currentSource = sourceElement ? sourceElement.value : 'inline';
              updateTemplateOptions(currentSource, templateSelect ? templateSelect.value : '');
              if (currentSource === 'local' || currentSource === 'global') {
                if (templateSelectGroup) templateSelectGroup.style.display = 'block';
              } else {
                if (templateSelectGroup) templateSelectGroup.style.display = 'none';
              }
            }
            break;
          case 'promptTemplateLoaded':
            var promptTextEl = document.getElementById('prompt-text');
            if (promptTextEl) promptTextEl.value = message.content;
            break;
          case 'switchToList':
            switchTab('list');
            break;
          case 'focusTask':
            switchTab('list');
            setTimeout(function() {
              var card = document.querySelector('.task-card[data-id="' + message.taskId + '"]');
              if (card) card.scrollIntoView({ behavior: 'smooth' });
            }, 100);
            break;
          case 'showError':
            if (message.text) {
              window.alert(message.text);
            }
            break;
        }
      });
      
      // Initial render
      renderTaskList(tasks);
      
      // Notify extension that webview is ready
      vscode.postMessage({ type: 'webviewReady' });
    })();
  </script>
</body>
</html>`;
  }
}
