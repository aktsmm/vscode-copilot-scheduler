/**
 * Copilot Scheduler - Scheduler Webview
 * Provides GUI for task creation, editing, and listing
 */

import * as vscode from "vscode";
import * as path from "path";
import type {
  ScheduledTask,
  CreateTaskInput,
  TaskAction,
  AgentInfo,
  ModelInfo,
  PromptTemplate,
  TaskScope,
  WebviewToExtensionMessage,
  PromptExecutionRequest,
} from "./types";
import { CopilotExecutor } from "./copilotExecutor";
import { messages, isJapanese, getCronPresets } from "./i18n";
import { logError } from "./logger";
import { validateTemplateLoadRequest } from "./templateValidation";
import {
  getPromptTemplateDisplayName,
  isPromptTemplateMarkdownFile,
  resolveGlobalPromptsRoot,
} from "./promptResolver";
import { sanitizeAbsolutePathDetails } from "./errorSanitizer";
import {
  buildModelPickerGroups,
  filterPickerModelCatalog,
} from "./modelSelection";

type OutgoingWebviewMessage = { type: string; [key: string]: unknown };

/**
 * Manages the Webview panel for task management
 */
export class SchedulerWebview {
  private static panel: vscode.WebviewPanel | undefined;
  private static cachedAgents: AgentInfo[] = [];
  private static cachedModels: ModelInfo[] = [];
  private static cachedPromptTemplates: PromptTemplate[] = [];
  private static hasShownPromptTemplateRefreshError = false;
  private static onTaskActionCallback:
    | ((action: TaskAction) => void)
    | undefined;
  private static onTestPromptCallback:
    | ((request: PromptExecutionRequest) => void)
    | undefined;
  private static extensionUri: vscode.Uri;
  private static currentTasks: ScheduledTask[] = [];
  private static webviewReady = false;
  private static pendingMessages: OutgoingWebviewMessage[] = [];

  private static getFormDefaults(): {
    defaultScope: TaskScope;
    defaultAutoMode: boolean;
    defaultJitterSeconds: number;
  } {
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const defaultScope = config.get<TaskScope>("defaultScope", "workspace");
    const defaultAutoMode = config.get<boolean>("autoModeDefault", false);
    const defaultJitterSecondsRaw = config.get<number>("jitterSeconds", 600);
    const defaultJitterSeconds = (() => {
      const n =
        typeof defaultJitterSecondsRaw === "number"
          ? defaultJitterSecondsRaw
          : Number(defaultJitterSecondsRaw);
      if (!Number.isFinite(n)) return 600;
      const i = Math.floor(n);
      return Math.min(Math.max(i, 0), 1800);
    })();

    return {
      defaultScope,
      defaultAutoMode,
      defaultJitterSeconds,
    };
  }

  private static resetWebviewReadyState(): void {
    this.webviewReady = false;
    this.pendingMessages = [];
    this.hasShownPromptTemplateRefreshError = false;
  }

  private static hasResolvedModelCatalog(
    models: readonly ModelInfo[],
  ): boolean {
    return models.some(
      (model) => typeof model.id === "string" && model.id.trim().length > 0,
    );
  }

  private static localizeCachedModels(
    models: readonly ModelInfo[],
  ): ModelInfo[] {
    if (!Array.isArray(models) || models.length === 0) {
      return CopilotExecutor.getFallbackModels();
    }

    return models.map((model) => {
      if ((model.id || "").trim().length > 0) {
        return model;
      }

      return {
        ...model,
        name: messages.modelDefaultName(),
        label: messages.modelDefaultName(),
        description: messages.modelDefaultDesc(),
        vendor: "",
      };
    });
  }

  private static buildModelPickerPayload(models: readonly ModelInfo[]): {
    modelPickerDefault: ReturnType<typeof buildModelPickerGroups>;
  } {
    const relabelDefaultVariant = (
      groups: ReturnType<typeof buildModelPickerGroups>,
    ) =>
      groups.map((group) => ({
        ...group,
        variants: group.variants.map((variant) => ({
          ...variant,
          label:
            variant.label === "Default"
              ? messages.labelModelVariantDefault()
              : variant.label,
        })),
      }));

    return {
      modelPickerDefault: relabelDefaultVariant(
        buildModelPickerGroups(filterPickerModelCatalog(models)),
      ),
    };
  }

  private static buildUpdateModelsMessage(): OutgoingWebviewMessage {
    return {
      type: "updateModels",
      models: this.cachedModels,
      ...this.buildModelPickerPayload(this.cachedModels),
    };
  }

  /**
   * Dispose the webview panel (e.g., on extension deactivation)
   */
  static dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      // onDidDispose handler will reset panel & readyState
    }
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
      // Route through the wrapper to keep all sending logic consistent (U2).
      this.postMessage(message);
    }
  }

  /**
   * Show or reveal the webview panel
   */
  static async show(
    extensionUri: vscode.Uri,
    tasks: ScheduledTask[],
    onTaskAction: (action: TaskAction) => void,
    onTestPrompt?: (request: PromptExecutionRequest) => void,
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
    } else {
      this.cachedModels = this.localizeCachedModels(this.cachedModels);
    }

    const refreshInBackground = (forcePromptRefresh: boolean): void => {
      void this.refreshAgentsAndModels(true)
        .then(() => {
          this.postMessage({
            type: "updateAgents",
            agents: this.cachedAgents,
          });
          this.postMessage(this.buildUpdateModelsMessage());
        })
        .catch((error) => {
          const rawMessage =
            error instanceof Error ? error.message : String(error ?? "");
          logError(
            "[CopilotScheduler] Failed to refresh agents/models:",
            this.sanitizeErrorDetailsForUser(rawMessage),
          );
        });

      void this.refreshPromptTemplates(forcePromptRefresh)
        .then(() => {
          this.postMessage({
            type: "updatePromptTemplates",
            templates: this.cachedPromptTemplates,
          });
        })
        .catch((error) => {
          const rawMessage =
            error instanceof Error ? error.message : String(error ?? "");
          logError(
            "[CopilotScheduler] Failed to refresh prompt templates:",
            this.sanitizeErrorDetailsForUser(rawMessage),
          );
        });
    };

    if (this.panel) {
      // Reveal existing panel — send cached data immediately, then refresh in background.
      this.panel.reveal(vscode.ViewColumn.One);
      this.updateTasks(tasks);
      // Send already-cached agents/models/templates without rescanning
      this.postMessage({
        type: "updateAgents",
        agents: this.cachedAgents,
      });
      this.postMessage(this.buildUpdateModelsMessage());
      this.postMessage({
        type: "updatePromptTemplates",
        templates: this.cachedPromptTemplates,
      });
      // Keep reveal responsive while still syncing template file changes.
      refreshInBackground(true);
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
            const rawDetails =
              error instanceof Error ? error.message : String(error ?? "");
            const detailsForLog = this.sanitizeErrorDetailsForUser(rawDetails);
            const detailsForUser = this.resolveDisplayErrorMessage(rawDetails);
            logError("[CopilotScheduler] Webview message handling failed:", {
              type: (message as { type?: unknown } | undefined)?.type,
              error: detailsForLog,
            });
            this.showError(
              messages.webviewMessageHandlingFailed(detailsForUser),
            );
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

      // First open: populate caches from source files.
      refreshInBackground(true);
    }
  }

  /**
   * Update tasks in the webview
   */
  private static getCurrentWorkspacePaths(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .map((f) => f.uri.fsPath)
      .filter(Boolean);
  }

  static updateTasks(tasks: ScheduledTask[]): void {
    this.currentTasks = tasks;
    this.postMessage({
      type: "updateTasks",
      tasks: tasks,
      workspacePaths: this.getCurrentWorkspacePaths(),
    });
  }

  /**
   * Show an error message inside the webview
   */
  static showError(errorMessage: string): void {
    const text = this.resolveDisplayErrorMessage(errorMessage);
    this.postMessage({
      type: "showError",
      text,
    });
  }

  private static sanitizeErrorDetailsForUser(message: string): string {
    const sanitized = sanitizeAbsolutePathDetails(
      message,
      messages.redactedPlaceholder(),
    );
    return sanitized.trim() ? sanitized : messages.webviewUnknown();
  }

  private static resolveDisplayErrorMessage(message: string): string {
    const safe = this.sanitizeErrorDetailsForUser(message);
    const firstLine = safe.split(/\r?\n/)[0] ?? "";
    return firstLine.trim() ? firstLine : messages.webviewUnknown();
  }

  /**
   * Refresh language in the webview
   */
  static refreshLanguage(tasks: ScheduledTask[]): void {
    if (this.panel) {
      // Re-rendering HTML resets the webview context; wait for the new instance to become ready.
      this.resetWebviewReadyState();

      // Synchronously rebuild built-in agents/models so the initial HTML
      // already reflects the new language (U17: avoid stale localized names).
      this.cachedAgents = CopilotExecutor.getBuiltInAgents();
      this.cachedModels = this.hasResolvedModelCatalog(this.cachedModels)
        ? this.localizeCachedModels(this.cachedModels)
        : CopilotExecutor.getFallbackModels();

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
      this.postMessage(this.buildUpdateModelsMessage());
      this.postMessage({
        type: "updatePromptTemplates",
        templates: this.cachedPromptTemplates,
      });

      // Re-fetch agents/models/templates so that localized names reflect the new language
      void this.refreshCachesAndNotifyPanel(true).catch(() => {});
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
      this.cachedModels = this.hasResolvedModelCatalog(this.cachedModels)
        ? this.localizeCachedModels(this.cachedModels)
        : CopilotExecutor.getFallbackModels();
    }

    const previousPromptTemplates = this.cachedPromptTemplates;
    try {
      await this.refreshPromptTemplates(force);
      this.hasShownPromptTemplateRefreshError = false;
    } catch (error) {
      this.cachedPromptTemplates = previousPromptTemplates;
      const rawMessage =
        error instanceof Error ? error.message : String(error ?? "");
      logError(
        "[CopilotScheduler] Failed to refresh prompt templates:",
        this.sanitizeErrorDetailsForUser(rawMessage),
      );
      if (this.panel && !this.hasShownPromptTemplateRefreshError) {
        this.hasShownPromptTemplateRefreshError = true;
        this.showError(messages.templateLoadError());
      }
    }

    if (!this.panel) return;

    this.postMessage({
      type: "updateAgents",
      agents: this.cachedAgents,
    });
    this.postMessage(this.buildUpdateModelsMessage());
    this.postMessage({
      type: "updatePromptTemplates",
      templates: this.cachedPromptTemplates,
    });
  }

  /**
   * Refresh settings-backed defaults in the existing webview without rebuilding HTML.
   */
  static refreshFormDefaults(): void {
    if (!this.panel) return;
    this.postMessage({
      type: "updateDefaults",
      ...this.getFormDefaults(),
    });
  }

  /**
   * Switch to the list tab, optionally showing a success toast
   */
  static switchToList(successMessage?: string): void {
    this.postMessage({ type: "switchToList", successMessage });
  }

  /**
   * Force the webview into "create new task" mode (clears edit state and form).
   */
  static startCreateTask(): void {
    this.postMessage({ type: "startCreateTask" });
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
          this.onTestPromptCallback({
            prompt: message.prompt,
            agent: message.agent,
            model: message.model,
            modelName: message.modelName,
            modelVendor: message.modelVendor,
            modelFamily: message.modelFamily,
            modelVersion: message.modelVersion,
          });
        }
        break;

      case "refreshAgents":
        await this.refreshAgentsAndModels(true);
        this.postMessage({
          type: "updateAgents",
          agents: this.cachedAgents,
        });
        this.postMessage(this.buildUpdateModelsMessage());
        break;

      case "refreshPrompts":
        {
          const previousPromptTemplates = this.cachedPromptTemplates;
          try {
            await this.refreshPromptTemplates(true);
            this.hasShownPromptTemplateRefreshError = false;
          } catch (error) {
            this.cachedPromptTemplates = previousPromptTemplates;
            const rawMessage =
              error instanceof Error ? error.message : String(error ?? "");
            logError(
              "[CopilotScheduler] Failed to refresh prompt templates:",
              this.sanitizeErrorDetailsForUser(rawMessage),
            );
            this.showError(messages.templateLoadError());
          }
        }
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

      case "copyTask":
        if (this.onTaskActionCallback) {
          this.onTaskActionCallback({
            action: "copy",
            taskId: message.taskId,
          });
        }
        break;

      case "loadPromptTemplate":
        await this.loadPromptTemplateContent(message.path, message.source);
        break;

      case "webviewReady":
        this.webviewReady = true;
        // Flush any messages that were queued while the webview was not ready.
        // Cached agents/models/templates are already enqueued by refreshLanguage
        // or show(), so we only need to flush here to avoid duplicates.
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
      const result = await CopilotExecutor.getAvailableModelsWithSource();
      if (
        result.source === "fallback" &&
        this.hasResolvedModelCatalog(this.cachedModels)
      ) {
        this.cachedModels = this.localizeCachedModels(this.cachedModels);
      } else {
        this.cachedModels = this.localizeCachedModels(result.models);
      }
    } catch {
      this.cachedModels = this.hasResolvedModelCatalog(this.cachedModels)
        ? this.localizeCachedModels(this.cachedModels)
        : CopilotExecutor.getFallbackModels();
    }

    // Ensure we always have at least fallback data
    if (this.cachedAgents.length === 0) {
      this.cachedAgents = CopilotExecutor.getBuiltInAgents();
    }
    if (this.cachedModels.length === 0) {
      this.cachedModels = CopilotExecutor.getFallbackModels();
    } else {
      this.cachedModels = this.localizeCachedModels(this.cachedModels);
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

  private static buildPromptTemplateContextLabel(
    templatePath: string,
    source: "local" | "global",
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    globalPath?: string,
  ): string {
    const resolvedTemplatePath = path.resolve(templatePath);

    if (source === "local") {
      for (const folder of workspaceFolders) {
        const promptsRoot = path.join(folder.uri.fsPath, ".github", "prompts");
        const relativePath = path.relative(promptsRoot, resolvedTemplatePath);
        if (
          !relativePath ||
          relativePath.startsWith("..") ||
          path.isAbsolute(relativePath)
        ) {
          continue;
        }

        const relativeDir = path.dirname(relativePath);
        const sourceLabel = messages.labelPromptLocal();
        if (relativeDir && relativeDir !== ".") {
          return `${sourceLabel}: ${folder.name}/${relativeDir}`;
        }
        return workspaceFolders.length > 1
          ? `${sourceLabel}: ${folder.name}`
          : sourceLabel;
      }

      return messages.labelPromptLocal();
    }

    if (globalPath) {
      const relativePath = path.relative(globalPath, resolvedTemplatePath);
      if (
        relativePath &&
        !relativePath.startsWith("..") &&
        !path.isAbsolute(relativePath)
      ) {
        const relativeDir = path.dirname(relativePath);
        if (relativeDir && relativeDir !== ".") {
          return `${messages.labelPromptGlobal()}: ${relativeDir}`;
        }
      }
    }

    return messages.labelPromptGlobal();
  }

  private static applyPromptTemplateDisplayNames(
    templates: PromptTemplate[],
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    globalPath?: string,
  ): PromptTemplate[] {
    const nameCounts = new Map<string, number>();
    for (const template of templates) {
      nameCounts.set(template.name, (nameCounts.get(template.name) ?? 0) + 1);
    }

    return templates.map((template) => {
      if ((nameCounts.get(template.name) ?? 0) <= 1) {
        return template;
      }

      return {
        ...template,
        displayName: `${template.name} (${this.buildPromptTemplateContextLabel(template.path, template.source, workspaceFolders, globalPath)})`,
      };
    });
  }

  private static async collectMarkdownTemplatePaths(
    rootDir: vscode.Uri,
  ): Promise<string[]> {
    const files: string[] = [];
    const dirsToScan: vscode.Uri[] = [rootDir];

    while (dirsToScan.length > 0) {
      const currentDir = dirsToScan.pop();
      if (!currentDir) {
        continue;
      }

      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(currentDir);
      } catch {
        continue;
      }

      for (const [name, fileType] of entries) {
        const entryUri = vscode.Uri.joinPath(currentDir, name);

        if (fileType === vscode.FileType.Directory) {
          dirsToScan.push(entryUri);
          continue;
        }

        if (fileType !== vscode.FileType.File) {
          continue;
        }

        if (!isPromptTemplateMarkdownFile(name)) {
          continue;
        }

        files.push(entryUri.fsPath);
      }
    }

    return files;
  }

  /**
   * Get prompt templates from local and global locations
   */
  private static async getPromptTemplates(): Promise<PromptTemplate[]> {
    const templates: PromptTemplate[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

    // Get local templates (.github/prompts/*.md)
    for (const folder of workspaceFolders) {
      const localPromptDir = vscode.Uri.joinPath(
        folder.uri,
        ".github",
        "prompts",
      );
      const templatePaths =
        await this.collectMarkdownTemplatePaths(localPromptDir);
      for (const templatePath of templatePaths) {
        templates.push({
          path: templatePath,
          name: getPromptTemplateDisplayName(templatePath),
          source: "local",
        });
      }
    }

    // Get global templates
    const globalPath = this.getGlobalPromptsPath();
    if (globalPath) {
      const templatePaths = await this.collectMarkdownTemplatePaths(
        vscode.Uri.file(globalPath),
      );
      for (const templatePath of templatePaths) {
        templates.push({
          path: templatePath,
          name: getPromptTemplateDisplayName(templatePath),
          source: "global",
        });
      }
    }

    const templatesWithDisplayNames = this.applyPromptTemplateDisplayNames(
      templates,
      workspaceFolders,
      globalPath,
    );
    templatesWithDisplayNames.sort((a, b) =>
      (a.displayName || a.name).localeCompare(b.displayName || b.name),
    );
    return templatesWithDisplayNames;
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
    source: "local" | "global",
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
        throw new Error(`Template load rejected: ${validation.reason}`);
      }

      const resolvedPath = path.resolve(templatePath);
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(resolvedPath),
      );
      const content = Buffer.from(bytes).toString("utf8");
      this.postMessage({
        type: "promptTemplateLoaded",
        content: content,
        path: templatePath,
      });
    } catch (error) {
      const templateFile = path.basename(templatePath);
      const rawError =
        error instanceof Error ? error.message : String(error ?? "");
      const safeError = this.sanitizeErrorDetailsForUser(rawError);
      logError("[CopilotScheduler] Template load failed:", {
        templateFile,
        source,
        error: safeError,
      });
      const message = messages.templateLoadError();
      this.showError(message);
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

  private static escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
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
    const { defaultScope, defaultAutoMode, defaultJitterSeconds } =
      this.getFormDefaults();
    const initialTasks = Array.isArray(tasks) ? tasks : [];
    const initialAgents = Array.isArray(agents) ? agents : [];
    const initialModels = Array.isArray(models) ? models : [];
    const initialTemplates = Array.isArray(promptTemplates)
      ? promptTemplates
      : [];
    const initialModelPickerPayload =
      this.buildModelPickerPayload(initialModels);

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
      labelModelVariant: messages.labelModelVariant(),
      labelModelVariantDefault: messages.labelModelVariantDefault(),
      labelModelNote: messages.labelModelNote(),
      labelModelVariantNote: messages.labelModelVariantNote(),
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
      labelAutoMode: messages.labelAutoMode(),
      labelJitterSeconds: messages.labelJitterSeconds(),
      labelMaxExecutionsPerDay: messages.labelMaxExecutionsPerDay(),
      labelAllowedTimeWindow: messages.labelAllowedTimeWindow(),
      labelAllowedTimeStart: messages.labelAllowedTimeStart(),
      labelAllowedTimeEnd: messages.labelAllowedTimeEnd(),
      placeholderTaskName: messages.placeholderTaskName(),
      placeholderPrompt: messages.placeholderPrompt(),
      placeholderCron: messages.placeholderCron(),
      invalidCronExpression: messages.invalidCronExpression(),
      invalidTimeWindowFormat: messages.invalidTimeWindowFormat(),
      taskNameRequired: messages.taskNameRequired(),
      promptRequired: messages.promptRequired(),
      templateRequired: messages.templateRequired(),
      templateLoadingInProgress: messages.templateLoadingInProgress(),
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
      actionEnable: messages.actionEnable(),
      actionDisable: messages.actionDisable(),
      noTasksFound: messages.noTasksFound(),
      emptyStateDescription: messages.emptyStateDescription(),
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
      daySun: messages.daySun(),
      dayMon: messages.dayMon(),
      dayTue: messages.dayTue(),
      dayWed: messages.dayWed(),
      dayThu: messages.dayThu(),
      dayFri: messages.dayFri(),
      daySat: messages.daySat(),
      labelFriendlyBuilder: messages.labelFriendlyBuilder(),
      labelFriendlyGenerate: messages.labelFriendlyGenerate(),
      labelFriendlyPreview: messages.labelFriendlyPreview(),
      labelFriendlyFallback: messages.labelFriendlyFallback(),
      labelFriendlySelect: messages.labelFriendlySelect(),
      labelEveryNMinutes: messages.labelEveryNMinutes(),
      labelHourlyAtMinute: messages.labelHourlyAtMinute(),
      labelDailyAtTime: messages.labelDailyAtTime(),
      labelWeeklyAtTime: messages.labelWeeklyAtTime(),
      labelMonthlyAtTime: messages.labelMonthlyAtTime(),
      labelMinute: messages.labelMinute(),
      labelHour: messages.labelHour(),
      labelDayOfMonth: messages.labelDayOfMonth(),
      labelDayOfWeek: messages.labelDayOfWeek(),
      labelOpenInGuru: messages.labelOpenInGuru(),

      cronPreviewEveryNMinutes: messages.cronPreviewEveryNMinutes(),
      cronPreviewHourlyAtMinute: messages.cronPreviewHourlyAtMinute(),
      cronPreviewDailyAt: messages.cronPreviewDailyAt(),
      cronPreviewWeekdaysAt: messages.cronPreviewWeekdaysAt(),
      cronPreviewWeeklyOnAt: messages.cronPreviewWeeklyOnAt(),
      cronPreviewMonthlyOnAt: messages.cronPreviewMonthlyOnAt(),
      placeholderSelectAgent: messages.webviewSelectAgentPlaceholder(),
      placeholderNoAgents: messages.webviewNoAgentsAvailable(),
      placeholderSelectModel: messages.webviewSelectModelPlaceholder(),
      placeholderSelectModelVariant:
        messages.webviewSelectModelVariantPlaceholder(),
      placeholderNoModels: messages.webviewNoModelsAvailable(),
      placeholderSelectTemplate: messages.webviewSelectTemplatePlaceholder(),
      labelModelUnavailableNote: messages.labelModelUnavailableNote(),
      labelModelUnavailableSuffix: messages.labelModelUnavailableSuffix(),

      // Webview JS error text
      webviewScriptErrorPrefix: messages.webviewScriptErrorPrefix(),
      webviewUnhandledErrorPrefix: messages.webviewUnhandledErrorPrefix(),
      webviewLinePrefix: messages.webviewLinePrefix(),
      webviewLineSuffix: messages.webviewLineSuffix(),
      webviewUnknown: messages.webviewUnknown(),
      redactedPlaceholder: messages.redactedPlaceholder(),
      webviewApiUnavailable: messages.webviewApiUnavailable(),
      webviewClientErrorPrefix: messages.webviewClientErrorPrefix(),
      webviewSuccessPrefix: messages.webviewSuccessPrefix(),

      // Webview notes
      webviewAutoModeNote: messages.webviewAutoModeNote(),
      webviewJitterNote: messages.webviewJitterNote(),
      webviewMaxExecutionsPerDayNote: messages.webviewMaxExecutionsPerDayNote(),
      webviewAllowedTimeWindowNote: messages.webviewAllowedTimeWindowNote(),

      pageSubtitle: messages.pageSubtitle(),
      listSubtitle: messages.listSubtitle(),
      sectionBasics: messages.sectionBasics(),
      sectionTarget: messages.sectionTarget(),
      sectionGuardrails: messages.sectionGuardrails(),
      summaryTotalTasks: messages.summaryTotalTasks(),
      summaryEnabledTasks: messages.summaryEnabledTasks(),
      summaryPausedTasks: messages.summaryPausedTasks(),

      labelThisWorkspaceShort: messages.labelThisWorkspaceShort(),
      labelOtherWorkspaceShort: messages.labelOtherWorkspaceShort(),
    };

    const allPresets = presets;

    const serializeForWebview = this.serializeForWebview;
    const escapeHtmlAttr = this.escapeHtmlAttr;
    const escapeHtml = this.escapeHtml;

    const initialData = {
      tasks: initialTasks,
      agents: initialAgents,
      models: initialModels,
      modelPickerDefault: initialModelPickerPayload.modelPickerDefault,
      promptTemplates: initialTemplates,
      workspacePaths: this.getCurrentWorkspacePaths(),
      caseInsensitivePaths: process.platform === "win32",
      defaultScope,
      defaultAutoMode,
      defaultJitterSeconds,
      locale: isJa ? "ja-JP" : "en-US",
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
      margin: 0;
      padding: 24px;
      color: var(--vscode-foreground);
      background:
        radial-gradient(circle at top right, color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent) 0%, transparent 32%),
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent), transparent 180px),
        var(--vscode-editor-background);
      line-height: 1.5;
    }

    .page-shell {
      max-width: 1160px;
      margin: 0 auto;
    }

    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 16px;
      margin-bottom: 18px;
    }

    .page-title-block h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
      line-height: 1.2;
    }

    .page-title-block p {
      margin: 6px 0 0;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      max-width: 72ch;
    }
    
    .tabs {
      display: inline-flex;
      gap: 4px;
      margin-bottom: 18px;
      padding: 4px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 82%, transparent);
    }
    
    .tab-button {
      padding: 10px 18px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      font-size: 14px;
      border-radius: 999px;
      transition: background-color 0.15s ease, color 0.15s ease;
    }
    
    .tab-button:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    
    .tab-button.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-bottom-color: transparent;
    }
    
    .tab-content {
      display: none;
    }
    
    .tab-content.active {
      display: block;
    }

    .surface {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 14px;
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 90%, transparent);
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.08);
    }

    .feedback-banner {
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 13px;
      margin-bottom: 14px;
      border: 1px solid transparent;
    }

    .feedback-banner-error {
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border-color: var(--vscode-inputValidation-errorBorder);
    }

    .feedback-banner-success {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 18%, transparent);
      color: var(--vscode-foreground);
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 45%, transparent);
      opacity: 1;
      transition: opacity 0.5s ease-out;
    }

    .form-layout {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .form-section {
      padding: 18px;
    }

    .form-section-header {
      margin-bottom: 14px;
    }

    .form-section-header h2 {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: var(--vscode-foreground);
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 16px;
    }

    .col-12 {
      grid-column: span 12;
    }

    .col-8 {
      grid-column: span 8;
    }

    .col-6 {
      grid-column: span 6;
    }

    .col-4 {
      grid-column: span 4;
    }
    
    .form-group {
      margin-bottom: 0;
    }
    
    .form-group label {
      display: block;
      margin-bottom: 6px;
      font-weight: 500;
    }
    
    input[type="text"],
    input[type="number"],
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
      min-height: 36px;
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
      min-height: 36px;
    }
    
    .checkbox-group input[type="checkbox"] {
      width: auto;
    }
    
    .button-group {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .form-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 16px 18px;
    }

    .form-actions .button-group {
      margin-top: 0;
    }
    
    button {
      padding: 8px 16px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
      min-height: 36px;
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

    .btn-danger:hover {
      background-color: color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 82%, black);
    }
    
    .btn-icon {
      padding: 0 12px;
    }
    
    .task-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .list-toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }

    .summary-card {
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .summary-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .summary-value {
      font-size: 24px;
      font-weight: 700;
      color: var(--vscode-foreground);
    }
    
    .task-card {
      padding: 18px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
      background-color: var(--vscode-editor-background);
    }

    .task-card.other-workspace {
      border-left-width: 5px;
      border-left-color: var(--vscode-inputValidation-warningBorder);
    }
    
    .task-card.disabled {
      background-color: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);
    }

    .task-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .task-section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 2px;
    }

    .task-section-title {
      font-size: 14px;
      font-weight: 700;
      margin: 0;
    }

    .task-section-count {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    
    .task-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 12px;
    }

    .task-header-main {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }
    
    .task-name {
      font-weight: 700;
      font-size: 16px;
    }

    .task-title-button {
      padding: 0;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      text-align: left;
      min-height: auto;
    }

    .task-title-button:hover {
      color: var(--vscode-textLink-foreground);
    }
    
    .task-status-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    
    .task-status {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    
    .task-status.enabled {
      background-color: var(--vscode-testing-iconPassed);
      color: var(--vscode-button-foreground);
    }
    
    .task-status.disabled {
      background-color: var(--vscode-disabledForeground);
      color: var(--vscode-button-foreground);
    }

    .scope-badge {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px;
      background: color-mix(in srgb, var(--vscode-textLink-foreground) 16%, transparent);
      color: var(--vscode-foreground);
      border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 36%, transparent);
    }

    .task-next-run {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 2px;
      min-width: 180px;
      text-align: right;
    }

    .task-next-run-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
    }

    .task-next-run strong {
      font-size: 13px;
      color: var(--vscode-foreground);
    }
    
    .task-info {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    
    .task-info span {
      margin-right: 0;
      padding: 7px 10px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 82%, transparent);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    
    .task-prompt {
      padding: 12px;
      background-color: var(--vscode-textBlockQuote-background);
      border-radius: 10px;
      font-size: 12px;
      white-space: pre-wrap;
      max-height: 84px;
      overflow: hidden;
      margin-bottom: 14px;
      border-left: 3px solid color-mix(in srgb, var(--vscode-textLink-foreground) 55%, transparent);
    }
    
    .task-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .action-chip {
      padding: 0 12px;
      font-size: 12px;
      font-weight: 600;
    }

    .task-group-collapsible {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
      background-color: color-mix(in srgb, var(--vscode-editorWidget-background) 90%, transparent);
      padding: 0 14px 14px;
    }

    .task-group-collapsible summary {
      cursor: pointer;
      padding: 14px 0;
      font-weight: 700;
      color: var(--vscode-foreground);
    }

    .task-group-inner {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .empty-state {
      text-align: center;
      padding: 28px;
      color: var(--vscode-descriptionForeground);
    }

    .empty-state-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--vscode-foreground);
      margin-bottom: 8px;
    }

    .empty-state-description {
      margin: 0 0 16px;
    }
    
    .radio-group {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
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
      flex-wrap: wrap;
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
      padding: 14px;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 10px;
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

    .note {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      margin-bottom: 0;
    }

    .time-window-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    @media (max-width: 860px) {
      body {
        padding: 16px;
      }

      .page-header,
      .form-actions {
        flex-direction: column;
        align-items: stretch;
      }

      .summary-grid,
      .time-window-grid {
        grid-template-columns: 1fr;
      }

      .col-8,
      .col-6,
      .col-4 {
        grid-column: span 12;
      }

      .task-header {
        flex-direction: column;
      }

      .task-next-run {
        min-width: 0;
        align-items: flex-start;
        text-align: left;
      }
    }
  </style>
</head>
<body>
  <div class="page-shell">
    <div class="tabs">
      <button type="button" class="tab-button active" data-tab="create">${escapeHtml(strings.tabCreate)}</button>
      <button type="button" class="tab-button" data-tab="list">${escapeHtml(strings.tabList)}</button>
    </div>
    
    <div id="create-tab" class="tab-content active">
      <div class="page-header">
        <div class="page-title-block">
          <h1>${escapeHtml(strings.tabCreate)}</h1>
          <p>${escapeHtml(strings.pageSubtitle)}</p>
        </div>
      </div>
      <form id="task-form" class="form-layout">
        <div id="form-error" class="feedback-banner feedback-banner-error" style="display:none;"></div>
        <input type="hidden" id="edit-task-id" value="">

        <section class="surface form-section">
          <div class="form-section-header">
            <h2>${escapeHtml(strings.sectionBasics)}</h2>
          </div>
          <div class="form-grid">
            <div class="form-group col-6">
              <label for="task-name">${escapeHtml(strings.labelTaskName)}</label>
              <input type="text" id="task-name" placeholder="${escapeHtmlAttr(strings.placeholderTaskName)}" required>
            </div>

            <div class="form-group col-6">
              <label>${escapeHtml(strings.labelPromptType)}</label>
              <div class="radio-group">
                <label>
                  <input type="radio" name="prompt-source" value="inline" checked>
                  ${escapeHtml(strings.labelPromptInline)}
                </label>
                <label>
                  <input type="radio" name="prompt-source" value="local">
                  ${escapeHtml(strings.labelPromptLocal)}
                </label>
                <label>
                  <input type="radio" name="prompt-source" value="global">
                  ${escapeHtml(strings.labelPromptGlobal)}
                </label>
              </div>
            </div>

            <div class="form-group col-12" id="template-select-group" style="display: none;">
              <label for="template-select">${escapeHtml(strings.labelPrompt)}</label>
              <div class="template-row">
                <select id="template-select">
                  <option value="">${escapeHtml(strings.placeholderSelectTemplate)}</option>
                </select>
                <button type="button" class="btn-secondary" id="template-refresh-btn">${escapeHtml(strings.actionRefresh)}</button>
              </div>
            </div>

            <div class="form-group col-12" id="prompt-group">
              <label for="prompt-text">${escapeHtml(strings.labelPrompt)}</label>
              <textarea id="prompt-text" placeholder="${escapeHtmlAttr(strings.placeholderPrompt)}" required></textarea>
            </div>
          </div>
        </section>

        <section class="surface form-section">
          <div class="form-section-header">
            <h2>${escapeHtml(strings.labelSchedule)}</h2>
          </div>
          <div class="form-grid">
            <div class="form-group col-12">
              <label>${escapeHtml(strings.labelSchedule)}</label>
              <div class="preset-select">
                <select id="cron-preset">
                  <option value="">${escapeHtml(strings.labelCustom)}</option>
                  ${allPresets.map((p) => `<option value="${escapeHtmlAttr(p.expression)}">${escapeHtml(p.name)}</option>`).join("")}
                </select>
              </div>
              <input type="text" id="cron-expression" placeholder="${escapeHtmlAttr(strings.placeholderCron)}" required>
              <div class="cron-preview">
                <strong>${escapeHtml(strings.labelFriendlyPreview)}:</strong>
                <span id="cron-preview-text">${escapeHtml(strings.labelFriendlyFallback)}</span>
                <button type="button" class="btn-secondary btn-icon" id="open-guru-btn">${escapeHtml(strings.labelOpenInGuru)}</button>
              </div>
              <div class="friendly-cron">
                <div class="section-title">${escapeHtml(strings.labelFriendlyBuilder)}</div>
                <div class="friendly-grid">
                  <div class="form-group">
                    <label for="friendly-frequency">${escapeHtml(strings.labelFrequency)}</label>
                    <select id="friendly-frequency">
                      <option value="">${escapeHtml(strings.labelFriendlySelect)}</option>
                      <option value="every-n">${escapeHtml(strings.labelEveryNMinutes)}</option>
                      <option value="hourly">${escapeHtml(strings.labelHourlyAtMinute)}</option>
                      <option value="daily">${escapeHtml(strings.labelDailyAtTime)}</option>
                      <option value="weekly">${escapeHtml(strings.labelWeeklyAtTime)}</option>
                      <option value="monthly">${escapeHtml(strings.labelMonthlyAtTime)}</option>
                    </select>
                  </div>
                  <div class="form-group friendly-field" data-field="interval">
                    <label for="friendly-interval">${escapeHtml(strings.labelInterval)}</label>
                    <input type="number" id="friendly-interval" min="1" max="59" value="5">
                  </div>
                  <div class="form-group friendly-field" data-field="minute">
                    <label for="friendly-minute">${escapeHtml(strings.labelMinute)}</label>
                    <input type="number" id="friendly-minute" min="0" max="59" value="0">
                  </div>
                  <div class="form-group friendly-field" data-field="hour">
                    <label for="friendly-hour">${escapeHtml(strings.labelHour)}</label>
                    <input type="number" id="friendly-hour" min="0" max="23" value="9">
                  </div>
                  <div class="form-group friendly-field" data-field="dow">
                    <label for="friendly-dow">${escapeHtml(strings.labelDayOfWeek)}</label>
                    <select id="friendly-dow">
                      <option value="0">${escapeHtml(strings.daySun)}</option>
                      <option value="1">${escapeHtml(strings.dayMon)}</option>
                      <option value="2">${escapeHtml(strings.dayTue)}</option>
                      <option value="3">${escapeHtml(strings.dayWed)}</option>
                      <option value="4">${escapeHtml(strings.dayThu)}</option>
                      <option value="5">${escapeHtml(strings.dayFri)}</option>
                      <option value="6">${escapeHtml(strings.daySat)}</option>
                    </select>
                  </div>
                  <div class="form-group friendly-field" data-field="dom">
                    <label for="friendly-dom">${escapeHtml(strings.labelDayOfMonth)}</label>
                    <input type="number" id="friendly-dom" min="1" max="31" value="1">
                  </div>
                </div>
                <div class="friendly-actions">
                  <button type="button" class="btn-secondary" id="friendly-generate">${escapeHtml(strings.labelFriendlyGenerate)}</button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="surface form-section">
          <div class="form-section-header">
            <h2>${escapeHtml(strings.sectionTarget)}</h2>
          </div>
          <div class="form-grid">
            <div class="form-group col-6">
              <label for="agent-select">${escapeHtml(strings.labelAgent)}</label>
              <select id="agent-select">
                ${initialAgents.length > 0 ? `<option value="">${escapeHtml(strings.placeholderSelectAgent)}</option>` + initialAgents.map((a) => `<option value="${escapeHtmlAttr(a.id || "")}">${escapeHtml(a.name || "")}</option>`).join("") : `<option value="">${escapeHtml(strings.placeholderNoAgents)}</option>`}
              </select>
            </div>

            <div class="form-group col-6">
              <label for="model-select">${escapeHtml(strings.labelModel)}</label>
              <select id="model-select">
                <option value="">${escapeHtml(initialModelPickerPayload.modelPickerDefault.length > 0 ? strings.placeholderSelectModel : strings.placeholderNoModels)}</option>
              </select>
              <p class="note">${escapeHtml(strings.labelModelNote)}</p>
              <p class="note" id="model-selection-status" style="display:none;"></p>
            </div>

            <div class="form-group col-6" id="model-variant-group" style="display:none;">
              <label for="model-variant-select">${escapeHtml(strings.labelModelVariant)}</label>
              <select id="model-variant-select">
                <option value="">${escapeHtml(strings.placeholderSelectModelVariant)}</option>
              </select>
              <p class="note">${escapeHtml(strings.labelModelVariantNote)}</p>
            </div>

            <div class="form-group col-6">
              <label>${escapeHtml(strings.labelScope)}</label>
              <div class="radio-group">
                <label>
                  <input type="radio" name="scope" value="workspace" ${defaultScope === "workspace" ? "checked" : ""}>
                  ${escapeHtml(strings.labelScopeWorkspace)}
                </label>
                <label>
                  <input type="radio" name="scope" value="global" ${defaultScope === "global" ? "checked" : ""}>
                  ${escapeHtml(strings.labelScopeGlobal)}
                </label>
              </div>
            </div>

            <div class="form-group col-6">
              <label>${escapeHtml(strings.labelRunFirstInOneMinute)}</label>
              <div class="checkbox-group">
                <input type="checkbox" id="run-first">
                <label for="run-first">${escapeHtml(strings.labelRunFirstInOneMinute)}</label>
              </div>
            </div>
          </div>
        </section>

        <section class="surface form-section">
          <div class="form-section-header">
            <h2>${escapeHtml(strings.sectionGuardrails)}</h2>
          </div>
          <div class="form-grid">
            <div class="form-group col-12">
              <div class="checkbox-group">
                <input type="checkbox" id="auto-mode" ${defaultAutoMode ? "checked" : ""}>
                <label for="auto-mode">${escapeHtml(strings.labelAutoMode)}</label>
              </div>
              <p class="note">${escapeHtml(strings.webviewAutoModeNote)}</p>
            </div>

            <div class="form-group col-4">
              <label for="jitter-seconds">${escapeHtml(strings.labelJitterSeconds)}</label>
              <input type="number" id="jitter-seconds" min="0" max="1800" step="1" value="${escapeHtmlAttr(String(defaultJitterSeconds))}">
              <p class="note">${escapeHtml(strings.webviewJitterNote)}</p>
            </div>

            <div class="form-group col-4">
              <label for="max-executions-per-day">${escapeHtml(strings.labelMaxExecutionsPerDay)}</label>
              <input type="number" id="max-executions-per-day" min="0" max="100" step="1" value="0">
              <p class="note">${escapeHtml(strings.webviewMaxExecutionsPerDayNote)}</p>
            </div>

            <div class="form-group col-4">
              <label>${escapeHtml(strings.labelAllowedTimeWindow)}</label>
              <div class="time-window-grid">
                <div class="form-group">
                  <label for="allowed-time-start">${escapeHtml(strings.labelAllowedTimeStart)}</label>
                  <input type="time" id="allowed-time-start" step="60">
                </div>
                <div class="form-group">
                  <label for="allowed-time-end">${escapeHtml(strings.labelAllowedTimeEnd)}</label>
                  <input type="time" id="allowed-time-end" step="60">
                </div>
              </div>
              <p class="note">${escapeHtml(strings.webviewAllowedTimeWindowNote)}</p>
            </div>
          </div>
        </section>

        <div class="surface form-actions">
          <div class="button-group">
            <button type="submit" class="btn-primary" id="submit-btn">${escapeHtml(strings.actionCreate)}</button>
            <button type="button" class="btn-secondary" id="new-task-btn" style="display:none;">${escapeHtml(strings.actionNewTask)}</button>
            <button type="button" class="btn-danger" id="edit-delete-btn" style="display:none;">${escapeHtml(strings.actionDelete)}</button>
            <button type="button" class="btn-secondary" id="test-btn">${escapeHtml(strings.actionTestRun)}</button>
          </div>
        </div>
      </form>
    </div>
    
    <div id="list-tab" class="tab-content">
      <div id="success-toast" class="feedback-banner feedback-banner-success" style="display:none;"></div>
      <div class="page-header">
        <div class="page-title-block">
          <h1>${escapeHtml(strings.tabList)}</h1>
          <p>${escapeHtml(strings.listSubtitle)}</p>
        </div>
        <div class="list-toolbar">
          <button type="button" class="btn-primary" id="open-create-btn">${escapeHtml(strings.actionNewTask)}</button>
          <button type="button" class="btn-secondary" id="refresh-btn">${escapeHtml(strings.actionRefresh)}</button>
        </div>
      </div>
      <div class="summary-grid">
        <div class="surface summary-card">
          <span class="summary-label">${escapeHtml(strings.summaryTotalTasks)}</span>
          <strong class="summary-value" id="summary-total">0</strong>
        </div>
        <div class="surface summary-card">
          <span class="summary-label">${escapeHtml(strings.summaryEnabledTasks)}</span>
          <strong class="summary-value" id="summary-enabled">0</strong>
        </div>
        <div class="surface summary-card">
          <span class="summary-label">${escapeHtml(strings.summaryPausedTasks)}</span>
          <strong class="summary-value" id="summary-paused">0</strong>
        </div>
      </div>
      <div id="task-list" class="task-list">
        <div class="surface empty-state">
          <div class="empty-state-title">${escapeHtml(strings.noTasksFound)}</div>
          <p class="empty-state-description">${escapeHtml(strings.emptyStateDescription)}</p>
          <button type="button" class="btn-primary" data-open-create="true">${escapeHtml(strings.actionNewTask)}</button>
        </div>
      </div>
    </div>
  </div>
  
  <script nonce="${nonce}" id="initial-data" type="application/json">${serializeForWebview(initialData)}</script>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;

    return rawHtml;
  }
}
