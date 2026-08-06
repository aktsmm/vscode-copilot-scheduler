import * as vscode from "vscode";

import type { ScheduleManager } from "../scheduleManager";
import {
  createLmToolMutationClient,
  type ModelSelectionResolver,
} from "../taskMutationService";
import { createSchedulerCreateTaskTool } from "./tools/createTask";
import { createSchedulerDeleteTaskTool } from "./tools/deleteTask";
import {
  createSchedulerQueryTool,
  type SchedulerCatalogProvider,
} from "./tools/query";
import { createSchedulerSetTaskEnabledTool } from "./tools/setTaskEnabled";
import { createSchedulerUpdateTaskTool } from "./tools/updateTask";

/**
 * Optional collaborators are injected so this module stays independent of the
 * `CopilotExecutor` dependency graph and remains easy to fake in tests.
 */
export interface LmToolsRegistrationOptions {
  catalogProvider?: SchedulerCatalogProvider;
  resolveModelSelection?: ModelSelectionResolver;
}

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
  options: LmToolsRegistrationOptions = {},
): void {
  const mutationClient = createLmToolMutationClient({
    scheduleManager,
    resolveModelSelection: options.resolveModelSelection,
  });

  const disposables: vscode.Disposable[] = [
    vscode.lm.registerTool(
      "scheduler_query",
      createSchedulerQueryTool(scheduleManager, options.catalogProvider),
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
