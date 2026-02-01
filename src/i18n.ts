/**
 * Copilot Scheduler - Internationalization (i18n)
 */

import * as vscode from "vscode";
import type { CronPreset } from "./types";

/**
 * Check if the current language is Japanese
 */
export function isJapanese(): boolean {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const lang = config.get<string>("language", "auto");

  if (lang === "ja") {
    return true;
  }
  if (lang === "en") {
    return false;
  }

  // Auto-detect from VS Code language
  return vscode.env.language.startsWith("ja");
}

/**
 * Get localized string helper
 */
function t(en: string, ja: string): string {
  return isJapanese() ? ja : en;
}

/**
 * All localized messages
 */
export const messages = {
  // ==================== General ====================
  extensionActive: () =>
    t(
      "Copilot Scheduler is now active",
      "Copilot Scheduler が有効になりました",
    ),
  extensionDeactivated: () =>
    t(
      "Copilot Scheduler has been deactivated",
      "Copilot Scheduler が無効になりました",
    ),
  schedulerStarted: () =>
    t("Scheduler started", "スケジューラーが開始されました"),
  schedulerStopped: () =>
    t("Scheduler stopped", "スケジューラーが停止されました"),

  // ==================== Task Operations ====================
  taskCreated: (name: string) =>
    t(`Task "${name}" created successfully`, `タスク「${name}」を作成しました`),
  taskUpdated: (name: string) =>
    t(`Task "${name}" updated successfully`, `タスク「${name}」を更新しました`),
  taskDeleted: (name: string) =>
    t(`Task "${name}" deleted`, `タスク「${name}」を削除しました`),
  taskDuplicated: (name: string) =>
    t(`Task duplicated as "${name}"`, `タスクを「${name}」として複製しました`),
  taskEnabled: (name: string) =>
    t(`Task "${name}" enabled`, `タスク「${name}」を有効にしました`),
  taskDisabled: (name: string) =>
    t(`Task "${name}" disabled`, `タスク「${name}」を無効にしました`),
  taskExecuting: (name: string) =>
    t(`Executing task "${name}"...`, `タスク「${name}」を実行中...`),
  taskExecuted: (name: string) =>
    t(
      `Task "${name}" executed successfully`,
      `タスク「${name}」を実行しました`,
    ),
  taskExecutionFailed: (name: string, error: string) =>
    t(
      `Task "${name}" execution failed: ${error}`,
      `タスク「${name}」の実行に失敗しました: ${error}`,
    ),
  taskNotFound: () => t("Task not found", "タスクが見つかりません"),
  noTasksFound: () =>
    t("No scheduled tasks found", "スケジュールされたタスクがありません"),

  // ==================== Validation ====================
  invalidCronExpression: () => t("Invalid cron expression", "無効なcron式です"),
  taskNameRequired: () =>
    t("Task name is required", "タスク名を入力してください"),
  promptRequired: () => t("Prompt is required", "プロンプトを入力してください"),
  cronExpressionRequired: () =>
    t("Cron expression is required", "cron式を入力してください"),

  // ==================== Prompts ====================
  enterTaskName: () => t("Enter task name", "タスク名を入力"),
  enterPrompt: () =>
    t("Enter prompt to send to Copilot", "Copilotに送信するプロンプトを入力"),
  enterCronExpression: () =>
    t(
      "Enter cron expression (e.g., '0 9 * * 1-5' for weekdays at 9am)",
      "cron式を入力（例: '0 9 * * 1-5' で平日9時）",
    ),
  selectAgent: () => t("Select agent", "エージェントを選択"),
  selectModel: () => t("Select model", "モデルを選択"),
  selectScope: () => t("Select scope", "スコープを選択"),
  selectTask: () => t("Select a task", "タスクを選択"),
  selectPromptTemplate: () =>
    t("Select prompt template", "プロンプトテンプレートを選択"),

  // ==================== Actions ====================
  actionRun: () => t("Run", "実行"),
  actionEdit: () => t("Edit", "編集"),
  actionDelete: () => t("Delete", "削除"),
  actionDuplicate: () => t("Duplicate", "複製"),
  actionEnable: () => t("Enable", "有効化"),
  actionDisable: () => t("Disable", "無効化"),
  actionCancel: () => t("Cancel", "キャンセル"),
  actionCopyPrompt: () => t("Copy Prompt", "プロンプトをコピー"),
  actionTestRun: () => t("Test Run", "テスト実行"),
  actionSave: () => t("Save", "保存"),
  actionCreate: () => t("Create", "作成"),
  actionRefresh: () => t("Refresh", "更新"),

  // ==================== Confirmations ====================
  confirmDelete: (name: string) =>
    t(
      `Are you sure you want to delete task "${name}"?`,
      `タスク「${name}」を削除しますか？`,
    ),
  confirmDeleteYes: () => t("Yes, delete", "はい、削除します"),
  confirmDeleteNo: () => t("No, keep", "いいえ、残します"),

  // ==================== Clipboard ====================
  promptCopied: () =>
    t(
      "Prompt copied to clipboard",
      "プロンプトをクリップボードにコピーしました",
    ),

  // ==================== Execution Errors ====================
  autoExecuteFailed: () =>
    t(
      "Failed to automatically execute prompt. Would you like to copy it to clipboard?",
      "プロンプトの自動実行に失敗しました。クリップボードにコピーしますか？",
    ),
  copilotNotAvailable: () =>
    t(
      "GitHub Copilot Chat is not available",
      "GitHub Copilot Chat が利用できません",
    ),

  // ==================== Webview UI ====================
  tabCreate: () => t("Create Task", "タスク作成"),
  tabList: () => t("Task List", "タスク一覧"),

  labelTaskName: () => t("Task Name", "タスク名"),
  labelPromptType: () => t("Prompt Type", "プロンプト種別"),
  labelPromptInline: () => t("Free Input", "自由入力"),
  labelPromptLocal: () => t("Local Template", "ローカルテンプレート"),
  labelPromptGlobal: () => t("Global Template", "グローバルテンプレート"),
  labelPrompt: () => t("Prompt", "プロンプト"),
  labelSchedule: () => t("Schedule", "スケジュール"),
  labelCronExpression: () => t("Cron Expression", "Cron式"),
  labelPreset: () => t("Preset", "プリセット"),
  labelCustom: () => t("Custom", "カスタム"),
  labelAdvanced: () => t("Advanced", "詳細設定"),
  labelFrequency: () => t("Frequency", "頻度"),
  labelFrequencyMinute: () => t("Every X minutes", "X分ごと"),
  labelFrequencyHourly: () => t("Hourly", "毎時"),
  labelFrequencyDaily: () => t("Daily", "毎日"),
  labelFrequencyWeekly: () => t("Weekly", "毎週"),
  labelFrequencyMonthly: () => t("Monthly", "毎月"),
  labelSelectDays: () => t("Select days", "曜日を選択"),
  labelSelectTime: () => t("Time", "時刻"),
  labelSelectHour: () => t("Hour", "時"),
  labelSelectMinute: () => t("Minute", "分"),
  labelSelectDay: () => t("Day of month", "日"),
  labelInterval: () => t("Interval", "間隔"),
  labelAgent: () => t("Agent", "エージェント"),
  labelModel: () => t("Model", "モデル"),
  labelScope: () => t("Scope", "スコープ"),
  labelScopeGlobal: () =>
    t("Global (All Workspaces)", "グローバル（全ワークスペース）"),
  labelScopeWorkspace: () => t("Workspace Only", "ワークスペースのみ"),
  labelEnabled: () => t("Enabled", "有効"),
  labelDisabled: () => t("Disabled", "無効"),
  labelStatus: () => t("Status", "ステータス"),
  labelNextRun: () => t("Next Run", "次回実行"),
  labelLastRun: () => t("Last Run", "前回実行"),
  labelNever: () => t("Never", "なし"),
  labelRunFirstInOneMinute: () =>
    t("Run first execution in 1 minute", "1分後に初回実行する"),

  placeholderTaskName: () => t("Enter task name...", "タスク名を入力..."),
  placeholderPrompt: () =>
    t(
      "Enter prompt to send to Copilot...",
      "Copilotに送信するプロンプトを入力...",
    ),
  placeholderCron: () => t("e.g., 0 9 * * 1-5", "例: 0 9 * * 1-5"),

  // ==================== TreeView ====================
  treeGroupGlobal: () => t("🌐 Global", "🌐 グローバル"),
  treeGroupWorkspace: () => t("📁 Workspace", "📁 ワークスペース"),
  treeNoTasks: () => t("No tasks", "タスクなし"),

  // ==================== Version Info ====================
  versionInfo: (version: string) =>
    t(`Copilot Scheduler v${version}`, `Copilot Scheduler v${version}`),

  // ==================== Settings ====================
  openingSettings: () =>
    t(
      "Opening Copilot Scheduler settings...",
      "Copilot Scheduler の設定を開いています...",
    ),

  // ==================== Agents ====================
  agentNone: () => t("None (Default)", "なし（デフォルト）"),
  agentAgent: () => t("Agent (Tool use)", "Agent（ツール利用）"),
  agentAsk: () => t("Ask (Code questions)", "Ask（コード質問）"),
  agentEdit: () => t("Edit (AI code editing)", "Edit（AIコード編集）"),
  agentWorkspace: () =>
    t("@workspace (Codebase search)", "@workspace（コードベース検索）"),
  agentTerminal: () =>
    t("@terminal (Terminal operations)", "@terminal（ターミナル操作）"),
  agentVscode: () => t("@vscode (VS Code settings)", "@vscode（VS Code設定）"),

  // ==================== Models ====================
  modelDefault: () => t("Default", "デフォルト"),

  // ==================== Date/Time ====================
  formatDateTime: (date: Date) => {
    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    };
    return date.toLocaleString(isJapanese() ? "ja-JP" : "en-US", options);
  },

  // ==================== Cron Descriptions ====================
  cronNextRun: (date: Date) =>
    t(
      `Next run: ${messages.formatDateTime(date)}`,
      `次回実行: ${messages.formatDateTime(date)}`,
    ),
  cronInvalid: () => t("Invalid cron expression", "無効なcron式"),

  // ==================== Prompt Templates ====================
  noTemplatesFound: () =>
    t("No prompt templates found", "プロンプトテンプレートが見つかりません"),
  templateLoadError: () =>
    t("Failed to load template", "テンプレートの読み込みに失敗しました"),

  // ==================== Workspace ====================
  noWorkspaceOpen: () =>
    t("No workspace is open", "ワークスペースが開かれていません"),
  workspaceTaskSkipped: (name: string) =>
    t(
      `Task "${name}" skipped (workspace-specific)`,
      `タスク「${name}」をスキップしました（ワークスペース固有）`,
    ),
};

/**
 * Cron presets with localized names
 */
export function getCronPresets(): CronPreset[] {
  return [
    {
      id: "every-3min",
      name: t("Every 3 Minutes", "3分ごと"),
      expression: "*/3 * * * *",
      description: t("Every 3 minutes", "3分ごと"),
    },
    {
      id: "every-5min",
      name: t("Every 5 Minutes", "5分ごと"),
      expression: "*/5 * * * *",
      description: t("Every 5 minutes", "5分ごと"),
    },
    {
      id: "every-10min",
      name: t("Every 10 Minutes", "10分ごと"),
      expression: "*/10 * * * *",
      description: t("Every 10 minutes", "10分ごと"),
    },
    {
      id: "every-15min",
      name: t("Every 15 Minutes", "15分ごと"),
      expression: "*/15 * * * *",
      description: t("Every 15 minutes", "15分ごと"),
    },
    {
      id: "every-30min",
      name: t("Every 30 Minutes", "30分ごと"),
      expression: "*/30 * * * *",
      description: t("Every 30 minutes", "30分ごと"),
    },
    {
      id: "hourly",
      name: t("Hourly", "毎時"),
      expression: "0 * * * *",
      description: t("Every hour at minute 0", "毎時0分"),
    },
    {
      id: "daily-9am",
      name: t("Daily 9:00 AM", "毎日 9:00"),
      expression: "0 9 * * *",
      description: t("Every day at 9:00 AM", "毎日9時"),
    },
    {
      id: "daily-12pm",
      name: t("Daily 12:00 PM", "毎日 12:00"),
      expression: "0 12 * * *",
      description: t("Every day at 12:00 PM", "毎日12時"),
    },
    {
      id: "daily-6pm",
      name: t("Daily 6:00 PM", "毎日 18:00"),
      expression: "0 18 * * *",
      description: t("Every day at 6:00 PM", "毎日18時"),
    },
    {
      id: "weekday-9am",
      name: t("Weekdays 9:00 AM", "平日 9:00"),
      expression: "0 9 * * 1-5",
      description: t("Monday to Friday at 9:00 AM", "月曜〜金曜の9時"),
    },
    {
      id: "weekday-6pm",
      name: t("Weekdays 6:00 PM", "平日 18:00"),
      expression: "0 18 * * 1-5",
      description: t("Monday to Friday at 6:00 PM", "月曜〜金曜の18時"),
    },
    {
      id: "weekly-monday",
      name: t("Every Monday 9:00 AM", "毎週月曜 9:00"),
      expression: "0 9 * * 1",
      description: t("Every Monday at 9:00 AM", "毎週月曜日の9時"),
    },
    {
      id: "weekly-friday",
      name: t("Every Friday 6:00 PM", "毎週金曜 18:00"),
      expression: "0 18 * * 5",
      description: t("Every Friday at 6:00 PM", "毎週金曜日の18時"),
    },
    {
      id: "monthly-1st",
      name: t("1st of Month 9:00 AM", "毎月1日 9:00"),
      expression: "0 9 1 * *",
      description: t("1st day of every month at 9:00 AM", "毎月1日の9時"),
    },
  ];
}

/**
 * Get agent display info
 */
export function getAgentDisplayInfo(agentId: string): {
  name: string;
  description: string;
} {
  const agentMap: Record<string, () => { name: string; description: string }> =
    {
      "": () => ({
        name: t("None", "なし"),
        description: t("Use default behavior", "デフォルトの動作を使用"),
      }),
      agent: () => ({
        name: "Agent",
        description: t(
          "Agent mode with tool use",
          "ツール利用のエージェントモード",
        ),
      }),
      ask: () => ({
        name: "Ask",
        description: t("Ask questions about code", "コードに関する質問"),
      }),
      edit: () => ({
        name: "Edit",
        description: t("AI code editing", "AIでコード編集"),
      }),
      "@workspace": () => ({
        name: "@workspace",
        description: t("Search codebase", "コードベース検索"),
      }),
      "@terminal": () => ({
        name: "@terminal",
        description: t("Terminal operations", "ターミナル操作"),
      }),
      "@vscode": () => ({
        name: "@vscode",
        description: t(
          "VS Code settings and commands",
          "VS Code設定とコマンド",
        ),
      }),
    };

  const getInfo = agentMap[agentId];
  if (getInfo) {
    return getInfo();
  }

  // For custom agents, return the ID as name
  return {
    name: agentId,
    description: t("Custom agent", "カスタムエージェント"),
  };
}

/**
 * Format cron expression for display
 */
export function formatCronForDisplay(expression: string): string {
  const presets = getCronPresets();
  const preset = presets.find((p) => p.expression === expression);
  if (preset) {
    return preset.name;
  }
  return expression;
}
