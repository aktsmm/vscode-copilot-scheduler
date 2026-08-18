import * as vscode from "vscode";

import type {
  MutationDeleteResult,
  MutationResult,
} from "../taskMutationService";
import type { ScheduledTask, TaskAttachment } from "../types";

const ENABLE_WRITE_TOOLS_CONFIG_KEY = "lmTools.enableWriteTools";
const CONFIRMATION_MODE_CONFIG_KEY = "lmTools.confirmationMode";

export type LmToolsConfirmationMode = "always" | "destructiveOnly" | "minimal";

export type ConfirmableLmToolAction =
  | "create"
  | "update"
  | "delete"
  | "setEnabled";

export function isWriteToolsEnabled(): boolean {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  return config.get<boolean>(ENABLE_WRITE_TOOLS_CONFIG_KEY, true);
}

export function getLmToolsConfirmationMode(): LmToolsConfirmationMode {
  const config = vscode.workspace.getConfiguration("copilotScheduler");
  const value = config.get<unknown>(
    CONFIRMATION_MODE_CONFIG_KEY,
    "destructiveOnly",
  );
  switch (value) {
    case "always":
    case "destructiveOnly":
    case "minimal":
      return value;
    default:
      return "destructiveOnly";
  }
}

export function shouldUseCustomConfirmation(
  action: ConfirmableLmToolAction,
): boolean {
  const mode = getLmToolsConfirmationMode();
  switch (mode) {
    case "always":
      return true;
    case "destructiveOnly":
      return action === "delete";
    case "minimal":
      return false;
  }
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

/**
 * Attachment contents are sent to the model on every later unattended run, so
 * the confirmation has to name the files, not just how many there are.
 */
export function describeAttachmentsForConfirmation(
  attachments: TaskAttachment[] | undefined,
): string | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return undefined;
  }
  const lines = attachments.map((item) => {
    const source = item?.source === "global" ? "global" : "local";
    const raw = typeof item?.path === "string" ? item.path : "";
    const safe = raw.replace(/[`\r\n]/g, "");
    return `  - ${source}: \`${safe || "(missing path)"}\``;
  });
  return [`- attachments (${attachments.length}):`, ...lines].join("\n");
}

export function buildJsonTextResult(
  payload: unknown,
): vscode.LanguageModelToolResult {
  return buildTextResult(JSON.stringify(payload, null, 2));
}

const PROMPT_PREVIEW_MAX_CHARS = 160;

/**
 * Strip the prompt body from a task before it reaches the model: a `local` or
 * `global` task stores a snapshot of the whole prompt file. The preview uses
 * its own key so a truncated body can never be written back through an update.
 */
export function toTaskSummary(task: ScheduledTask): Record<string, unknown> {
  const { prompt, ...rest } = task;
  const text = typeof prompt === "string" ? prompt : "";
  const collapsed = text.trim().replace(/\s+/gu, " ");
  return {
    ...rest,
    promptLength: text.length,
    promptPreview:
      collapsed.length > PROMPT_PREVIEW_MAX_CHARS
        ? `${collapsed.slice(0, PROMPT_PREVIEW_MAX_CHARS - 1)}…`
        : collapsed,
  };
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
