/**
 * Copilot Scheduler - Scheduler Webview
 * Provides GUI for task creation, editing, and listing
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type {
  ScheduledTask,
  CreateTaskInput,
  TaskAction,
  AgentInfo,
  ModelInfo,
  PromptTemplate,
  TaskScope,
  PromptSource,
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
        "promptPilot",
        "Prompt Pilot",
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
      this.panel.webview.html = this.getWebviewContent(
        this.panel.webview,
        tasks,
      );

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
   * Refresh language in the webview
   */
  static refreshLanguage(tasks: ScheduledTask[]): void {
    if (this.panel) {
      // Regenerate HTML with new language
      this.panel.webview.html = this.getWebviewContent(
        this.panel.webview,
        tasks,
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
        vscode.window.showInformationMessage(messages.promptCopied());
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
    if (!force && this.cachedAgents.length > 0) {
      return;
    }

    this.cachedAgents = await CopilotExecutor.getAllAgents();
    this.cachedModels = await CopilotExecutor.getAvailableModels();
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
        if (fs.existsSync(globalPath)) {
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
    const config = vscode.workspace.getConfiguration("promptPilot");
    const customPath = config.get<string>("globalPromptsPath", "");

    if (customPath) {
      return customPath;
    }

    // Default paths
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (!homeDir) {
      return undefined;
    }

    // Try VS Code user prompts path
    const appData = process.env.APPDATA;
    if (appData) {
      const vscodePromptsPath = path.join(appData, "Code", "User", "prompts");
      if (fs.existsSync(vscodePromptsPath)) {
        return vscodePromptsPath;
      }
    }

    // Try ~/.github/prompts
    const githubPromptsPath = path.join(homeDir, ".github", "prompts");
    if (fs.existsSync(githubPromptsPath)) {
      return githubPromptsPath;
    }

    return undefined;
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
      vscode.window.showErrorMessage(messages.templateLoadError());
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
  ): string {
    const nonce = this.getNonce();
    const isJa = isJapanese();
    const presets = getCronPresets();
    const config = vscode.workspace.getConfiguration("promptPilot");
    const defaultScope = config.get<TaskScope>("defaultScope", "workspace");

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
      actionCreate: messages.actionCreate(),
      actionSave: messages.actionSave(),
      actionTestRun: messages.actionTestRun(),
      actionRun: messages.actionRun(),
      actionEdit: messages.actionEdit(),
      actionDelete: messages.actionDelete(),
      actionRefresh: messages.actionRefresh(),
      actionCopyPrompt: messages.actionCopyPrompt(),
      noTasksFound: messages.noTasksFound(),
      confirmDelete: (name: string) => messages.confirmDelete(name),
    };

    return `<!DOCTYPE html>
<html lang="${isJa ? "ja" : "en"}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https:; font-src ${webview.cspSource};">
  <title>Prompt Pilot</title>
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
  </style>
</head>
<body>
  <div class="tabs">
    <button class="tab-button active" data-tab="create">${strings.tabCreate}</button>
    <button class="tab-button" data-tab="list">${strings.tabList}</button>
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
            <option value="">${strings.labelCustom}</option>
            ${presets.map((p) => `<option value="${p.expression}">${p.name}</option>`).join("")}
          </select>
        </div>
        <input type="text" id="cron-expression" placeholder="${strings.placeholderCron}">
      </div>
      
      <div class="inline-group">
        <div class="form-group">
          <label for="agent-select">${strings.labelAgent}</label>
          <select id="agent-select">
            <option value="">Loading...</option>
          </select>
        </div>
        
        <div class="form-group">
          <label for="model-select">${strings.labelModel}</label>
          <select id="model-select">
            <option value="">Loading...</option>
          </select>
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
  
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      
      // Initial data
      let tasks = ${JSON.stringify(tasks)};
      let agents = [];
      let models = [];
      let promptTemplates = [];
      let editingTaskId = null;
      
      const strings = ${JSON.stringify(strings)};
      
      // DOM elements
      const tabButtons = document.querySelectorAll('.tab-button');
      const tabContents = document.querySelectorAll('.tab-content');
      const taskForm = document.getElementById('task-form');
      const taskList = document.getElementById('task-list');
      const editTaskIdInput = document.getElementById('edit-task-id');
      const submitBtn = document.getElementById('submit-btn');
      const testBtn = document.getElementById('test-btn');
      const refreshBtn = document.getElementById('refresh-btn');
      const cronPreset = document.getElementById('cron-preset');
      const cronExpression = document.getElementById('cron-expression');
      const agentSelect = document.getElementById('agent-select');
      const modelSelect = document.getElementById('model-select');
      const templateSelect = document.getElementById('template-select');
      const templateSelectGroup = document.getElementById('template-select-group');
      const promptGroup = document.getElementById('prompt-group');
      const promptSourceRadios = document.querySelectorAll('input[name="prompt-source"]');
      
      // Tab switching
      tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          const tab = btn.dataset.tab;
          tabButtons.forEach(b => b.classList.remove('active'));
          tabContents.forEach(c => c.classList.remove('active'));
          btn.classList.add('active');
          document.getElementById(tab + '-tab').classList.add('active');
        });
      });
      
      // Prompt source handling
      promptSourceRadios.forEach(radio => {
        radio.addEventListener('change', () => {
          const source = radio.value;
          if (source === 'inline') {
            templateSelectGroup.style.display = 'none';
            promptGroup.style.display = 'block';
          } else {
            templateSelectGroup.style.display = 'block';
            promptGroup.style.display = 'block';
            updateTemplateOptions(source);
          }
        });
      });
      
      // Cron preset handling
      cronPreset.addEventListener('change', () => {
        if (cronPreset.value) {
          cronExpression.value = cronPreset.value;
        }
      });
      
      cronExpression.addEventListener('input', () => {
        cronPreset.value = '';
      });
      
      // Template selection
      templateSelect.addEventListener('change', () => {
        const selectedPath = templateSelect.value;
        if (selectedPath) {
          const source = document.querySelector('input[name="prompt-source"]:checked').value;
          vscode.postMessage({
            type: 'loadPromptTemplate',
            path: selectedPath,
            source: source
          });
        }
      });
      
      // Form submission
      taskForm.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const taskData = {
          name: document.getElementById('task-name').value,
          prompt: document.getElementById('prompt-text').value,
          cronExpression: cronExpression.value,
          agent: agentSelect.value,
          model: modelSelect.value,
          scope: document.querySelector('input[name="scope"]:checked').value,
          promptSource: document.querySelector('input[name="prompt-source"]:checked').value,
          promptPath: templateSelect.value,
          runFirstInOneMinute: document.getElementById('run-first').checked,
          enabled: true
        };
        
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
        
        // Reset form
        resetForm();
      });
      
      // Test button
      testBtn.addEventListener('click', () => {
        const prompt = document.getElementById('prompt-text').value;
        const agent = agentSelect.value;
        const model = modelSelect.value;
        
        if (prompt) {
          vscode.postMessage({
            type: 'testPrompt',
            prompt: prompt,
            agent: agent,
            model: model
          });
        }
      });
      
      // Refresh button
      refreshBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'refreshAgents' });
        vscode.postMessage({ type: 'refreshPrompts' });
      });
      
      // Render task list
      function renderTaskList() {
        if (tasks.length === 0) {
          taskList.innerHTML = '<div class="empty-state">' + strings.noTasksFound + '</div>';
          return;
        }
        
        taskList.innerHTML = tasks.map(task => {
          const statusClass = task.enabled ? 'enabled' : 'disabled';
          const statusText = task.enabled ? strings.labelEnabled : strings.labelDisabled;
          const nextRun = task.nextRun ? new Date(task.nextRun).toLocaleString() : strings.labelNever;
          const lastRun = task.lastRun ? new Date(task.lastRun).toLocaleString() : strings.labelNever;
          const promptPreview = task.prompt.length > 100 ? task.prompt.substring(0, 100) + '...' : task.prompt;
          
          return '<div class="task-card ' + (task.enabled ? '' : 'disabled') + '" data-id="' + task.id + '">' +
            '<div class="task-header">' +
              '<span class="task-name">' + escapeHtml(task.name) + '</span>' +
              '<span class="task-status ' + statusClass + '">' + statusText + '</span>' +
            '</div>' +
            '<div class="task-info">' +
              '<span>⏰ ' + task.cronExpression + '</span>' +
              '<span>' + strings.labelNextRun + ': ' + nextRun + '</span>' +
            '</div>' +
            '<div class="task-prompt">' + escapeHtml(promptPreview) + '</div>' +
            '<div class="task-actions">' +
              '<button class="btn-secondary btn-icon" onclick="runTask(\\'' + task.id + '\\')" title="' + strings.actionRun + '">▶</button>' +
              '<button class="btn-secondary btn-icon" onclick="editTask(\\'' + task.id + '\\')" title="' + strings.actionEdit + '">✏️</button>' +
              '<button class="btn-secondary btn-icon" onclick="copyPrompt(\\'' + task.id + '\\')" title="' + strings.actionCopyPrompt + '">📋</button>' +
              '<button class="btn-danger btn-icon" onclick="deleteTask(\\'' + task.id + '\\')" title="' + strings.actionDelete + '">🗑️</button>' +
            '</div>' +
          '</div>';
        }).join('');
      }
      
      // Helper functions
      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }
      
      function resetForm() {
        taskForm.reset();
        editingTaskId = null;
        editTaskIdInput.value = '';
        submitBtn.textContent = strings.actionCreate;
        templateSelectGroup.style.display = 'none';
        promptGroup.style.display = 'block';
      }
      
      function updateAgentOptions() {
        agentSelect.innerHTML = agents.map(a => 
          '<option value="' + a.id + '">' + a.name + '</option>'
        ).join('');
      }
      
      function updateModelOptions() {
        modelSelect.innerHTML = models.map(m => 
          '<option value="' + m.id + '">' + m.name + '</option>'
        ).join('');
      }
      
      function updateTemplateOptions(source) {
        const filtered = promptTemplates.filter(t => t.source === source);
        templateSelect.innerHTML = '<option value="">-- Select Template --</option>' +
          filtered.map(t => '<option value="' + t.path + '">' + t.name + '</option>').join('');
      }
      
      // Global functions for onclick handlers
      window.runTask = function(id) {
        vscode.postMessage({ type: 'runTask', taskId: id });
      };
      
      window.editTask = function(id) {
        const task = tasks.find(t => t.id === id);
        if (!task) return;
        
        editingTaskId = id;
        document.getElementById('task-name').value = task.name;
        document.getElementById('prompt-text').value = task.prompt;
        cronExpression.value = task.cronExpression;
        cronPreset.value = '';
        
        if (task.agent) agentSelect.value = task.agent;
        if (task.model) modelSelect.value = task.model;
        
        document.querySelector('input[name="scope"][value="' + task.scope + '"]').checked = true;
        document.querySelector('input[name="prompt-source"][value="' + task.promptSource + '"]').checked = true;
        
        if (task.promptSource !== 'inline') {
          templateSelectGroup.style.display = 'block';
          updateTemplateOptions(task.promptSource);
          if (task.promptPath) templateSelect.value = task.promptPath;
        }
        
        submitBtn.textContent = strings.actionSave;
        
        // Switch to create tab
        document.querySelector('.tab-button[data-tab="create"]').click();
      };
      
      window.copyPrompt = function(id) {
        const task = tasks.find(t => t.id === id);
        if (task) {
          vscode.postMessage({ type: 'copyPrompt', prompt: task.prompt });
        }
      };
      
      window.deleteTask = function(id) {
        const task = tasks.find(t => t.id === id);
        if (task && confirm(strings.confirmDelete(task.name))) {
          vscode.postMessage({ type: 'deleteTask', taskId: id });
        }
      };
      
      // Handle messages from extension
      window.addEventListener('message', event => {
        const message = event.data;
        
        switch (message.type) {
          case 'updateTasks':
            tasks = message.tasks;
            renderTaskList();
            break;
          case 'updateAgents':
            agents = message.agents;
            updateAgentOptions();
            break;
          case 'updateModels':
            models = message.models;
            updateModelOptions();
            break;
          case 'updatePromptTemplates':
            promptTemplates = message.templates;
            break;
          case 'promptTemplateLoaded':
            document.getElementById('prompt-text').value = message.content;
            break;
          case 'switchToList':
            document.querySelector('.tab-button[data-tab="list"]').click();
            break;
          case 'focusTask':
            document.querySelector('.tab-button[data-tab="list"]').click();
            const card = document.querySelector('.task-card[data-id="' + message.taskId + '"]');
            if (card) card.scrollIntoView({ behavior: 'smooth' });
            break;
        }
      });
      
      // Initial render
      renderTaskList();
      
      // Notify extension that webview is ready
      vscode.postMessage({ type: 'webviewReady' });
    })();
  </script>
</body>
</html>`;
  }
}

