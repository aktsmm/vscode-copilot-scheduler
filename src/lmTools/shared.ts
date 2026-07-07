import * as vscode from "vscode";

import type {
  MutationDeleteResult,
  MutationResult,
} from "../taskMutationService";
import type { ScheduledTask } from "../types";

const ENABLE_WRITE_TOOLS_CONFIG_KEY = "lmTools.enableWriteTools";

export function isWriteToolsEnabled(): boolean {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  return config.get<boolean>(ENABLE_WRITE_TOOLS_CONFIG_KEY, true);
}

export function writeGateBlockedResult(): vscode.LanguageModelToolResult {
  const message = [
    "Write scheduler tools are disabled in this workspace.",
    "Enable `copilotScheduler.lmTools.enableWriteTools` in settings and retry, or ask the user to change the task via the Copilot Scheduler view.",
  ].join(" ");
  return buildTextResult(message);
}

export function trustGateBlockedResult(): vscode.LanguageModelToolResult {
  return buildTextResult(
    "This workspace is not trusted, so scheduler write tools are disabled. Ask the user to trust the workspace or edit tasks through the Copilot Scheduler view.",
  );
}

export function assertWriteToolGates():
  | vscode.LanguageModelToolResult
  | undefined {
  if (!isWriteToolsEnabled()) {
    return writeGateBlockedResult();
  }
  if (!vscode.workspace.isTrusted) {
    return trustGateBlockedResult();
  }
  return undefined;
}

export function buildTextResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(text),
  ]);
}

export function buildJsonTextResult(
  payload: unknown,
): vscode.LanguageModelToolResult {
  return buildTextResult(JSON.stringify(payload, null, 2));
}

export function formatTaskSummary(task: ScheduledTask): string {
  const workspace = task.workspacePath ?? "(none)";
  const enabled = task.enabled ? "enabled" : "disabled";
  const nextRun =
    task.nextRun instanceof Date
      ? task.nextRun.toISOString()
      : typeof task.nextRun === "string"
        ? task.nextRun
        : undefined;
  return [
    `- id: ${task.id}`,
    `  name: ${task.name}`,
    `  scope: ${task.scope}`,
    `  workspace: ${workspace}`,
    `  cron: ${task.cronExpression}`,
    `  status: ${enabled}`,
    nextRun ? `  nextRun: ${nextRun}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function formatMutationSuccess(
  action: "create" | "update" | "enable" | "disable",
  result: Extract<MutationResult, { ok: true }>,
): vscode.LanguageModelToolResult {
  const payload = {
    ok: true,
    action,
    task: result.task,
    warning: result.warning,
  };
  return buildJsonTextResult(payload);
}

export function formatMutationFailure(
  result: Extract<MutationResult | MutationDeleteResult, { ok: false }>,
): vscode.LanguageModelToolResult {
  const payload = {
    ok: false,
    reason: result.reason,
    message: result.message,
  };
  return buildJsonTextResult(payload);
}

/**
 * Return true if the given cron expression parses through the ScheduleManager.
 * Callers should invoke this before optimistic UI text so a bad expression is
 * surfaced with a helpful message rather than a generic 500-style error.
 */
export function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
