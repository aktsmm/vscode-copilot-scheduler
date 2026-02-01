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
 * Scheduled task definition
 */
export interface ScheduledTask {
  /** Unique identifier (e.g., "task_1700000000000_abc123") */
  id: string;

  /** Task name */
  name: string;

  /** Cron expression (e.g., "0 9 * * 1-5") */
  cronExpression: string;

  /** Prompt text to send to Copilot (when promptSource is "inline") */
  prompt: string;

  /** Whether the task is enabled */
  enabled: boolean;

  /** Agent to use (@workspace, @terminal, agent, ask, edit, etc.) */
  agent?: string;

  /** AI model to use (gpt-4o, claude-sonnet-4, etc.) */
  model?: string;

  /** Task scope */
  scope: TaskScope;

  /** Workspace path (when scope is "workspace") */
  workspacePath?: string;

  /** Prompt source type */
  promptSource: PromptSource;

  /** Path to prompt file (when promptSource is not "inline") */
  promptPath?: string;

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

  /** Task scope (default: "workspace") */
  scope?: TaskScope;

  /** Whether to run first execution in 1 minute */
  runFirstInOneMinute?: boolean;

  /** Prompt source type (default: "inline") */
  promptSource?: PromptSource;

  /** Path to prompt file */
  promptPath?: string;
}

/**
 * Result of task execution
 */
export interface TaskExecutionResult {
  /** Task ID */
  taskId: string;

  /** Whether execution was successful */
  success: boolean;

  /** Execution timestamp */
  executedAt: Date;

  /** Error message if execution failed */
  error?: string;

  /** Execution duration in milliseconds */
  duration?: number;
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

  /** Description */
  description: string;

  /** Vendor name */
  vendor: string;
}

/**
 * Prompt template definition
 */
export interface PromptTemplate {
  /** Template file path */
  path: string;

  /** Template name (derived from filename) */
  name: string;

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
  action: "run" | "toggle" | "delete" | "edit" | "copy" | "duplicate";

  /** Task ID */
  taskId: string;

  /** Additional data for the action */
  data?: Partial<CreateTaskInput>;
}

/**
 * Execute options for CopilotExecutor
 */
export interface ExecuteOptions {
  /** Agent to use */
  agent?: string;

  /** Model to use */
  model?: string;
}

/**
 * Extension configuration
 */
export interface ExtensionConfig {
  /** Whether scheduling is enabled */
  enabled: boolean;

  /** Whether to show notifications */
  showNotifications: boolean;

  /** Log level */
  logLevel: LogLevel;

  /** Language setting */
  language: "auto" | "en" | "ja";

  /** Timezone for scheduling */
  timezone: string;

  /** Chat session behavior */
  chatSession: ChatSessionBehavior;

  /** Default scope for new tasks */
  defaultScope: TaskScope;

  /** Custom global prompts path */
  globalPromptsPath: string;
}

/**
 * Webview message types (Extension → Webview)
 */
export type ExtensionToWebviewMessage =
  | { type: "updateTasks"; tasks: ScheduledTask[] }
  | { type: "updateAgents"; agents: AgentInfo[] }
  | { type: "updateModels"; models: ModelInfo[] }
  | { type: "updatePromptTemplates"; templates: PromptTemplate[] }
  | { type: "promptTemplateLoaded"; content: string; path: string }
  | { type: "switchToList" }
  | { type: "focusTask"; taskId: string }
  | { type: "refreshLanguage" };

/**
 * Webview message types (Webview → Extension)
 */
export type WebviewToExtensionMessage =
  | { type: "createTask"; data: CreateTaskInput }
  | { type: "updateTask"; taskId: string; data: Partial<CreateTaskInput> }
  | { type: "testPrompt"; prompt: string; agent?: string; model?: string }
  | { type: "copyPrompt"; prompt: string }
  | { type: "duplicateTask"; taskId: string }
  | { type: "refreshAgents" }
  | { type: "refreshPrompts" }
  | { type: "runTask"; taskId: string }
  | { type: "toggleTask"; taskId: string }
  | { type: "deleteTask"; taskId: string }
  | { type: "setDefaultScope"; scope: TaskScope }
  | { type: "loadPromptTemplate"; path: string; source: PromptSource }
  | { type: "webviewReady" };

/**
 * TreeView node types
 */
export type TreeNodeType = "scopeGroup" | "task";

/**
 * TreeView context values
 */
export type TreeContextValue = "scopeGroup" | "enabledTask" | "disabledTask";
