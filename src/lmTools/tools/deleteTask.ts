import * as vscode from "vscode";

import type { ScheduleManager } from "../../scheduleManager";
import type { LmToolMutationClient } from "../../taskMutationService";
import {
  assertWriteToolGates,
  buildJsonTextResult,
  formatMutationFailure,
} from "../shared";

interface DeleteTaskToolInput {
  id?: string;
}

export function createSchedulerDeleteTaskTool(
  scheduleManager: ScheduleManager,
  client: LmToolMutationClient,
): vscode.LanguageModelTool<DeleteTaskToolInput> {
  return {
    async prepareInvocation(
      options: vscode.LanguageModelToolInvocationPrepareOptions<DeleteTaskToolInput>,
    ): Promise<vscode.PreparedToolInvocation> {
      const input = options.input ?? {};
      const id = typeof input.id === "string" ? input.id : "(missing id)";
      const task =
        typeof input.id === "string"
          ? scheduleManager.getTask(input.id)
          : undefined;
      const detail = task
        ? [
            `**${task.name}**`,
            `- id: \`${task.id}\``,
            `- scope: ${task.scope}`,
            `- workspace: ${task.workspacePath ?? "(none)"}`,
            `- cron: \`${task.cronExpression}\``,
          ].join("\n")
        : `- id: \`${id}\` (task not found; it may have been deleted already)`;
      return {
        invocationMessage: `Deleting scheduler task: ${task?.name ?? id}`,
        confirmationMessages: {
          title: "⚠️ Delete scheduler task",
          message: new vscode.MarkdownString(
            `Copilot Chat wants to **permanently delete** a scheduler task. This cannot be undone.\n\n${detail}`,
          ),
        },
      };
    },
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<DeleteTaskToolInput>,
    ) {
      const gate = assertWriteToolGates();
      if (gate) {
        return gate;
      }
      const input = options.input ?? {};
      if (!input.id || typeof input.id !== "string") {
        return buildJsonTextResult({
          ok: false,
          reason: "validation",
          message: "Missing required field: id.",
        });
      }
      const result = await client.deleteTaskConfirmed(input.id);
      if (!result.ok) {
        return formatMutationFailure(result);
      }
      return buildJsonTextResult({
        ok: true,
        action: "delete",
        deletedId: result.deletedId,
      });
    },
  };
}
