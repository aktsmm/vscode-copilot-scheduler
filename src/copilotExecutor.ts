/**
 * Copilot Scheduler - Copilot Executor
 * Handles communication with GitHub Copilot Chat
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { notifyInfo } from "./extension";
import type {
  AgentInfo,
  ModelInfo,
  ExecuteOptions,
  ChatSessionBehavior,
} from "./types";
import { messages, isJapanese } from "./i18n";

// Node.js globals
declare const setTimeout: (callback: () => void, ms: number) => NodeJS.Timeout;

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
        } else if (["agent", "ask", "edit"].includes(options.agent)) {
          fullPrompt = `/${options.agent} ${processedPrompt}`;
        } else {
          fullPrompt = `@${options.agent} ${processedPrompt}`;
        }
      }
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
      await this.delay(300);

      // Try to set model if specified
      if (options?.model && options.model !== "") {
        try {
          console.log(
            `[CopilotScheduler] Attempting to select model: ${options.model}`,
          );
          await vscode.commands.executeCommand(
            "workbench.action.chat.selectModel",
            options.model,
          );
          console.log(`[CopilotScheduler] Model selection command executed`);
          await this.delay(100);
        } catch (error) {
          console.error(`[CopilotScheduler] Model selection failed:`, error);
          // Model selection may not be available, continue without it
        }
      }

      // Type the prompt using the type command
      await vscode.commands.executeCommand("type", { text: fullPrompt });
      await this.delay(100);

      // Submit the prompt
      await vscode.commands.executeCommand("workbench.action.chat.submit");
    } catch (error) {
      // Show error and offer to copy to clipboard
      const errorMessage =
        error instanceof Error ? error.message : String(error);
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
      await this.delay(200);
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
    const now = new Date();
    result = result.replace(
      /\{\{date\}\}/gi,
      now.toLocaleDateString(isJapanese() ? "ja-JP" : "en-US"),
    );

    // Replace {{time}} with current time
    result = result.replace(
      /\{\{time\}\}/gi,
      now.toLocaleTimeString(isJapanese() ? "ja-JP" : "en-US"),
    );

    // Replace {{datetime}} with current date and time
    result = result.replace(
      /\{\{datetime\}\}/gi,
      now.toLocaleString(isJapanese() ? "ja-JP" : "en-US"),
    );

    // Replace {{workspace}} with workspace name
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || "";
    result = result.replace(/\{\{workspace\}\}/gi, workspaceName);

    // Replace {{file}} with current file name
    const currentFile = vscode.window.activeTextEditor?.document.fileName || "";
    result = result.replace(/\{\{file\}\}/gi, path.basename(currentFile));

    // Replace {{filepath}} with current file path
    result = result.replace(/\{\{filepath\}\}/gi, currentFile);

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
        name: isJapanese() ? "なし" : "None",
        description: isJapanese() ? "デフォルトの動作" : "Default behavior",
        isCustom: false,
      },
      {
        id: "agent",
        name: "Agent",
        description: isJapanese()
          ? "ツール利用のエージェントモード"
          : "Agent mode with tool use",
        isCustom: false,
      },
      {
        id: "ask",
        name: "Ask",
        description: isJapanese()
          ? "コードに関する質問"
          : "Questions about code",
        isCustom: false,
      },
      {
        id: "edit",
        name: "Edit",
        description: isJapanese() ? "AIでコード編集" : "AI code editing",
        isCustom: false,
      },
      {
        id: "@workspace",
        name: "@workspace",
        description: isJapanese() ? "コードベース検索" : "Codebase search",
        isCustom: false,
      },
      {
        id: "@terminal",
        name: "@terminal",
        description: isJapanese() ? "ターミナル操作" : "Terminal operations",
        isCustom: false,
      },
      {
        id: "@vscode",
        name: "@vscode",
        description: isJapanese()
          ? "VS Code設定とコマンド"
          : "VS Code settings and commands",
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
    );

    for (const file of agentFiles) {
      const fileName = path.basename(file.fsPath, ".agent.md");
      agents.push({
        id: `@${fileName}`,
        name: `@${fileName}`,
        description: isJapanese() ? "カスタムエージェント" : "Custom agent",
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
        const content = fs.readFileSync(file.fsPath, "utf-8");
        const agentMatches = content.matchAll(
          /<agent>\s*<name>([^<]+)<\/name>/g,
        );

        for (const match of agentMatches) {
          const agentName = match[1].trim();
          if (agentName && !agents.some((a) => a.name === agentName)) {
            agents.push({
              id: agentName,
              name: agentName,
              description: isJapanese()
                ? "AGENTS.mdで定義"
                : "Defined in AGENTS.md",
              isCustom: true,
              filePath: file.fsPath,
            });
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    return agents;
  }

  /**
   * Get global agents from VS Code User prompts folder
   */
  static getGlobalAgents(): AgentInfo[] {
    const agents: AgentInfo[] = [];

    // Get global agents path from settings or default
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const customPath = config.get<string>("globalAgentsPath", "");
    const defaultPath = process.env.APPDATA
      ? path.join(process.env.APPDATA, "Code", "User", "prompts")
      : "";

    const globalPath = customPath || defaultPath;
    if (!globalPath || !fs.existsSync(globalPath)) {
      return agents;
    }

    try {
      const files = fs.readdirSync(globalPath);
      for (const file of files) {
        if (file.endsWith(".agent.md")) {
          const agentName = file.replace(".agent.md", "");
          agents.push({
            id: agentName,
            name: agentName,
            description: isJapanese()
              ? "グローバルエージェント"
              : "Global agent",
            isCustom: true,
            filePath: path.join(globalPath, file),
          });
        }
      }
    } catch {
      // Ignore read errors
    }

    return agents;
  }

  /**
   * Get all agents (built-in + custom + global)
   */
  static async getAllAgents(): Promise<AgentInfo[]> {
    const builtIn = CopilotExecutor.getBuiltInAgents();
    const custom = await CopilotExecutor.getCustomAgents();
    const global = CopilotExecutor.getGlobalAgents();
    return [...builtIn, ...custom, ...global];
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
            name: isJapanese() ? "デフォルト" : "Default",
            description: isJapanese()
              ? "デフォルトモデルを使用"
              : "Use default model",
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
    } catch {
      // Language Model API may not be available
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
        name: isJapanese() ? "デフォルト" : "Default",
        description: isJapanese()
          ? "デフォルトモデルを使用"
          : "Use default model",
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
