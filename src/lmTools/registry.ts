import * as vscode from "vscode";

import type { ScheduleManager } from "../scheduleManager";
import { createLmToolMutationClient } from "../taskMutationService";
import { createSchedulerCreateTaskTool } from "./tools/createTask";
import { createSchedulerDeleteTaskTool } from "./tools/deleteTask";
import { createSchedulerQueryTool } from "./tools/query";
import { createSchedulerSetTaskEnabledTool } from "./tools/setTaskEnabled";
import { createSchedulerUpdateTaskTool } from "./tools/updateTask";

/**
 * Register all Copilot Scheduler language-model tools.
 *
 * The write tools are gated at invocation time via workspace trust and the
 * `copilotScheduler.lmTools.enableWriteTools` setting (both checked in each
 * tool's `invoke`). Registration itself is unconditional so the tools appear
 * in the Copilot Chat tool picker even when writes are currently disabled –
 * that matches VS Code's expectations and lets the tool return an actionable
 * error to the LLM rather than being invisible.
 */
export function registerLmTools(
  context: vscode.ExtensionContext,
  scheduleManager: ScheduleManager,
): void {
  const mutationClient = createLmToolMutationClient({ scheduleManager });

  const disposables: vscode.Disposable[] = [
    vscode.lm.registerTool(
      "scheduler_query",
      createSchedulerQueryTool(scheduleManager),
    ),
    vscode.lm.registerTool(
      "scheduler_create_task",
      createSchedulerCreateTaskTool(mutationClient),
    ),
    vscode.lm.registerTool(
      "scheduler_update_task",
      createSchedulerUpdateTaskTool(mutationClient),
    ),
    vscode.lm.registerTool(
      "scheduler_delete_task",
      createSchedulerDeleteTaskTool(scheduleManager, mutationClient),
    ),
    vscode.lm.registerTool(
      "scheduler_set_task_enabled",
      createSchedulerSetTaskEnabledTool(mutationClient),
    ),
  ];

  context.subscriptions.push(...disposables);
}
