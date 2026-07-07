import * as vscode from "vscode";

import type { LmToolMutationClient } from "../../taskMutationService";
import type { ScheduledTask } from "../../types";
import {
  assertWriteToolGates,
  buildJsonTextResult,
  formatMutationFailure,
} from "../shared";

interface SetEnabledToolInput {
  id?: string;
  enabled?: boolean;
}

export function createSchedulerSetTaskEnabledTool(
  client: LmToolMutationClient,
): vscode.LanguageModelTool<SetEnabledToolInput> {
  return {
    async prepareInvocation(
      options: vscode.LanguageModelToolInvocationPrepareOptions<SetEnabledToolInput>,
    ): Promise<vscode.PreparedToolInvocation> {
      const input = options.input ?? {};
      const verb = input.enabled === false ? "disable" : "enable";
      return {
        invocationMessage: `${verb === "enable" ? "Enabling" : "Disabling"} scheduler task: ${input.id ?? "(missing id)"}`,
        confirmationMessages: {
          title: `${verb === "enable" ? "Enable" : "Disable"} scheduler task`,
          message: new vscode.MarkdownString(
            `Copilot Chat wants to **${verb}** task \`${input.id ?? "(missing)"}\`.`,
          ),
        },
      };
    },
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<SetEnabledToolInput>,
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
      if (typeof input.enabled !== "boolean") {
        return buildJsonTextResult({
          ok: false,
          reason: "validation",
          message: "Missing required field: enabled (boolean).",
        });
      }
      const result = await client.setTaskEnabled(input.id, input.enabled);
      if (!result.ok) {
        return formatMutationFailure(result);
      }
      const payload: {
        ok: true;
        action: "enable" | "disable";
        task: ScheduledTask;
      } = {
        ok: true,
        action: input.enabled ? "enable" : "disable",
        task: result.task,
      };
      return buildJsonTextResult(payload);
    },
  };
}
