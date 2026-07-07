import * as vscode from "vscode";

import type { LmToolMutationClient } from "../../taskMutationService";
import type { CreateTaskInput, ScheduledTask } from "../../types";
import {
  assertWriteToolGates,
  buildJsonTextResult,
  formatMutationFailure,
  shouldUseCustomConfirmation,
} from "../shared";

interface UpdateTaskToolInput {
  id?: string;
  updates?: Partial<CreateTaskInput> & { enabled?: unknown };
}

export function createSchedulerUpdateTaskTool(
  client: LmToolMutationClient,
): vscode.LanguageModelTool<UpdateTaskToolInput> {
  return {
    async prepareInvocation(
      options: vscode.LanguageModelToolInvocationPrepareOptions<UpdateTaskToolInput>,
    ): Promise<vscode.PreparedToolInvocation> {
      const input = options.input ?? {};
      const updateKeys = input.updates ? Object.keys(input.updates) : [];
      const prepared: vscode.PreparedToolInvocation = {
        invocationMessage: `Updating scheduler task: ${input.id ?? "(missing id)"}`,
      };
      if (shouldUseCustomConfirmation("update")) {
        prepared.confirmationMessages = {
          title: "Update scheduler task",
          message: new vscode.MarkdownString(
            `Copilot Chat wants to update task \`${input.id ?? "(missing)"}\`.\n\nFields to change: ${
              updateKeys.length
                ? updateKeys.map((k) => `\`${k}\``).join(", ")
                : "(none)"
            }`,
          ),
        };
      }
      return prepared;
    },
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<UpdateTaskToolInput>,
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
      if (!input.updates || typeof input.updates !== "object") {
        return buildJsonTextResult({
          ok: false,
          reason: "validation",
          message: "Missing required field: updates (object).",
        });
      }
      const result = await client.updateTask(input.id, input.updates);
      if (!result.ok) {
        return formatMutationFailure(result);
      }
      const payload: {
        ok: true;
        action: "update";
        task: ScheduledTask;
        warning?: string;
      } = {
        ok: true,
        action: "update",
        task: result.task,
      };
      if (result.warning) {
        payload.warning = result.warning;
      }
      return buildJsonTextResult(payload);
    },
  };
}
