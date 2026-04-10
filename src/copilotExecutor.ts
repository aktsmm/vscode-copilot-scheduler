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
import { resolveGlobalAgentRoots } from "./promptResolver";
import {
  areModelSelectionsEqual,
  findBestMatchingModel,
  hasModelSelection,
  hasStrictModelVariantSelection,
  modelInfoToSelection,
  normalizeModelCatalog,
  normalizeModelSelection,
  type NormalizedModelSelection,
} from "./modelSelection";

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

type BuiltInChatMode = "agent" | "ask" | "edit";

type AvailableModelsResult = {
  models: ModelInfo[];
  source: "api" | "fallback";
};

type PromptRouting = {
  normalizedAgent: string;
  mode?: BuiltInChatMode;
  chatOpenPrompt: string;
  legacyPrompt: string;
};

type ResolvedModelSelectionResult = {
  selection: NormalizedModelSelection;
  matched?: ModelInfo;
};

type ChatModelLike = {
  id?: string;
  name?: string;
  vendor?: string;
  family?: string;
  version?: string;
};

function buildChatModelMergeKey(model: ChatModelLike | undefined): string {
  return JSON.stringify([
    String(model?.id || "").trim(),
    String(model?.name || "").trim(),
    String(model?.vendor || "").trim(),
    String(model?.family || "").trim(),
    String(model?.version || "").trim(),
  ]);
}

function mergeChatModelLists<T extends ChatModelLike>(
  preferredModels: readonly T[],
  discoveredModels: readonly T[],
): T[] {
  const merged: T[] = [];
  const seen = new Set<string>();

  for (const model of [...preferredModels, ...discoveredModels]) {
    const key = buildChatModelMergeKey(model);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(model);
  }

  return merged;
}

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

function resolveBuiltInChatMode(
  agent: string | undefined,
): BuiltInChatMode | undefined {
  const normalized =
    typeof agent === "string" ? normalizeAgentPrefix(agent) : "";
  if (normalized === "/agent") {
    return "agent";
  }
  if (normalized === "/ask") {
    return "ask";
  }
  if (normalized === "/edit") {
    return "edit";
  }
  return undefined;
}

function stripLeadingBuiltInModePrefix(
  prompt: string,
  mode: BuiltInChatMode,
): string {
  const pattern = new RegExp(`^\\s*/${mode}(?=\\s|$)\\s*`, "i");
  const stripped = prompt.replace(pattern, "").trim();
  return stripped || prompt;
}

function buildPromptRouting(
  processedPrompt: string,
  agent: string | undefined,
): PromptRouting {
  const normalizedAgent =
    typeof agent === "string" ? normalizeAgentPrefix(agent) : "";
  const mode = resolveBuiltInChatMode(agent);
  let legacyPrompt = processedPrompt;

  if (normalizedAgent) {
    if (!processedPrompt.startsWith("@") && !processedPrompt.startsWith("/")) {
      legacyPrompt = `${normalizedAgent} ${processedPrompt}`;
    }
  }

  return {
    normalizedAgent,
    mode,
    legacyPrompt,
    chatOpenPrompt: mode
      ? stripLeadingBuiltInModePrefix(legacyPrompt, mode)
      : legacyPrompt,
  };
}

function formatModelSelectionForLog(
  selection: NormalizedModelSelection,
): string {
  const parts = [
    selection.model ? `id=${selection.model}` : "",
    selection.modelVendor ? `vendor=${selection.modelVendor}` : "",
    selection.modelFamily ? `family=${selection.modelFamily}` : "",
    selection.modelVersion ? `version=${selection.modelVersion}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "default";
}

function buildModelSelectorCandidates(
  selection: NormalizedModelSelection,
): Array<Record<string, string>> {
  const selectors: Array<Record<string, string>> = [];
  const seen = new Set<string>();
  const hasStrictVariant = hasStrictModelVariantSelection(selection);

  const pushSelector = (candidate: {
    id?: string;
    vendor?: string;
    family?: string;
    version?: string;
  }) => {
    const compact = Object.fromEntries(
      Object.entries(candidate).filter(
        ([, value]) => typeof value === "string" && value.trim().length > 0,
      ),
    ) as Record<string, string>;
    if (Object.keys(compact).length === 0) {
      return;
    }
    const key = JSON.stringify(compact);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    selectors.push(compact);
  };

  if (selection.model) {
    pushSelector({
      id: selection.model,
      vendor: selection.modelVendor,
      family: selection.modelFamily,
      version: selection.modelVersion,
    });
    if (!selection.modelVersion) {
      pushSelector({
        id: selection.model,
        vendor: selection.modelVendor,
      });
      pushSelector({
        id: selection.model,
      });
    }
    return selectors;
  }

  pushSelector({
    vendor: selection.modelVendor,
    family: selection.modelFamily,
    version: selection.modelVersion,
  });
  if (!hasStrictVariant) {
    pushSelector({
      vendor: selection.modelVendor,
      family: selection.modelFamily,
    });
    pushSelector({
      family: selection.modelFamily,
      version: selection.modelVersion,
    });
    pushSelector({
      family: selection.modelFamily,
    });
  }

  return selectors;
}

function buildLegacyModelPickerCandidates(
  matchedModel: ModelInfo | undefined,
  selection: NormalizedModelSelection,
): string[] {
  const rawCandidates = [
    matchedModel?.label,
    selection.modelName,
    matchedModel?.name,
    selection.model,
  ];

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const candidate of rawCandidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    candidates.push(value);
  }

  return candidates;
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
  resolveBuiltInChatMode,
  stripLeadingBuiltInModePrefix,
  buildPromptRouting,
  buildModelSelectorCandidates,
  buildLegacyModelPickerCandidates,
  mergeChatModelLists,
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

    const routing = buildPromptRouting(processedPrompt, options?.agent);

    if (routing.normalizedAgent) {
      logDebug(
        `[CopilotScheduler] Agent set: ${routing.normalizedAgent}, mode: ${routing.mode || "none"}, prompt length: ${routing.legacyPrompt.length}`,
      );
    } else {
      logDebug(`[CopilotScheduler] No agent specified, using default`);
    }

    // Get chat session behavior and command delay factor once per execution
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const chatSession = config.get<ChatSessionBehavior>("chatSession", "new");
    const delayFactor = this.getCommandDelayFactor(config);
    const requestedModel = normalizeModelSelection(options);

    try {
      // Try to create new session if configured
      if (chatSession === "new") {
        await this.tryCreateNewChatSession(delayFactor);
      }

      const chatOpenResult = await this.tryOpenChatWithPrompt(
        routing.chatOpenPrompt,
        routing.mode,
        requestedModel,
      );
      if (!chatOpenResult.opened) {
        logDebug(
          `[CopilotScheduler] Falling back to legacy chat commands after chat.open failure`,
        );
        await this.executePromptLegacy(
          routing.legacyPrompt,
          chatOpenResult.resolvedSelection,
          chatOpenResult.resolvedModel,
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
        await vscode.env.clipboard.writeText(routing.legacyPrompt);
        notifyInfo(messages.promptCopied());
      }

      throw error;
    }
  }

  private async tryOpenChatWithPrompt(
    chatOpenPrompt: string,
    mode: BuiltInChatMode | undefined,
    requestedSelection: NormalizedModelSelection,
  ): Promise<{
    opened: boolean;
    resolvedSelection: NormalizedModelSelection;
    resolvedModel?: ModelInfo;
  }> {
    const resolved =
      await CopilotExecutor.resolveRequestedModelSelection(requestedSelection);
    const resolvedSelection = resolved.selection;

    if (!areModelSelectionsEqual(requestedSelection, resolvedSelection)) {
      logDebug(
        `[CopilotScheduler] Resolved model selection to current environment: ${formatModelSelectionForLog(resolvedSelection)}`,
      );
    }

    for (const selector of buildModelSelectorCandidates(resolvedSelection)) {
      try {
        logDebug(
          `[CopilotScheduler] Trying workbench.action.chat.open with model selector: ${JSON.stringify(selector)}`,
        );
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: chatOpenPrompt,
          isPartialQuery: false,
          mode,
          modelSelector: selector,
        });
        return {
          opened: true,
          resolvedSelection,
          resolvedModel: resolved.matched,
        };
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
        query: chatOpenPrompt,
        isPartialQuery: false,
        mode,
      });
      return {
        opened: true,
        resolvedSelection,
        resolvedModel: resolved.matched,
      };
    } catch (error) {
      logDebug(
        `[CopilotScheduler] chat.open without model selector failed: ${toSafeErrorDetails(error)}`,
      );
      return {
        opened: false,
        resolvedSelection,
        resolvedModel: resolved.matched,
      };
    }
  }

  private static async resolveRequestedModelSelection(
    selection: NormalizedModelSelection,
  ): Promise<ResolvedModelSelectionResult> {
    if (!hasModelSelection(selection)) {
      return { selection };
    }

    const { models } = await CopilotExecutor.getAvailableModelsWithSource();
    const matched = findBestMatchingModel(selection, models);
    if (!matched) {
      return { selection };
    }

    return {
      selection: modelInfoToSelection(matched),
      matched,
    };
  }

  private async executePromptLegacy(
    fullPrompt: string,
    selection: NormalizedModelSelection,
    matchedModel: ModelInfo | undefined,
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
    const modelCandidates = buildLegacyModelPickerCandidates(
      matchedModel,
      selection,
    );
    if (modelCandidates.length > 0) {
      let modelSelected = false;
      for (const candidate of modelCandidates) {
        try {
          logDebug(
            `[CopilotScheduler] Attempting to select legacy model candidate: ${candidate}`,
          );
          const result = await vscode.commands.executeCommand(
            "workbench.action.chat.selectModel",
            candidate,
          );
          logDebug(`[CopilotScheduler] Model selection result:`, result);
          modelSelected = true;
          await this.delay(
            this.getAdjustedDelayMs(DELAY_AFTER_MODEL_SELECT_MS, delayFactor),
          );
          break;
        } catch (error) {
          logDebug(
            `[CopilotScheduler] Legacy model selection failed for ${candidate}: ${toSafeErrorDetails(error)}`,
          );
        }
      }

      if (!modelSelected) {
        logError(
          `[CopilotScheduler] Model selection failed:`,
          formatModelSelectionForLog(selection),
        );
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
   * Get global agents from supported user-level custom agent locations.
   */
  static async getGlobalAgents(): Promise<AgentInfo[]> {
    const agents: AgentInfo[] = [];
    const seenAgentIds = new Set<string>();

    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const globalPaths = resolveGlobalAgentRoots(
      config.get<string>("globalAgentsPath", ""),
    );
    if (globalPaths.length === 0) {
      return agents;
    }

    for (const globalPath of globalPaths) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(
          vscode.Uri.file(globalPath),
        );
        for (const [fileName, fileType] of entries) {
          if (fileType !== vscode.FileType.File) continue;
          if (fileName.toLowerCase().endsWith(".agent.md")) {
            const agentName = fileName.replace(/\.agent\.md$/i, "");
            const agentId = `@${agentName}`;
            if (seenAgentIds.has(agentId)) {
              continue;
            }
            seenAgentIds.add(agentId);
            agents.push({
              id: agentId,
              name: agentId,
              description: messages.agentGlobalDesc(),
              isCustom: true,
              filePath: path.join(globalPath, fileName),
            });
          }
        }
      } catch (error) {
        logDebug(
          `[CopilotScheduler] Failed to read global agents from ${globalPath}:`,
          toSafeErrorDetails(error),
        );
      }
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
    const { models } = await CopilotExecutor.getAvailableModelsWithSource();
    return models;
  }

  static async getAvailableModelsWithSource(): Promise<AvailableModelsResult> {
    try {
      // Prefer the Copilot-contributed chat catalog so the picker stays aligned
      // with GitHub Copilot Chat rather than unrelated providers, but still
      // merge in the full catalog so matching Low/Medium/High variants remain
      // available for Copilot-exposed models.
      let models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      if (!models || models.length === 0) {
        models = await vscode.lm.selectChatModels({});
      } else {
        try {
          const discoveredModels = await vscode.lm.selectChatModels({});
          if (discoveredModels && discoveredModels.length > 0) {
            models = mergeChatModelLists(models, discoveredModels);
          }
        } catch (error) {
          logDebug(
            "[CopilotScheduler] Full model catalog lookup unavailable:",
            toSafeErrorDetails(error),
          );
        }
      }

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
            family: model.family || undefined,
            version: model.version || undefined,
          });
        }

        return { models: normalizeModelCatalog(modelInfos), source: "api" };
      }
    } catch (error) {
      // Language Model API may not be available
      logDebug(
        "[CopilotScheduler] Language Model API unavailable:",
        toSafeErrorDetails(error),
      );
    }

    // Fallback to static list
    return {
      models: CopilotExecutor.getFallbackModels(),
      source: "fallback",
    };
  }

  /**
   * Get fallback model list
   */
  static getFallbackModels(): ModelInfo[] {
    return normalizeModelCatalog([
      {
        id: "",
        name: messages.modelDefaultName(),
        description: messages.modelDefaultDesc(),
        vendor: "",
      },
    ]);
  }
}
