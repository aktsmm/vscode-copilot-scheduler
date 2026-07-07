import type { ScheduleManager } from "./scheduleManager";
import type { CreateTaskInput, ScheduledTask } from "./types";

/**
 * Reasons a mutation can fail via the LM Tool path.
 * Chat / agent must be able to translate each of these into a helpful hint for
 * the user without pulling in extension-internal UI code.
 */
export type MutationFailureReason =
  | "workspace_mismatch"
  | "disclaimer_not_accepted"
  | "validation"
  | "not_found"
  | "already_running"
  | "enabled_not_allowed"
  | "internal_error";

/**
 * Represents state after a mutation failed mid-way. Reserved for future
 * compensating flows (e.g. create → disclaimer decline → auto delete).
 */
export type MutationRolledBackState =
  | "createdThenDeleted"
  | "createdThenDisabled"
  | "enabledThenDisabled"
  | "createdRollbackFailed";

export type MutationResult<T = ScheduledTask> =
  | { ok: true; task: T; warning?: string }
  | {
      ok: false;
      reason: MutationFailureReason;
      message: string;
      state?: MutationRolledBackState;
    };

export type MutationDeleteResult =
  | { ok: true; deletedId: string }
  | { ok: false; reason: MutationFailureReason; message: string };

export interface LmToolMutationClient {
  createTask(input: CreateTaskInput): Promise<MutationResult>;
  updateTask(
    id: string,
    updates: Partial<CreateTaskInput> & { enabled?: unknown },
  ): Promise<MutationResult>;
  setTaskEnabled(id: string, enabled: boolean): Promise<MutationResult>;
  deleteTaskConfirmed(id: string): Promise<MutationDeleteResult>;
}

type ClientDependencies = {
  scheduleManager: ScheduleManager;
};

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error ?? "");
}

function collectCronWarning(
  scheduleManager: ScheduleManager,
  cronExpression: string | undefined,
): string | undefined {
  if (!cronExpression || !cronExpression.trim()) {
    return undefined;
  }
  try {
    return scheduleManager.checkMinimumInterval(cronExpression);
  } catch {
    // checkMinimumInterval should not throw for a syntactically valid
    // expression; if it does, upstream validation will surface the error.
    return undefined;
  }
}

/**
 * Create an LM-Tool-facing mutation client.
 *
 * The LM Tool path is fully non-interactive:
 *  - Never shows UI dialogs (Chat confirmation is handled via
 *    `prepareInvocation()` at the tool layer).
 *  - Reports disclaimer requirements as failures instead of prompting.
 *  - Returns cron-interval warnings alongside successful mutations rather
 *    than blocking or prompting.
 *  - Re-fetches the task inside `deleteTaskConfirmed` to guard against races
 *    between preparation and invocation.
 *
 * UI (webview / CLI commands) continues to use the existing helpers with
 * their interactive disclaimers and warnings; that path is intentionally not
 * migrated in this change to minimise regression risk.
 */
export function createLmToolMutationClient(
  deps: ClientDependencies,
): LmToolMutationClient {
  const { scheduleManager } = deps;

  return {
    async createTask(input) {
      try {
        if (input.enabled && !scheduleManager.isDisclaimerAccepted()) {
          return {
            ok: false,
            reason: "disclaimer_not_accepted",
            message:
              "First-time execution disclaimer has not been accepted. Open the Copilot Scheduler view and accept the disclaimer before creating enabled tasks.",
          };
        }
        const warning = collectCronWarning(
          scheduleManager,
          input.cronExpression,
        );
        const task = await scheduleManager.createTask(input);
        return warning ? { ok: true, task, warning } : { ok: true, task };
      } catch (error) {
        return {
          ok: false,
          reason: "validation",
          message: toMessage(error),
        };
      }
    },

    async updateTask(id, updates) {
      if (Object.prototype.hasOwnProperty.call(updates, "enabled")) {
        return {
          ok: false,
          reason: "enabled_not_allowed",
          message:
            "Use scheduler_set_task_enabled to change the enabled state.",
        };
      }

      const existing = scheduleManager.getTask(id);
      if (!existing) {
        return {
          ok: false,
          reason: "not_found",
          message: `Task not found: ${id}`,
        };
      }

      try {
        const warning = collectCronWarning(
          scheduleManager,
          updates.cronExpression,
        );
        const updated = await scheduleManager.updateTask(id, updates);
        if (!updated) {
          return {
            ok: false,
            reason: "not_found",
            message: `Task not found: ${id}`,
          };
        }
        return warning
          ? { ok: true, task: updated, warning }
          : { ok: true, task: updated };
      } catch (error) {
        return {
          ok: false,
          reason: "validation",
          message: toMessage(error),
        };
      }
    },

    async setTaskEnabled(id, enabled) {
      const existing = scheduleManager.getTask(id);
      if (!existing) {
        return {
          ok: false,
          reason: "not_found",
          message: `Task not found: ${id}`,
        };
      }
      if (enabled && !scheduleManager.isDisclaimerAccepted()) {
        return {
          ok: false,
          reason: "disclaimer_not_accepted",
          message:
            "First-time execution disclaimer has not been accepted. Open the Copilot Scheduler view and accept the disclaimer before enabling tasks.",
        };
      }
      try {
        const updated = await scheduleManager.setTaskEnabled(id, enabled);
        if (!updated) {
          return {
            ok: false,
            reason: "not_found",
            message: `Task not found: ${id}`,
          };
        }
        return { ok: true, task: updated };
      } catch (error) {
        return {
          ok: false,
          reason: "validation",
          message: toMessage(error),
        };
      }
    },

    async deleteTaskConfirmed(id) {
      // Race-guard: re-fetch immediately before deletion so tools that
      // captured a stale snapshot in prepareInvocation still surface a
      // helpful error rather than silently deleting the wrong task.
      const existing = scheduleManager.getTask(id);
      if (!existing) {
        return {
          ok: false,
          reason: "not_found",
          message: `Task not found: ${id}`,
        };
      }
      try {
        const removed = await scheduleManager.deleteTask(id);
        if (!removed) {
          return {
            ok: false,
            reason: "not_found",
            message: `Task not found: ${id}`,
          };
        }
        return { ok: true, deletedId: id };
      } catch (error) {
        return {
          ok: false,
          reason: "internal_error",
          message: toMessage(error),
        };
      }
    },
  };
}
