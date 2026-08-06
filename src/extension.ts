/**
 * Copilot Scheduler - Extension Entry Point
 * Registers commands, initializes components, and starts the scheduler
 */

import * as vscode from "vscode";
import * as path from "path";
import { ScheduleManager } from "./scheduleManager";
import { CopilotExecutor } from "./copilotExecutor";
import { ScheduledTaskTreeProvider, ScheduledTaskItem } from "./treeProvider";
import { SchedulerWebview } from "./schedulerWebview";
import { messages } from "./i18n";
import { initLogger, logDebug, logError } from "./logger";
import { sanitizeAbsolutePathDetails } from "./errorSanitizer";
import {
  buildModelPickerGroups,
  filterPickerModelCatalog,
} from "./modelSelection";
import {
  getLanguageModelsConfigUriFromGlobalStorageUri,
  isExperimentalModelQualityEnabled,
} from "./modelQualityExperiment";
import { getNextCronRun } from "./cronExpressions";
import {
  computePromptHash,
  normalizeForCompare,
  resolveGlobalAgentRoots,
  resolveGlobalPromptPath,
  resolveLocalPromptCandidates,
  resolveGlobalPromptsRoot,
} from "./promptResolver";
import {
  createPromptBlockedError,
  getPromptBlockedReason,
  isPromptBlockedError,
  type PromptBlockedReason,
} from "./promptExecutionErrors";
import {
  enqueueExecutionHistoryEntry as enqueueExecutionHistory,
  getExecutionHistoryEntries,
  initExecutionHistoryStore,
  recordExecutionHistoryBestEffort,
  resetExecutionHistoryQueueForTests,
  setExecutionHistoryContextForTests,
  type ExecutionHistoryEntry,
  type ExecutionHistoryStatus,
  type ExecutionPromptSource,
  type ExecutionTrigger,
} from "./executionHistoryStore";
import { registerLmTools } from "./lmTools/registry";
import { createModelSelectionResolver } from "./taskMutationService";
import type {
  ScheduledTask,
  CreateTaskInput,
  TaskAction,
  PromptPreview,
  PromptSource,
  PromptExecutionRequest,
} from "./types";

type NotificationMode = "sound" | "silentToast" | "silentStatus";
type PromptExecutionOptions = Omit<PromptExecutionRequest, "prompt">;

/**
 * What to do when a file-backed prompt cannot be read at execution time.
 * Only applies to tasks whose promptSource is not "inline" and that have a promptPath.
 */
type PromptFileFallbackPolicy =
  | "snapshot"
  | "blockWhenResolvable"
  | "blockAlways";

type PromptResolution = {
  /** Raw prompt text as resolved, before frontmatter parsing or auto-mode hints. */
  text: string;
  source: ExecutionPromptSource;
  resolvedPath?: string;
  hash: string;
  resolvedAt: string;
  fallbackReason?: PromptBlockedReason;
  /** True when the file was found in a workspace folder other than the preferred one. */
  crossWorkspaceResolved?: boolean;
  /** Number of allowed candidate paths found for this task. */
  candidateCount: number;
};

const PROMPT_SYNC_DATE_KEY = "promptSyncDate";
const LAST_VERSION_KEY = "lastKnownVersion";
const EMPTY_PROMPT_TEMPLATE_ERROR_NAME = "PromptTemplateEmptyError";

function sanitizeErrorDetailsForLog(message: string): string {
  const sanitized = sanitizeAbsolutePathDetails(
    message,
    messages.redactedPlaceholder(),
  );
  return sanitized.trim() ? sanitized : messages.webviewUnknown();
}

function shouldNotify(): boolean {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  return config.get<boolean>("showNotifications", true);
}

function normalizeNotificationMode(mode: unknown): NotificationMode {
  switch (mode) {
    case "sound":
    case "silentToast":
    case "silentStatus":
      return mode;
    default:
      return "sound";
  }
}

function resolveNotificationMode(
  showNotificationsEnabled: boolean,
  mode: unknown,
): NotificationMode {
  if (!showNotificationsEnabled) {
    return "silentStatus";
  }
  return normalizeNotificationMode(mode);
}

function getNotificationMode(): NotificationMode {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  return resolveNotificationMode(
    config.get<boolean>("showNotifications", true),
    config.get<NotificationMode>("notificationMode", "sound"),
  );
}

function resolveDisplayErrorMessage(message: string): string {
  const safeMessage = sanitizeErrorDetailsForLog(message);
  return resolveDisplayErrorMessageFromSanitized(safeMessage);
}

function resolveDisplayErrorMessageFromSanitized(safeMessage: string): string {
  const firstLine = safeMessage.split(/\r?\n/)[0] ?? "";
  return firstLine.trim() ? firstLine : messages.webviewUnknown();
}

function createEmptyPromptTemplateError(filePath: string): Error {
  const error = new Error(
    messages.promptTemplateEmpty(path.basename(filePath)),
  );
  error.name = EMPTY_PROMPT_TEMPLATE_ERROR_NAME;
  return error;
}

function isEmptyPromptTemplateError(error: unknown): boolean {
  return (
    error instanceof Error && error.name === EMPTY_PROMPT_TEMPLATE_ERROR_NAME
  );
}

function buildPromptExecutionOptions(
  request: PromptExecutionRequest,
): PromptExecutionOptions {
  return {
    agent: request.agent,
    chatSession: request.chatSession,
    model: request.model,
    modelName: request.modelName,
    modelVendor: request.modelVendor,
    modelFamily: request.modelFamily,
    modelVersion: request.modelVersion,
    modelReasoningEffort: request.modelReasoningEffort,
  };
}

async function maybeWarnCronInterval(cronExpression?: string): Promise<void> {
  if (!cronExpression) return;
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const enabled = config.get<boolean>("minimumIntervalWarning", true);
  if (!enabled) return;
  const warning = scheduleManager.checkMinimumInterval(cronExpression);
  if (warning) {
    // Non-blocking warning: do not stall create/update until the user dismisses
    void vscode.window.showInformationMessage(warning);
  }
}

async function maybeShowDisclaimerOnce(task: ScheduledTask): Promise<boolean> {
  if (!task.enabled) return true;
  if (scheduleManager.isDisclaimerAccepted()) return true;
  const choice = await vscode.window.showInformationMessage(
    messages.disclaimerMessage(),
    messages.disclaimerAccept(),
    messages.disclaimerDecline(),
  );
  if (choice !== messages.disclaimerAccept()) {
    return false;
  }
  await scheduleManager.setDisclaimerAccepted(true);
  return true;
}

async function ensureTaskEnabledAfterDisclaimer(
  task: ScheduledTask,
): Promise<boolean> {
  if (!task.enabled) return true;
  const accepted = await maybeShowDisclaimerOnce(task);
  if (accepted) {
    return true;
  }

  const disabled = await scheduleManager.setTaskEnabled(task.id, false);
  if (disabled) {
    SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
    notifyInfo(messages.disclaimerDeclinedTaskDisabled(task.name));
    return false;
  }
  notifyError(messages.taskNotFound());
  return false;
}

type CreatedTaskDisclaimerDeps = {
  maybeShowDisclaimer: (task: ScheduledTask) => Promise<boolean>;
  deleteTask: (id: string) => Promise<boolean>;
  disableTask: (id: string) => Promise<ScheduledTask | undefined>;
  onTasksChanged: () => void;
  notifyInfo: (message: string) => void;
  notifyError: (message: string) => void;
};

async function ensureCreatedTaskAcceptedAfterDisclaimer(
  task: ScheduledTask,
  deps?: CreatedTaskDisclaimerDeps,
): Promise<boolean> {
  const resolvedDeps: CreatedTaskDisclaimerDeps = deps ?? {
    maybeShowDisclaimer: maybeShowDisclaimerOnce,
    deleteTask: (id) => scheduleManager.deleteTask(id),
    disableTask: (id) => scheduleManager.setTaskEnabled(id, false),
    onTasksChanged: () => {
      SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
    },
    notifyInfo,
    notifyError,
  };

  const accepted = await resolvedDeps.maybeShowDisclaimer(task);
  if (accepted) {
    return true;
  }

  const deleted = await resolvedDeps.deleteTask(task.id);
  if (deleted) {
    resolvedDeps.onTasksChanged();
    resolvedDeps.notifyInfo(messages.disclaimerDeclinedTaskCanceled(task.name));
    return false;
  }

  const disabled = await resolvedDeps.disableTask(task.id);
  if (disabled) {
    resolvedDeps.onTasksChanged();
    resolvedDeps.notifyInfo(messages.disclaimerDeclinedTaskDisabled(task.name));
    return false;
  }

  resolvedDeps.notifyError(messages.taskNotFound());
  return false;
}

async function syncPromptTemplatesIfNeeded(
  context: vscode.ExtensionContext,
  force = false,
): Promise<void> {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (!force) {
    const last = context.globalState.get<string>(PROMPT_SYNC_DATE_KEY, "");
    if (last === todayKey) {
      return;
    }
  }

  const tasks = scheduleManager.getAllTasks();
  const promptUpdates: Array<{ id: string; prompt: string }> = [];
  let hadUnreadableTemplate = false;

  for (const task of tasks) {
    if (task.promptSource === "inline") continue;
    if (!task.promptPath) continue;
    try {
      // Background sync should only read persisted file contents.
      const resolution = await resolvePromptSnapshot(task, false);
      if (resolution.source !== "file") {
        // Path/read failure: keep retrying on the next sync instead of
        // marking today as done.
        hadUnreadableTemplate = true;
        continue;
      }
      if (resolution.text !== task.prompt && resolution.text.trim()) {
        promptUpdates.push({ id: task.id, prompt: resolution.text });
      }
    } catch (error) {
      hadUnreadableTemplate = true;
      const errorMessage =
        error instanceof Error ? error.message : String(error ?? "");
      logError(
        `[CopilotScheduler] Prompt sync failed for task "${task.name}": ${sanitizeErrorDetailsForLog(errorMessage)}`,
      );
    }
  }

  const updated =
    promptUpdates.length > 0
      ? (await scheduleManager.updateTaskPrompts(promptUpdates)) > 0
      : false;

  if (updated) {
    // updateTaskPrompts -> saveTasks -> notifyTasksChanged callback already
    // refreshes both TreeView and Webview. Avoid duplicate task-list pushes.
  }

  if (!hadUnreadableTemplate) {
    await context.globalState.update(PROMPT_SYNC_DATE_KEY, todayKey);
  }
}

export function notifyInfo(message: string, timeoutMs = 4000): void {
  if (!shouldNotify()) return;
  const mode = getNotificationMode();
  switch (mode) {
    case "silentStatus":
      vscode.window.setStatusBarMessage(message, timeoutMs);
      break;
    case "silentToast":
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: message },
        () => new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      );
      break;
    default:
      void vscode.window.showInformationMessage(message);
  }
}

export function notifyError(message: string, timeoutMs = 6000): void {
  const safeMessage = sanitizeErrorDetailsForLog(message);
  const displayMessage = resolveDisplayErrorMessageFromSanitized(safeMessage);
  const mode = getNotificationMode();
  logError(safeMessage);
  if (mode === "silentStatus") {
    vscode.window.setStatusBarMessage(`⚠ ${displayMessage}`, timeoutMs);
    return;
  }
  if (mode === "silentToast") {
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `⚠ ${displayMessage}`,
      },
      () => new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    );
    return;
  }
  void vscode.window.showErrorMessage(displayMessage);
}

function getNotificationNextRun(
  task: ScheduledTask,
  baseTime = new Date(),
): Date | undefined {
  const tz = vscode.workspace
    .getConfiguration("copilotScheduler")
    .get<string>("timezone", "");
  const currentDate = baseTime;
  try {
    const options: { currentDate: Date; tz?: string } = { currentDate };
    if (tz) {
      options.tz = tz;
    }
    return getNextCronRun(task.cronExpression, options);
  } catch {
    if (tz) {
      try {
        logDebug(
          `[CopilotScheduler] Invalid timezone \"${tz}\" for notification nextRun; falling back to local time.`,
        );
        return getNextCronRun(task.cronExpression, { currentDate });
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function formatNextRunText(date?: Date): string {
  if (!date || Number.isNaN(date.getTime())) {
    return messages.labelNever();
  }
  return messages.formatDateTime(date);
}

function buildExecutionSummary(
  taskName: string,
  status: ExecutionHistoryStatus,
  nextRunDate?: Date,
): string {
  const resultLabel =
    status === "success"
      ? messages.executionResultSuccess()
      : status === "blocked"
        ? messages.executionResultBlocked()
        : messages.executionResultFailed();
  return messages.taskExecutionSummary(
    taskName,
    resultLabel,
    formatNextRunText(nextRunDate),
  );
}

function setExtensionContextForTests(
  context: Pick<vscode.ExtensionContext, "globalState"> | undefined,
): void {
  extensionContextRef = context as vscode.ExtensionContext | undefined;
  setExecutionHistoryContextForTests(context);
}

function formatHistoryTimestamp(value: string | undefined): string {
  if (!value) return messages.webviewUnknown();
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? messages.webviewUnknown()
    : messages.formatDateTime(date);
}

function resolveHistoryPromptSourceLabel(
  source: ExecutionHistoryEntry["promptSource"],
): string | undefined {
  switch (source) {
    case "inline":
      return messages.executionPromptSourceInline();
    case "openDocument":
      return messages.executionPromptSourceOpenDocument();
    case "file":
      return messages.executionPromptSourceFile();
    case "snapshotFallback":
      return messages.executionPromptSourceSnapshot();
    default:
      return undefined;
  }
}

function resolveHistoryFallbackLabel(
  reason: string | undefined,
): string | undefined {
  switch (reason) {
    case "noPromptPath":
    case "pathUnresolved":
    case "readFailed":
      return describePromptBlockedReason(reason);
    default:
      return undefined;
  }
}

function buildExecutionHistoryDetail(entry: ExecutionHistoryEntry): string {
  const lines: string[] = [];
  if (entry.detail?.trim()) {
    lines.push(entry.detail.trim());
  }

  const sourceLabel = resolveHistoryPromptSourceLabel(entry.promptSource);
  if (sourceLabel) {
    lines.push(`${messages.executionHistoryPromptSource()}: ${sourceLabel}`);
  }
  if (entry.promptPathDisplay?.trim()) {
    lines.push(
      `${messages.executionHistoryPromptPath()}: ${resolveDisplayErrorMessage(entry.promptPathDisplay)}`,
    );
  }
  if (entry.promptHash && /^[a-f0-9]{12}$/i.test(entry.promptHash)) {
    lines.push(
      `${messages.executionHistoryPromptHash()}: ${entry.promptHash.toLowerCase()}`,
    );
  }
  if (entry.promptResolvedAt) {
    lines.push(
      `${messages.executionHistoryPromptResolvedAt()}: ${formatHistoryTimestamp(entry.promptResolvedAt)}`,
    );
  }
  const fallbackLabel = resolveHistoryFallbackLabel(entry.promptFallbackReason);
  if (fallbackLabel) {
    lines.push(
      `${messages.executionHistoryPromptFallback()}: ${fallbackLabel}`,
    );
  }

  return lines.join("\n");
}

function buildExecutionHistoryQuickPickItems(
  history: ExecutionHistoryEntry[],
): Array<{ label: string; description: string; detail: string }> {
  return history.map((entry) => {
    const icon =
      entry.status === "success"
        ? "✅"
        : entry.status === "blocked"
          ? "⛔"
          : "❌";
    const statusLabel =
      entry.status === "success"
        ? messages.executionResultSuccess()
        : entry.status === "blocked"
          ? messages.executionResultBlocked()
          : messages.executionResultFailed();
    const triggerLabel =
      entry.trigger === "manual"
        ? messages.executionTriggerManual()
        : messages.executionTriggerAuto();
    const nextRunText = entry.nextRunAt
      ? formatHistoryTimestamp(entry.nextRunAt)
      : messages.labelNever();
    return {
      label: `${icon} ${entry.taskName}`,
      description: `${formatHistoryTimestamp(entry.executedAt)} · ${triggerLabel} · ${statusLabel} · ${messages.labelNextRun()}: ${nextRunText}`,
      detail: buildExecutionHistoryDetail(entry),
    };
  });
}

async function showExecutionHistoryView(deps?: {
  getHistoryEntries(): ExecutionHistoryEntry[];
  notifyInfo(message: string): void;
  showQuickPick(
    items: Array<{ label: string; description: string; detail: string }>,
    options: {
      placeHolder: string;
      matchOnDescription: boolean;
      matchOnDetail: boolean;
    },
  ): Thenable<unknown>;
}): Promise<void> {
  const history = deps
    ? deps.getHistoryEntries()
    : getExecutionHistoryEntries();
  if (history.length === 0) {
    (deps?.notifyInfo ?? notifyInfo)(messages.executionHistoryEmpty());
    return;
  }

  const picks = buildExecutionHistoryQuickPickItems(history);

  const showQuickPick = deps?.showQuickPick
    ? deps.showQuickPick
    : vscode.window.showQuickPick.bind(vscode.window);
  await showQuickPick(picks, {
    placeHolder: messages.executionHistoryPickPlaceholder(),
    matchOnDescription: true,
    matchOnDetail: true,
  });
}

// Global instances
let scheduleManager: ScheduleManager;
let copilotExecutor: CopilotExecutor;
let treeProvider: ScheduledTaskTreeProvider;
let promptSyncInterval: ReturnType<typeof setInterval> | undefined;
let promptResourceWatchers: vscode.Disposable[] = [];
let extensionContextRef: vscode.ExtensionContext | undefined;
const manualRunInFlightTaskIds = new Set<string>();

const PROMPT_PREVIEW_DEBOUNCE_MS = 300;
const pendingPromptPreviewPaths = new Set<string>();
let promptPreviewTimer: ReturnType<typeof setTimeout> | undefined;

type PromptExecutionPayload = PromptExecutionRequest;

type ManualRunFailureResult = {
  ok: false;
  reason:
    | "taskNotFound"
    | "executorUnavailable"
    | "alreadyRunning"
    | "promptBlocked"
    | "executionFailed"
    | "saveFailed";
  errorMessage?: string;
  userNotified?: boolean;
};

const USER_NOTIFIED_EXECUTION_ERROR_FLAG = "copilotSchedulerUserNotified";

function markExecutionErrorAsUserNotified(error: unknown): void {
  if (!error || typeof error !== "object") {
    return;
  }

  try {
    (error as Record<string, unknown>)[USER_NOTIFIED_EXECUTION_ERROR_FLAG] =
      true;
  } catch {
    // best-effort marker only
  }
}

function handleManualRunFailure(
  taskName: string,
  runResult: ManualRunFailureResult,
  options?: { showWebviewError?: boolean },
): void {
  const showWebviewError = options?.showWebviewError === true;

  if (runResult.reason === "alreadyRunning") {
    const msg = messages.taskAlreadyRunning(taskName);
    notifyInfo(msg);
    if (showWebviewError) {
      SchedulerWebview.showError(msg);
    }
    return;
  }

  if (runResult.reason === "promptBlocked") {
    const msg =
      resolveDisplayErrorMessage(
        runResult.errorMessage || messages.webviewUnknown(),
      ) || messages.webviewUnknown();
    notifyError(msg);
    if (showWebviewError) {
      SchedulerWebview.showError(msg);
    }
    return;
  }

  if (runResult.reason === "executionFailed") {
    if (runResult.userNotified) {
      return;
    }
    const msg = messages.taskExecutionFailed(
      taskName,
      runResult.errorMessage || messages.webviewUnknown(),
    );
    notifyError(msg);
    if (showWebviewError) {
      SchedulerWebview.showError(msg);
    }
    return;
  }

  if (runResult.reason === "saveFailed") {
    const msg = messages.manualRunSaveFailed(
      taskName,
      runResult.errorMessage || messages.webviewUnknown(),
    );
    if (getNotificationMode() !== "silentStatus") {
      vscode.window.setStatusBarMessage(
        `⚠ ${messages.manualRunSaveFailedStatus(taskName)}`,
        6000,
      );
    }
    notifyError(msg);
    if (showWebviewError) {
      SchedulerWebview.showError(msg);
    }
    return;
  }

  if (runResult.reason === "executorUnavailable") {
    const msg = messages.manualRunUnavailable();
    notifyError(msg);
    if (showWebviewError) {
      SchedulerWebview.showError(msg);
    }
    return;
  }

  const msg = messages.taskNotFound();
  notifyError(msg);
  if (showWebviewError) {
    SchedulerWebview.showError(msg);
  }
}

function disposePromptResourceWatchers(): void {
  for (const disposable of promptResourceWatchers) {
    try {
      disposable.dispose();
    } catch {
      // best-effort cleanup only
    }
  }
  promptResourceWatchers = [];
}

function registerPromptResourceWatchers(): void {
  disposePromptResourceWatchers();

  const refreshCaches = () => {
    // Agent definitions are scanned and cached in the executor; drop that cache
    // so edits to *.agent.md / AGENTS.md are reflected on the next run and in
    // the panel.
    CopilotExecutor.invalidateAgentCache();
    void SchedulerWebview.refreshCachesAndNotifyPanel(true);
  };

  const watchPattern = (
    pattern: vscode.GlobPattern,
    onPromptFileChanged?: (uri: vscode.Uri) => void,
  ): void => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const handle = (uri: vscode.Uri) => {
      refreshCaches();
      onPromptFileChanged?.(uri);
    };
    promptResourceWatchers.push(
      watcher,
      watcher.onDidCreate(handle),
      watcher.onDidChange(handle),
      watcher.onDidDelete(handle),
    );
  };

  watchPattern("**/.github/prompts/**/*.md", schedulePromptPreviewRefresh);
  // Workspace agent definitions can live outside .github/prompts (e.g.
  // .github/agents, AGENTS.md, or repository root), so watch them explicitly.
  watchPattern("**/*.agent.md");
  watchPattern("**/AGENTS.md");

  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const watchedRoots = new Set<string>();
  const roots = [
    resolveGlobalPromptsRoot(config.get<string>("globalPromptsPath", "")),
    ...resolveGlobalAgentRoots(config.get<string>("globalAgentsPath", "")),
  ];

  for (const root of roots) {
    if (!root) {
      continue;
    }

    const normalizedRoot = normalizeForCompare(root);
    if (!normalizedRoot || watchedRoots.has(normalizedRoot)) {
      continue;
    }

    watchedRoots.add(normalizedRoot);
    watchPattern(
      new vscode.RelativePattern(vscode.Uri.file(root), "**/*.md"),
      schedulePromptPreviewRefresh,
    );
  }
}

/**
 * Push the latest prompt file content to the panel without persisting it.
 *
 * Persisting on every file change would multiply last-write-wins task saves
 * across windows, so the stored snapshot is only updated on execution and by
 * the daily sync.
 */
function schedulePromptPreviewRefresh(uri: vscode.Uri): void {
  if (uri.scheme !== "file") return;

  pendingPromptPreviewPaths.add(uri.fsPath);
  if (promptPreviewTimer) {
    clearTimeout(promptPreviewTimer);
  }
  promptPreviewTimer = setTimeout(() => {
    promptPreviewTimer = undefined;
    void flushPromptPreviewRefresh();
  }, PROMPT_PREVIEW_DEBOUNCE_MS);
}

function getPromptCandidatePaths(task: ScheduledTask): string[] {
  const promptPath =
    typeof task.promptPath === "string" ? task.promptPath.trim() : "";
  if (!promptPath) return [];
  if (task.promptSource === "global") {
    const candidate = resolveGlobalPromptPath(
      getGlobalPromptsRoot(),
      promptPath,
    );
    return candidate ? [candidate] : [];
  }
  if (task.promptSource === "local") {
    return resolveLocalPromptCandidates(
      getPreferredWorkspaceFolderPaths(task),
      promptPath,
    );
  }
  return [];
}

async function flushPromptPreviewRefresh(): Promise<void> {
  const changedPaths = new Set(
    Array.from(pendingPromptPreviewPaths, (p) => normalizeForCompare(p)),
  );
  pendingPromptPreviewPaths.clear();
  if (changedPaths.size === 0) return;
  if (!SchedulerWebview.isPanelOpen()) return;

  const previews: PromptPreview[] = [];

  for (const task of scheduleManager.getAllTasks()) {
    if (task.promptSource === "inline") continue;
    if (typeof task.promptPath !== "string" || !task.promptPath.trim()) {
      continue;
    }
    const candidatePaths = getPromptCandidatePaths(task);
    if (
      !candidatePaths.some((candidate) =>
        changedPaths.has(normalizeForCompare(candidate)),
      )
    ) {
      continue;
    }

    let resolution: PromptResolution;
    try {
      // Disk content only: previews must not surface unsaved editor text.
      resolution = await resolvePromptSnapshot(task, false);
    } catch {
      previews.push(buildUnavailablePromptPreview(task));
      continue;
    }

    previews.push(buildPromptPreview(task, resolution));
  }

  if (previews.length > 0) {
    SchedulerWebview.updatePromptPreviews(previews);
  }
}

function buildUnavailablePromptPreview(task: ScheduledTask): PromptPreview {
  const storedPrompt = typeof task.prompt === "string" ? task.prompt : "";
  return buildPromptPreview(task, {
    text: storedPrompt,
    source: "snapshotFallback",
    hash: computePromptHash(storedPrompt),
    resolvedAt: new Date().toISOString(),
    fallbackReason: "readFailed",
    candidateCount: 0,
  });
}

function buildPromptPreview(
  task: ScheduledTask,
  resolution: PromptResolution,
): PromptPreview {
  return {
    taskId: task.id,
    promptPath:
      typeof task.promptPath === "string" ? task.promptPath.trim() : "",
    promptPathDisplay: resolution.resolvedPath
      ? sanitizeAbsolutePathDetails(
          resolution.resolvedPath,
          messages.redactedPlaceholder(),
        )
      : "",
    source: resolution.source,
    hash: resolution.hash,
    resolvedAt: resolution.resolvedAt,
    canOpenPromptFile: resolution.source === "file",
    hasSnapshotDiff:
      resolution.source === "file" && resolution.text !== task.prompt,
    prompt: resolution.source === "file" ? resolution.text : undefined,
  };
}

async function handlePromptPreviewRequest(taskId: string): Promise<void> {
  const task = scheduleManager.getTask(taskId);
  if (
    !task ||
    task.promptSource === "inline" ||
    typeof task.promptPath !== "string" ||
    !task.promptPath.trim()
  ) {
    return;
  }

  try {
    const resolution = await resolvePromptSnapshot(task, false);
    SchedulerWebview.updatePromptPreviews([
      buildPromptPreview(task, resolution),
    ]);
  } catch (error) {
    SchedulerWebview.updatePromptPreviews([
      buildUnavailablePromptPreview(task),
    ]);
    logDebug(
      `[CopilotScheduler] Prompt preview failed for task "${task.name}": ${sanitizeErrorDetailsForLog(
        error instanceof Error ? error.message : String(error ?? ""),
      )}`,
    );
  }
}

async function handleOpenPromptFile(taskId: string): Promise<void> {
  const task = scheduleManager.getTask(taskId);
  if (!task || task.promptSource === "inline") return;

  try {
    const resolution = await resolvePromptSnapshot(task, false);
    if (!resolution.resolvedPath || resolution.source !== "file") {
      notifyError(messages.labelPromptFileUnavailable());
      return;
    }
    await vscode.window.showTextDocument(
      vscode.Uri.file(resolution.resolvedPath),
    );
  } catch (error) {
    logDebug(
      `[CopilotScheduler] Open prompt file failed for task "${task.name}": ${sanitizeErrorDetailsForLog(
        error instanceof Error ? error.message : String(error ?? ""),
      )}`,
    );
    notifyError(messages.labelPromptFileUnavailable());
  }
}

async function appendManualRunHistory(
  task: ScheduledTask,
  runResult: { ok: true } | ManualRunFailureResult,
): Promise<void> {
  const promptMetadata = buildPromptHistoryMetadata(
    takePromptResolution(task.id),
  );

  if (runResult.ok) {
    const latestTask = scheduleManager.getTask(task.id) ?? task;
    const nextRunDate =
      latestTask.nextRun instanceof Date &&
      !Number.isNaN(latestTask.nextRun.getTime())
        ? latestTask.nextRun
        : undefined;
    notifyInfo(buildExecutionSummary(task.name, "success", nextRunDate));
    const nextRunAt =
      latestTask.nextRun instanceof Date &&
      !Number.isNaN(latestTask.nextRun.getTime())
        ? latestTask.nextRun.toISOString()
        : undefined;
    await recordExecutionHistoryBestEffort({
      taskId: task.id,
      taskName: task.name,
      trigger: "manual",
      status: "success",
      executedAt: new Date().toISOString(),
      nextRunAt,
      ...promptMetadata,
    });
    return;
  }

  const detail =
    runResult.reason === "executionFailed" ||
    runResult.reason === "saveFailed" ||
    runResult.reason === "promptBlocked"
      ? runResult.errorMessage || messages.webviewUnknown()
      : runResult.reason === "executorUnavailable"
        ? messages.manualRunUnavailable()
        : messages.taskNotFound();
  await recordExecutionHistoryBestEffort({
    taskId: task.id,
    taskName: task.name,
    trigger: "manual",
    status: runResult.reason === "promptBlocked" ? "blocked" : "failed",
    executedAt: new Date().toISOString(),
    nextRunAt: undefined,
    detail: resolveDisplayErrorMessage(detail),
    ...promptMetadata,
  });
}

function buildTaskQuickPickMeta(task: ScheduledTask): string {
  if (task.scope === "global") {
    return messages.labelScopeGlobal();
  }

  const workspaceName = task.workspacePath
    ? path.basename(task.workspacePath)
    : messages.tooltipNotSet();
  const appliesHere = scheduleManager.shouldTaskRunInCurrentWorkspace(task)
    ? messages.labelThisWorkspaceShort()
    : messages.labelOtherWorkspaceShort();
  return `${messages.labelScopeWorkspace()} • ${workspaceName} • ${appliesHere}`;
}

function buildTaskQuickPickItem(task: ScheduledTask): {
  label: string;
  description: string;
  detail: string;
  task: ScheduledTask;
} {
  return {
    label: task.name,
    description: task.cronExpression,
    detail: buildTaskQuickPickMeta(task),
    task,
  };
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
  extensionContextRef = context;
  initExecutionHistoryStore(context);

  // Create the dedicated output channel early so diagnostic logs are visible
  // in the Output panel under "Copilot Scheduler".
  initLogger(context);

  // Prompt reload when the extension has been updated
  {
    const currentVersion =
      (context.extension.packageJSON as { version?: string }).version ??
      "0.0.0";
    const lastVersion = context.globalState.get<string>(LAST_VERSION_KEY);
    if (lastVersion && lastVersion !== currentVersion) {
      void vscode.window
        .showInformationMessage(
          messages.reloadAfterUpdate(currentVersion),
          messages.reloadNow(),
        )
        .then((choice) => {
          if (choice === messages.reloadNow()) {
            void vscode.commands.executeCommand(
              "workbench.action.reloadWindow",
            );
          }
        });
    }
    void context.globalState.update(LAST_VERSION_KEY, currentVersion);
  }

  // Initialize components
  scheduleManager = new ScheduleManager(context);
  copilotExecutor = new CopilotExecutor();
  CopilotExecutor.configureForExtensionContext(context.globalStorageUri);
  treeProvider = new ScheduledTaskTreeProvider(scheduleManager);
  // Chat must only offer models the user can also see in the Webview picker and
  // that startup healing can resolve, so all three share one filtered catalog.
  const loadPickerModelCatalog = async () => {
    const { models, source } =
      await CopilotExecutor.getAvailableModelsWithSource();
    return { source, models: filterPickerModelCatalog(models) };
  };
  registerLmTools(context, scheduleManager, {
    catalogProvider: {
      listModels: loadPickerModelCatalog,
      listAgents: () => CopilotExecutor.getAllAgents(),
    },
    resolveModelSelection: createModelSelectionResolver(loadPickerModelCatalog),
  });
  void CopilotExecutor.getAvailableModelsWithSource()
    .then(async ({ models, source }) => {
      const healed = await scheduleManager.healTaskModelSelections(
        filterPickerModelCatalog(models),
      );
      if (healed > 0) {
        logDebug(
          `[CopilotScheduler] Healed ${healed} task model selection(s) from ${source} model catalog`,
        );
      }
    })
    .catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error ?? "");
      logDebug(
        `[CopilotScheduler] Failed to run startup model healing: ${sanitizeErrorDetailsForLog(errorMessage)}`,
      );
    });
  scheduleManager.addOnTasksChangedCallback(() => {
    SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
  });

  // Register TreeView
  const treeView = vscode.window.createTreeView("copilotSchedulerTasks", {
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
    registerEnableTaskCommand(),
    registerDisableTaskCommand(),
    registerRunNowCommand(),
    registerCopyPromptCommand(),
    registerDuplicateTaskCommand(),
    registerMoveToCurrentWorkspaceCommand(),
    registerOpenSettingsCommand(),
    registerShowVersionCommand(context),
    registerShowExecutionHistoryCommand(),
    registerDumpModelCatalogCommand(),
  ];

  // Start scheduler
  scheduleManager.startScheduler(async (task) => {
    await executeTask(task);
  });

  // If disabled in settings, stop the timer immediately (callback stays set for manual runs)
  {
    const cfg = vscode.workspace.getConfiguration("copilotScheduler");
    if (cfg.get<boolean>("enabled", true) === false) {
      scheduleManager.stopScheduler();
    }
  }

  // Sync prompt templates to tasks (startup and daily)
  void syncPromptTemplatesIfNeeded(context, true).catch((error) =>
    logError(
      "[CopilotScheduler] Prompt template sync failed:",
      sanitizeErrorDetailsForLog(
        error instanceof Error ? error.message : String(error ?? ""),
      ),
    ),
  );
  promptSyncInterval = setInterval(
    () => {
      void syncPromptTemplatesIfNeeded(context, false).catch((error) =>
        logError(
          "[CopilotScheduler] Prompt template daily sync failed:",
          sanitizeErrorDetailsForLog(
            error instanceof Error ? error.message : String(error ?? ""),
          ),
        ),
      );
    },
    24 * 60 * 60 * 1000,
  );

  registerPromptResourceWatchers();

  // Warm the agent/model/template caches at startup so the first panel open and
  // the first scheduled run do not pay the full workspace-scan cost. Runs in the
  // background; failures are non-fatal and handled inside the refresh routine.
  void SchedulerWebview.refreshCachesAndNotifyPanel(false).catch(() => {});

  context.subscriptions.push({
    dispose: () => {
      if (promptSyncInterval) {
        clearInterval(promptSyncInterval);
        promptSyncInterval = undefined;
      }
      disposePromptResourceWatchers();
    },
  });

  // Show activation message
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const logLevel = config.get<string>("logLevel", "info");
  if (logLevel === "info" || logLevel === "debug") {
    notifyInfo(messages.extensionActive());
  }

  // React to language changes so the webview can be re-rendered in the selected locale
  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("copilotScheduler.language")) {
      SchedulerWebview.refreshLanguage(scheduleManager.getAllTasks());
      treeProvider.refresh();
    }
    if (
      e.affectsConfiguration("copilotScheduler.defaultScope") ||
      e.affectsConfiguration("copilotScheduler.autoModeDefault") ||
      e.affectsConfiguration("copilotScheduler.chatSession") ||
      e.affectsConfiguration("copilotScheduler.jitterSeconds")
    ) {
      SchedulerWebview.refreshFormDefaults();
    }
    if (
      e.affectsConfiguration("copilotScheduler.globalPromptsPath") ||
      e.affectsConfiguration("copilotScheduler.globalAgentsPath")
    ) {
      registerPromptResourceWatchers();
      void SchedulerWebview.refreshCachesAndNotifyPanel(true);
    }
    // Consolidate timezone / enabled recalculation to avoid duplicate
    // recalculateAllNextRuns() when both change in one event (U22/U24).
    let needsRecalculate = false;
    if (e.affectsConfiguration("copilotScheduler.timezone")) {
      needsRecalculate = true;
    }
    if (e.affectsConfiguration("copilotScheduler.enabled")) {
      const cfg = vscode.workspace.getConfiguration("copilotScheduler");
      const enabled = cfg.get<boolean>("enabled", true);
      if (enabled) {
        scheduleManager.startScheduler(async (task) => {
          await executeTask(task);
        });
        needsRecalculate = true;
      } else {
        scheduleManager.stopScheduler();
      }
    }
    if (needsRecalculate) {
      // recalculateAllNextRuns → saveTasks → notifyTasksChanged already
      // refreshes the tree via the callback; only Webview needs explicit update.
      void scheduleManager
        .recalculateAllNextRuns()
        .then(() => {
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        })
        .catch((error) => {
          const errorMessage =
            error instanceof Error ? error.message : String(error ?? "");
          logError(
            "[CopilotScheduler] Failed to recalculate nextRun after config change:",
            sanitizeErrorDetailsForLog(errorMessage),
          );
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        });
    }
    if (e.affectsConfiguration("copilotScheduler.maxDailyExecutions")) {
      const cfg = vscode.workspace.getConfiguration("copilotScheduler");
      if (cfg.get<number>("maxDailyExecutions", 24) === 0) {
        void vscode.window.showWarningMessage(messages.unlimitedDailyWarning());
      }
    }
  });

  const workspaceFoldersWatcher = vscode.workspace.onDidChangeWorkspaceFolders(
    () => {
      registerPromptResourceWatchers();
      SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
      void SchedulerWebview.refreshCachesAndNotifyPanel(true);
      treeProvider.refresh();
    },
  );

  // Register subscriptions
  context.subscriptions.push(
    treeView,
    configWatcher,
    workspaceFoldersWatcher,
    ...commands,
  );
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  scheduleManager?.stopScheduler();
  SchedulerWebview.dispose();
  extensionContextRef = undefined;
  manualRunInFlightTaskIds.clear();
  resetExecutionHistoryQueueForTests();
  setExecutionHistoryContextForTests(undefined);
  // promptSyncInterval is cleared by the disposable registered in context.subscriptions.
}

/**
 * Execute a scheduled task
 */
async function executeTask(task: ScheduledTask): Promise<void> {
  const trigger: ExecutionTrigger = manualRunInFlightTaskIds.has(task.id)
    ? "manual"
    : "auto";
  // notifyInfo already checks shouldNotify() internally — no need for an outer guard.
  notifyInfo(messages.taskExecuting(task.name));

  try {
    const resolved = await resolvePromptExecution(task);

    // Execute the prompt
    try {
      await copilotExecutor.executePrompt(
        resolved.prompt,
        buildPromptExecutionOptions(resolved),
      );
    } catch (error) {
      // executePrompt displays its own warning on failure.
      markExecutionErrorAsUserNotified(error);
      throw error;
    }

    await syncPromptSnapshotAfterRun(task);

    if (trigger === "auto") {
      const nextRunDate = getNotificationNextRun(task, new Date());
      notifyInfo(buildExecutionSummary(task.name, "success", nextRunDate));
      void recordExecutionHistoryBestEffort({
        taskId: task.id,
        taskName: task.name,
        trigger,
        status: "success",
        executedAt: new Date().toISOString(),
        nextRunAt: nextRunDate?.toISOString(),
        ...buildPromptHistoryMetadata(
          lastPromptResolutionByTaskId.get(task.id),
        ),
      });
    }
  } catch (error) {
    if (isPromptBlockedError(error)) {
      // Manual runs record their own history entry via appendManualRunHistory.
      if (trigger === "auto") {
        const nextRunDate = getNotificationNextRun(task, new Date());
        const summary = buildExecutionSummary(
          task.name,
          "blocked",
          nextRunDate,
        );
        vscode.window.setStatusBarMessage(`⛔ ${summary}`, 6000);
        void recordExecutionHistoryBestEffort({
          taskId: task.id,
          taskName: task.name,
          trigger,
          status: "blocked",
          executedAt: new Date().toISOString(),
          nextRunAt: nextRunDate?.toISOString(),
          detail: resolveDisplayErrorMessage(
            error instanceof Error ? error.message : String(error),
          ),
          ...buildPromptHistoryMetadata(
            lastPromptResolutionByTaskId.get(task.id),
          ),
        });
      }

      throw error;
    }

    // executePrompt already shows a warning with copy-to-clipboard option,
    // so only log the error here to avoid double notification.
    // Re-throw so callers (checkAndExecuteTasks / runTaskNow) can distinguish
    // success from failure and avoid recording lastRun on failure (U15).
    const errorMessage = error instanceof Error ? error.message : String(error);
    const safeErrorMessage = sanitizeErrorDetailsForLog(errorMessage);
    logError(messages.taskExecutionFailed(task.name, safeErrorMessage));

    if (trigger === "auto") {
      const nextRunDate = getNotificationNextRun(task, new Date());
      const summary = buildExecutionSummary(task.name, "failed", nextRunDate);
      vscode.window.setStatusBarMessage(`⚠ ${summary}`, 6000);
      void recordExecutionHistoryBestEffort({
        taskId: task.id,
        taskName: task.name,
        trigger,
        status: "failed",
        executedAt: new Date().toISOString(),
        nextRunAt: nextRunDate?.toISOString(),
        detail: resolveDisplayErrorMessageFromSanitized(safeErrorMessage),
        ...buildPromptHistoryMetadata(
          lastPromptResolutionByTaskId.get(task.id),
        ),
      });
    }

    throw error;
  } finally {
    // Manual runs read the metadata later in appendManualRunHistory.
    if (trigger === "auto") {
      lastPromptResolutionByTaskId.delete(task.id);
    }
  }
}

/**
 * Keep the stored snapshot aligned with the file that was just executed.
 * Only disk content is persisted; unsaved editor text is never written back.
 */
async function syncPromptSnapshotAfterRun(task: ScheduledTask): Promise<void> {
  const resolution = lastPromptResolutionByTaskId.get(task.id);
  if (!resolution || resolution.source !== "file") return;
  if (!resolution.text.trim()) return;
  if (resolution.text === task.prompt) return;

  try {
    await scheduleManager.updateTaskPrompts([
      { id: task.id, prompt: resolution.text },
    ]);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error ?? "");
    logError(
      `[CopilotScheduler] Prompt snapshot sync failed for task "${task.name}": ${sanitizeErrorDetailsForLog(errorMessage)}`,
    );
  }
}

/**
 * Workspace folders ordered so that the task's own workspace is tried first.
 * The task workspace is only used when it is actually open, so the resolver
 * never reaches outside the current window's allowlisted folders.
 */
function getPreferredWorkspaceFolderPaths(task: ScheduledTask): string[] {
  const allFolders = getWorkspaceFolderPaths();
  const workspacePath =
    typeof task.workspacePath === "string" ? task.workspacePath.trim() : "";
  if (!workspacePath) {
    return allFolders;
  }

  const target = normalizeForCompare(workspacePath);
  const preferred = allFolders.filter((p) => normalizeForCompare(p) === target);
  if (preferred.length === 0) {
    return allFolders;
  }

  return [
    ...preferred,
    ...allFolders.filter((p) => normalizeForCompare(p) !== target),
  ];
}

function getPromptFileFallbackPolicy(): PromptFileFallbackPolicy {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const raw = config.get<string>("promptFileFallback", "snapshot");
  return raw === "blockWhenResolvable" || raw === "blockAlways"
    ? raw
    : "snapshot";
}

function describePromptBlockedReason(reason: PromptBlockedReason): string {
  switch (reason) {
    case "pathUnresolved":
      return messages.promptBlockedReasonPathUnresolved();
    case "readFailed":
      return messages.promptBlockedReasonReadFailed();
    default:
      return messages.promptBlockedReasonNoPromptPath();
  }
}

/**
 * Throw when policy forbids running a file-backed task from the stored snapshot.
 * Inline tasks and tasks without a promptPath are never affected.
 */
function assertPromptResolutionAllowed(
  task: ScheduledTask,
  resolution: PromptResolution,
): void {
  if (task.promptSource === "inline") return;
  if (typeof task.promptPath !== "string" || !task.promptPath.trim()) return;
  if (resolution.source === "file" || resolution.source === "openDocument") {
    return;
  }

  const policy = getPromptFileFallbackPolicy();
  if (policy === "snapshot") return;

  const reason = resolution.fallbackReason ?? "readFailed";
  if (policy === "blockWhenResolvable" && resolution.candidateCount === 0) {
    return;
  }

  const message = messages.promptFileBlocked(
    task.name,
    describePromptBlockedReason(reason),
  );
  logError(`[CopilotScheduler] ${message}`);
  throw createPromptBlockedError(message, reason);
}

/**
 * Resolve prompt text from task (inline, local, or global).
 *
 * File-backed tasks read the latest file content at call time. Candidates are
 * tried in order (preferred workspace first) and the first readable one wins;
 * only when none can be read does this fall back to the stored snapshot.
 */
async function resolvePromptSnapshot(
  task: ScheduledTask,
  preferOpenDocument = true,
): Promise<PromptResolution> {
  const resolvedAt = new Date().toISOString();
  const storedPrompt = typeof task.prompt === "string" ? task.prompt : "";

  const buildFallback = (
    fallbackReason: PromptBlockedReason,
    candidateCount: number,
    resolvedPath?: string,
  ): PromptResolution => ({
    text: storedPrompt,
    source: "snapshotFallback",
    resolvedPath,
    hash: computePromptHash(storedPrompt),
    resolvedAt,
    fallbackReason,
    candidateCount,
  });

  if (task.promptSource === "inline") {
    logDebug(`[CopilotScheduler] resolvePromptText: inline (task=${task.id})`);
    return {
      text: storedPrompt,
      source: "inline",
      hash: computePromptHash(storedPrompt),
      resolvedAt,
      candidateCount: 0,
    };
  }

  const promptPath =
    typeof task.promptPath === "string" ? task.promptPath.trim() : "";
  if (!promptPath) {
    logDebug(
      `[CopilotScheduler] resolvePromptText: missing promptPath (source=${task.promptSource}, task=${task.id})`,
    );
    return buildFallback("noPromptPath", 0);
  }

  const candidates =
    task.promptSource === "global"
      ? [resolveGlobalPromptPath(getGlobalPromptsRoot(), promptPath)].filter(
          (p): p is string => typeof p === "string" && p.length > 0,
        )
      : resolveLocalPromptCandidates(
          getPreferredWorkspaceFolderPaths(task),
          promptPath,
        );

  if (candidates.length === 0) {
    logDebug(
      `[CopilotScheduler] resolvePromptText: path resolution failed (source=${task.promptSource}, file=${path.basename(promptPath)}, task=${task.id})`,
    );
    return buildFallback("pathUnresolved", 0);
  }

  for (let index = 0; index < candidates.length; index++) {
    const filePath = candidates[index];
    const crossWorkspaceResolved = index > 0;

    if (preferOpenDocument) {
      // Prefer in-memory document text when the file is open (supports unsaved edits).
      const normalizedTarget = normalizeForCompare(filePath);
      const openDoc = vscode.workspace.textDocuments.find(
        (d) =>
          d.uri.scheme === "file" &&
          normalizeForCompare(d.uri.fsPath) === normalizedTarget,
      );
      if (openDoc) {
        const text = openDoc.getText();
        if (text.trim()) {
          logDebug(
            `[CopilotScheduler] resolvePromptText: openDocument (file=${path.basename(filePath)}, dirty=${openDoc.isDirty}, task=${task.id})`,
          );
          return {
            text,
            source: "openDocument",
            resolvedPath: filePath,
            hash: computePromptHash(text),
            resolvedAt,
            crossWorkspaceResolved,
            candidateCount: candidates.length,
          };
        }
        logDebug(
          `[CopilotScheduler] resolvePromptText: empty openDocument (file=${path.basename(filePath)}, dirty=${openDoc.isDirty}, task=${task.id})`,
        );
        throw createEmptyPromptTemplateError(filePath);
      }
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(filePath),
      );
      const content = Buffer.from(bytes).toString("utf8");
      if (content.trim()) {
        logDebug(
          `[CopilotScheduler] resolvePromptText: file (file=${path.basename(filePath)}, task=${task.id})`,
        );
        return {
          text: content,
          source: "file",
          resolvedPath: filePath,
          hash: computePromptHash(content),
          resolvedAt,
          crossWorkspaceResolved,
          candidateCount: candidates.length,
        };
      }
      logDebug(
        `[CopilotScheduler] resolvePromptText: empty file (file=${path.basename(filePath)}, task=${task.id})`,
      );
      throw createEmptyPromptTemplateError(filePath);
    } catch (error) {
      if (isEmptyPromptTemplateError(error)) {
        throw error;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error ?? "");
      logDebug(
        `[CopilotScheduler] resolvePromptText: readFile failed (file=${path.basename(filePath)}, task=${task.id})`,
        sanitizeErrorDetailsForLog(errorMessage),
      );
      // Try the next candidate (the file may live in another workspace folder).
    }
  }

  logDebug(
    `[CopilotScheduler] resolvePromptText: fallback to stored prompt (source=${task.promptSource}, task=${task.id})`,
  );
  return buildFallback("readFailed", candidates.length, candidates[0]);
}

async function resolvePromptText(
  task: ScheduledTask,
  preferOpenDocument = true,
): Promise<string> {
  const resolution = await resolvePromptSnapshot(task, preferOpenDocument);
  return resolution.text;
}

function parsePromptFrontmatter(promptText: string): PromptExecutionPayload {
  const match = promptText.match(
    /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/,
  );
  if (!match) {
    return { prompt: promptText };
  }

  const frontmatter = match[1];
  const body = promptText.slice(match[0].length);
  let agent: string | undefined;
  let model: string | undefined;

  for (const line of frontmatter.split(/\r?\n/)) {
    const parsed = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!parsed) continue;

    const key = parsed[1].toLowerCase();
    let value = parsed[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (!value) continue;

    if (key === "agent") {
      agent = value;
      continue;
    }
    if (key === "model") {
      model = value;
    }
  }

  if (!agent && !model) {
    return { prompt: promptText };
  }

  return {
    prompt: body,
    agent,
    model,
  };
}

function resolveExecutionOption(
  taskValue: string | undefined,
  frontmatterValue: string | undefined,
): string | undefined {
  const normalizedTaskValue =
    typeof taskValue === "string" ? taskValue.trim() : "";
  if (normalizedTaskValue) {
    return normalizedTaskValue;
  }

  const normalizedFrontmatterValue =
    typeof frontmatterValue === "string" ? frontmatterValue.trim() : "";
  if (normalizedFrontmatterValue) {
    return normalizedFrontmatterValue;
  }

  return undefined;
}

const AUTO_MODE_HINT =
  "[auto] Proceed autonomously. Apply all changes directly without asking for confirmation.";

function hasAutoModeHint(promptText: string): boolean {
  if (promptText.toLowerCase().includes(AUTO_MODE_HINT.toLowerCase())) {
    return true;
  }

  return /(?:^|\r?\n)\s*(?:\[auto\]|auto)\s*(?:\r?\n|$)/i.test(promptText);
}

function applyAutoModeHint(promptText: string, enabled: boolean): string {
  if (!enabled) {
    return promptText;
  }

  if (hasAutoModeHint(promptText)) {
    return promptText;
  }

  const fmMatch = promptText.match(
    /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n?/,
  );
  if (fmMatch) {
    const after = promptText.slice(fmMatch[0].length);
    return `${fmMatch[0]}${AUTO_MODE_HINT}\n\n${after}`;
  }

  return `${AUTO_MODE_HINT}\n\n${promptText}`;
}

/**
 * Prompt resolution metadata for the most recent execution attempt per task.
 * Written at resolve time so history writers never re-read the file and record
 * content that differs from what was actually executed.
 */
const lastPromptResolutionByTaskId = new Map<string, PromptResolution>();

function takePromptResolution(taskId: string): PromptResolution | undefined {
  const resolution = lastPromptResolutionByTaskId.get(taskId);
  lastPromptResolutionByTaskId.delete(taskId);
  return resolution;
}

function buildPromptHistoryMetadata(
  resolution: PromptResolution | undefined,
): Pick<
  ExecutionHistoryEntry,
  | "promptSource"
  | "promptPathDisplay"
  | "promptHash"
  | "promptResolvedAt"
  | "promptFallbackReason"
> {
  if (!resolution) {
    return {};
  }

  return {
    promptSource: resolution.source,
    promptPathDisplay: resolution.resolvedPath
      ? sanitizeAbsolutePathDetails(
          resolution.resolvedPath,
          messages.redactedPlaceholder(),
        )
      : undefined,
    promptHash: resolution.hash,
    promptResolvedAt: resolution.resolvedAt,
    promptFallbackReason: resolution.fallbackReason,
  };
}

async function resolvePromptExecution(
  task: ScheduledTask,
  preferOpenDocument = true,
): Promise<PromptExecutionPayload> {
  const resolution = await resolvePromptSnapshot(task, preferOpenDocument);
  lastPromptResolutionByTaskId.set(task.id, resolution);
  assertPromptResolutionAllowed(task, resolution);

  const parsed = parsePromptFrontmatter(resolution.text);

  return {
    prompt: applyAutoModeHint(parsed.prompt, task.autoMode === true),
    agent: resolveExecutionOption(task.agent, parsed.agent),
    chatSession: task.chatSession,
    model: resolveExecutionOption(task.model, parsed.model),
    modelName: task.modelName,
    modelVendor: task.modelVendor,
    modelFamily: task.modelFamily,
    modelVersion: task.modelVersion,
    modelReasoningEffort: task.modelReasoningEffort,
  };
}

export const __testOnly = {
  normalizeNotificationMode,
  resolveNotificationMode,
  resolvePromptText,
  resolvePromptSnapshot,
  buildUnavailablePromptPreview,
  parsePromptFrontmatter,
  resolveExecutionOption,
  applyAutoModeHint,
  buildPromptExecutionOptions,
  resolvePromptExecution,
  sanitizeErrorDetailsForLog,
  resolveDisplayErrorMessage,
  ensureCreatedTaskAcceptedAfterDisclaimer,
  enqueueExecutionHistory,
  getExecutionHistoryEntries,
  buildExecutionHistoryQuickPickItems,
  showExecutionHistoryView,
  confirmManualRunIfWorkspaceMismatch,
  setExtensionContextForTests,
  resetExecutionHistoryQueueForTests,
};

function getWorkspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .map((f) => f.uri.fsPath)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}

function getGlobalPromptsRoot(): string | undefined {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  return resolveGlobalPromptsRoot(config.get<string>("globalPromptsPath", ""));
}

/**
 * Handle task actions from Webview
 */
function handleTaskAction(action: TaskAction): void {
  void handleTaskActionAsync(action);
}

async function confirmManualRunIfWorkspaceMismatch(
  task: ScheduledTask,
  deps?: {
    shouldRunInCurrentWorkspace(task: ScheduledTask): boolean;
    showWarningMessage(
      message: string,
      options: { modal: true },
      ...items: string[]
    ): Thenable<string | undefined>;
  },
): Promise<boolean> {
  if (task.scope !== "workspace") {
    return true;
  }
  const shouldRunInCurrentWorkspace = deps
    ? deps.shouldRunInCurrentWorkspace(task)
    : scheduleManager.shouldTaskRunInCurrentWorkspace(task);
  if (shouldRunInCurrentWorkspace) {
    return true;
  }
  const showWarningMessage = deps?.showWarningMessage
    ? deps.showWarningMessage
    : vscode.window.showWarningMessage.bind(vscode.window);
  const choice = await showWarningMessage(
    messages.confirmRunOutsideWorkspace(task.name),
    { modal: true },
    messages.confirmRunAnyway(),
    messages.actionCancel(),
  );
  return choice === messages.confirmRunAnyway();
}

async function handleTaskActionAsync(action: TaskAction): Promise<void> {
  try {
    switch (action.action) {
      case "run": {
        const runTask = scheduleManager.getTask(action.taskId);
        if (!runTask) {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }

        const confirmed = await confirmManualRunIfWorkspaceMismatch(runTask);
        if (!confirmed) {
          break;
        }

        // Manual run: no jitter / no daily limit. Persist lastRun when possible.
        // On execution failure, executePrompt already shows a warning with copy option.
        manualRunInFlightTaskIds.add(action.taskId);
        const runResult = await scheduleManager
          .runTaskNowDetailed(action.taskId)
          .finally(() => {
            manualRunInFlightTaskIds.delete(action.taskId);
          });
        if (!runResult.ok) {
          await appendManualRunHistory(runTask, runResult);
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
          handleManualRunFailure(runTask.name, runResult, {
            showWebviewError: true,
          });
          break;
        }
        await appendManualRunHistory(runTask, runResult);
        // Success path already persists via saveTasks(), which triggers
        // onTasksChanged callback → SchedulerWebview.updateTasks once.
        // Avoid sending a duplicate full task list here.
        break;
      }

      case "toggle": {
        const task = await scheduleManager.toggleTask(action.taskId);
        if (!task) {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }

        if (task.enabled) {
          const accepted = await ensureTaskEnabledAfterDisclaimer(task);
          if (!accepted) {
            break;
          }
        }
        notifyInfo(
          task.enabled
            ? messages.taskEnabled(task.name)
            : messages.taskDisabled(task.name),
        );
        SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        break;
      }

      case "delete": {
        const deleteTask = scheduleManager.getTask(action.taskId);
        if (!deleteTask) {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }

        if (
          deleteTask.scope === "workspace" &&
          !scheduleManager.shouldTaskRunInCurrentWorkspace(deleteTask)
        ) {
          const msg = messages.cannotDeleteOtherWorkspaceTask(deleteTask.name);
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }

        // Show confirmation dialog
        const confirm = await vscode.window.showWarningMessage(
          messages.confirmDelete(deleteTask.name),
          { modal: true },
          messages.confirmDeleteYes(),
        );

        if (confirm === messages.confirmDeleteYes()) {
          const deleted = await scheduleManager.deleteTask(action.taskId);
          if (!deleted) {
            const msg = messages.taskNotFound();
            notifyError(msg);
            SchedulerWebview.showError(msg);
            break;
          }
          const deletedMsg = messages.taskDeleted(deleteTask.name);
          notifyInfo(deletedMsg);
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
          SchedulerWebview.switchToList(deletedMsg);
        }
        break;
      }

      case "edit": {
        if (action.taskId === "__create__" && action.data) {
          await maybeWarnCronInterval(action.data.cronExpression);
          const task = await scheduleManager.createTask(
            action.data as CreateTaskInput,
          );
          const accepted = await ensureCreatedTaskAcceptedAfterDisclaimer(task);
          if (!accepted) {
            SchedulerWebview.switchToList();
            break;
          }
          const createdMsg = messages.taskCreated(task.name);
          notifyInfo(createdMsg);
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
          SchedulerWebview.switchToList(createdMsg);
        } else if (action.data) {
          await maybeWarnCronInterval(action.data.cronExpression);
          const task = await scheduleManager.updateTask(
            action.taskId,
            action.data,
          );
          if (!task) {
            const msg = messages.taskNotFound();
            notifyError(msg);
            SchedulerWebview.showError(msg);
            break;
          }
          if (task.enabled) {
            const accepted = await ensureTaskEnabledAfterDisclaimer(task);
            if (!accepted) {
              SchedulerWebview.switchToList();
              break;
            }
          }
          const updatedMsg = messages.taskUpdated(task.name);
          notifyInfo(updatedMsg);
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
          SchedulerWebview.switchToList(updatedMsg);
        }
        break;
      }

      case "copy": {
        const copyTask = scheduleManager.getTask(action.taskId);
        if (!copyTask) {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }
        const resolution = await resolvePromptSnapshot(copyTask);
        await vscode.env.clipboard.writeText(resolution.text);
        notifyInfo(
          resolution.source === "snapshotFallback"
            ? messages.promptCopiedFromSnapshot(copyTask.name)
            : messages.promptCopied(),
        );
        break;
      }

      case "duplicate": {
        const task = await scheduleManager.duplicateTask(action.taskId);
        if (!task) {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }
        notifyInfo(messages.taskDuplicated(task.name));
        SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        break;
      }

      case "moveToCurrentWorkspace": {
        const task = scheduleManager.getTask(action.taskId);
        if (!task) {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
          break;
        }

        const confirm = await vscode.window.showWarningMessage(
          messages.confirmMoveToCurrentWorkspace(task.name),
          { modal: true },
          messages.confirmMoveYes(),
          messages.actionCancel(),
        );
        if (confirm !== messages.confirmMoveYes()) {
          break;
        }

        const moved = await scheduleManager.moveTaskToCurrentWorkspace(task.id);
        if (moved) {
          notifyInfo(messages.taskMovedToCurrentWorkspace(moved.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        } else {
          const msg = messages.taskNotFound();
          notifyError(msg);
          SchedulerWebview.showError(msg);
        }
        break;
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error ?? "");
    notifyError(errorMessage);
    SchedulerWebview.showError(errorMessage);
  }
}

// ==================== Command Registrations ====================

function registerCreateTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.createTask",
    async () => {
      try {
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

        await maybeWarnCronInterval(cronExpression);
        const task = await scheduleManager.createTask({
          name,
          prompt,
          cronExpression,
        });
        const accepted = await ensureCreatedTaskAcceptedAfterDisclaimer(task);
        if (!accepted) {
          return;
        }
        notifyInfo(messages.taskCreated(task.name));
        SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

async function handleTestPromptAction(
  request: PromptExecutionRequest,
): Promise<void> {
  // Test prompt execution
  // executePrompt already shows a user-facing warning with copy-to-clipboard
  // on failure, so we only log the error here to avoid double notification (U20).
  try {
    await copilotExecutor.executePrompt(
      request.prompt,
      buildPromptExecutionOptions(request),
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const safeErrorMessage = sanitizeErrorDetailsForLog(errorMessage);
    logError(`[CopilotScheduler] Test prompt failed: ${safeErrorMessage}`);
  }
}

function registerCreateTaskGuiCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.createTaskGui",
    async () => {
      try {
        await SchedulerWebview.show(
          context.extensionUri,
          scheduleManager.getAllTasks(),
          handleTaskAction,
          handleTestPromptAction,
          (taskId) => void handlePromptPreviewRequest(taskId),
          (taskId) => void handleOpenPromptFile(taskId),
        );

        // Ensure the '+' command always opens the webview in "new task" mode.
        SchedulerWebview.startCreateTask();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerListTasksCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.listTasks",
    async () => {
      try {
        await SchedulerWebview.show(
          context.extensionUri,
          scheduleManager.getAllTasks(),
          handleTaskAction,
          handleTestPromptAction,
          (taskId) => void handlePromptPreviewRequest(taskId),
          (taskId) => void handleOpenPromptFile(taskId),
        );
        SchedulerWebview.switchToList();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerEditTaskCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.editTask",
    async (item?: ScheduledTaskItem) => {
      try {
        let taskId: string | undefined;

        if (item instanceof ScheduledTaskItem) {
          taskId = item.task.id;
        } else {
          // Show quick pick to select task
          const tasks = scheduleManager.getAllTasks();
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              ...buildTaskQuickPickItem(t),
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
          handleTestPromptAction,
          (requestedTaskId) => void handlePromptPreviewRequest(requestedTaskId),
          (requestedTaskId) => void handleOpenPromptFile(requestedTaskId),
        );
        SchedulerWebview.editTask(taskId);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerDeleteTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.deleteTask",
    async (item?: ScheduledTaskItem) => {
      try {
        let task: ScheduledTask | undefined;

        if (item instanceof ScheduledTaskItem) {
          task = item.task;
        } else {
          // Show quick pick to select task
          const tasks = scheduleManager
            .getAllTasks()
            .filter(
              (t) =>
                t.scope === "global" ||
                scheduleManager.shouldTaskRunInCurrentWorkspace(t),
            );
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => buildTaskQuickPickItem(t)),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          task = selected.task;
        }

        if (
          task.scope === "workspace" &&
          !scheduleManager.shouldTaskRunInCurrentWorkspace(task)
        ) {
          notifyError(messages.cannotDeleteOtherWorkspaceTask(task.name));
          return;
        }

        // Confirm deletion
        const confirm = await vscode.window.showWarningMessage(
          messages.confirmDelete(task.name),
          { modal: true },
          messages.confirmDeleteYes(),
        );

        if (confirm === messages.confirmDeleteYes()) {
          const deleted = await scheduleManager.deleteTask(task.id);
          if (!deleted) {
            notifyError(messages.taskNotFound());
            return;
          }
          notifyInfo(messages.taskDeleted(task.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerToggleTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.toggleTask",
    async (item?: ScheduledTaskItem) => {
      try {
        let taskId: string | undefined;

        if (item instanceof ScheduledTaskItem) {
          taskId = item.task.id;
        } else {
          // Show quick pick to select task
          const tasks = scheduleManager.getAllTasks();
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              ...buildTaskQuickPickItem(t),
              label: `${t.enabled ? "✅" : "⏸️"} ${t.name}`,
              id: t.id,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          taskId = selected.id;
        }

        const task = await scheduleManager.toggleTask(taskId);
        if (task) {
          if (task.enabled) {
            const accepted = await ensureTaskEnabledAfterDisclaimer(task);
            if (!accepted) {
              return;
            }
          }
          notifyInfo(
            task.enabled
              ? messages.taskEnabled(task.name)
              : messages.taskDisabled(task.name),
          );
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        } else {
          notifyError(messages.taskNotFound());
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerEnableTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.enableTask",
    async (item?: ScheduledTaskItem) => {
      try {
        let taskId: string | undefined;

        if (item instanceof ScheduledTaskItem) {
          taskId = item.task.id;
        } else {
          // Show quick pick to select a disabled task
          const tasks = scheduleManager.getAllTasks().filter((t) => !t.enabled);
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              ...buildTaskQuickPickItem(t),
              label: `⏸️ ${t.name}`,
              id: t.id,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          taskId = selected.id;
        }

        const task = await scheduleManager.setTaskEnabled(taskId, true);
        if (task) {
          const accepted = await ensureTaskEnabledAfterDisclaimer(task);
          if (!accepted) {
            return;
          }
          notifyInfo(messages.taskEnabled(task.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        } else {
          notifyError(messages.taskNotFound());
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerDisableTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.disableTask",
    async (item?: ScheduledTaskItem) => {
      try {
        let taskId: string | undefined;

        if (item instanceof ScheduledTaskItem) {
          taskId = item.task.id;
        } else {
          // Show quick pick to select an enabled task
          const tasks = scheduleManager.getAllTasks().filter((t) => t.enabled);
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              ...buildTaskQuickPickItem(t),
              label: `✅ ${t.name}`,
              id: t.id,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          taskId = selected.id;
        }

        const task = await scheduleManager.setTaskEnabled(taskId, false);
        if (task) {
          notifyInfo(messages.taskDisabled(task.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        } else {
          notifyError(messages.taskNotFound());
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerRunNowCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.runNow",
    async (item?: ScheduledTaskItem) => {
      try {
        let task: ScheduledTask | undefined;

        if (item instanceof ScheduledTaskItem) {
          task = item.task;
        } else {
          // Show quick pick to select task
          const tasks = scheduleManager.getAllTasks();
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => buildTaskQuickPickItem(t)),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          task = selected.task;
        }

        const confirmed = await confirmManualRunIfWorkspaceMismatch(task);
        if (!confirmed) {
          return;
        }

        // Manual run: no jitter / no daily limit. Persist lastRun when possible.
        manualRunInFlightTaskIds.add(task.id);
        const runResult = await scheduleManager
          .runTaskNowDetailed(task.id)
          .finally(() => {
            manualRunInFlightTaskIds.delete(task.id);
          });
        if (!runResult.ok) {
          await appendManualRunHistory(task, runResult);
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
          handleManualRunFailure(task.name, runResult);
          return;
        }
        await appendManualRunHistory(task, runResult);
        // Success path already persists via saveTasks(), which triggers
        // onTasksChanged callback → SchedulerWebview.updateTasks once.
        // Avoid sending a duplicate full task list here.
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerCopyPromptCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.copyPrompt",
    async (item?: ScheduledTaskItem) => {
      try {
        let task: ScheduledTask | undefined;

        if (item instanceof ScheduledTaskItem) {
          task = item.task;
        } else {
          // Show quick pick to select task
          const tasks = scheduleManager.getAllTasks();
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => {
              const templateSourceLabel =
                t.promptSource === "local"
                  ? messages.labelPromptLocal()
                  : t.promptSource === "global"
                    ? messages.labelPromptGlobal()
                    : messages.webviewUnknown();
              const description =
                t.promptSource !== "inline"
                  ? path.basename(t.promptPath ?? "") ||
                    `(${templateSourceLabel})`
                  : t.prompt.length > 50
                    ? t.prompt.substring(0, 50) + "..."
                    : t.prompt;
              return {
                ...buildTaskQuickPickItem(t),
                description,
              };
            }),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          task = selected.task;
        }

        const resolution = await resolvePromptSnapshot(task);
        await vscode.env.clipboard.writeText(resolution.text);
        notifyInfo(
          resolution.source === "snapshotFallback"
            ? messages.promptCopiedFromSnapshot(task.name)
            : messages.promptCopied(),
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerDuplicateTaskCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.duplicateTask",
    async (item?: ScheduledTaskItem) => {
      try {
        let taskId: string | undefined;

        if (item instanceof ScheduledTaskItem) {
          taskId = item.task.id;
        } else {
          // Show quick pick to select task
          const tasks = scheduleManager.getAllTasks();
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              ...buildTaskQuickPickItem(t),
              id: t.id,
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          taskId = selected.id;
        }

        const duplicated = await scheduleManager.duplicateTask(taskId);
        if (duplicated) {
          notifyInfo(messages.taskDuplicated(duplicated.name));
          SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
        } else {
          notifyError(messages.taskNotFound());
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerMoveToCurrentWorkspaceCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.moveToCurrentWorkspace",
    async (item?: ScheduledTaskItem) => {
      try {
        let task: ScheduledTask | undefined;

        if (item instanceof ScheduledTaskItem) {
          task = item.task;
        } else {
          const tasks = scheduleManager
            .getAllTasks()
            .filter((t) => t.scope === "workspace");
          if (tasks.length === 0) {
            notifyInfo(messages.noTasksFound());
            return;
          }

          const selected = await vscode.window.showQuickPick(
            tasks.map((t) => ({
              ...buildTaskQuickPickItem(t),
              description: t.workspacePath
                ? path.basename(t.workspacePath)
                : "",
            })),
            { placeHolder: messages.selectTask() },
          );

          if (!selected) return;
          task = selected.task;
        }

        if (!task) {
          notifyError(messages.taskNotFound());
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          messages.confirmMoveToCurrentWorkspace(task.name),
          { modal: true },
          messages.confirmMoveYes(),
          messages.actionCancel(),
        );
        if (confirm !== messages.confirmMoveYes()) {
          return;
        }

        const moved = await scheduleManager.moveTaskToCurrentWorkspace(task.id);
        if (!moved) {
          notifyError(messages.taskNotFound());
          return;
        }
        notifyInfo(messages.taskMovedToCurrentWorkspace(moved.name));
        SchedulerWebview.updateTasks(scheduleManager.getAllTasks());
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error ?? "");
        notifyError(errorMessage);
      }
    },
  );
}

function registerOpenSettingsCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.openSettings",
    async () => {
      try {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@ext:yamapan.copilot-scheduler",
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerShowVersionCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.showVersion",
    async () => {
      try {
        const packageJson = context.extension.packageJSON as {
          version: string;
        };
        const version = packageJson.version || "0.0.0";
        notifyInfo(messages.versionInfo(version));
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        notifyError(errorMessage);
      }
    },
  );
}

function registerShowExecutionHistoryCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.showExecutionHistory",
    async () => {
      try {
        await showExecutionHistoryView();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error ?? "");
        notifyError(errorMessage);
      }
    },
  );
}

type SerializableLanguageModelChat = {
  id: string;
  name: string;
  vendor: string;
  family: string;
  version: string;
  maxInputTokens?: number;
};

function serializeLanguageModelChat(
  model: vscode.LanguageModelChat,
): SerializableLanguageModelChat {
  return {
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    family: model.family,
    version: model.version,
    maxInputTokens:
      typeof model.maxInputTokens === "number"
        ? model.maxInputTokens
        : undefined,
  };
}

function serializeModelInfo(model: {
  id: string;
  name: string;
  label?: string;
  description: string;
  vendor: string;
  family?: string;
  version?: string;
  maxInputTokens?: number;
}) {
  return {
    id: model.id,
    name: model.name,
    label: model.label,
    description: model.description,
    vendor: model.vendor,
    family: model.family,
    version: model.version,
    maxInputTokens: model.maxInputTokens,
  };
}

async function registerModelCatalogDiagnosticDocument(): Promise<void> {
  const safeModelSettings = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return {
      keys: Object.keys(record).sort(),
      reasoningEffort:
        typeof record.reasoningEffort === "string"
          ? record.reasoningEffort
          : undefined,
      contextSize:
        typeof record.contextSize === "number" ? record.contextSize : undefined,
    };
  };

  const readSafeLanguageModelSettings = async (modelIds: readonly string[]) => {
    const context = extensionContextRef;
    if (!context) {
      return { available: false };
    }

    const configUri = getLanguageModelsConfigUriFromGlobalStorageUri(
      context.globalStorageUri,
    );
    let parsed: unknown;
    try {
      const bytes = await vscode.workspace.fs.readFile(configUri);
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === "FileNotFound") {
        return { available: false };
      }
      return {
        available: false,
        error: sanitizeErrorDetailsForLog(
          error instanceof Error ? error.message : String(error ?? ""),
        ),
      };
    }

    const groups = Array.isArray(parsed) ? parsed : [];
    const copilotGroup = groups.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as { vendor?: unknown }).vendor === "copilot",
    ) as { settings?: Record<string, unknown> } | undefined;
    const settings = copilotGroup?.settings || {};
    const uniqueModelIds = Array.from(
      new Set(modelIds.filter((id) => id.trim().length > 0)),
    );
    return {
      available: true,
      vendor: "copilot",
      settings: Object.fromEntries(
        uniqueModelIds.map((id) => [id, safeModelSettings(settings[id])]),
      ),
    };
  };

  const readRelevantReasoningSettings = () => {
    const config = vscode.workspace.getConfiguration();
    const keys = [
      "github.copilot.chat.reasoningEffortOverride",
      "chat.reasoningEffortOverride",
      "github.copilot.chat.responsesApiReasoningEffort",
    ];
    return Object.fromEntries(
      keys.map((key) => [
        key,
        config.inspect<unknown>(key)?.globalValue ??
          config.inspect<unknown>(key)?.workspaceValue ??
          config.inspect<unknown>(key)?.defaultValue,
      ]),
    );
  };

  const readSelector = async (
    selector?: vscode.LanguageModelChatSelector,
  ): Promise<
    | {
        selector: Record<string, string>;
        count: number;
        models: SerializableLanguageModelChat[];
      }
    | {
        selector: Record<string, string>;
        error: string;
      }
  > => {
    const normalizedSelector = Object.fromEntries(
      Object.entries(selector ?? {}).filter(
        ([, value]) => typeof value === "string" && value.trim().length > 0,
      ),
    ) as Record<string, string>;

    try {
      const models = await vscode.lm.selectChatModels(selector);
      return {
        selector: normalizedSelector,
        count: models.length,
        models: models.map(serializeLanguageModelChat),
      };
    } catch (error) {
      return {
        selector: normalizedSelector,
        error: sanitizeErrorDetailsForLog(
          error instanceof Error ? error.message : String(error ?? ""),
        ),
      };
    }
  };

  const [vendorCopilot, allModels] = await Promise.all([
    readSelector({ vendor: "copilot" }),
    readSelector({}),
  ]);

  let normalizedCatalog:
    | {
        source: string;
        models: ReturnType<typeof serializeModelInfo>[];
        defaultPickerCatalog: ReturnType<typeof serializeModelInfo>[];
        defaultPickerGroups: Array<{
          label: string;
          variants: Array<{
            key: string;
            label: string;
            reasoningEffort?: string;
            model: ReturnType<typeof serializeModelInfo>;
          }>;
        }>;
      }
    | { error: string };

  try {
    const result = await CopilotExecutor.getAvailableModelsWithSource();
    const defaultPickerCatalog = filterPickerModelCatalog(result.models);
    const defaultPickerGroups = buildModelPickerGroups(defaultPickerCatalog, {
      includeExperimentalModelQualityVariants:
        isExperimentalModelQualityEnabled(),
    }).map((group) => ({
      label: group.label,
      variants: group.variants.map((variant) => ({
        key: variant.key,
        label: variant.label,
        reasoningEffort: variant.reasoningEffort,
        model: serializeModelInfo(variant.model),
      })),
    }));

    normalizedCatalog = {
      source: result.source,
      models: result.models.map((model) => serializeModelInfo(model)),
      defaultPickerCatalog: defaultPickerCatalog.map((model) =>
        serializeModelInfo(model),
      ),
      defaultPickerGroups,
    };
  } catch (error) {
    normalizedCatalog = {
      error: sanitizeErrorDetailsForLog(
        error instanceof Error ? error.message : String(error ?? ""),
      ),
    };
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    vscodeVersion: vscode.version,
    vscodeLanguage: vscode.env.language,
    relatedSettings: readRelevantReasoningSettings(),
    rawSelectors: {
      vendorCopilot,
      allModels,
    },
    normalizedCatalog,
    languageModelsConfig:
      "models" in normalizedCatalog
        ? await readSafeLanguageModelSettings(
            normalizedCatalog.defaultPickerCatalog.map((model) => model.id),
          )
        : { available: false },
  };

  const document = await vscode.workspace.openTextDocument({
    language: "json",
    content: JSON.stringify(payload, null, 2),
  });
  await vscode.window.showTextDocument(document, { preview: false });
}

function registerDumpModelCatalogCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    "copilotScheduler.dumpModelCatalog",
    async () => {
      try {
        await registerModelCatalogDiagnosticDocument();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error ?? "");
        notifyError(errorMessage);
      }
    },
  );
}
