/**
 * Copilot Scheduler - Copilot Executor
 * Handles communication with GitHub Copilot Chat
 */

import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { notifyInfo } from "./extension";
import { chooseChatFallbackModel, normalizeModelFallbackPolicy } from "./modelFallback";
import type {
  AgentInfo,
  ModelInfo,
  ExecuteOptions,
  ExecutePromptResult,
  ModelFallbackInfo,
  ModelFallbackPolicy,
  ChatSessionBehavior,
} from "./types";
import { messages, isJapanese } from "./i18n";
import { resolveAgentHostTimeout } from "./agentHostTimeout";
import { logDebug, logError } from "./logger";
import { sanitizeAbsolutePathDetails } from "./errorSanitizer";
import {
  buildCopilotCliArgs,
  buildSkillPromptForCli,
  isCopilotCliModelSupported,
  resolveCopilotCliPath,
  runCopilotCliProcess,
} from "./copilotCliRunner";
import { getCurrentSkillRoots, readSkillInstructions } from "./skillResolver";
import { applyExperimentalModelQualitySelection } from "./modelQualityExperiment";
import {
  loadModelConfigurationCatalog,
  migrateLegacyModelConfiguration,
  validateModelConfiguration,
} from "./model-configuration";
import {
  hasSystemMessageDeclaration,
  resolveConfiguredTaskModel,
  supportsConfiguredModelExecution,
  supportsSystemMessageForwarding,
} from "./configured-model-provider";
import { resolveGlobalAgentRoots, isPathInsideBaseDir } from "./promptResolver";
import { getPreferredWorkspaceName } from "./workspaceRoots";
import {
  AgentHostError,
  findAgentHostEndpoint,
  isAgentHostTurnTerminal,
  listAgentHostChats,
  listAgentHostModels,
  queueAgentHostMessage,
  resolveAgentHostChatBinding,
  resolveUserDataDir,
  runAgentHostTurn,
  toAgentHostChatBindingId,
  toFileUri,
  WORKSPACE_FOLDER_REQUIRED_DETAIL,
  type AgentHostChatInfo,
  type AgentHostEndpoint,
  type AgentHostModelInfo,
  type AgentHostSessionRef,
} from "./agentHostClient";
import {
  withAgentHostDispatchJournal,
  type AgentHostDispatchRecord,
} from "./agentHostDispatchJournal";
import {
  createPromptBlockedError,
  isAgentHostContextBudgetFailure,
  isPromptBlockedError,
} from "./promptExecutionErrors";
import {
  areModelSelectionsEqual,
  classifyModelReport,
  DEFAULT_MODEL_FALLBACK_CHAIN,
  findBestMatchingModel,
  findFallbackModel,
  hasModelSelection,
  hasStrictModelVariantSelection,
  isAgentHostModelBindingCompatible,
  isCopilotModelVendor,
  modelInfoToSelection,
  normalizeModelCatalog,
  normalizeModelFallbackChain,
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
/** Chat may still be warming up when the first chat.open ladder fails. */
const DELAY_ATTACHMENT_RETRY_MS = 750;
const COMMAND_DELAY_FACTOR_DEFAULT = 0.8;
const COMMAND_DELAY_FACTOR_MIN = 0.1;
const COMMAND_DELAY_FACTOR_MAX = 2;

/** Slash-command agents — prefixed with "/" instead of "@" */
const SLASH_COMMAND_AGENTS: ReadonlySet<string> = new Set([
  "agent",
  "ask",
  "edit",
]);

/** Participant-style agents still require prompt prefixes today. */
const PARTICIPANT_STYLE_AGENTS: ReadonlySet<string> = new Set([
  "@workspace",
  "@terminal",
  "@vscode",
]);

type BuiltInChatMode = "agent" | "ask" | "edit";

type AvailableModelsResult = {
  models: ModelInfo[];
  source: "api" | "fallback";
  liveFallbackModels?: ModelInfo[];
};

type PromptRouting = {
  requestedAgent: string;
  runtimeAgent: string;
  chatOpenMode?: string;
  chatOpenPrompt: string;
  legacyPrompt: string;
};

type ResolvedModelSelectionResult = {
  selection: NormalizedModelSelection;
  matched?: ModelInfo;
  fallback?: ModelFallbackInfo;
};

type ChatModelLike = {
  id?: string;
  name?: string;
  vendor?: string;
  family?: string;
  version?: string;
  maxInputTokens?: number;
};

function buildChatModelMergeKey(model: ChatModelLike | undefined): string {
  return JSON.stringify([
    String(model?.id || "").trim(),
    String(model?.name || "").trim(),
    String(model?.vendor || "").trim(),
    String(model?.family || "").trim(),
    String(model?.version || "").trim(),
    typeof model?.maxInputTokens === "number" ? model.maxInputTokens : "",
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

function parseAgentFrontmatterName(content: string): string | undefined {
  return parseAgentFrontmatter(content).name;
}

/**
 * Parse the relevant fields from a `.agent.md` (or `AGENTS.md`) frontmatter
 * block. Returns the declared `name` and whether the agent is user-invocable.
 * Agents with `user-invocable: false` are subagent-only and cannot be selected
 * as a chat mode, so callers exclude them from the picker.
 */
function parseAgentFrontmatter(content: string): {
  name?: string;
  userInvocable: boolean;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { name: undefined, userInvocable: true };
  }

  const frontmatter = match[1];
  const nameMatch = frontmatter.match(
    /^name:\s*(?:"([^"]+)"|'([^']+)'|(.+))$/m,
  );
  const rawName = nameMatch?.[1] || nameMatch?.[2] || nameMatch?.[3];
  const name = rawName?.trim() || undefined;

  const invocableMatch = frontmatter.match(
    /^user-invocable:\s*(?:"([^"]+)"|'([^']+)'|(.+))$/m,
  );
  const rawInvocable = (
    invocableMatch?.[1] ||
    invocableMatch?.[2] ||
    invocableMatch?.[3] ||
    ""
  )
    .trim()
    .toLowerCase();
  // Default to true; only an explicit falsy value hides the agent.
  const userInvocable = !(
    rawInvocable === "false" ||
    rawInvocable === "no" ||
    rawInvocable === "0"
  );

  return { name, userInvocable };
}

async function readAgentMetadata(
  filePath: string | undefined,
): Promise<{ invocationName?: string; userInvocable: boolean }> {
  if (!filePath || path.extname(filePath).toLowerCase() !== ".md") {
    return { invocationName: undefined, userInvocable: true };
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    const parsed = parseAgentFrontmatter(Buffer.from(bytes).toString("utf8"));
    return {
      invocationName: parsed.name,
      userInvocable: parsed.userInvocable,
    };
  } catch (error) {
    logDebug(
      `[CopilotScheduler] Failed to read agent frontmatter from ${path.basename(filePath)}: ${toSafeErrorDetails(error)}`,
    );
    return { invocationName: undefined, userInvocable: true };
  }
}

function resolveChatOpenMode(agent: string | undefined): string | undefined {
  const normalized =
    typeof agent === "string" ? normalizeAgentPrefix(agent) : "";
  if (!normalized) {
    return undefined;
  }

  const builtInMode = resolveBuiltInChatMode(normalized);
  if (builtInMode) {
    return builtInMode;
  }

  if (normalized.startsWith("@") && !PARTICIPANT_STYLE_AGENTS.has(normalized)) {
    return normalized.slice(1).trim() || undefined;
  }

  return undefined;
}

function stripLeadingAgentPrefix(prompt: string, prefix: string): string {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escapedPrefix}(?=\\s|$)\\s*`, "i");
  const stripped = prompt.replace(pattern, "").trim();
  return stripped || prompt;
}

function stripLeadingAgentPrefixes(
  prompt: string,
  prefixes: readonly string[],
): string {
  let current = prompt;
  for (const prefix of prefixes) {
    if (!prefix) {
      continue;
    }
    const stripped = stripLeadingAgentPrefix(current, prefix);
    if (stripped !== current) {
      current = stripped;
      break;
    }
  }
  return current;
}

function stripLeadingBuiltInModePrefix(
  prompt: string,
  mode: BuiltInChatMode,
): string {
  return stripLeadingAgentPrefix(prompt, `/${mode}`);
}

function buildPromptRouting(
  processedPrompt: string,
  requestedAgent: string | undefined,
  runtimeAgentOverride?: string,
): PromptRouting {
  const normalizedRequestedAgent =
    typeof requestedAgent === "string"
      ? normalizeAgentPrefix(requestedAgent)
      : "";
  const runtimeAgent = runtimeAgentOverride
    ? normalizeAgentPrefix(runtimeAgentOverride)
    : normalizedRequestedAgent;
  const chatOpenMode = resolveChatOpenMode(runtimeAgent);
  let legacyPrompt = processedPrompt;

  if (runtimeAgent) {
    const strippedPrompt = stripLeadingAgentPrefixes(processedPrompt, [
      normalizedRequestedAgent,
      runtimeAgent,
    ]);

    if (
      (normalizedRequestedAgent &&
        processedPrompt.startsWith(normalizedRequestedAgent)) ||
      processedPrompt.startsWith(runtimeAgent)
    ) {
      legacyPrompt = `${runtimeAgent} ${strippedPrompt}`;
    } else if (
      !processedPrompt.startsWith("@") &&
      !processedPrompt.startsWith("/")
    ) {
      legacyPrompt = `${runtimeAgent} ${processedPrompt}`;
    }
  }

  return {
    requestedAgent: normalizedRequestedAgent,
    runtimeAgent,
    chatOpenMode,
    legacyPrompt,
    chatOpenPrompt:
      chatOpenMode && runtimeAgent
        ? stripLeadingAgentPrefixes(legacyPrompt, [
            normalizedRequestedAgent,
            runtimeAgent,
          ])
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

function hasStrictProviderSelection(
  selection: NormalizedModelSelection,
): boolean {
  return (
    !!selection.modelVendor &&
    !["copilot", "github-copilot", "githubcopilot"].includes(
      selection.modelVendor.toLowerCase(),
    )
  );
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
    // Auto routes between models, so the family and version it reports change with
    // its routing. Selecting it by those would miss it; id and vendor identify it.
    if (
      selection.model.trim().toLowerCase() === "auto" &&
      !hasStrictProviderSelection(selection)
    ) {
      pushSelector({ id: selection.model, vendor: selection.modelVendor });
      return selectors;
    }
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
        vendor: selection.modelVendor,
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
      vendor: selection.modelVendor,
      family: selection.modelFamily,
      version: selection.modelVersion,
    });
    pushSelector({
      vendor: selection.modelVendor,
      family: selection.modelFamily,
    });
  }

  return selectors;
}

function buildChatOpenArgs(
  chatOpenPrompt: string,
  mode: string | undefined,
  selection: NormalizedModelSelection,
  modelSelector?: Record<string, string>,
  omitModelConfiguration = false,
  attachFiles?: vscode.Uri[],
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    query: chatOpenPrompt,
    isPartialQuery: false,
    mode,
  };
  if (modelSelector && Object.keys(modelSelector).length > 0) {
    args.modelSelector = modelSelector;
  }
  if (attachFiles && attachFiles.length > 0) {
    args.attachFiles = attachFiles;
  }
  // NOTE: The actual reasoning-effort knob is applied out-of-band by
  // applyExperimentalModelQualitySelection(), which writes the Copilot Chat
  // `chatLanguageModels.json` settings file. VS Code's documented
  // IChatViewOpenOptions for `workbench.action.chat.open` has no
  // `modelConfiguration` field, so this inline value is best-effort only:
  // harmless if the running VS Code build ignores it, and a no-op forward-compat
  // hint otherwise. Do not rely on it as the sole reasoning-effort mechanism.
  if (!omitModelConfiguration && selection.modelReasoningEffort) {
    args.modelConfiguration = {
      reasoningEffort: selection.modelReasoningEffort,
    };
  }
  return args;
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

function resolveChatSessionBehavior(
  override: ChatSessionBehavior | undefined,
  config: vscode.WorkspaceConfiguration,
): ChatSessionBehavior {
  if (override === "new" || override === "continue") {
    return override;
  }

  const configured = config.get<ChatSessionBehavior>("chatSession", "new");
  return configured === "continue" ? "continue" : "new";
}

type SessionHarness = "auto" | "local";

/** "auto" leaves the session type to VS Code; unknown values never enable "local". */
function resolveSessionHarness(
  config: vscode.WorkspaceConfiguration,
): SessionHarness {
  return config.get<string>("sessionHarness", "auto") === "local"
    ? "local"
    : "auto";
}

type ExecutionRoute = "agentHost" | "chat";

/**
 * The Agent Host route needs a Copilot harness session in a local window: the
 * endpoint registry it reads is local, and `sessionHarness: local` asks for the
 * older Local harness, which the Agent Host does not run.
 */
function resolveExecutionRoute(
  config: vscode.WorkspaceConfiguration,
): ExecutionRoute {
  if (config.get<string>("executionRoute", "agentHost") === "chat") {
    return "chat";
  }
  if (resolveSessionHarness(config) === "local" || vscode.env.remoteName) {
    return "chat";
  }
  return "agentHost";
}

export const __testOnly = {
  resolveExecutionRoute,
  toSafeErrorDetails,
  resolveChatSessionBehavior,
  resolveSessionHarness,
  normalizeAgentPrefix,
  resolveBuiltInChatMode,
  parseAgentFrontmatterName,
  parseAgentFrontmatter,
  readAgentMetadata,
  resolveChatOpenMode,
  stripLeadingAgentPrefix,
  stripLeadingAgentPrefixes,
  stripLeadingBuiltInModePrefix,
  buildPromptRouting,
  buildModelSelectorCandidates,
  hasStrictProviderSelection,
  buildChatOpenArgs,
  buildLegacyModelPickerCandidates,
  mergeChatModelLists,
};

/**
 * Executes prompts through GitHub Copilot Chat
 */
interface CachedAgentHostSession {
  ref: AgentHostSessionRef;
  hostIdentity: string;
  startedAt?: number;
  orderUncertain?: boolean;
}

interface UncertainAgentHostTurn {
  hostIdentity: string;
  ref?: AgentHostSessionRef;
  turnId?: string;
}

export class CopilotExecutor {
  private static extensionGlobalStorageUri: vscode.Uri | undefined;
  private static agentHostUserDataDir: string | undefined;
  /** Latest confirmed session start per working folder and approval policy. */
  private static readonly agentHostSessions = new Map<
    string,
    CachedAgentHostSession
  >();
  private static readonly agentHostQueues = new Map<string, Promise<void>>();
  private static readonly agentHostUncertainChats = new Map<string, UncertainAgentHostTurn>();
  private static readonly agentHostDispatchOwner = randomUUID();
  private static readonly agentHostActiveDispatches = new Set<string>();

  static configureForExtensionContext(globalStorageUri: vscode.Uri): void {
    this.extensionGlobalStorageUri = globalStorageUri;
    this.agentHostUserDataDir = resolveUserDataDir(globalStorageUri.fsPath);
  }

  private static agentHostDispatchStorage(): string {
    // VS Code 1.147 reports a local global storage folder as `vscode-userdata:`, so the
    // scheme says nothing about locality; the extension host's own fsPath is what is used.
    const storagePath = this.extensionGlobalStorageUri?.fsPath;
    if (!storagePath || !path.isAbsolute(storagePath)) {
      // Nothing was dispatched yet, so the outcome is known and the run is safe to retry.
      throw new AgentHostError(
        "failed",
        "The Agent Host dispatch safety store is unavailable.",
        "failed",
      );
    }
    return storagePath;
  }

  private static async updateAgentHostDispatch(
    storage: string,
    chatId: string,
    recordId: string,
    action: "started" | "uncertain" | "remove",
    turnId?: string,
  ): Promise<void> {
    await withAgentHostDispatchJournal(storage, chatId, async (journal) => {
      const index = journal.records.findIndex((record) => record.id === recordId);
      if (index < 0) return;
      if (action === "remove") {
        journal.records.splice(index, 1);
      } else if (turnId) {
        journal.records[index].turnId = turnId;
      } else {
        return;
      }
      await journal.save();
    });
  }

  static async listAvailableAgentHostChats(): Promise<AgentHostChatInfo[]> {
    const userDataDir = this.agentHostUserDataDir;
    const endpoint = userDataDir ? findAgentHostEndpoint(userDataDir) : undefined;
    if (!endpoint) {
      throw new AgentHostError("unavailable", "No running Agent Host was found.");
    }
    return listAgentHostChats(endpoint);
  }

  static async listAvailableAgentHostModels(): Promise<AgentHostModelInfo[]> {
    const userDataDir = this.agentHostUserDataDir;
    const endpoint = userDataDir ? findAgentHostEndpoint(userDataDir) : undefined;
    if (!endpoint) {
      throw new AgentHostError("unavailable", "No running Agent Host was found.");
    }
    return listAgentHostModels(endpoint);
  }

  static async resolveTargetAgentHostChat(
    targetChatId: string,
    expectedWorkspacePath?: string,
  ): Promise<AgentHostChatInfo> {
    const userDataDir = this.agentHostUserDataDir;
    const endpoint = userDataDir ? findAgentHostEndpoint(userDataDir) : undefined;
    if (!endpoint) {
      throw new AgentHostError("unavailable", "No running Agent Host was found.");
    }
    return resolveAgentHostChatBinding(
      endpoint,
      targetChatId,
      expectedWorkspacePath,
    );
  }

  private getPreferredWorkspaceName(): string {
    return getPreferredWorkspaceName();
  }

  /**
   * Execute a prompt in Copilot Chat
   */
  async executePrompt(
    prompt: string,
    options?: ExecuteOptions,
  ): Promise<ExecutePromptResult> {
    // Apply prompt commands/placeholders
    const processedPrompt = this.applyPromptCommands(prompt);
    const hasExplicitTarget =
      options?.targetChatId !== undefined && options.targetChatId !== "";
    if (
      options?.agentHostWorkspaceMode !== undefined &&
      options.agentHostWorkspaceMode !== "folder" &&
      options.agentHostWorkspaceMode !== "worktree"
    ) {
      return this.warnAndThrow(
        createPromptBlockedError(messages.agentHostWorkspaceModeInvalid(), "agentHostUnavailable"),
        processedPrompt,
      );
    }

    if (hasExplicitTarget && options?.useCopilotCli === true) {
      return this.warnAndThrow(
        createPromptBlockedError(
          messages.targetChatRequiresAgentHost(),
          "agentHostUnavailable",
        ),
        processedPrompt,
      );
    }

    // The CLI route needs a model to apply; without one the chat route is used as before.
    if (options?.useCopilotCli === true && (options.model ?? "").trim()) {
      if (options.dispatchGuard && !options.allowUnguardedFallback) {
        return this.warnAndThrow(
          createPromptBlockedError(messages.oneTimeDispatchRequiresAgentHost(), "agentHostUnavailable"),
          processedPrompt,
        );
      }
      return this.executePromptViaCopilotCli(processedPrompt, options);
    }

    const runtimeAgent = await CopilotExecutor.resolveAgentInvocationTarget(
      options?.agent,
    );
    const routing = buildPromptRouting(
      processedPrompt,
      options?.agent,
      runtimeAgent,
    );

    if (routing.requestedAgent || routing.runtimeAgent) {
      logDebug(
        `[CopilotScheduler] Agent set: requested=${routing.requestedAgent || "none"}, runtime=${routing.runtimeAgent || "none"}, mode=${routing.chatOpenMode || "none"}, prompt length: ${routing.legacyPrompt.length}`,
      );
    } else {
      logDebug(`[CopilotScheduler] No agent specified, using default`);
    }

    // Get chat session behavior and command delay factor once per execution
    const config = vscode.workspace.getConfiguration("copilotScheduler");
    if (
      (hasExplicitTarget || options?.agentHostWorkspaceMode) &&
      resolveExecutionRoute(config) !== "agentHost"
    ) {
      return this.warnAndThrow(
        createPromptBlockedError(
          hasExplicitTarget
            ? messages.targetChatRequiresAgentHost()
            : messages.agentHostWorkspaceUnavailable(""),
          "agentHostUnavailable",
        ),
        routing.legacyPrompt,
      );
    }
    const chatSession = resolveChatSessionBehavior(
      options?.chatSession,
      config,
    );
    const delayFactor = this.getCommandDelayFactor(config);

    let agentHostFallbackReason: string | undefined;
    if (resolveExecutionRoute(config) === "agentHost") {
      const attempt = await this.tryExecuteViaAgentHost(
        routing,
        options,
        config,
        chatSession,
      );
      if (attempt.result) {
        return attempt.result;
      }
      agentHostFallbackReason = attempt.fallbackReason;
    }
    if (options?.dispatchGuard && !options.allowUnguardedFallback) {
      return this.warnAndThrow(
        createPromptBlockedError(messages.oneTimeDispatchRequiresAgentHost(), "agentHostUnavailable"),
        routing.legacyPrompt,
      );
    }
    let requestedModel: NormalizedModelSelection;
    try {
      requestedModel = normalizeModelSelection(options);
    } catch {
      throw createPromptBlockedError(
        messages.dynamicConfigurationUnavailable(),
        "modelConfigurationUnavailable",
      );
    }
    let resolved = await CopilotExecutor.resolveRequestedModelSelection(
      requestedModel,
      options?.modelFallback === true,
      options?.modelFallbackPolicy,
    );
    if (resolved.fallback) {
      logDebug(
        `[CopilotScheduler] Model fallback applied: ${resolved.fallback.from} -> ${resolved.fallback.to}`,
      );
    }
    if (resolved.selection.modelConfiguration !== undefined) {
      if (resolved.selection.modelReasoningEffort) {
        throw createPromptBlockedError(
          messages.dynamicConfigurationUnavailable(),
          "modelConfigurationUnavailable",
        );
      }
      if (Object.keys(resolved.selection.modelConfiguration).length > 0) {
        if (!resolved.matched)
          throw createPromptBlockedError(
            messages.dynamicConfigurationUnavailable(),
            "modelConfigurationUnavailable",
          );
        try {
          validateModelConfiguration(
            resolved.matched,
            resolved.selection.modelConfiguration,
          );
        } catch {
          throw createPromptBlockedError(
            messages.dynamicConfigurationUnavailable(),
            "modelConfigurationUnavailable",
          );
        }
        const participant = /^(@[^\s]+)(?:\s|$)/u.exec(
          routing.chatOpenPrompt.trim(),
        )?.[1];
        if (
          !hasSystemMessageDeclaration() ||
          ((!participant ||
            PARTICIPANT_STYLE_AGENTS.has(participant.toLowerCase())) &&
            !supportsSystemMessageForwarding())
        ) {
          throw createPromptBlockedError(
            !hasSystemMessageDeclaration()
              ? messages.detailedOptionsRequirePreview()
              : messages.dynamicConfigurationSystemMessagesUnsupported(),
            "modelConfigurationUnavailable",
          );
        }
        try {
          const configured = await resolveConfiguredTaskModel(
            resolved.matched,
            resolved.selection.modelConfiguration,
          );
          resolved = {
            selection: {
              ...modelInfoToSelection(configured),
              modelConfiguration: resolved.selection.modelConfiguration,
            },
            matched: configured,
          };
        } catch {
          throw createPromptBlockedError(
            messages.dynamicConfigurationExecutionBlocked(),
            "modelConfigurationUnavailable",
          );
        }
      }
    }

    if (!areModelSelectionsEqual(requestedModel, resolved.selection)) {
      logDebug(
        `[CopilotScheduler] Resolved model selection to current environment: ${formatModelSelectionForLog(resolved.selection)}`,
      );
    }

    if (
      resolved.selection.modelConfiguration === undefined &&
      resolved.selection.modelReasoningEffort
    ) {
      await this.syncExperimentalModelQuality(
        resolved.selection,
        resolved.matched,
      );
    }

    try {
      // Attachments are added by chat.open itself, so a new session must be
      // started before it, never after.
      if (chatSession === "new") {
        if (resolveSessionHarness(config) === "local") {
          await this.startLocalChatSession(delayFactor);
        } else {
          await this.tryCreateNewChatSession(delayFactor);
        }
      } else if (resolveSessionHarness(config) === "local") {
        logDebug(
          "[CopilotScheduler] sessionHarness=local applies to new sessions only; continuing the current session",
        );
      }

      const attachFiles = (options?.attachFilePaths ?? []).map((p) =>
        vscode.Uri.file(p),
      );

      let chatOpenResult = await this.tryOpenChatWithPrompt(
        routing.chatOpenPrompt,
        routing.chatOpenMode,
        resolved.selection,
        resolved.matched,
        attachFiles,
      );
      if (
        !chatOpenResult.opened &&
        attachFiles.length > 0 &&
        !resolved.selection.modelConfiguration &&
        !resolved.selection.model &&
        !resolved.selection.modelReasoningEffort
      ) {
        // Chat may still be warming up; retry once before refusing to run.
        await this.delay(
          this.getAdjustedDelayMs(DELAY_ATTACHMENT_RETRY_MS, delayFactor),
        );
        chatOpenResult = await this.tryOpenChatWithPrompt(
          routing.chatOpenPrompt,
          routing.chatOpenMode,
          resolved.selection,
          resolved.matched,
          attachFiles,
        );
      }
      if (!chatOpenResult.opened) {
        if (
          hasStrictProviderSelection(resolved.selection) ||
          !!resolved.selection.model ||
          !!resolved.selection.modelReasoningEffort ||
          (resolved.selection.modelConfiguration &&
            Object.keys(resolved.selection.modelConfiguration).length > 0)
        ) {
          throw createPromptBlockedError(
            messages.providerModelDispatchFailed(),
            "providerModelDispatchFailed",
          );
        }
        if (attachFiles.length > 0) {
          // The legacy path cannot carry attachments, and silently sending the
          // prompt without them would look like a successful run.
          throw createPromptBlockedError(
            messages.attachmentsRequireChatOpen(),
            "attachmentsRequireChatOpen",
          );
        }
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
      return this.warnAndThrow(
        error,
        routing.legacyPrompt,
        isPromptBlockedError(error) && error instanceof Error
          ? error.message
          : messages.autoExecuteFailed(),
      );
    }

    return {
      ...(resolved.fallback ? { modelFallback: resolved.fallback } : {}),
      ...(agentHostFallbackReason
        ? { agentHostRun: { fallbackReason: agentHostFallbackReason } }
        : {}),
      modelExecution: {
        route: vscode.env.remoteName
          ? "remote"
          : resolveSessionHarness(config) === "local"
            ? "local"
            : "chat",
        ...(requestedModel.model
          ? { requestedModel: requestedModel.model }
          : {}),
        verification: "unverified",
      },
    };
  }

  /**
   * Sends the prompt to the Agent Host that VS Code runs for the Copilot harness,
   * so the task's model and options are applied rather than left to the chat window.
   * Returns a fallback reason when the host cannot take the task; whether that
   * reason ends the run or sends it down the chat route is the user's setting.
   */
  private async tryExecuteViaAgentHost(
    routing: PromptRouting,
    options: ExecuteOptions | undefined,
    config: vscode.WorkspaceConfiguration,
    chatSession: ChatSessionBehavior,
  ): Promise<{ result?: ExecutePromptResult; fallbackReason?: string }> {
    const targetChatId = options?.targetChatId;
    const hasExplicitTarget = targetChatId !== undefined && targetChatId !== "";
    let failOnFallback =
      hasExplicitTarget ||
      !!options?.agentHostWorkspaceMode ||
      options?.preventAgentHostFallback === true ||
      config.get<string>("executionFallback", "chat") === "fail";
    const decline = async (rawDetail: string) => {
      const detail = sanitizeAbsolutePathDetails(
        rawDetail,
        messages.redactedPlaceholder(),
      );
      logDebug(`[CopilotScheduler] Agent Host not used: ${detail}`);
      if (failOnFallback) {
        await this.warnAndThrow(
          createPromptBlockedError(
            options?.agentHostWorkspaceMode && !hasExplicitTarget
              ? messages.agentHostWorkspaceUnavailable(detail)
              : options?.preventAgentHostFallback === true || hasExplicitTarget
                ? messages.agentHostFallbackPrevented(detail)
                : messages.agentHostNotUsed(detail),
            "agentHostUnavailable",
          ),
          routing.legacyPrompt,
        );
      }
      return { fallbackReason: detail };
    };
    const explicitTargetId = typeof targetChatId === "string"
      ? targetChatId.trim().toLowerCase()
      : "";
    if (hasExplicitTarget && !explicitTargetId) {
      return decline("the selected Copilot chat is no longer available");
    }

    let modelId: string | undefined;
    let hostModelIdExplicit = false;
    let selection: ReturnType<typeof normalizeModelSelection>;
    try {
      selection = normalizeModelSelection(options);
    } catch {
      return this.warnAndThrow(
        createPromptBlockedError(
          messages.dynamicConfigurationUnavailable(),
          "modelConfigurationUnavailable",
        ),
        routing.legacyPrompt,
      );
    }
    const hasSelector = hasModelSelection({
      ...selection,
      modelConfiguration: undefined,
    });
    const hasConfiguration =
      Object.keys(selection.modelConfiguration ?? {}).length > 0;
    if (hasSelector || hasConfiguration) {
      if (!isAgentHostModelBindingCompatible(selection)) {
        return this.warnAndThrow(
          createPromptBlockedError(
            messages.agentHostModelBindingInvalid(),
            "agentHostUnavailable",
          ),
          routing.legacyPrompt,
        );
      }
      hostModelIdExplicit = !!selection.agentHostModelId;
      if (
        !hostModelIdExplicit &&
        ((selection.modelVendor &&
          !isCopilotModelVendor(selection.modelVendor)) ||
          selection.model?.includes("::") ||
          selection.model?.includes("/") ||
          !selection.model)
      ) {
        return this.warnAndThrow(
          createPromptBlockedError(
            messages.agentHostModelSelectionRequired(),
            "agentHostUnavailable",
          ),
          routing.legacyPrompt,
        );
      }
      modelId = selection.agentHostModelId ?? selection.model?.trim();
    }

    const workspaceFolders = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath);
    const requestedCwd = (options?.workingDirectory ?? "").trim();
    const isDirectory = (candidate: string): boolean => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    };
    if (requestedCwd && !isDirectory(requestedCwd)) {
      return decline("the task's folder does not exist");
    }
    const cwd = requestedCwd
      ? requestedCwd
      : workspaceFolders.find((candidate) => isDirectory(candidate));
    const workspaceModeActive = !!options?.agentHostWorkspaceMode && !hasExplicitTarget;
    if (workspaceModeActive && (!cwd || !path.isAbsolute(cwd))) {
      return decline(WORKSPACE_FOLDER_REQUIRED_DETAIL);
    }

    const configuration = options?.modelConfiguration ?? {};
    // A replacement Host ID only applies to a pinned Host ID: a Chat-catalog ID
    // that is merely missing from the Host catalog does not prove the model is gone.
    const modelFallback = options?.modelFallback === true && hostModelIdExplicit
      ? normalizeModelFallbackPolicy(options.modelFallbackPolicy)
      : undefined;
    const hostFallbackFields = (fromId?: string, toId?: string) =>
      fromId && toId ? {
        modelFallback: {
          from: fromId,
          to: toId,
          fromId,
          toId,
          route: "agentHost" as const,
          reason: "modelAbsent" as const,
        },
      } : {};
    const agentHostTimeout = resolveAgentHostTimeout(config);
    const autoApprove =
      config.get<boolean>("agentHostAutoApprove", true) !== false;
    // The approval policy is fixed when a session is created, so sessions with a
    // different policy are never shared.
    const resolvedCwd = cwd ? path.resolve(cwd) : "";
    const sessionKey = JSON.stringify([
      process.platform === "win32" ? resolvedCwd.toLowerCase() : resolvedCwd,
      autoApprove,
    ]);
    // Capture once, before waiting for a same-chat operation.
    const selectedSession = !hasExplicitTarget && chatSession === "continue"
      ? CopilotExecutor.agentHostSessions.get(sessionKey)
      : undefined;
    failOnFallback ||= !!selectedSession;
    const ambiguousWorkspaceMode =
      workspaceModeActive && !requestedCwd && workspaceFolders.length !== 1;
    if (ambiguousWorkspaceMode && !selectedSession) {
      return decline(WORKSPACE_FOLDER_REQUIRED_DETAIL);
    }
    const userDataDir = CopilotExecutor.agentHostUserDataDir;
    const endpoint = userDataDir ? findAgentHostEndpoint(userDataDir) : undefined;
    if (!endpoint) {
      return decline("no running Agent Host was found");
    }
    const hostIdentity = createHash("sha256")
      .update(endpoint.socketPath)
      .update("\0")
      .update(endpoint.token)
      .digest("hex");
    let agentUri: string | undefined;
    let agentResolved = false;
    let newMessageDispatchedRef: AgentHostSessionRef | undefined;
    let startedRef: AgentHostSessionRef | undefined;
    let startedTurnId: string | undefined;
    const resolveAgent = async (): Promise<string | undefined> => {
      if (agentResolved || !routing.runtimeAgent) return undefined;
      const mode = routing.chatOpenMode;
      if (!mode || mode === "ask" || mode === "edit") {
        return "the task's agent is not available in the Agent Host";
      }
      if (mode !== "agent") {
        const filePath = await CopilotExecutor.findCustomAgentFile(
          routing.requestedAgent,
          routing.runtimeAgent,
        );
        if (!filePath) return "the task's custom agent file was not found";
        agentUri = toFileUri(filePath);
      }
      agentResolved = true;
      return undefined;
    };
    const run = async () => {
      const storage = CopilotExecutor.agentHostDispatchStorage();
      let recordId: string | undefined;
      let recordChatId: string | undefined;
      try {
        const result = await runAgentHostTurn({
        endpoint,
        text: routing.chatOpenPrompt,
        ...(cwd ? { cwdUri: toFileUri(cwd) } : {}),
        ...(options?.agentHostWorkspaceMode
          ? { workspaceMode: options.agentHostWorkspaceMode }
          : {}),
        ...(ambiguousWorkspaceMode ? { allowNewSession: false } : {}),
        ...(modelId ? { modelId } : {}),
        ...(hostModelIdExplicit ? { hostModelIdExplicit: true } : {}),
        ...(modelFallback ? { modelFallback } : {}),
        modelOptions: {
          ...configuration,
          reasoningEffort:
            configuration.reasoningEffort ?? options?.modelReasoningEffort,
        },
        ...(agentUri ? { agentUri } : {}),
        attachments: (options?.attachFilePaths ?? []).map((filePath) => ({
          label: path.basename(filePath),
          uri: toFileUri(filePath),
        })),
        autoApprove,
        ...(agentHostTimeout.runMs !== undefined
          ? { timeoutMs: agentHostTimeout.runMs }
          : {}),
        ...(options?.onAgentHostInputNeeded
          ? {
              onInputNeeded: options.onAgentHostInputNeeded,
              onInputObservationError: () =>
                logDebug("[CopilotScheduler] Agent Host input status could not be fully observed."),
            }
          : {}),
        ...(options?.dispatchGuard ? { dispatchGuard: options.dispatchGuard } : {}),
        beforeDispatch: async (ref, messageId) => {
          const id = randomUUID();
          const chatId = toAgentHostChatBindingId(ref.chatUri);
          recordId = id;
          recordChatId = chatId;
          await withAgentHostDispatchJournal(storage, chatId, async (journal) => {
            await CopilotExecutor.requireKnownChatOutcome(
              chatId, hostIdentity, endpoint, journal.records,
            );
            journal.records.push({
              id,
              owner: CopilotExecutor.agentHostDispatchOwner,
              hostIdentity,
              ref: { sessionUri: ref.sessionUri, chatUri: ref.chatUri },
              messageId,
            });
            await journal.save();
          });
        },
        onMessageDispatched: (ref) => { newMessageDispatchedRef = ref; },
        onSessionStarted: (ref, turnId, startedAt) => {
          startedRef = ref;
          startedTurnId = turnId;
          if (recordId && recordChatId) {
            CopilotExecutor.agentHostActiveDispatches.add(recordId);
            void CopilotExecutor.updateAgentHostDispatch(
              storage, recordChatId, recordId, "started", turnId,
            ).catch(() =>
              logError("[CopilotScheduler] Could not persist the Agent Host turn identity."),
            );
          }
          CopilotExecutor.recordAgentHostStart(sessionKey, hostIdentity, ref, startedAt);
          if (config.get<boolean>("agentHostOpenSession", true) === false) {
            return;
          }
          const sessionId = ref.sessionUri.split("/").pop();
          if (!sessionId) {
            return;
          }
          // Opens the session as an editor tab (verified on VS Code 1.146); if
          // the command changes, the run is unaffected and only the tab is missing.
          void Promise.resolve(
            vscode.commands.executeCommand(
              "workbench.action.chat.openSessionInEditorGroup",
              {
                resource: vscode.Uri.from({
                  scheme: "agent-host-copilotcli",
                  path: `/${sessionId}`,
                }),
              },
            ),
          ).then(undefined, (error: unknown) =>
            logDebug(
              `[CopilotScheduler] Could not open the Agent Host session: ${toSafeErrorDetails(error)}`,
            ),
          );
        },
        });
        if (recordId && recordChatId) {
          // Keep the dispatch active until its record is gone, so a queued send
          // racing with this completion does not read it as an unknown outcome.
          await CopilotExecutor.updateAgentHostDispatch(storage, recordChatId, recordId, "remove");
          CopilotExecutor.agentHostActiveDispatches.delete(recordId);
        }
        return result;
      } catch (error) {
        const knownTerminal = error instanceof AgentHostError &&
          (error.turnOutcome === "failed" || error.turnOutcome === "cancelled");
        if (recordId && recordChatId) {
          CopilotExecutor.agentHostActiveDispatches.delete(recordId);
          try {
            await CopilotExecutor.updateAgentHostDispatch(
              storage,
              recordChatId,
              recordId,
              newMessageDispatchedRef && !knownTerminal ? "uncertain" : "remove",
              startedTurnId,
            );
          } catch {
            logError("[CopilotScheduler] Could not update Agent Host dispatch safety state.");
            throw new AgentHostError(
              "failed",
              "The Agent Host dispatch safety state could not be updated. Check Chat before retrying.",
              "unknown",
            );
          }
        }
        if (
          newMessageDispatchedRef &&
          !knownTerminal &&
          (!(error instanceof AgentHostError) ||
            error.kind !== "failed" ||
            error.turnOutcome !== "unknown")
        ) {
          throw new AgentHostError(
            "failed",
            "The Agent Host dispatch outcome could not be confirmed.",
            "unknown",
          );
        }
        throw error;
      }
    };
    const targetId = hasExplicitTarget
      ? explicitTargetId
      : selectedSession ? toAgentHostChatBindingId(selectedSession.ref.chatUri) : undefined;

    try {
      logDebug(
        `[CopilotScheduler] ${targetId ? "Queueing to an Agent Host chat" : "Running through the Agent Host"}: model=${modelId ? "selected" : "default"}, agent=${routing.runtimeAgent ? "selected" : "default"}, continue=${chatSession === "continue"}, prompt length: ${routing.chatOpenPrompt.length}`,
      );
      if (targetId) {
        const storage = CopilotExecutor.agentHostDispatchStorage();
        const queueResult = await CopilotExecutor.runSerialized(`chat:${targetId}`, () =>
          withAgentHostDispatchJournal(storage, targetId, async (journal) => {
          if (selectedSession && (selectedSession.orderUncertain || selectedSession.hostIdentity !== hostIdentity)) {
            throw new AgentHostError("failed", "The continued Agent Host target could not be verified.", "unknown");
          }
          await CopilotExecutor.requireKnownChatOutcome(targetId, hostIdentity, endpoint, journal.records);
          const activeDispatches = journal.records
            .filter((record) =>
              record.owner === CopilotExecutor.agentHostDispatchOwner &&
              CopilotExecutor.agentHostActiveDispatches.has(record.id),
            )
            .map((record) => record.id);
          const agentFailure = await resolveAgent();
          if (agentFailure) return { agentFailure };
          let dispatchedRef: AgentHostSessionRef | undefined;
          let queuedTurnId: string | undefined;
          let record: AgentHostDispatchRecord | undefined;
          try {
            const queued = await queueAgentHostMessage({
              endpoint,
              targetChatId: targetId,
              ...(selectedSession ? { resume: selectedSession.ref } : {}),
              text: routing.chatOpenPrompt,
              ...(options?.taskId ? { taskId: options.taskId } : {}),
              ...(options?.queueOccurrenceId !== undefined
                ? { occurrenceId: options.queueOccurrenceId }
                : {}),
              ...(hasExplicitTarget && requestedCwd ? { expectedWorkspacePath: requestedCwd } : {}),
              ...(modelId ? { modelId } : {}),
              ...(hostModelIdExplicit ? { hostModelIdExplicit: true } : {}),
              ...(modelFallback ? { modelFallback } : {}),
              modelOptions: {
                ...configuration,
                reasoningEffort:
                  configuration.reasoningEffort ?? options?.modelReasoningEffort,
              },
              ...(agentUri ? { agentUri } : {}),
              attachments: (options?.attachFilePaths ?? []).map((filePath) => ({
                label: path.basename(filePath),
                uri: toFileUri(filePath),
              })),
              ...(options?.onAgentHostInputNeeded || options?.onAgentHostQueueBlocked
                ? {
                    ...(options.onAgentHostInputNeeded
                      ? { onInputNeeded: options.onAgentHostInputNeeded }
                      : {}),
                    ...(options.onAgentHostQueueBlocked
                      ? { onQueueBlocked: options.onAgentHostQueueBlocked }
                      : {}),
                    onInputObservationError: () =>
                      logDebug("[CopilotScheduler] Agent Host input status could not be fully observed."),
                    inputObservationTimeoutMs: agentHostTimeout.observationMs,
                  }
                : {}),
              beforeDispatch: async (ref, messageId) => {
                record = {
                  id: randomUUID(),
                  owner: CopilotExecutor.agentHostDispatchOwner,
                  hostIdentity,
                  ref: { sessionUri: ref.sessionUri, chatUri: ref.chatUri },
                  messageId,
                };
                journal.records.push(record);
                await journal.save();
              },
              dispatchGuard: async (dispatch) => {
                let earlierOutcomeUnknown = false;
                const checkedDispatch = () => {
                  if (
                    activeDispatches.some((id) => !CopilotExecutor.agentHostActiveDispatches.has(id)) ||
                    CopilotExecutor.agentHostUncertainChats.has(targetId)
                  ) {
                    earlierOutcomeUnknown = true;
                    return;
                  }
                  dispatch();
                };
                if (options?.dispatchGuard) await options.dispatchGuard(checkedDispatch);
                else checkedDispatch();
                if (earlierOutcomeUnknown) {
                  throw new AgentHostError("failed", "The earlier Agent Host outcome is still unknown.", "unknown");
                }
              },
              onMessageDispatched: (ref) => { dispatchedRef = ref; },
              onQueuedTurnStarted: (_ref, turnId) => { queuedTurnId = turnId; },
            });
            if (record) {
              const recordId = record.id;
              const index = journal.records.findIndex((entry) => entry.id === recordId);
              if (index >= 0) journal.records.splice(index, 1);
              await journal.save();
            }
            return { queued };
          } catch (error) {
            const knownTerminal = error instanceof AgentHostError &&
              (error.turnOutcome === "failed" || error.turnOutcome === "cancelled");
            const uncertain = !!dispatchedRef && !knownTerminal;
            if (uncertain && dispatchedRef) {
              CopilotExecutor.agentHostUncertainChats.set(targetId, {
                hostIdentity,
                ref: dispatchedRef,
                turnId: queuedTurnId,
              });
            }
            if (record) {
              const recordId = record.id;
              const index = journal.records.findIndex((entry) => entry.id === recordId);
              if (uncertain) {
                if (queuedTurnId) record.turnId = queuedTurnId;
                if (index < 0) journal.records.push(record);
              } else if (index >= 0) {
                journal.records.splice(index, 1);
              }
              try {
                await journal.save();
              } catch {
                logError("[CopilotScheduler] Could not update Agent Host dispatch safety state.");
                throw new AgentHostError(
                  "failed",
                  "The Agent Host dispatch safety state could not be updated. Check Chat before retrying.",
                  "unknown",
                );
              }
            }
            if (
              !dispatchedRef &&
              selectedSession &&
              error instanceof AgentHostError &&
              error.kind === "sessionExpired"
            ) {
              return { expired: true };
            }
            if (
              uncertain &&
              (!(error instanceof AgentHostError) ||
                error.kind !== "failed" ||
                error.turnOutcome !== "unknown")
            ) {
              throw new AgentHostError(
                "failed",
                "The queued Agent Host dispatch outcome could not be confirmed.",
                "unknown",
              );
            }
            throw error;
          }
          }),
        );
        if (queueResult.agentFailure) return decline(queueResult.agentFailure);
        if (queueResult.queued) {
          const queued = queueResult.queued;
          return {
            result: {
              ...hostFallbackFields(queued.fallbackFromModel, queued.requestedModel),
              agentHostRun: {
                ...(queued.requestedModel ? { requestedModel: queued.requestedModel } : {}),
                turnOutcome: "queued",
                messageId: queued.messageId,
                ...(selectedSession && options?.agentHostWorkspaceMode
                  ? {
                      workspaceMode: options.agentHostWorkspaceMode,
                      workspaceModeApplication: "not_applied_resumed",
                    }
                  : {}),
              },
              modelExecution: {
                route: "agentHost",
                ...(queued.requestedModel ? { requestedModel: queued.requestedModel } : {}),
                verification: "unverified",
              },
            },
          };
        }
        if (ambiguousWorkspaceMode) return decline(WORKSPACE_FOLDER_REQUIRED_DETAIL);
      }
      const agentFailure = await resolveAgent();
      if (agentFailure) return decline(agentFailure);
      const turn = await run();
      const requested = turn.requestedModel;
      const applied = turn.appliedModel;
      const verification = classifyModelReport(requested, applied);
      if (requested && applied && verification === "reported_mismatch") {
        void vscode.window.showWarningMessage(
          messages.agentHostModelMismatch(requested, applied),
        );
      }
      return {
        result: {
          ...hostFallbackFields(turn.fallbackFromModel, requested),
          agentHostRun: {
            ...(requested ? { requestedModel: requested } : {}),
            ...(applied ? { appliedModel: applied } : {}),
            turnOutcome: "completed",
            responseText: turn.responseText,
            ...(turn.workspaceMode ? { workspaceMode: turn.workspaceMode } : {}),
            ...(turn.workspaceModeApplication
              ? { workspaceModeApplication: turn.workspaceModeApplication }
              : {}),
          },
          modelExecution: {
            route: "agentHost",
            ...(requested ? { requestedModel: requested } : {}),
            ...(applied ? { reportedModel: applied } : {}),
            verification,
          },
        },
      };
    } catch (error) {
      const uncertainRef = startedRef ?? newMessageDispatchedRef;
      if (
        uncertainRef &&
        error instanceof AgentHostError &&
        error.kind === "failed" &&
        (error.turnOutcome ?? "unknown") === "unknown"
      ) {
        CopilotExecutor.agentHostUncertainChats.set(
          toAgentHostChatBindingId(uncertainRef.chatUri),
          { hostIdentity, ref: uncertainRef, turnId: startedTurnId },
        );
      }
      if (isPromptBlockedError(error)) {
        return this.warnAndThrow(error, routing.legacyPrompt);
      }
      if (error instanceof AgentHostError && error.kind === "workspaceMode") {
        return this.warnAndThrow(
          createPromptBlockedError(
            messages.agentHostWorkspaceUnavailable(
              sanitizeAbsolutePathDetails(error.message, messages.redactedPlaceholder()),
            ),
            "agentHostUnavailable",
          ),
          routing.legacyPrompt,
        );
      }
      if (error instanceof AgentHostError && error.kind === "modelIdentity") {
        return this.warnAndThrow(
          createPromptBlockedError(
            messages.agentHostModelSelectionRequired(),
            "agentHostUnavailable",
          ),
          routing.legacyPrompt,
        );
      }
      if (error instanceof AgentHostError && error.kind !== "failed") {
        return decline(error.message);
      }
      const detail = sanitizeAbsolutePathDetails(
        error instanceof Error ? error.message : "",
        messages.redactedPlaceholder(),
      )
        .replace(/\s+/g, " ")
        .trim();
      const turnOutcome =
        error instanceof AgentHostError
          ? (error.turnOutcome ?? "unknown")
          : "unknown";
      return this.warnAndThrow(
        createPromptBlockedError(
          turnOutcome === "unknown"
            ? messages.agentHostOutcomeUnknown(detail)
            : turnOutcome === "cancelled"
              ? messages.agentHostCancelled(detail)
              : turnOutcome === "failed" &&
                  isAgentHostContextBudgetFailure(detail)
                ? messages.agentHostContextBudgetExceeded()
                : messages.agentHostFailed(detail),
          "agentHostFailed",
          turnOutcome,
        ),
        routing.legacyPrompt,
      );
    }
  }

  private static recordAgentHostStart(
    sessionKey: string,
    hostIdentity: string,
    ref: AgentHostSessionRef,
    startedAt: string,
  ): void {
    const previous = this.agentHostSessions.get(sessionKey);
    const timestamp = Date.parse(startedAt);
    if (!Number.isFinite(timestamp)) {
      this.agentHostSessions.set(sessionKey, {
        ...(previous ?? { ref, hostIdentity }),
        startedAt: undefined,
        orderUncertain: true,
      });
      return;
    }
    if (previous?.orderUncertain && previous.startedAt === undefined) return;
    if (previous?.startedAt !== undefined && timestamp < previous.startedAt) return;
    if (
      previous?.startedAt === timestamp &&
      previous.ref.chatUri !== ref.chatUri
    ) {
      this.agentHostSessions.set(sessionKey, { ...previous, orderUncertain: true });
      return;
    }
    this.agentHostSessions.set(sessionKey, { ref, hostIdentity, startedAt: timestamp });
  }

  private static async requireKnownChatOutcome(
    chatId: string,
    hostIdentity: string,
    endpoint: AgentHostEndpoint,
    records: AgentHostDispatchRecord[],
  ): Promise<void> {
    const uncertain = this.agentHostUncertainChats.get(chatId);
    if (uncertain) {
      let terminal = false;
      if (uncertain.hostIdentity === hostIdentity && uncertain.ref && uncertain.turnId) {
        try {
          terminal = await isAgentHostTurnTerminal(endpoint, uncertain.ref, uncertain.turnId);
        } catch {
          // A missing or unreadable snapshot is not a terminal-state confirmation.
        }
      }
      if (!terminal) {
        throw new AgentHostError("failed", "The earlier Agent Host outcome is still unknown.", "unknown");
      }
      if (this.agentHostUncertainChats.get(chatId) === uncertain) {
        this.agentHostUncertainChats.delete(chatId);
      }
    }
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (
        record.hostIdentity === hostIdentity &&
        record.owner === this.agentHostDispatchOwner &&
        this.agentHostActiveDispatches.has(record.id)
      ) {
        continue;
      }
      let terminal = false;
      if (record.hostIdentity === hostIdentity && record.turnId) {
        try {
          terminal = await isAgentHostTurnTerminal(endpoint, record.ref, record.turnId);
        } catch {
          // Unavailable state must not release a persisted dispatch.
        }
      }
      if (!terminal) {
        throw new AgentHostError("failed", "The earlier Agent Host outcome is still unknown.", "unknown");
      }
      records.splice(index, 1);
    }
  }

  /** Serialize queue submissions for the same actual chat, not for a folder. */
  private static runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = CopilotExecutor.agentHostQueues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    CopilotExecutor.agentHostQueues.set(key, tail);
    void tail.then(() => {
      if (CopilotExecutor.agentHostQueues.get(key) === tail) {
        CopilotExecutor.agentHostQueues.delete(key);
      }
    });
    return next;
  }

  private static async findCustomAgentFile(
    requested: string,
    runtime: string,
  ): Promise<string | undefined> {
    const wanted = new Set(
      [requested, runtime].filter(Boolean).map(normalizeAgentPrefix),
    );
    try {
      const agents = await CopilotExecutor.getAllAgents();
      const matched = agents.find(
        (candidate) =>
          wanted.has(normalizeAgentPrefix(candidate.id)) ||
          wanted.has(normalizeAgentPrefix(candidate.name)) ||
          (!!candidate.invocationName &&
            wanted.has(normalizeAgentPrefix(candidate.invocationName))),
      );
      return matched?.filePath && fs.existsSync(matched.filePath)
        ? matched.filePath
        : undefined;
    } catch {
      return undefined;
    }
  }

  private warnAndThrow(
    error: unknown,
    promptForCopy: string,
    warning?: string,
  ): never {
    try {
      void Promise.resolve(
        vscode.window.showWarningMessage(
          warning ?? (error instanceof Error ? error.message : messages.autoExecuteFailed()),
          messages.actionCopyPrompt(),
          messages.actionCancel(),
        ),
      )
        .then(async (action) => {
          if (action === messages.actionCopyPrompt()) {
            await vscode.env.clipboard.writeText(promptForCopy);
            notifyInfo(messages.promptCopied());
          }
        })
        .catch((notificationError: unknown) =>
          logError(
            "[CopilotScheduler] Execution warning failed:",
            toSafeErrorDetails(notificationError),
          ),
        );
    } catch (notificationError) {
      logError(
        "[CopilotScheduler] Execution warning failed:",
        toSafeErrorDetails(notificationError),
      );
    }
    throw error;
  }

  /**
   * Runs the prompt as a background `copilot` process so the saved model and
   * reasoning effort are applied (a chat session may ignore them). Nothing is sent
   * to a chat window, and the answer is not kept.
   */
  private async executePromptViaCopilotCli(
    prompt: string,
    options: ExecuteOptions,
  ): Promise<ExecutePromptResult> {
    try {
      return await this.runCopilotCli(prompt, options);
    } catch (error) {
      return this.warnAndThrow(
        error,
        prompt,
        isPromptBlockedError(error) && error instanceof Error
          ? error.message
          : messages.autoExecuteFailed(),
      );
    }
  }

  private async runCopilotCli(
    prompt: string,
    options: ExecuteOptions,
  ): Promise<ExecutePromptResult> {
    const hasDynamicOptions =
      !!options.modelConfiguration &&
      Object.keys(options.modelConfiguration).length > 0;
    if (
      (options.attachFilePaths?.length ?? 0) > 0 ||
      hasDynamicOptions ||
      (options.agent ?? "").trim()
    ) {
      throw createPromptBlockedError(
        messages.copilotCliUnsupportedOptions(),
        "copilotCliUnavailable",
      );
    }

    const config = vscode.workspace.getConfiguration("copilotScheduler");
    const executable = resolveCopilotCliPath(
      config.get<string>("cliPath", ""),
    );
    if (!executable) {
      throw createPromptBlockedError(
        messages.copilotCliNotFound(),
        "copilotCliUnavailable",
      );
    }

    const model = (options.model ?? "").trim();
    if (!isCopilotCliModelSupported(options.modelVendor, model)) {
      throw createPromptBlockedError(
        messages.copilotCliUnsupportedModel(),
        "copilotCliUnavailable",
      );
    }
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath);
    const requestedCwd = (options.workingDirectory ?? "").trim();
    const cwd =
      [requestedCwd, workspaceFolders[0]].find(
        (candidate) =>
          !!candidate &&
          fs.existsSync(candidate) &&
          fs.statSync(candidate).isDirectory(),
      ) ?? os.homedir();
    const trustFolder =
      vscode.workspace.isTrusted &&
      workspaceFolders.some((folder) => isPathInsideBaseDir(folder, cwd));

    const skillMatch = /^\s*\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)([\s\S]*)$/.exec(
      prompt.replace(/^\uFEFF/, ""),
    );
    let cliPrompt = prompt;
    if (skillMatch) {
      const skill = await readSkillInstructions(
        skillMatch[1],
        getCurrentSkillRoots(),
        { workspaceTrusted: vscode.workspace.isTrusted },
      );
      if (skill) {
        cliPrompt = buildSkillPromptForCli(
          skillMatch[1],
          skill.dir,
          skill.body,
          skillMatch[2],
        );
      }
    }

    const timeoutMinutes = Math.min(
      Math.max(Math.floor(config.get<number>("cliTimeoutMinutes", 60)) || 60, 1),
      720,
    );
    logDebug(
      `[CopilotScheduler] Running with the Copilot CLI: model=${model}, reasoningEffort=${options.modelReasoningEffort || "default"}, trustFolder=${trustFolder}, prompt length: ${cliPrompt.length}`,
    );

    const result = await runCopilotCliProcess({
      executable,
      args: buildCopilotCliArgs({
        model,
        reasoningEffort: options.modelReasoningEffort,
        allowAllTools: config.get<boolean>("cliAllowAllTools", false) === true,
        trustFolder,
      }),
      cwd,
      prompt: cliPrompt,
      timeoutMs: timeoutMinutes * 60 * 1000,
    });

    if (result.cancelled) {
      throw createPromptBlockedError(
        messages.copilotCliCancelled(),
        "copilotCliFailed",
      );
    }
    if (result.timedOut) {
      throw createPromptBlockedError(
        messages.copilotCliTimedOut(timeoutMinutes),
        "copilotCliFailed",
      );
    }
    if (result.spawnError) {
      throw createPromptBlockedError(
        messages.copilotCliNotFound(),
        "copilotCliUnavailable",
      );
    }
    if (result.exitCode !== 0) {
      const detail = sanitizeAbsolutePathDetails(
        result.stderrTail,
        messages.redactedPlaceholder(),
      )
        .replace(/\s+/g, " ")
        .trim();
      throw createPromptBlockedError(
        messages.copilotCliFailed(result.exitCode, detail),
        "copilotCliFailed",
      );
    }

    return {
      cliRun: {
        requestedModel: model,
        ...(result.summary.appliedModel
          ? { appliedModel: result.summary.appliedModel }
          : {}),
        ...(typeof result.summary.premiumRequests === "number"
          ? { premiumRequests: result.summary.premiumRequests }
          : {}),
      },
      modelExecution: {
        route: "copilotCli",
        requestedModel: model,
        ...(result.summary.appliedModel
          ? { reportedModel: result.summary.appliedModel }
          : {}),
        verification: classifyModelReport(model, result.summary.appliedModel),
      },
    };
  }

  private async tryOpenChatWithPrompt(
    chatOpenPrompt: string,
    mode: string | undefined,
    resolvedSelection: NormalizedModelSelection,
    resolvedModel: ModelInfo | undefined,
    attachFiles: vscode.Uri[],
  ): Promise<{
    opened: boolean;
    resolvedSelection: NormalizedModelSelection;
    resolvedModel?: ModelInfo;
  }> {
    if (
      resolvedSelection.modelConfiguration &&
      Object.keys(resolvedSelection.modelConfiguration).length > 0
    ) {
      try {
        const result = await vscode.commands.executeCommand<{
          errorDetails?: unknown;
        }>("workbench.action.chat.open", {
          ...buildChatOpenArgs(
            chatOpenPrompt,
            mode,
            resolvedSelection,
            {
              id: resolvedSelection.model!,
              vendor: resolvedSelection.modelVendor!,
            },
            false,
            attachFiles,
          ),
          blockOnResponse: true,
        });
        return {
          opened: !result?.errorDetails,
          resolvedSelection,
          resolvedModel,
        };
      } catch {
        return { opened: false, resolvedSelection, resolvedModel };
      }
    }
    if (resolvedSelection.model || resolvedSelection.modelReasoningEffort) {
      const id = resolvedModel?.id || resolvedSelection.model;
      if (!id) return { opened: false, resolvedSelection, resolvedModel };
      try {
        const result = await vscode.commands.executeCommand<{
          errorDetails?: unknown;
        }>(
          "workbench.action.chat.open",
          buildChatOpenArgs(
            chatOpenPrompt,
            mode,
            resolvedSelection,
            {
              id,
              vendor:
                resolvedModel?.vendor ||
                resolvedSelection.modelVendor ||
                "copilot",
              ...(resolvedSelection.modelFamily
                ? { family: resolvedSelection.modelFamily }
                : {}),
              ...(resolvedSelection.modelVersion
                ? { version: resolvedSelection.modelVersion }
                : {}),
            },
            false,
            attachFiles,
          ),
        );
        return {
          opened: !result?.errorDetails,
          resolvedSelection,
          resolvedModel,
        };
      } catch {
        return { opened: false, resolvedSelection, resolvedModel };
      }
    }
    for (const selector of buildModelSelectorCandidates(resolvedSelection)) {
      try {
        logDebug(
          `[CopilotScheduler] Trying workbench.action.chat.open mode=${mode ?? "(none)"} with model selector: ${JSON.stringify(selector)}, reasoningEffort=${resolvedSelection.modelReasoningEffort || "default"}, attachments=${attachFiles.length}`,
        );
        await vscode.commands.executeCommand(
          "workbench.action.chat.open",
          buildChatOpenArgs(
            chatOpenPrompt,
            mode,
            resolvedSelection,
            selector,
            false,
            attachFiles,
          ),
        );
        return {
          opened: true,
          resolvedSelection,
          resolvedModel,
        };
      } catch (error) {
        logDebug(
          `[CopilotScheduler] chat.open with model selector failed: ${toSafeErrorDetails(error)}`,
        );
      }
    }

    if (hasStrictProviderSelection(resolvedSelection)) {
      return { opened: false, resolvedSelection, resolvedModel };
    }

    try {
      logDebug(
        `[CopilotScheduler] Trying workbench.action.chat.open mode=${mode ?? "(none)"} without model selector, reasoningEffort=${resolvedSelection.modelReasoningEffort || "default"}`,
      );
      await vscode.commands.executeCommand(
        "workbench.action.chat.open",
        buildChatOpenArgs(
          chatOpenPrompt,
          mode,
          resolvedSelection,
          undefined,
          false,
          attachFiles,
        ),
      );
      return {
        opened: true,
        resolvedSelection,
        resolvedModel,
      };
    } catch (error) {
      logDebug(
        `[CopilotScheduler] chat.open without model selector failed: ${toSafeErrorDetails(error)}`,
      );
    }

    if (mode) {
      logDebug(
        `[CopilotScheduler] chat.open failed for all attempts; falling back to legacy chat commands. The custom agent mode=${mode}${resolvedSelection.modelReasoningEffort ? ` and reasoningEffort=${resolvedSelection.modelReasoningEffort}` : ""} cannot be applied via the legacy fallback.`,
      );
    }
    return {
      opened: false,
      resolvedSelection,
      resolvedModel,
    };
  }

  private static async resolveAgentInvocationTarget(
    agent: string | undefined,
  ): Promise<string | undefined> {
    const normalizedAgent =
      typeof agent === "string" ? normalizeAgentPrefix(agent) : "";
    if (!normalizedAgent) {
      return undefined;
    }

    if (
      resolveBuiltInChatMode(normalizedAgent) ||
      PARTICIPANT_STYLE_AGENTS.has(normalizedAgent)
    ) {
      return normalizedAgent;
    }

    try {
      const agents = await CopilotExecutor.getAllAgents();
      const matched = agents.find(
        (candidate) =>
          normalizeAgentPrefix(candidate.id) === normalizedAgent ||
          normalizeAgentPrefix(candidate.name) === normalizedAgent,
      );
      if (!matched) {
        return normalizedAgent;
      }

      const invocationName =
        matched.invocationName || matched.name || matched.id;
      return normalizeAgentPrefix(invocationName);
    } catch (error) {
      logDebug(
        `[CopilotScheduler] Failed to resolve runtime agent target for ${normalizedAgent}: ${toSafeErrorDetails(error)}`,
      );
      return normalizedAgent;
    }
  }

  private static async resolveRequestedModelSelection(
    selection: NormalizedModelSelection,
    allowFallback = false,
    requestedPolicy?: ModelFallbackPolicy,
  ): Promise<ResolvedModelSelectionResult> {
    if (!hasModelSelection(selection)) {
      return { selection };
    }

    const { models, source, liveFallbackModels } =
      await CopilotExecutor.getAvailableModelsWithSource();
    const taskPolicy = allowFallback && requestedPolicy !== undefined;
    // Resolution keeps its existing tolerance for renamed IDs; the policy only
    // applies when nothing resolves and the live catalog proves the model is gone.
    const matched = findBestMatchingModel(selection, models);
    if (!matched) {
      if (taskPolicy && selection.model && liveFallbackModels?.length) {
        const isSaved = (model: ModelInfo) => model.id === selection.model &&
          (!selection.modelVendor || model.vendor === selection.modelVendor);
        if (!liveFallbackModels.some(isSaved)) {
          const policy = normalizeModelFallbackPolicy(requestedPolicy);
          const replacement = policy
            ? chooseChatFallbackModel(policy, selection, liveFallbackModels)
            : undefined;
          if (!replacement) {
            throw createPromptBlockedError(
              messages.chatFallbackModelUnavailable(),
              "providerModelUnavailable",
            );
          }
          return {
            selection: modelInfoToSelection(replacement),
            matched: replacement,
            fallback: {
              from: selection.modelName || selection.model || "",
              to: replacement.name || replacement.id,
              fromId: selection.model,
              toId: replacement.id,
              fromProvider: selection.modelVendor,
              toProvider: replacement.vendor,
              route: "chat",
              reason: "modelAbsent",
            },
          };
        }
      }
      // Only a live catalog can prove the model is gone; the static list
      // contains no models and would make every task look unavailable.
      if (allowFallback && !taskPolicy && source === "api") {
        const fallbackModel = findFallbackModel(
          normalizeModelFallbackChain(
            vscode.workspace
              .getConfiguration("copilotScheduler")
              .get<unknown>(
                "modelFallbackChain",
                DEFAULT_MODEL_FALLBACK_CHAIN,
              ),
          ),
          models,
          selection,
        );
        if (fallbackModel) {
          return {
            selection: modelInfoToSelection(fallbackModel),
            matched: fallbackModel,
            fallback: {
              from: selection.modelName || selection.model || "",
              to: fallbackModel.name || fallbackModel.id,
            },
          };
        }
      }
      if (hasStrictProviderSelection(selection)) {
        throw createPromptBlockedError(
          messages.providerModelUnavailable(),
          "providerModelUnavailable",
        );
      }
      return { selection };
    }

    const matchedSelection = {
      ...modelInfoToSelection(matched),
      modelReasoningEffort: selection.modelReasoningEffort,
      modelConfiguration: selection.modelConfiguration,
    };
    return {
      selection: supportsConfiguredModelExecution()
        ? migrateLegacyModelConfiguration(
            matchedSelection,
            matched,
            supportsSystemMessageForwarding(),
          )
        : matchedSelection,
      matched,
    };
  }

  private async syncExperimentalModelQuality(
    selection: NormalizedModelSelection,
    matchedModel: ModelInfo | undefined,
  ): Promise<void> {
    const globalStorageUri = CopilotExecutor.extensionGlobalStorageUri;
    if (!globalStorageUri) {
      if (
        selection.modelVendor === "openai-codex" &&
        selection.modelReasoningEffort
      ) {
        throw createPromptBlockedError(
          messages.providerModelDispatchFailed(),
          "providerModelDispatchFailed",
        );
      }
      return;
    }

    try {
      const syncResult = await applyExperimentalModelQualitySelection({
        globalStorageUri,
        selection,
        matchedModel,
      });
      logDebug(
        `[CopilotScheduler] Experimental model quality sync: model=${syncResult.modelId || "none"}, vendor=${syncResult.vendor || "none"}, family=${syncResult.family || "none"}, requested=${syncResult.requestedReasoningEffort || "default"}, supported=${syncResult.supportedReasoningEfforts.join("/") || "none"}, effective=${syncResult.effectiveReasoningEffort || "default"}, previous=${syncResult.previousReasoningEffort || "default"}, changed=${syncResult.configChanged}, skipped=${syncResult.skippedReason || "none"}`,
      );
    } catch (error) {
      logError(
        "[CopilotScheduler] Experimental model quality sync failed:",
        toSafeErrorDetails(error),
      );
      if (selection.modelVendor === "openai-codex") {
        throw createPromptBlockedError(
          messages.providerModelDispatchFailed(),
          "providerModelDispatchFailed",
        );
      }
    }
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

  /**
   * Start a new Local-harness chat session. Unlike the default path, a failure
   * stops the run: sending into another session type would silently change
   * where the task runs.
   */
  private async startLocalChatSession(delayFactor: number): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.newLocalChat");
    } catch (error) {
      logDebug(
        "[CopilotScheduler] newLocalChat failed:",
        toSafeErrorDetails(error),
      );
      throw createPromptBlockedError(
        messages.sessionHarnessLocalUnavailable(),
        "sessionHarnessUnavailable",
      );
    }
    await this.delay(this.getAdjustedDelayMs(DELAY_NEW_SESSION_MS, delayFactor));
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

    // Search for *.agent.md files. The previous hard limit of 100 could
    // silently truncate the agent list (and any cache built from it) in large
    // workspaces, so raise the cap and surface a warning when it is reached.
    const agentFileScanLimit = 1000;
    const agentFiles = await vscode.workspace.findFiles(
      "**/*.agent.md",
      "**/node_modules/**",
      agentFileScanLimit,
    );
    if (agentFiles.length >= agentFileScanLimit) {
      logDebug(
        `[CopilotScheduler] Custom agent scan hit the ${agentFileScanLimit}-file limit; some *.agent.md files may be omitted.`,
      );
    }

    for (const file of agentFiles) {
      const fileName = path.basename(file.fsPath).replace(/\.agent\.md$/i, "");
      const { invocationName, userInvocable } = await readAgentMetadata(
        file.fsPath,
      );
      // Subagent-only agents (`user-invocable: false`) are never offered as a
      // chat mode by VS Code, so excluding them keeps the picker actionable.
      if (!userInvocable) {
        continue;
      }
      const runtimeLabel = normalizeAgentPrefix(invocationName || fileName);
      agents.push({
        id: `@${fileName}`,
        name: runtimeLabel,
        description: messages.agentCustomDesc(),
        isCustom: true,
        invocationName,
        userInvocable,
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
              invocationName: agentName,
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
            const { invocationName, userInvocable } = await readAgentMetadata(
              path.join(globalPath, fileName),
            );
            // Skip subagent-only agents (`user-invocable: false`); they cannot
            // be selected as a chat mode.
            if (!userInvocable) {
              continue;
            }
            const runtimeLabel = normalizeAgentPrefix(
              invocationName || agentName,
            );
            if (seenAgentIds.has(agentId)) {
              continue;
            }
            seenAgentIds.add(agentId);
            agents.push({
              id: agentId,
              name: runtimeLabel,
              description: messages.agentGlobalDesc(),
              isCustom: true,
              invocationName,
              userInvocable,
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

  /** Cached result of {@link getAllAgents}; cleared by {@link invalidateAgentCache}. */
  private static cachedAgents: AgentInfo[] | undefined;
  /** In-flight scan shared by concurrent {@link getAllAgents} callers. */
  private static cachedAgentsPromise: Promise<AgentInfo[]> | undefined;

  /**
   * Drop the cached agent list so the next {@link getAllAgents} call rescans.
   * Called when agent files change, relevant settings change, or the set of
   * workspace folders changes.
   */
  static invalidateAgentCache(): void {
    CopilotExecutor.cachedAgents = undefined;
    CopilotExecutor.cachedAgentsPromise = undefined;
  }

  /**
   * Get all agents (built-in + custom + global), deduplicated by id.
   *
   * Results are cached so the execution path (and the webview) do not rescan
   * the workspace on every call. Pass `forceRefresh` to bypass the cache, and
   * use {@link invalidateAgentCache} to drop it when sources change.
   */
  static async getAllAgents(forceRefresh = false): Promise<AgentInfo[]> {
    if (forceRefresh) {
      CopilotExecutor.invalidateAgentCache();
    }
    if (CopilotExecutor.cachedAgents) {
      return CopilotExecutor.cachedAgents;
    }
    if (!CopilotExecutor.cachedAgentsPromise) {
      CopilotExecutor.cachedAgentsPromise = (async () => {
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
      })();
    }
    const pending = CopilotExecutor.cachedAgentsPromise;
    const result = await pending;
    // Only publish to the shared cache if this scan is still the current one.
    // If invalidateAgentCache() (e.g. a forced refresh, file change, or setting
    // change) ran while this scan was in flight, cachedAgentsPromise was reset,
    // so a stale older scan must not overwrite the newer result.
    if (CopilotExecutor.cachedAgentsPromise === pending) {
      CopilotExecutor.cachedAgents = result;
      CopilotExecutor.cachedAgentsPromise = undefined;
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
      let models: vscode.LanguageModelChat[] = [];
      let fullCatalog: vscode.LanguageModelChat[] | undefined;
      try {
        models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      } catch (error) {
        logDebug(
          "[CopilotScheduler] Copilot model catalog lookup unavailable:",
          toSafeErrorDetails(error),
        );
      }
      if (!models || models.length === 0) {
        fullCatalog = models = await vscode.lm.selectChatModels({});
      } else {
        try {
          const discoveredModels = fullCatalog = await vscode.lm.selectChatModels({});
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
            maxInputTokens:
              typeof model.maxInputTokens === "number"
                ? model.maxInputTokens
                : undefined,
          });
        }

        return {
          models: await loadModelConfigurationCatalog(
            normalizeModelCatalog(modelInfos),
          ),
          source: "api",
          ...(fullCatalog?.length && fullCatalog.every((model) => model.id?.trim() && model.vendor?.trim())
            ? { liveFallbackModels: fullCatalog.map((model) => ({
                id: model.id,
                name: model.name || model.id,
                vendor: model.vendor,
                family: model.family,
                version: model.version,
                description: model.family || "",
              })) }
            : {}),
        };
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
