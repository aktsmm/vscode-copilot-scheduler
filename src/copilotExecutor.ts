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
import { resolveGlobalPromptsRoot } from "./promptResolver";

// Node.js globals
declare const setTimeout: (callback: () => void, ms: number) => NodeJS.Timeout;

// Timing constants for Copilot Chat interaction delays (ms)
const DELAY_AFTER_FOCUS_MS = 150;
const DELAY_AFTER_MODEL_SELECT_MS = 100;
const DELAY_AFTER_TYPE_MS = 50;
const DELAY_NEW_SESSION_MS = 200;

/** Slash-command agents — prefixed with "/" instead of "@" */
const SLASH_COMMAND_AGENTS: ReadonlySet<string> = new Set([
  "agent",
  "ask",
  "edit",
]);

/**
 * Executes prompts through GitHub Copilot Chat
 */
export class CopilotExecutor {
  /**
   * Execute a prompt in Copilot Chat
   */
  async executePrompt(prompt: string, options?: ExecuteOptions): Promise<void> {
    // Apply prompt commands/placeholders
    const processedPrompt = this.applyPromptCommands(prompt);

    // Build full prompt with agent prefix
    let fullPrompt = processedPrompt;
    if (options?.agent && options.agent !== "") {
      // Add agent prefix if not already present
      if (
        !processedPrompt.startsWith("@") &&
        !processedPrompt.startsWith("/")
      ) {
        if (options.agent.startsWith("@")) {
          fullPrompt = `${options.agent} ${processedPrompt}`;
        } else if (SLASH_COMMAND_AGENTS.has(options.agent)) {
          fullPrompt = `/${options.agent} ${processedPrompt}`;
        } else {
          fullPrompt = `@${options.agent} ${processedPrompt}`;
        }
      }
      logDebug(
        `[CopilotScheduler] Agent set: ${options.agent}, prompt length: ${fullPrompt.length}`,
      );
    } else {
      logDebug(`[CopilotScheduler] No agent specified, using default`);
    }

    // Get chat session behavior
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const chatSession = config.get<ChatSessionBehavior>("chatSession", "new");

    try {
      // Try to create new session if configured
      if (chatSession === "new") {
        await this.tryCreateNewChatSession();
      }

      // Focus on Copilot Chat panel
      await vscode.commands.executeCommand(
        "workbench.panel.chat.view.copilot.focus",
      );
      await this.delay(DELAY_AFTER_FOCUS_MS);

      // Try to set model if specified
      if (options?.model && options.model !== "") {
        try {
          logDebug(
            `[CopilotScheduler] Attempting to select model: ${options.model}`,
          );
          const result = await vscode.commands.executeCommand(
            "workbench.action.chat.selectModel",
            options.model,
          );
          logDebug(`[CopilotScheduler] Model selection result:`, result);
          await this.delay(DELAY_AFTER_MODEL_SELECT_MS);
        } catch (error) {
          logError(`[CopilotScheduler] Model selection failed:`, error);
          // Model selection may not be available, continue without it
        }
      } else {
        logDebug(`[CopilotScheduler] No model specified or model is empty`);
      }

      // Type the prompt using the type command
      await vscode.commands.executeCommand("type", { text: fullPrompt });
      await this.delay(DELAY_AFTER_TYPE_MS);

      // Submit the prompt
      await vscode.commands.executeCommand("workbench.action.chat.submit");
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

  /**
   * Try to create a new chat session
   */
  private async tryCreateNewChatSession(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.newChat");
      await this.delay(DELAY_NEW_SESSION_MS);
      return true;
    } catch {
      return false;
    }
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
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || "";
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
        name: "Agent",
        description: messages.agentModeDesc(),
        isCustom: false,
      },
      {
        id: "ask",
        name: "Ask",
        description: messages.agentAskDesc(),
        isCustom: false,
      },
      {
        id: "edit",
        name: "Edit",
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
      const fileName = path.basename(file.fsPath, ".agent.md");
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
        logDebug("[CopilotScheduler] Failed to parse AGENTS.md:", error);
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
        if (fileName.endsWith(".agent.md")) {
          const agentName = path.basename(fileName, ".agent.md");
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
      logDebug("[CopilotScheduler] Failed to read global agents:", error);
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
      logDebug("[CopilotScheduler] Language Model API unavailable:", error);
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
