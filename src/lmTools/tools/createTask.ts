import * as vscode from "vscode";

import type { LmToolMutationClient } from "../../taskMutationService";
import type { CreateTaskInput, ScheduledTask } from "../../types";
import {
  assertWriteToolGates,
  buildJsonTextResult,
  formatMutationFailure,
} from "../shared";

interface CreateTaskToolInput {
  name?: string;
  cronExpression?: string;
  prompt?: string;
  scope?: string;
  promptSource?: string;
  promptPath?: string;
  agent?: string;
  enabled?: boolean;
  chatSession?: string;
}

function toCreateInput(input: CreateTaskToolInput): CreateTaskInput {
  return {
    name: input.name ?? "",
    cronExpression: input.cronExpression ?? "",
    prompt: input.prompt ?? "",
    scope: input.scope as CreateTaskInput["scope"],
    promptSource:
      (input.promptSource as CreateTaskInput["promptSource"]) ?? "inline",
    promptPath: input.promptPath,
    agent: input.agent,
    enabled: input.enabled ?? true,
    chatSession: input.chatSession as CreateTaskInput["chatSession"],
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
        `**${input.name || "(unnamed)"}**`,
        `- cron: \`${input.cronExpression || "(missing)"}\``,
        `- scope: ${input.scope || "(missing)"}`,
        `- promptSource: ${input.promptSource || "inline"}`,
        input.promptPath ? `- promptPath: \`${input.promptPath}\`` : undefined,
        input.enabled === false
          ? "- initial state: disabled"
          : "- initial state: enabled",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        invocationMessage: `Creating scheduler task: ${input.name || "(unnamed)"}`,
        confirmationMessages: {
          title: "Create scheduler task",
          message: new vscode.MarkdownString(
            `Copilot Chat wants to create a new scheduled task:\n\n${detail}`,
          ),
        },
      };
    },
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<CreateTaskToolInput>,
    ) {
      const gate = assertWriteToolGates();
      if (gate) {
        return gate;
      }
      const input = options.input ?? {};
      if (
        !input.name ||
        !input.cronExpression ||
        !input.prompt ||
        !input.scope
      ) {
        return buildJsonTextResult({
          ok: false,
          reason: "validation",
          message:
            "Missing required fields: name, cronExpression, prompt, scope.",
        });
      }
      const result = await client.createTask(toCreateInput(input));
      if (!result.ok) {
        return formatMutationFailure(result);
      }
      const payload: {
        ok: true;
        action: "create";
        task: ScheduledTask;
        warning?: string;
      } = {
        ok: true,
        action: "create",
        task: result.task,
      };
      if (result.warning) {
        payload.warning = result.warning;
      }
      return buildJsonTextResult(payload);
    },
  };
}
