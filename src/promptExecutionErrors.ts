/**
 * Shared marker for "prompt file could not be used" execution blocks.
 *
 * Defined in its own module so that `extension.ts` (which throws) and
 * `scheduleManager.ts` (which classifies manual-run failures) cannot drift apart.
 */

export const PROMPT_BLOCKED_EXECUTION_ERROR_FLAG =
  "copilotSchedulerPromptBlocked";

export type PromptBlockedReason =
  | "noPromptPath"
  | "pathUnresolved"
  | "readFailed"
  | "attachmentMissing"
  | "attachmentsRequireChatOpen";

export function createPromptBlockedError(
  message: string,
  reason: PromptBlockedReason,
): Error {
  const error = new Error(message);
  try {
    (error as unknown as Record<string, unknown>)[
      PROMPT_BLOCKED_EXECUTION_ERROR_FLAG
    ] = reason;
  } catch {
    // best-effort marker only
  }
  return error;
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
