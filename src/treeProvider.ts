/**
 * Copilot Scheduler - Tree Provider
 * Provides data for the sidebar TreeView
 */

import * as vscode from "vscode";
import * as path from "path";
import type { ScheduledTask, TaskScope, TreeContextValue } from "./types";
import { ScheduleManager } from "./scheduleManager";
import { messages, formatCronForDisplay, isJapanese } from "./i18n";

type WorkspaceTaskGroup = "this" | "other";

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
    this.id = `scope-${scope}`;
    this.contextValue = "scopeGroup";
    this.description = `(${taskCount})`;

    // Set icon
    this.iconPath = new vscode.ThemeIcon(
      scope === "global" ? "globe" : "folder",
    );
  }
}

/**
 * TreeView node for workspace task sub-groups (This workspace / Other workspaces)
 */
export class WorkspaceGroupItem extends vscode.TreeItem {
  public readonly group: WorkspaceTaskGroup;

  constructor(group: WorkspaceTaskGroup, taskCount: number) {
    const label =
      group === "this"
        ? messages.treeGroupThisWorkspace()
        : messages.treeGroupOtherWorkspace();

    super(label, vscode.TreeItemCollapsibleState.Expanded);

    this.group = group;
    this.id = `workspace-group-${group}`;
    this.contextValue = "workspaceGroup";
    this.description = `(${taskCount})`;

    this.iconPath = new vscode.ThemeIcon(group === "this" ? "home" : "link");
  }
}

/**
 * TreeView node for individual tasks
 */
export class ScheduledTaskItem extends vscode.TreeItem {
  public readonly task: ScheduledTask;
  private readonly inThisWorkspace: boolean;

  constructor(task: ScheduledTask, inThisWorkspace: boolean) {
    super(task.name, vscode.TreeItemCollapsibleState.None);

    this.task = task;
    this.inThisWorkspace = inThisWorkspace;

    // Set context value based on enabled state and workspace applicability
    let contextValue: TreeContextValue;
    if (task.scope === "workspace") {
      if (inThisWorkspace) {
        contextValue = task.enabled
          ? "enabledWorkspaceTask"
          : "disabledWorkspaceTask";
      } else {
        contextValue = task.enabled
          ? "enabledOtherWorkspaceTask"
          : "disabledOtherWorkspaceTask";
      }
    } else {
      contextValue = task.enabled ? "enabledTask" : "disabledTask";
    }
    this.contextValue = contextValue;

    // Set description with cron and next run
    const cronDisplay = formatCronForDisplay(task.cronExpression);
    if (task.nextRun && task.enabled) {
      const nextRunStr = messages.formatDateTime(task.nextRun);
      this.description = `${cronDisplay} → ${nextRunStr}`;
    } else {
      this.description = cronDisplay;
    }

    if (task.scope === "workspace" && !inThisWorkspace) {
      const wsName = task.workspacePath ? path.basename(task.workspacePath) : "";
      this.description = `${this.description} • ${wsName || messages.labelOtherWorkspaceShort()}`;
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
      command: "copilotScheduler.editTask",
      title: messages.actionEdit(),
      arguments: [this],
    };
  }

  private createTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;

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

    // Scope / workspace
    const scopeLabel = ja ? "スコープ" : "Scope";
    const scopeValue =
      task.scope === "global"
        ? ja
          ? "🌐 グローバル"
          : "🌐 Global"
        : ja
          ? "📁 ワークスペースのみ"
          : "📁 Workspace only";
    md.appendMarkdown(`**${scopeLabel}:** ${scopeValue}\n\n`);

    if (task.scope === "workspace") {
      const workspaceLabel = ja ? "対象ワークスペース" : "Workspace";
      const wsPath = task.workspacePath || "";
      md.appendMarkdown(`**${workspaceLabel}:**\n\n`);
      if (wsPath) {
        md.appendCodeblock(wsPath);
      } else {
        md.appendMarkdown(ja ? "(未設定)\n\n" : "(not set)\n\n");
      }

      const appliesLabel = ja ? "このワークスペース" : "Applies here";
      const appliesValue = this.inThisWorkspace
        ? messages.labelThisWorkspaceShort()
        : messages.labelOtherWorkspaceShort();
      md.appendMarkdown(`**${appliesLabel}:** ${appliesValue}\n\n`);
    }

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
    md.appendMarkdown(`**${promptLabel}:**\n\n`);
    md.appendCodeblock(promptPreview);

    return md;
  }
}

/**
 * Union type for tree nodes
 */
export type TreeNode = ScopeGroupItem | ScheduledTaskItem;

export type WorkspaceTreeNode = ScopeGroupItem | WorkspaceGroupItem | ScheduledTaskItem;

/**
 * TreeDataProvider for scheduled tasks
 */
export class ScheduledTaskTreeProvider
  implements vscode.TreeDataProvider<WorkspaceTreeNode>
{
  private _onDidChangeTreeData: vscode.EventEmitter<
    WorkspaceTreeNode | undefined | null | void
  > = new vscode.EventEmitter<WorkspaceTreeNode | undefined | null | void>();

  readonly onDidChangeTreeData: vscode.Event<
    WorkspaceTreeNode | undefined | null | void
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
  getTreeItem(element: WorkspaceTreeNode): vscode.TreeItem {
    return element;
  }

  /**
   * Get children for tree node
   */
  getChildren(element?: WorkspaceTreeNode): Thenable<WorkspaceTreeNode[]> {
    if (!element) {
      // Root level: return scope groups
      return this.getRootChildren();
    }

    if (element instanceof ScopeGroupItem) {
      // Scope group: return tasks in that scope (or workspace sub-groups)
      if (element.scope === "workspace") {
        return this.getWorkspaceGroups();
      }
      return this.getTasksForScope(element.scope);
    }

    if (element instanceof WorkspaceGroupItem) {
      return this.getWorkspaceTasksForGroup(element.group);
    }

    // Task items have no children
    return Promise.resolve([]);
  }

  /**
   * Get root level children (scope groups)
   */
  private async getRootChildren(): Promise<WorkspaceTreeNode[]> {
    const allTasks = this.scheduleManager.getAllTasks();

    const globalTasks = allTasks.filter((t) => t.scope === "global");
    const workspaceTasks = allTasks.filter((t) => t.scope === "workspace");

    const groups: WorkspaceTreeNode[] = [];

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
  private async getTasksForScope(scope: TaskScope): Promise<WorkspaceTreeNode[]> {
    const tasks = this.scheduleManager.getTasksByScope(scope);

    // Sort by name
    tasks.sort((a, b) => a.name.localeCompare(b.name));

    return tasks.map(
      (task) =>
        new ScheduledTaskItem(
          task,
          this.scheduleManager.shouldTaskRunInCurrentWorkspace(task),
        ),
    );
  }

  private partitionWorkspaceTasks(): {
    thisWorkspace: ScheduledTask[];
    otherWorkspace: ScheduledTask[];
  } {
    const tasks = this.scheduleManager.getTasksByScope("workspace");
    const thisWorkspace: ScheduledTask[] = [];
    const otherWorkspace: ScheduledTask[] = [];

    for (const task of tasks) {
      if (this.scheduleManager.shouldTaskRunInCurrentWorkspace(task)) {
        thisWorkspace.push(task);
      } else {
        otherWorkspace.push(task);
      }
    }

    return { thisWorkspace, otherWorkspace };
  }

  private async getWorkspaceGroups(): Promise<WorkspaceTreeNode[]> {
    const { thisWorkspace, otherWorkspace } = this.partitionWorkspaceTasks();

    const groups: WorkspaceTreeNode[] = [];
    if (thisWorkspace.length > 0) {
      groups.push(new WorkspaceGroupItem("this", thisWorkspace.length));
    }
    if (otherWorkspace.length > 0) {
      groups.push(new WorkspaceGroupItem("other", otherWorkspace.length));
    }

    return groups;
  }

  private async getWorkspaceTasksForGroup(
    group: WorkspaceTaskGroup,
  ): Promise<WorkspaceTreeNode[]> {
    const { thisWorkspace, otherWorkspace } = this.partitionWorkspaceTasks();
    const tasks = group === "this" ? thisWorkspace : otherWorkspace;

    tasks.sort((a, b) => a.name.localeCompare(b.name));

    return tasks.map((task) => new ScheduledTaskItem(task, group === "this"));
  }

  /**
   * Get parent of a tree node (required for reveal)
   */
  getParent(element: WorkspaceTreeNode): vscode.ProviderResult<WorkspaceTreeNode> {
    if (element instanceof ScheduledTaskItem) {
      const task = element.task;

      if (task.scope === "workspace") {
        const { thisWorkspace, otherWorkspace } = this.partitionWorkspaceTasks();
        const inThisWorkspace = this.scheduleManager.shouldTaskRunInCurrentWorkspace(task);
        return new WorkspaceGroupItem(
          inThisWorkspace ? "this" : "other",
          inThisWorkspace ? thisWorkspace.length : otherWorkspace.length,
        );
      }

      // Global: return the scope group for this task
      const allTasks = this.scheduleManager.getAllTasks();
      const tasksInScope = allTasks.filter((t) => t.scope === task.scope);
      return new ScopeGroupItem(task.scope, tasksInScope.length);
    }

    if (element instanceof WorkspaceGroupItem) {
      const { thisWorkspace, otherWorkspace } = this.partitionWorkspaceTasks();
      return new ScopeGroupItem(
        "workspace",
        thisWorkspace.length + otherWorkspace.length,
      );
    }

    // Scope groups have no parent
    return undefined;
  }
}
