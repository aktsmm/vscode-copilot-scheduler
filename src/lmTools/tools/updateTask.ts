import * as vscode from "vscode";

import type { LmToolMutationClient } from "../../taskMutationService";
import type { CreateTaskInput } from "../../types";
import {
  assertWriteToolGates,
  buildJsonTextResult,
  formatMutationFailure,
  shouldUseCustomConfirmation,
  toTaskSummary,
} from "../shared";

interface UpdateTaskToolInput {
  id?: string;
  updates?: Partial<CreateTaskInput> & { enabled?: unknown };
}

/**
 * `enabled` is recognized but not schema-exposed: letting it through keeps the
 * dedicated `enabled_not_allowed` error from taskMutationService.
 */
const RECOGNIZED_UPDATE_KEYS: ReadonlySet<string> = new Set([
  "name",
  "cronExpression",
  "prompt",
  "promptSource",
  "promptPath",
  "agent",
  "model",
  "modelReasoningEffort",
  "scope",
  "chatSession",
  "autoMode",
  "jitterSeconds",
  "maxExecutionsPerDay",
  "allowedTimeStart",
  "allowedTimeEnd",
  "attachments",
  "enabled",
]);

function findUnexpectedUpdateKeys(updates: object): string[] {
  return Object.keys(updates).filter((key) => !RECOGNIZED_UPDATE_KEYS.has(key));
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
      const unexpected = findUnexpectedUpdateKeys(input.updates);
      if (unexpected.length > 0) {
        return buildJsonTextResult({
          ok: false,
          reason: "validation",
          message: `Fields not allowed in 'updates': ${unexpected.join(", ")}. Remove them and retry.`,
        });
      }
      const result = await client.updateTask(input.id, input.updates);
      if (!result.ok) {
        return formatMutationFailure(result);
      }
      const payload: {
        ok: true;
        action: "update";
        promptTextOmitted: true;
        task: Record<string, unknown>;
        warning?: string;
        warnings?: string[];
      } = {
        ok: true,
        action: "update",
        promptTextOmitted: true,
        task: toTaskSummary(result.task),
      };
      if (result.warning) {
        payload.warning = result.warning;
      }
      if (result.warnings && result.warnings.length > 0) {
        payload.warnings = result.warnings;
      }
      return buildJsonTextResult(payload);
    },
  };
}
