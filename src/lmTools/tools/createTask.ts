import * as vscode from "vscode";

import type { LmToolMutationClient } from "../../taskMutationService";
import type { CreateTaskInput, TaskAttachment } from "../../types";
import {
  assertWriteToolGates,
  buildJsonTextResult,
  describeAttachmentsForConfirmation,
  escapeConfirmationText,
  formatConfirmationCode,
  formatMutationFailure,
  shouldUseCustomConfirmation,
  toTaskSummary,
} from "../shared";

interface CreateTaskToolInput {
  name?: string;
  cronExpression?: string;
  runAt?: string;
  afterRun?: "disable" | "delete";
  prompt?: string;
  scope?: string;
  promptSource?: string;
  promptPath?: string;
  agent?: string;
  model?: string;
  modelReasoningEffort?: string;
  enabled?: boolean;
  chatSession?: string;
  autoMode?: boolean;
  jitterSeconds?: number;
  maxExecutionsPerDay?: number;
  allowedTimeStart?: string;
  allowedTimeEnd?: string;
  attachments?: TaskAttachment[];
}

function toCreateInput(input: CreateTaskToolInput): CreateTaskInput {
  return {
    name: input.name ?? "",
    cronExpression: input.cronExpression ?? "",
    runAt: input.runAt,
    afterRun: input.afterRun,
    prompt: input.prompt ?? "",
    scope: input.scope as CreateTaskInput["scope"],
    promptSource:
      (input.promptSource as CreateTaskInput["promptSource"]) ?? "inline",
    promptPath: input.promptPath,
    agent: input.agent,
    model: input.model,
    modelReasoningEffort: input.modelReasoningEffort,
    enabled: input.enabled ?? true,
    chatSession: input.chatSession as CreateTaskInput["chatSession"],
    autoMode: input.autoMode,
    jitterSeconds: input.jitterSeconds,
    maxExecutionsPerDay: input.maxExecutionsPerDay,
    allowedTimeStart: input.allowedTimeStart,
    allowedTimeEnd: input.allowedTimeEnd,
    attachments: input.attachments,
  };
}

export function createSchedulerCreateTaskTool(
  client: LmToolMutationClient,
): vscode.LanguageModelTool<CreateTaskToolInput> {
  return {
    async prepareInvocation(
      options: vscode.LanguageModelToolInvocationPrepareOptions<CreateTaskToolInput>,
    ): Promise<vscode.PreparedToolInvocation> {
      const input = options.input ?? {};
      const detail = [
        `**${escapeConfirmationText(input.name || "(unnamed)")}**`,
        input.runAt
          ? `- runAt: ${formatConfirmationCode(input.runAt)}; afterRun: ${formatConfirmationCode(input.afterRun ?? "disable")}`
          : `- cron: ${formatConfirmationCode(input.cronExpression || "(missing)")}`,
        `- scope: ${escapeConfirmationText(input.scope || "(missing)")}`,
        `- promptSource: ${escapeConfirmationText(input.promptSource || "inline")}`,
        input.promptPath
          ? `- promptPath: ${formatConfirmationCode(input.promptPath)}`
          : undefined,
        input.agent
          ? `- agent: ${escapeConfirmationText(input.agent)}`
          : undefined,
        input.model
          ? `- model: ${escapeConfirmationText(input.model)}`
          : undefined,
        describeAttachmentsForConfirmation(input.attachments),
        input.enabled === false
          ? "- initial state: disabled"
          : "- initial state: enabled",
      ]
        .filter(Boolean)
        .join("\n");
      const prepared: vscode.PreparedToolInvocation = {
        invocationMessage: `Creating scheduler task: ${input.name || "(unnamed)"}`,
      };
      if (shouldUseCustomConfirmation("create")) {
        prepared.confirmationMessages = {
          title: "Create scheduler task",
          message: new vscode.MarkdownString(
            `Copilot Chat wants to create a new scheduled task:\n\n${detail}`,
          ),
        };
      }
      return prepared;
    },
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<CreateTaskToolInput>,
      token: vscode.CancellationToken,
    ) {
      const gate = assertWriteToolGates(token);
      if (gate) {
        return gate;
      }
      const input = options.input ?? {};
      if (
        !input.name ||
        (!input.cronExpression && !input.runAt) ||
        !input.prompt ||
        !input.scope
      ) {
        return buildJsonTextResult({
          ok: false,
          reason: "validation",
          message:
            "Missing required fields: name, cronExpression or runAt, prompt, scope.",
        });
      }
      const result = await client.createTask(toCreateInput(input));
      if (!result.ok) {
        return formatMutationFailure(result);
      }
      const payload: {
        ok: true;
        action: "create";
        promptTextOmitted: true;
        task: Record<string, unknown>;
        warning?: string;
        warnings?: string[];
      } = {
        ok: true,
        action: "create",
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
