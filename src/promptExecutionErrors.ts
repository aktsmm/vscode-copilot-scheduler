/**
 * Shared marker for "prompt file could not be used" execution blocks.
 *
 * Defined in its own module so that `extension.ts` (which throws) and
 * `scheduleManager.ts` (which classifies manual-run failures) cannot drift apart.
 */

import type { AgentHostTurnOutcome } from "./types";

export const PROMPT_BLOCKED_EXECUTION_ERROR_FLAG =
  "copilotSchedulerPromptBlocked";

export type PromptBlockedReason =
  | "noPromptPath"
  | "pathUnresolved"
  | "readFailed"
  | "attachmentMissing"
  | "providerModelUnavailable"
  | "providerModelDispatchFailed"
  | "modelConfigurationUnavailable"
  | "attachmentsRequireChatOpen"
  | "sessionHarnessUnavailable"
  | "skillUnavailable"
  | "copilotCliUnavailable"
  | "copilotCliFailed"
  | "agentHostUnavailable"
  | "taskClaimChanged"
  | "agentHostFailed";

export function createPromptBlockedError(
  message: string,
  reason: PromptBlockedReason,
  agentHostTurnOutcome?: Exclude<AgentHostTurnOutcome, "completed">,
): Error {
  return Object.assign(new Error(message), {
    [PROMPT_BLOCKED_EXECUTION_ERROR_FLAG]: reason,
    ...(agentHostTurnOutcome ? { agentHostTurnOutcome } : {}),
  });
}

export function isPromptBlockedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (
    typeof (error as Record<string, unknown>)[
      PROMPT_BLOCKED_EXECUTION_ERROR_FLAG
    ] === "string"
  );
}

export function getPromptBlockedReason(
  error: unknown,
): PromptBlockedReason | undefined {
  if (!isPromptBlockedError(error)) {
    return undefined;
  }
  return (error as Record<string, unknown>)[
    PROMPT_BLOCKED_EXECUTION_ERROR_FLAG
  ] as PromptBlockedReason;
}

/**
 * The Host only reports this after the turn has started, because the size of the
 * tool definitions depends on the session's enabled tools and MCP servers.
 */
export function isAgentHostContextBudgetFailure(detail: string): boolean {
  return /system messages and tool definitions exceed .{0,40}context budget/i.test(
    detail,
  );
}

export function getAgentHostTurnFailure(
  error: unknown,
): Exclude<AgentHostTurnOutcome, "completed" | "queued"> | undefined {
  if (getPromptBlockedReason(error) !== "agentHostFailed") {
    return undefined;
  }
  const outcome = (error as Record<string, unknown>).agentHostTurnOutcome;
  return outcome === "failed" || outcome === "cancelled" || outcome === "unknown"
    ? outcome
    : undefined;
}
