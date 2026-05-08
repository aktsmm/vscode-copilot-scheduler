/**
 * Copilot Scheduler - Type Definitions
 */

/**
 * Task scope type
 * - "global": Task runs in all workspaces
 * - "workspace": Task runs only in the specified workspace
 */
export type TaskScope = "global" | "workspace";

/**
 * Prompt source type
 * - "inline": Prompt text stored directly in task
 * - "local": Prompt loaded from workspace file
 * - "global": Prompt loaded from global templates
 */
export type PromptSource = "inline" | "local" | "global";

/**
 * Log level type
 */
export type LogLevel = "none" | "error" | "info" | "debug";

/**
 * Chat session behavior
 */
export type ChatSessionBehavior = "new" | "continue";

/**
 * Structured model selection fields.
 * `model` remains the primary persisted identifier for backward compatibility.
 */
export interface ModelSelectionFields {
  /** Preferred model identifier */
  model?: string;

  /** Preferred display name captured at save time */
  modelName?: string;

  /** Preferred vendor captured at save time */
  modelVendor?: string;

  /** Preferred family captured at save time */
  modelFamily?: string;

  /** Preferred version captured at save time */
  modelVersion?: string;

  /** Experimental reasoning effort captured at save time */
  modelReasoningEffort?: string;
}

/**
 * Scheduled task definition
 */
export interface ScheduledTask {
  /** Unique identifier (e.g., "task_1700000000000_abc123") */
  id: string;

  /** Task name */
  name: string;

  /** Cron expression, or multiple newline-separated expressions. */
  cronExpression: string;

  /** Prompt text to send to Copilot (when promptSource is "inline") */
  prompt: string;

  /** Whether the task is enabled */
  enabled: boolean;

  /** Agent to use (@workspace, @terminal, agent, ask, edit, etc.) */
  agent?: string;

  /** AI model to use (gpt-4o, claude-sonnet-4, etc.) */
  model?: string;

  /** Saved model display name for migration/healing */
  modelName?: string;

  /** Saved model vendor for migration/healing */
  modelVendor?: string;

  /** Saved model family for migration/healing */
  modelFamily?: string;

  /** Saved model version for migration/healing */
  modelVersion?: string;

  /** Experimental reasoning effort for eligible Copilot models */
  modelReasoningEffort?: string;

  /** Task scope */
  scope: TaskScope;

  /** Workspace path (when scope is "workspace") */
  workspacePath?: string;

  /** Prompt source type */
  promptSource: PromptSource;

  /** Path to prompt file (when promptSource is not "inline") */
  promptPath?: string;

  /** Whether to append an auto-mode hint to the runtime prompt. */
  autoMode?: boolean;

  /** Max random delay in seconds applied before execution (0 = off). */
  jitterSeconds?: number;

  /** Per-task max executions per day (0 = unlimited). */
  maxExecutionsPerDay?: number;

  /** Allowed execution start time in local clock (HH:mm). */
  allowedTimeStart?: string;

  /** Allowed execution end time in local clock (HH:mm). */
  allowedTimeEnd?: string;

  /** Last execution time */
  lastRun?: Date;

  /** Next scheduled execution time */
  nextRun?: Date;

  /** Creation timestamp */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * Input for creating a new task
 */
export interface CreateTaskInput {
  /** Task name */
  name: string;

  /** Cron expression */
  cronExpression: string;

  /** Prompt text */
  prompt: string;

  /** Whether the task is enabled (default: true) */
  enabled?: boolean;

  /** Agent to use */
  agent?: string;

  /** AI model to use */
  model?: string;

  /** Saved model display name for migration/healing */
  modelName?: string;

  /** Saved model vendor for migration/healing */
  modelVendor?: string;

  /** Saved model family for migration/healing */
  modelFamily?: string;

  /** Saved model version for migration/healing */
  modelVersion?: string;

  /** Experimental reasoning effort for eligible Copilot models */
  modelReasoningEffort?: string;

  /** Task scope (default: "workspace") */
  scope?: TaskScope;

  /**
   * Whether to schedule the first execution soon after creation.
   * Despite the legacy name, the actual delay is FIRST_RUN_DELAY_MINUTES (3 min).
   * Kept as-is to avoid breaking the Webview ↔ Extension message contract.
   */
  runFirstInOneMinute?: boolean;

  /** Prompt source type (default: "inline") */
  promptSource?: PromptSource;

  /** Path to prompt file */
  promptPath?: string;

  /** Whether to append an auto-mode hint to the runtime prompt. */
  autoMode?: boolean;

  /** Max random delay in seconds applied before execution (0 = off; undefined = use configured default). */
  jitterSeconds?: number;

  /** Per-task max executions per day (0 = unlimited). */
  maxExecutionsPerDay?: number;

  /** Allowed execution start time in local clock (HH:mm). */
  allowedTimeStart?: string;

  /** Allowed execution end time in local clock (HH:mm). */
  allowedTimeEnd?: string;
}

/**
 * Agent definition
 */
export interface AgentInfo {
  /** Agent ID (e.g., "@workspace", "agent") */
  id: string;

  /** Display name */
  name: string;

  /** Description */
  description: string;

  /** Whether this is a custom agent */
  isCustom: boolean;

  /** Actual runtime agent name/mode when it differs from the persisted id */
  invocationName?: string;

  /** File path for custom agents */
  filePath?: string;
}

/**
 * Model definition
 */
export interface ModelInfo {
  /** Model ID (e.g., "gpt-4o") */
  id: string;

  /** Display name */
  name: string;

  /** Optional UI label used to disambiguate variants in pickers */
  label?: string;

  /** Description */
  description: string;

  /** Vendor name */
  vendor: string;

  /** Model family identifier when available */
  family?: string;

  /** Model version when available */
  version?: string;

  /** Max input tokens when exposed by the VS Code API */
  maxInputTokens?: number;
}

/**
 * Payload for prompt execution and test runs.
 */
export interface PromptExecutionRequest extends ModelSelectionFields {
  /** Prompt text */
  prompt: string;

  /** Agent to use */
  agent?: string;
}

/**
 * Prompt template definition
 */
export interface PromptTemplate {
  /** Template file path */
  path: string;

  /** Template name (derived from filename) */
  name: string;

  /** Optional UI label used to disambiguate templates with the same name */
  displayName?: string;

  /** Source type */
  source: "local" | "global";

  /** File content (loaded on demand) */
  content?: string;
}

/**
 * Cron preset definition
 */
export interface CronPreset {
  /** Preset ID */
  id: string;

  /** Display name */
  name: string;

  /** Cron expression */
  expression: string;

  /** Description */
  description: string;
}

/**
 * Task action from Webview
 */
export interface TaskAction {
  /** Action type */
  action:
    | "run"
    | "toggle"
    | "delete"
    | "edit"
    | "copy"
    | "duplicate"
    | "moveToCurrentWorkspace";

  /** Task ID */
  taskId: string;

  /** Additional data for the action */
  data?: Partial<CreateTaskInput>;
}

/**
 * Execute options for CopilotExecutor
 */
export interface ExecuteOptions extends ModelSelectionFields {
  /** Agent to use */
  agent?: string;
}

/**
 * Webview message types (Webview → Extension)
 */
export type WebviewToExtensionMessage =
  | { type: "createTask"; data: CreateTaskInput }
  | { type: "updateTask"; taskId: string; data: Partial<CreateTaskInput> }
  | ({ type: "testPrompt" } & PromptExecutionRequest)
  | { type: "duplicateTask"; taskId: string }
  | { type: "refreshAgents" }
  | { type: "refreshPrompts" }
  | { type: "runTask"; taskId: string }
  | { type: "toggleTask"; taskId: string }
  | { type: "deleteTask"; taskId: string }
  | { type: "moveTaskToCurrentWorkspace"; taskId: string }
  | { type: "copyTask"; taskId: string }
  | { type: "loadPromptTemplate"; path: string; source: "local" | "global" }
  | { type: "webviewReady" };

/**
 * TreeView context values
 */
export type TreeContextValue =
  | "scopeGroup"
  | "workspaceGroup"
  | "enabledTask"
  | "disabledTask"
  | "enabledWorkspaceTask"
  | "disabledWorkspaceTask"
  | "enabledOtherWorkspaceTask"
  | "disabledOtherWorkspaceTask";
