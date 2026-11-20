import * as vscode from "vscode";

import type { LmToolMutationClient } from "../../taskMutationService";
import type { CreateTaskInput } from "../../types";
import {
  assertWriteToolGates,
  buildJsonTextResult,
  describeAgentHostFieldsForConfirmation,
  describeAttachmentsForConfirmation,
  describeOverlappingRunsForConfirmation,
  describeTaskTimeoutForConfirmation,
  formatConfirmationCode,
  formatMutationFailure,
  shouldUseCustomConfirmation,
  toTaskSummary,
  validateAgentHostToolFields,
  validateOverlappingRuns,
  validateTaskTimeoutField,
} from "../shared";

interface UpdateTaskToolInput {
  id?: string;
  updates?: Partial<CreateTaskInput> & { enabled?: unknown };
}

/**
 * `enabled` is recognized but not schema-exposed: letting it through keeps the
 * dedicated `enabled_not_allowed` error from taskMutationService.
 */
export const RECOGNIZED_UPDATE_KEYS: ReadonlySet<string> = new Set([
  "name",
  "cronExpression",
  "runAt",
  "afterRun",
  "prompt",
  "promptSource",
  "promptPath",
  "agent",
  "model",
  "modelVendor",
  "agentHostModelId",
  "modelReasoningEffort",
  "modelConfiguration",
  "scope",
  "chatSession",
  "agentHostWorkspaceMode",
  "targetChatId",
  "autoMode",
  "modelFallback",
  "preventAgentHostFallback",
  "timeout",
  "jitterSeconds",
  "maxExecutionsPerDay",
  "allowOverlappingRuns",
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
      const agentHostDetails = describeAgentHostFieldsForConfirmation(
        input.updates ?? {},
      );
      const attachmentDetail = Object.prototype.hasOwnProperty.call(
        input.updates ?? {},
        "attachments",
      )
        ? (describeAttachmentsForConfirmation(input.updates?.attachments) ??
          "- attachments: all attachments will be removed")
        : undefined;
      const prepared: vscode.PreparedToolInvocation = {
        invocationMessage: `Updating scheduler task: ${input.id ?? "(missing id)"}`,
      };
      if (shouldUseCustomConfirmation("update")) {
        prepared.confirmationMessages = {
          title: "Update scheduler task",
          message: new vscode.MarkdownString(
            [
              `Copilot Chat wants to update task ${formatConfirmationCode(input.id ?? "(missing)")}.\n\nFields to change: ${
                updateKeys.length
                  ? updateKeys
                      .map((key) => formatConfirmationCode(key))
                      .join(", ")
                  : "(none)"
              }`,
              agentHostDetails.length
                ? `\n\n${agentHostDetails.join("\n")}`
                : "",
              attachmentDetail
                ? `\n\nThe attachment list is replaced by:\n${attachmentDetail}`
                : "",
              updateKeys.includes("allowOverlappingRuns")
                ? `\n\n${describeOverlappingRunsForConfirmation(input.updates?.allowOverlappingRuns)}`
                : "",
              updateKeys.includes("timeout")
                ? `\n\n${describeTaskTimeoutForConfirmation(input.updates?.timeout)}`
                : "",
              updateKeys.includes("targetChatId")
                ? "\n\nThe task's prompts will be queued into the selected existing Copilot chat (an empty value unbinds it)."
                : "",
            ].join(""),
          ),
        };
      }
      return prepared;
    },
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<UpdateTaskToolInput>,
      token: vscode.CancellationToken,
    ) {
      const gate = assertWriteToolGates(token);
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
      if (
        !input.updates ||
        typeof input.updates !== "object" ||
        Array.isArray(input.updates)
      ) {
        return buildJsonTextResult({
          ok: false,
          reason: "validation",
          message: "Field 'updates' must be an object (not null or an array).",
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
      const fieldError = validateAgentHostToolFields(input.updates);
      if (fieldError) {
        return fieldError;
      }
      const overlapError = validateOverlappingRuns(input.updates.allowOverlappingRuns);
      if (overlapError) {
        return overlapError;
      }
      const timeoutError = validateTaskTimeoutField(input.updates.timeout);
      if (timeoutError) {
        return timeoutError;
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
