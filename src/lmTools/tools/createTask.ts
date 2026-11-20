import * as vscode from "vscode";

import type { LmToolMutationClient } from "../../taskMutationService";
import type {
  CreateTaskInput,
  TaskAttachment,
  ModelConfiguration,
} from "../../types";
import {
  assertWriteToolGates,
  buildJsonTextResult,
  describeAgentHostFieldsForConfirmation,
  describeAttachmentsForConfirmation,
  describeOverlappingRunsForConfirmation,
  describeTaskTimeoutForConfirmation,
  escapeConfirmationText,
  formatConfirmationCode,
  formatMutationFailure,
  shouldUseCustomConfirmation,
  toTaskSummary,
  validateAgentHostToolFields,
  validateOverlappingRuns,
  validateTaskTimeoutField,
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
  modelVendor?: string;
  agentHostModelId?: string;
  modelReasoningEffort?: string;
  modelConfiguration?: ModelConfiguration;
  enabled?: boolean;
  chatSession?: string;
  agentHostWorkspaceMode?: CreateTaskInput["agentHostWorkspaceMode"];
  targetChatId?: string;
  autoMode?: boolean;
  modelFallback?: boolean;
  preventAgentHostFallback?: boolean;
  timeout?: CreateTaskInput["timeout"];
  jitterSeconds?: number;
  maxExecutionsPerDay?: number;
  allowOverlappingRuns?: boolean;
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
    modelVendor: input.modelVendor,
    agentHostModelId: input.agentHostModelId,
    modelReasoningEffort: input.modelReasoningEffort,
    modelConfiguration:
      input.modelConfiguration ?? (input.modelReasoningEffort ? undefined : {}),
    enabled: input.enabled ?? true,
    chatSession: input.chatSession as CreateTaskInput["chatSession"],
    ...(input.agentHostWorkspaceMode !== undefined &&
    input.agentHostWorkspaceMode !== "default"
      ? { agentHostWorkspaceMode: input.agentHostWorkspaceMode }
      : {}),
    targetChatId: input.targetChatId,
    autoMode: input.autoMode,
    modelFallback: input.modelFallback,
    preventAgentHostFallback: input.preventAgentHostFallback,
    timeout: input.timeout,
    jitterSeconds: input.jitterSeconds,
    maxExecutionsPerDay: input.maxExecutionsPerDay,
    allowOverlappingRuns: input.allowOverlappingRuns,
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
        input.modelVendor
          ? `- modelVendor: ${escapeConfirmationText(input.modelVendor)}`
          : undefined,
        ...describeAgentHostFieldsForConfirmation(input, true),
        describeAttachmentsForConfirmation(input.attachments),
        describeOverlappingRunsForConfirmation(input.allowOverlappingRuns),
        describeTaskTimeoutForConfirmation(input.timeout),
        input.targetChatId
          ? `- existing chat: ${formatConfirmationCode(String(input.targetChatId).slice(0, 12))}… (prompts are queued into that chat)`
          : undefined,
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
      const fieldError = validateAgentHostToolFields(input);
      if (fieldError) {
        return fieldError;
      }
      const overlapError = validateOverlappingRuns(input.allowOverlappingRuns);
      if (overlapError) {
        return overlapError;
      }
      const timeoutError = validateTaskTimeoutField(input.timeout);
      if (timeoutError) {
        return timeoutError;
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
