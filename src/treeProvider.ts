/**
 * Copilot Scheduler - Tree Provider
 * Provides data for the sidebar TreeView
 */

import * as vscode from "vscode";
import type { ScheduledTask, TaskScope, TreeContextValue } from "./types";
import { ScheduleManager } from "./scheduleManager";
import { messages, formatCronForDisplay, isJapanese } from "./i18n";

/**
 * TreeView node for scope groups (Global / Workspace)
 */
export class ScopeGroupItem extends vscode.TreeItem {
  public readonly scope: TaskScope;

  constructor(scope: TaskScope, taskCount: number) {
    const label =
      scope === "global"
        ? messages.treeGroupGlobal()
        : messages.treeGroupWorkspace();

    super(label, vscode.TreeItemCollapsibleState.Expanded);

    this.scope = scope;
    this.contextValue = "scopeGroup";
    this.description = `(${taskCount})`;

    // Set icon
    this.iconPath = new vscode.ThemeIcon(
      scope === "global" ? "globe" : "folder",
    );
  }
}

/**
 * TreeView node for individual tasks
 */
export class ScheduledTaskItem extends vscode.TreeItem {
  public readonly task: ScheduledTask;

  constructor(task: ScheduledTask) {
    super(task.name, vscode.TreeItemCollapsibleState.None);

    this.task = task;

    // Set context value based on enabled state
    this.contextValue = task.enabled ? "enabledTask" : "disabledTask";

    // Set description with cron and next run
    const cronDisplay = formatCronForDisplay(task.cronExpression);
    if (task.nextRun && task.enabled) {
      const nextRunStr = messages.formatDateTime(task.nextRun);
      this.description = `${cronDisplay} → ${nextRunStr}`;
    } else {
      this.description = cronDisplay;
    }

    // Set tooltip with detailed info
    this.tooltip = this.createTooltip();

    // Set icon based on state
    if (task.enabled) {
      this.iconPath = new vscode.ThemeIcon(
        "clock",
        new vscode.ThemeColor("charts.green"),
      );
    } else {
      this.iconPath = new vscode.ThemeIcon(
        "circle-slash",
        new vscode.ThemeColor("disabledForeground"),
      );
    }

    // Set command to edit task on click
    this.command = {
      command: "promptPilot.editTask",
      title: messages.actionEdit(),
      arguments: [this],
    };
  }

  private createTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const task = this.task;
    const ja = isJapanese();

    md.appendMarkdown(`### ${task.name}\n\n`);

    // Status
    const statusLabel = ja ? "ステータス" : "Status";
    const statusValue = task.enabled
      ? ja
        ? "✅ 有効"
        : "✅ Enabled"
      : ja
        ? "⏸️ 無効"
        : "⏸️ Disabled";
    md.appendMarkdown(`**${statusLabel}:** ${statusValue}\n\n`);

    // Schedule
    const scheduleLabel = ja ? "スケジュール" : "Schedule";
    md.appendMarkdown(`**${scheduleLabel}:** \`${task.cronExpression}\`\n\n`);

    // Next run
    if (task.nextRun && task.enabled) {
      const nextRunLabel = ja ? "次回実行" : "Next run";
      md.appendMarkdown(
        `**${nextRunLabel}:** ${messages.formatDateTime(task.nextRun)}\n\n`,
      );
    }

    // Last run
    if (task.lastRun) {
      const lastRunLabel = ja ? "前回実行" : "Last run";
      md.appendMarkdown(
        `**${lastRunLabel}:** ${messages.formatDateTime(task.lastRun)}\n\n`,
      );
    }

    // Agent
    if (task.agent) {
      const agentLabel = ja ? "エージェント" : "Agent";
      md.appendMarkdown(`**${agentLabel}:** ${task.agent}\n\n`);
    }

    // Model
    if (task.model) {
      const modelLabel = ja ? "モデル" : "Model";
      md.appendMarkdown(`**${modelLabel}:** ${task.model}\n\n`);
    }

    // Prompt preview
    const promptLabel = ja ? "プロンプト" : "Prompt";
    const promptPreview =
      task.prompt.length > 100
        ? task.prompt.substring(0, 100) + "..."
        : task.prompt;
    md.appendMarkdown(`**${promptLabel}:**\n\`\`\`\n${promptPreview}\n\`\`\``);

    return md;
  }
}

/**
 * Union type for tree nodes
 */
export type TreeNode = ScopeGroupItem | ScheduledTaskItem;

/**
 * TreeDataProvider for scheduled tasks
 */
export class ScheduledTaskTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    TreeNode | undefined | null | void
  > = new vscode.EventEmitter<TreeNode | undefined | null | void>();

  readonly onDidChangeTreeData: vscode.Event<
    TreeNode | undefined | null | void
  > = this._onDidChangeTreeData.event;

  private scheduleManager: ScheduleManager;

  constructor(scheduleManager: ScheduleManager) {
    this.scheduleManager = scheduleManager;

    // Register for task changes
    this.scheduleManager.setOnTasksChangedCallback(() => {
      this.refresh();
    });
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  /**
   * Get children for tree node
   */
  getChildren(element?: TreeNode): Thenable<TreeNode[]> {
    if (!element) {
      // Root level: return scope groups
      return this.getRootChildren();
    }

    if (element instanceof ScopeGroupItem) {
      // Scope group: return tasks in that scope
      return this.getTasksForScope(element.scope);
    }

    // Task items have no children
    return Promise.resolve([]);
  }

  /**
   * Get root level children (scope groups)
   */
  private async getRootChildren(): Promise<TreeNode[]> {
    const allTasks = this.scheduleManager.getAllTasks();

    const globalTasks = allTasks.filter((t) => t.scope === "global");
    const workspaceTasks = allTasks.filter((t) => t.scope === "workspace");

    const groups: TreeNode[] = [];

    // Only show groups that have tasks or if there are no tasks at all
    if (globalTasks.length > 0 || allTasks.length === 0) {
      groups.push(new ScopeGroupItem("global", globalTasks.length));
    }

    if (workspaceTasks.length > 0 || allTasks.length === 0) {
      groups.push(new ScopeGroupItem("workspace", workspaceTasks.length));
    }

    return groups;
  }

  /**
   * Get tasks for a specific scope
   */
  private async getTasksForScope(scope: TaskScope): Promise<TreeNode[]> {
    const tasks = this.scheduleManager.getTasksByScope(scope);

    // Sort by name
    tasks.sort((a, b) => a.name.localeCompare(b.name));

    return tasks.map((task) => new ScheduledTaskItem(task));
  }

  /**
   * Get parent of a tree node (required for reveal)
   */
  getParent(element: TreeNode): vscode.ProviderResult<TreeNode> {
    if (element instanceof ScheduledTaskItem) {
      // Return the scope group for this task
      const task = element.task;
      const allTasks = this.scheduleManager.getAllTasks();
      const tasksInScope = allTasks.filter((t) => t.scope === task.scope);
      return new ScopeGroupItem(task.scope, tasksInScope.length);
    }

    // Scope groups have no parent
    return undefined;
  }
}

