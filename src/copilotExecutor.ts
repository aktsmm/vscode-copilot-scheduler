/**
 * Copilot Scheduler - Copilot Executor
 * Handles communication with GitHub Copilot Chat
 */

import * as vscode from "vscode";
import * as path from "path";
import { notifyInfo } from "./extension";
import type {
  AgentInfo,
  ModelInfo,
  ExecuteOptions,
  ChatSessionBehavior,
} from "./types";
import { messages, isJapanese } from "./i18n";
import { logDebug, logError } from "./logger";
import { sanitizeAbsolutePathDetails } from "./errorSanitizer";
import { resolveGlobalPromptsRoot } from "./promptResolver";

// Node.js globals
declare const setTimeout: (callback: () => void, ms: number) => NodeJS.Timeout;

// Timing constants for Copilot Chat interaction delays (ms)
const DELAY_AFTER_FOCUS_NEW_SESSION_MS = 150;
const DELAY_AFTER_FOCUS_CONTINUE_SESSION_MS = 40;
const DELAY_AFTER_MODEL_SELECT_MS = 100;
const DELAY_AFTER_TYPE_NEW_SESSION_MS = 50;
const DELAY_AFTER_TYPE_CONTINUE_SESSION_MS = 10;
const DELAY_NEW_SESSION_MS = 200;
const COMMAND_DELAY_FACTOR_DEFAULT = 0.8;
const COMMAND_DELAY_FACTOR_MIN = 0.1;
const COMMAND_DELAY_FACTOR_MAX = 2;

/** Slash-command agents — prefixed with "/" instead of "@" */
const SLASH_COMMAND_AGENTS: ReadonlySet<string> = new Set([
  "agent",
  "ask",
  "edit",
]);

function normalizeAgentPrefix(agent: string): string {
  const normalized = agent.trim();
  if (!normalized) {
    return "";
  }

  // Keep explicitly-prefixed values as-is (e.g. @workspace, /ask).
  if (normalized.startsWith("@") || normalized.startsWith("/")) {
    return normalized;
  }

  if (SLASH_COMMAND_AGENTS.has(normalized)) {
    return `/${normalized}`;
  }

  return `@${normalized}`;
}

function toSafeErrorDetails(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const sanitized = sanitizeAbsolutePathDetails(
    raw,
    messages.redactedPlaceholder(),
  );
  return sanitized.trim() ? sanitized : messages.webviewUnknown();
}

export const __testOnly = {
  toSafeErrorDetails,
  normalizeAgentPrefix,
};

/**
 * Executes prompts through GitHub Copilot Chat
 */
export class CopilotExecutor {
  private getPreferredWorkspaceName(): string {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const folder = vscode.workspace.getWorkspaceFolder(activeUri);
      if (folder?.name) {
        return folder.name;
      }
    }

    return vscode.workspace.workspaceFolders?.[0]?.name || "";
  }

  /**
   * Execute a prompt in Copilot Chat
   */
  async executePrompt(prompt: string, options?: ExecuteOptions): Promise<void> {
    // Apply prompt commands/placeholders
    const processedPrompt = this.applyPromptCommands(prompt);

    // Build full prompt with agent prefix
    let fullPrompt = processedPrompt;
    const normalizedAgent =
      typeof options?.agent === "string"
        ? normalizeAgentPrefix(options.agent)
        : "";

    if (normalizedAgent) {
      // Add agent prefix if not already present
      if (
        !processedPrompt.startsWith("@") &&
        !processedPrompt.startsWith("/")
      ) {
        fullPrompt = `${normalizedAgent} ${processedPrompt}`;
      }
      logDebug(
        `[CopilotScheduler] Agent set: ${normalizedAgent}, prompt length: ${fullPrompt.length}`,
      );
    } else {
      logDebug(`[CopilotScheduler] No agent specified, using default`);
    }

    // Get chat session behavior and command delay factor once per execution
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const chatSession = config.get<ChatSessionBehavior>("chatSession", "new");
    const delayFactor = this.getCommandDelayFactor(config);
    const model = options?.model && options.model !== "" ? options.model : "";

    try {
      // Try to create new session if configured
      if (chatSession === "new") {
        await this.tryCreateNewChatSession(delayFactor);
      }

      const openedWithChatOpen = await this.tryOpenChatWithPrompt(
        fullPrompt,
        model,
      );
      if (!openedWithChatOpen) {
        logDebug(
          `[CopilotScheduler] Falling back to legacy chat commands after chat.open failure`,
        );
        await this.executePromptLegacy(
          fullPrompt,
          model,
          chatSession,
          delayFactor,
        );
      }
    } catch (error) {
      // Show error and offer to copy to clipboard (this is the primary
      // user-facing notification for execution failures — callers should
      // avoid showing a second notification for the same error).
      const action = await vscode.window.showWarningMessage(
        messages.autoExecuteFailed(),
        messages.actionCopyPrompt(),
        messages.actionCancel(),
      );

      if (action === messages.actionCopyPrompt()) {
        await vscode.env.clipboard.writeText(fullPrompt);
        notifyInfo(messages.promptCopied());
      }

      throw error;
    }
  }

  private async tryOpenChatWithPrompt(
    fullPrompt: string,
    model: string,
  ): Promise<boolean> {
    if (model) {
      try {
        logDebug(
          `[CopilotScheduler] Trying workbench.action.chat.open with model selector: ${model}`,
        );
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: fullPrompt,
          isPartialQuery: false,
          modelSelector: { id: model },
        });
        return true;
      } catch (error) {
        logDebug(
          `[CopilotScheduler] chat.open with model selector failed: ${toSafeErrorDetails(error)}`,
        );
      }
    }

    try {
      logDebug(
        `[CopilotScheduler] Trying workbench.action.chat.open without model selector`,
      );
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query: fullPrompt,
        isPartialQuery: false,
      });
      return true;
    } catch (error) {
      logDebug(
        `[CopilotScheduler] chat.open without model selector failed: ${toSafeErrorDetails(error)}`,
      );
      return false;
    }
  }

  private async executePromptLegacy(
    fullPrompt: string,
    model: string,
    chatSession: ChatSessionBehavior,
    delayFactor: number,
  ): Promise<void> {
    // Focus on Copilot Chat panel
    await vscode.commands.executeCommand(
      "workbench.panel.chat.view.copilot.focus",
    );
    const focusDelayMs =
      chatSession === "new"
        ? DELAY_AFTER_FOCUS_NEW_SESSION_MS
        : DELAY_AFTER_FOCUS_CONTINUE_SESSION_MS;
    await this.delay(this.getAdjustedDelayMs(focusDelayMs, delayFactor));

    // Try to set model if specified
    if (model) {
      try {
        logDebug(`[CopilotScheduler] Attempting to select model: ${model}`);
        const result = await vscode.commands.executeCommand(
          "workbench.action.chat.selectModel",
          model,
        );
        logDebug(`[CopilotScheduler] Model selection result:`, result);
        await this.delay(
          this.getAdjustedDelayMs(DELAY_AFTER_MODEL_SELECT_MS, delayFactor),
        );
      } catch (error) {
        logError(
          `[CopilotScheduler] Model selection failed:`,
          toSafeErrorDetails(error),
        );
        // Model selection may not be available, continue without it
      }
    } else {
      logDebug(`[CopilotScheduler] No model specified or model is empty`);
    }

    // Type the prompt using the type command
    await vscode.commands.executeCommand("type", { text: fullPrompt });
    const submitDelayMs =
      chatSession === "new"
        ? DELAY_AFTER_TYPE_NEW_SESSION_MS
        : DELAY_AFTER_TYPE_CONTINUE_SESSION_MS;
    await this.delay(this.getAdjustedDelayMs(submitDelayMs, delayFactor));

    // Submit the prompt
    await vscode.commands.executeCommand("workbench.action.chat.submit");
  }

  /**
   * Try to create a new chat session
   */
  private async tryCreateNewChatSession(delayFactor: number): Promise<boolean> {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.newChat");
      await this.delay(
        this.getAdjustedDelayMs(DELAY_NEW_SESSION_MS, delayFactor),
      );
      return true;
    } catch {
      return false;
    }
  }

  private getCommandDelayFactor(config: vscode.WorkspaceConfiguration): number {
    const raw = config.get<number>(
      "commandDelayFactor",
      COMMAND_DELAY_FACTOR_DEFAULT,
    );
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(parsed)) {
      return COMMAND_DELAY_FACTOR_DEFAULT;
    }
    return Math.min(
      COMMAND_DELAY_FACTOR_MAX,
      Math.max(COMMAND_DELAY_FACTOR_MIN, parsed),
    );
  }

  private getAdjustedDelayMs(baseMs: number, factor: number): number {
    const adjusted = Math.round(baseMs * factor);
    return Math.max(0, adjusted);
  }

  /**
   * Apply prompt commands/placeholders
   */
  private applyPromptCommands(prompt: string): string {
    let result = prompt;

    // Replace {{date}} with current date
    // Use function replacers to prevent $& / $' / $` interpretation (U14)
    const now = new Date();
    // isJapanese() here is for locale-aware date/time formatting, not a UI label.
    const locale = isJapanese() ? "ja-JP" : "en-US";
    result = result.replace(/\{\{date\}\}/gi, () =>
      now.toLocaleDateString(locale),
    );

    // Replace {{time}} with current time
    result = result.replace(/\{\{time\}\}/gi, () =>
      now.toLocaleTimeString(locale),
    );

    // Replace {{datetime}} with current date and time
    result = result.replace(/\{\{datetime\}\}/gi, () =>
      now.toLocaleString(locale),
    );

    // Replace {{workspace}} with workspace name
    // Use function replacers to prevent $& / $' / $` interpretation in values
    const workspaceName = this.getPreferredWorkspaceName();
    result = result.replace(/\{\{workspace\}\}/gi, () => workspaceName);

    // Replace {{file}} with current file name
    const currentFile = vscode.window.activeTextEditor?.document.fileName || "";
    const currentFileName = path.basename(currentFile);
    result = result.replace(/\{\{file\}\}/gi, () => currentFileName);

    // Replace {{filepath}} with current file path
    result = result.replace(/\{\{filepath\}\}/gi, () => currentFile);

    return result;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get built-in agents
   */
  static getBuiltInAgents(): AgentInfo[] {
    const agents: AgentInfo[] = [
      {
        id: "",
        name: messages.agentNoneName(),
        description: messages.agentNoneDesc(),
        isCustom: false,
      },
      {
        id: "agent",
        name: messages.agentAgentName(),
        description: messages.agentModeDesc(),
        isCustom: false,
      },
      {
        id: "ask",
        name: messages.agentAskName(),
        description: messages.agentAskDesc(),
        isCustom: false,
      },
      {
        id: "edit",
        name: messages.agentEditName(),
        description: messages.agentEditDesc(),
        isCustom: false,
      },
      {
        id: "@workspace",
        name: "@workspace",
        description: messages.agentWorkspaceDesc(),
        isCustom: false,
      },
      {
        id: "@terminal",
        name: "@terminal",
        description: messages.agentTerminalDesc(),
        isCustom: false,
      },
      {
        id: "@vscode",
        name: "@vscode",
        description: messages.agentVscodeDesc(),
        isCustom: false,
      },
    ];

    return agents;
  }

  /**
   * Get custom agents from workspace
   */
  static async getCustomAgents(): Promise<AgentInfo[]> {
    const agents: AgentInfo[] = [];

    // Search for *.agent.md files
    const agentFiles = await vscode.workspace.findFiles(
      "**/*.agent.md",
      "**/node_modules/**",
      100,
    );

    for (const file of agentFiles) {
      const fileName = path.basename(file.fsPath).replace(/\.agent\.md$/i, "");
      agents.push({
        id: `@${fileName}`,
        name: `@${fileName}`,
        description: messages.agentCustomDesc(),
        isCustom: true,
        filePath: file.fsPath,
      });
    }

    // Parse AGENTS.md if exists
    const agentsMdFiles = await vscode.workspace.findFiles(
      "**/AGENTS.md",
      "**/node_modules/**",
    );

    for (const file of agentsMdFiles) {
      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        const content = Buffer.from(bytes).toString("utf8");
        // Best-effort regex parse of <agent><name>...</name> blocks.
        // Intentionally skips malformed or nested tags rather than throwing;
        // missing agents are a recoverable degradation (fallback: no suggestions).
        const agentMatches = content.matchAll(
          /<agent>\s*<name>([^<]+)<\/name>/g,
        );

        for (const match of agentMatches) {
          const agentName = match[1].trim();
          if (!agentName) continue;
          // Normalise to @-prefixed ID consistent with .agent.md agents (U32)
          const normalizedId = agentName.startsWith("@")
            ? agentName
            : `@${agentName}`;
          if (!agents.some((a) => a.id === normalizedId)) {
            agents.push({
              id: normalizedId,
              name: normalizedId,
              description: messages.agentAgentsMdDesc(),
              isCustom: true,
              filePath: file.fsPath,
            });
          }
        }
      } catch (error) {
        logDebug(
          "[CopilotScheduler] Failed to parse AGENTS.md:",
          toSafeErrorDetails(error),
        );
      }
    }

    return agents;
  }

  /**
   * Get global agents from VS Code User prompts folder
   */
  static async getGlobalAgents(): Promise<AgentInfo[]> {
    const agents: AgentInfo[] = [];

    // Reuse resolveGlobalPromptsRoot with the agents-specific setting
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const globalPath = resolveGlobalPromptsRoot(
      config.get<string>("globalAgentsPath", ""),
    );
    try {
      if (!globalPath) {
        return agents;
      }

      const entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(globalPath),
      );
      for (const [fileName, fileType] of entries) {
        if (fileType !== vscode.FileType.File) continue;
        if (fileName.toLowerCase().endsWith(".agent.md")) {
          const agentName = fileName.replace(/\.agent\.md$/i, "");
          agents.push({
            id: `@${agentName}`,
            name: `@${agentName}`,
            description: messages.agentGlobalDesc(),
            isCustom: true,
            filePath: path.join(globalPath, fileName),
          });
        }
      }
    } catch (error) {
      logDebug(
        "[CopilotScheduler] Failed to read global agents:",
        toSafeErrorDetails(error),
      );
    }

    return agents;
  }

  /**
   * Get all agents (built-in + custom + global), deduplicated by id
   */
  static async getAllAgents(): Promise<AgentInfo[]> {
    const builtIn = CopilotExecutor.getBuiltInAgents();
    const custom = await CopilotExecutor.getCustomAgents();
    const global = await CopilotExecutor.getGlobalAgents();

    const seen = new Set<string>();
    const result: AgentInfo[] = [];
    for (const agent of [...builtIn, ...custom, ...global]) {
      const key = agent.id || agent.name;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(agent);
    }
    return result;
  }

  /**
   * Get available models using VS Code API
   */
  static async getAvailableModels(): Promise<ModelInfo[]> {
    try {
      // Try to get models from VS Code Language Model API
      const models = await vscode.lm.selectChatModels({});

      if (models && models.length > 0) {
        const modelInfos: ModelInfo[] = [
          {
            id: "",
            name: messages.modelDefaultName(),
            description: messages.modelDefaultDesc(),
            vendor: "",
          },
        ];

        for (const model of models) {
          modelInfos.push({
            id: model.id,
            name: model.name || model.id,
            description: model.family || "",
            vendor: model.vendor || "",
          });
        }

        return modelInfos;
      }
    } catch (error) {
      // Language Model API may not be available
      logDebug(
        "[CopilotScheduler] Language Model API unavailable:",
        toSafeErrorDetails(error),
      );
    }

    // Fallback to static list
    return CopilotExecutor.getFallbackModels();
  }

  /**
   * Get fallback model list
   */
  static getFallbackModels(): ModelInfo[] {
    return [
      {
        id: "",
        name: messages.modelDefaultName(),
        description: messages.modelDefaultDesc(),
        vendor: "",
      },
      {
        id: "gpt-4o",
        name: "GPT-4o",
        description: "OpenAI GPT-4o",
        vendor: "OpenAI",
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        description: "OpenAI GPT-4o Mini",
        vendor: "OpenAI",
      },
      {
        id: "o3-mini",
        name: "o3-mini",
        description: "OpenAI o3-mini",
        vendor: "OpenAI",
      },
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        description: "Anthropic Claude Sonnet 4",
        vendor: "Anthropic",
      },
      {
        id: "claude-3.5-sonnet",
        name: "Claude 3.5 Sonnet",
        description: "Anthropic Claude 3.5 Sonnet",
        vendor: "Anthropic",
      },
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        description: "Google Gemini 2.0 Flash",
        vendor: "Google",
      },
    ];
  }
}
