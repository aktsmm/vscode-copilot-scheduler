import * as vscode from "vscode";

import { messages } from "../../i18n";
import type { ScheduleManager } from "../../scheduleManager";
import type { ScheduledTask } from "../../types";
import {
  assertWriteToolGates,
  buildJsonTextResult,
  shouldUseCustomConfirmation,
  toTaskSummary,
} from "../shared";

interface RunTaskToolInput {
  id?: string;
}

export type ManualTaskRunResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "taskNotFound"
        | "executorUnavailable"
        | "alreadyRunning"
        | "oneTimeCompleted"
        | "promptBlocked"
        | "executionFailed"
        | "saveFailed"
        | "workspaceMismatch";
      message?: string;
    };

export type ManualTaskRunner = (
  task: ScheduledTask,
) => Promise<ManualTaskRunResult>;

export function createSchedulerRunTaskTool(
  scheduleManager: ScheduleManager,
  runTask: ManualTaskRunner,
): vscode.LanguageModelTool<RunTaskToolInput> {
  return {
    async prepareInvocation(
      options: vscode.LanguageModelToolInvocationPrepareOptions<RunTaskToolInput>,
    ): Promise<vscode.PreparedToolInvocation> {
      const id = options.input?.id;
      const task =
        typeof id === "string" ? scheduleManager.getTask(id) : undefined;
      const taskLabel = task?.name ?? id ?? "(missing id)";
      const prepared: vscode.PreparedToolInvocation = {
        invocationMessage: messages.taskExecuting(taskLabel),
      };
      if (shouldUseCustomConfirmation("run")) {
        prepared.confirmationMessages = {
          title: messages.lmToolRunTitle(),
          message: new vscode.MarkdownString().appendText(
            messages.lmToolRunConfirmation(
              taskLabel,
              task?.runAt ? (task.afterRun ?? "disable") : undefined,
            ),
          ),
        };
      }
      return prepared;
    },
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<RunTaskToolInput>,
      token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
      const gate = assertWriteToolGates(token);
      if (gate) {
        return gate;
      }
      const input = options.input;
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== "id")
      ) {
        return buildJsonTextResult({
          ok: false,
          reason: "validation",
          message:
            "Only the task id may be supplied. This tool does not change task settings.",
        });
      }
      const id = input.id;
      if (typeof id !== "string" || !id.trim()) {
        return buildJsonTextResult({
          ok: false,
          reason: "validation",
          message: "Missing required field: id.",
        });
      }
      const task = scheduleManager.getTask(id);
      if (!task) {
        return buildJsonTextResult({
          ok: false,
          reason: "not_found",
          message: `Task not found: ${id}`,
        });
      }
      const wasEnabled = task.enabled;

      if (
        task.scope === "workspace" &&
        !scheduleManager.shouldTaskRunInCurrentWorkspace(task)
      ) {
        return buildJsonTextResult({
          ok: false,
          reason: "workspaceMismatch",
          message:
            "This task belongs to another workspace. Open that workspace or use the Copilot Scheduler view to confirm running it here.",
        });
      }

      let result: ManualTaskRunResult;
      try {
        result = await runTask(task);
      } catch {
        return buildJsonTextResult({
          ok: false,
          reason: "internal_error",
          executionSemantics: "unknown",
          retrySafe: false,
          message:
            "The dispatch outcome could not be confirmed. Check Chat and scheduler history; do not retry automatically.",
        });
      }
      if (!result.ok) {
        if (result.reason === "oneTimeCompleted") {
          return buildJsonTextResult({
            ...result,
            retrySafe: false,
            message: messages.oneTimeTaskCompleted(task.name),
          });
        }
        if (result.reason === "saveFailed") {
          return buildJsonTextResult({
            ...result,
            executionSemantics: "prompt_dispatched",
            retrySafe: false,
            message:
              "The prompt was dispatched, but lastRun/nextRun could not be saved. Do not retry automatically; check Chat and scheduler history.",
          });
        }
        return buildJsonTextResult(result);
      }
      const latestTask = scheduleManager.getTask(id);
      return buildJsonTextResult({
        ok: true,
        action: "run",
        executionSemantics: "prompt_dispatched",
        enabledStateChanged: latestTask
          ? latestTask.enabled !== wasEnabled
          : wasEnabled,
        taskDeleted: !latestTask,
        promptTextOmitted: true,
        task: latestTask
          ? toTaskSummary(latestTask)
          : {
              id: task.id,
              name: task.name,
              runAt: task.runAt,
              afterRun: task.afterRun,
            },
      });
    },
  };
}
