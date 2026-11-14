import * as vscode from "vscode";

import { messages } from "../../i18n";
import type { ScheduleManager } from "../../scheduleManager";
import type {
  AgentHostResponseTextObservation,
  AgentHostTurnOutcome,
  ScheduledTask,
} from "../../types";
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
  | {
      ok: true;
      turnOutcome?: "completed";
      responseText?: AgentHostResponseTextObservation;
    }
  | {
      ok: false;
      reason:
        | "taskNotFound"
        | "executorUnavailable"
        | "alreadyRunning"
        | "taskChanged"
        | "oneTimeCompleted"
        | "claimFailed"
        | "promptBlocked"
        | "executionFailed"
        | "saveFailed"
        | "workspaceMismatch";
      message?: string;
      turnOutcome?: AgentHostTurnOutcome;
      responseText?: AgentHostResponseTextObservation;
    };

export type ManualTaskRunner = (
  task: ScheduledTask,
  confirmedSnapshot?: string,
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
      let task: ScheduledTask | undefined;
      try {
        task = await scheduleManager.getTaskForRun(id);
      } catch {
        return buildJsonTextResult({
          ok: false,
          reason: "claimFailed",
          executionSemantics: "not_dispatched",
          retrySafe: false,
          message: messages.manualRunClaimFailed(),
        });
      }
      const gateAfterRefresh = assertWriteToolGates(token);
      if (gateAfterRefresh) return gateAfterRefresh;
      if (!task) {
        return buildJsonTextResult({
          ok: false,
          reason: "not_found",
          message: `Task not found: ${id}`,
        });
      }
      const wasEnabled = task.enabled;
      const wasOneTime = !!task.runAt;
      const confirmedSnapshot = JSON.stringify(task);

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

      if (shouldUseCustomConfirmation("run")) {
        const action = messages.actionRun();
        const choice = await vscode.window.showWarningMessage(
          messages.lmToolRunConfirmation(
            task.name,
            task.runAt ? (task.afterRun ?? "disable") : undefined,
          ),
          { modal: true },
          action,
        );
        if (choice !== action) {
          return buildJsonTextResult({ ok: false, reason: "cancelled" });
        }
        const gateAfterConfirmation = assertWriteToolGates(token);
        if (gateAfterConfirmation) return gateAfterConfirmation;
        let taskAfterConfirmation: ScheduledTask | undefined;
        try {
          taskAfterConfirmation = await scheduleManager.getTaskForRun(id);
        } catch {
          return buildJsonTextResult({
            ok: false,
            reason: "claimFailed",
            executionSemantics: "not_dispatched",
            retrySafe: false,
            message: messages.manualRunClaimFailed(),
          });
        }
        const gateAfterRefresh = assertWriteToolGates(token);
        if (gateAfterRefresh) return gateAfterRefresh;
        if (JSON.stringify(taskAfterConfirmation) !== confirmedSnapshot) {
          return buildJsonTextResult({
            ok: false,
            reason: "taskChanged",
            executionSemantics: "not_dispatched",
            retrySafe: false,
            message: messages.taskStoreChangedExternally(),
          });
        }
      }

      let result: ManualTaskRunResult;
      try {
        result = await runTask(task, confirmedSnapshot);
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
        if (result.reason === "taskChanged") {
          return buildJsonTextResult({
            ...result,
            executionSemantics: "not_dispatched",
            retrySafe: false,
            message: result.message ?? messages.taskStoreChangedExternally(),
          });
        }
        if (result.reason === "claimFailed") {
          return buildJsonTextResult({
            ...result,
            executionSemantics: "not_dispatched",
            retrySafe: false,
            message: messages.manualRunClaimFailed(),
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
        if (result.turnOutcome) {
          return buildJsonTextResult({
            ...result,
            executionSemantics:
              result.turnOutcome === "unknown" ? "unknown" : "prompt_dispatched",
            retrySafe: false,
            message:
              "The Agent Host turn failed, was cancelled, or could not be confirmed. Check Chat and scheduler history; do not retry automatically.",
          });
        }
        if (result.reason === "oneTimeCompleted") {
          return buildJsonTextResult({
            ...result,
            retrySafe: false,
            message: messages.oneTimeTaskCompleted(task.name),
          });
        }
        if (wasOneTime) {
          return buildJsonTextResult({
            ...result,
            executionSemantics: "unknown",
            retrySafe: false,
            message:
              "The one-time task was reserved but the run failed. Check Chat and scheduler history before rescheduling; do not retry automatically.",
          });
        }
        return buildJsonTextResult(result);
      }
      const latestTask = scheduleManager.getTask(id);
      return buildJsonTextResult({
        ok: true,
        action: "run",
        executionSemantics: "prompt_dispatched",
        ...(result.turnOutcome ? { turnOutcome: result.turnOutcome } : {}),
        ...(result.responseText ? { responseText: result.responseText } : {}),
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
