import {
  findBestMatchingModel,
  hasModelSelection,
  modelInfoToSelection,
  normalizeModelSelection,
} from "./modelSelection";
import { sanitizeAbsolutePathDetails } from "./errorSanitizer";
import {
  migrateLegacyModelConfiguration,
  validateModelConfiguration,
} from "./model-configuration";
import { supportsConfiguredModelExecution } from "./configured-model-provider";
import type { ScheduleManager } from "./scheduleManager";
import type {
  CreateTaskInput,
  ModelInfo,
  ModelSelectionFields,
  ScheduledTask,
} from "./types";

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
  | { ok: true; task: T; warning?: string; warnings?: string[] }
  | {
      ok: false;
      reason: MutationFailureReason;
      message: string;
      state?: MutationRolledBackState;
    };

export type MutationDeleteResult =
  | { ok: true; deletedId: string }
  | { ok: false; reason: MutationFailureReason; message: string };

export type ModelSelectionResolution =
  | { ok: true; selection: ModelSelectionFields; warnings: string[] }
  | { ok: false; message: string };

export type ModelSelectionResolver = (
  selection: ModelSelectionFields,
) => Promise<ModelSelectionResolution>;

export type ModelCatalogLoader = () => Promise<{
  source: "api" | "fallback";
  models: readonly ModelInfo[];
}>;

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
  /** Optional so existing callers and tests keep working without a catalog. */
  resolveModelSelection?: ModelSelectionResolver;
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

const MODEL_SELECTION_KEYS = [
  "model",
  "modelName",
  "modelVendor",
  "modelFamily",
  "modelVersion",
  "modelReasoningEffort",
] as const;

type ExplicitModelSelection = Required<
  Omit<ModelSelectionFields, "modelConfiguration">
> &
  Pick<ModelSelectionFields, "modelConfiguration">;

/**
 * Force every model field to a concrete value so `ScheduleManager.updateTask`
 * always enters its model branch and stale metadata cannot survive a change.
 */
function toExplicitModelSelection(
  selection: ModelSelectionFields,
): ExplicitModelSelection {
  return {
    model: selection.model ?? "",
    modelName: selection.modelName ?? "",
    modelVendor: selection.modelVendor ?? "",
    modelFamily: selection.modelFamily ?? "",
    modelVersion: selection.modelVersion ?? "",
    modelReasoningEffort: selection.modelReasoningEffort ?? "",
    modelConfiguration: selection.modelConfiguration,
  };
}

function isExplicitModelReset(fields: ModelSelectionFields): boolean {
  return (
    Object.prototype.hasOwnProperty.call(fields, "model") &&
    typeof fields.model === "string" &&
    fields.model.trim().length === 0
  );
}

function hasModelFieldsBesidesModel(fields: ModelSelectionFields): boolean {
  if (
    fields.modelConfiguration &&
    Object.keys(fields.modelConfiguration).length > 0
  )
    return true;
  return MODEL_SELECTION_KEYS.filter((key) => key !== "model").some((key) => {
    const value = fields[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function mergeModelSelection(
  current: ModelSelectionFields,
  updates: ModelSelectionFields,
): ModelSelectionFields {
  const merged: ModelSelectionFields = {};
  for (const key of MODEL_SELECTION_KEYS) {
    merged[key] = updates[key] !== undefined ? updates[key] : current[key];
  }
  if (
    updates.modelConfiguration !== undefined ||
    current.modelConfiguration !== undefined
  ) {
    merged.modelConfiguration =
      updates.modelConfiguration !== undefined
        ? updates.modelConfiguration
        : current.modelConfiguration;
    if (
      updates.modelConfiguration !== undefined &&
      updates.modelReasoningEffort === undefined
    )
      merged.modelReasoningEffort = undefined;
  }
  return merged;
}

function buildEffectiveModelSelection(
  current: ModelSelectionFields,
  updates: ModelSelectionFields,
): ModelSelectionFields {
  if (typeof updates.model === "string" && updates.model.trim().length > 0) {
    const sameIdentity =
      updates.model.trim() === current.model &&
      (updates.modelVendor === undefined ||
        updates.modelVendor === current.modelVendor);
    const requested = mergeModelSelection(sameIdentity ? current : {}, updates);
    requested.modelReasoningEffort =
      updates.modelReasoningEffort ??
      (updates.modelConfiguration !== undefined
        ? undefined
        : current.modelReasoningEffort);
    if (
      current.modelConfiguration !== undefined &&
      updates.modelConfiguration === undefined
    )
      requested.modelConfiguration = sameIdentity
        ? current.modelConfiguration
        : {};
    return requested;
  }
  const merged = mergeModelSelection(current, updates);
  if (
    current.modelConfiguration !== undefined &&
    updates.modelConfiguration === undefined &&
    updates.modelVendor !== undefined &&
    updates.modelVendor !== current.modelVendor
  ) {
    merged.modelConfiguration = {};
  }
  return merged;
}

type ModelResolutionOutcome =
  | {
      ok: true;
      selection?: ExplicitModelSelection;
      warnings: string[];
    }
  | { ok: false; reason: MutationFailureReason; message: string };

/**
 * @param requested fields the caller actually sent (drives reset detection)
 * @param effective requested fields merged over the task's current selection
 */
async function resolveModelFieldsForMutation(
  resolver: ModelSelectionResolver | undefined,
  requested: ModelSelectionFields,
  effective: ModelSelectionFields,
): Promise<ModelResolutionOutcome> {
  try {
    return await resolveModelFieldsForMutationUnchecked(
      resolver,
      requested,
      effective,
    );
  } catch {
    return {
      ok: false,
      reason: "validation",
      message:
        "Invalid model configuration. Query list_models and replace the task options explicitly.",
    };
  }
}

async function resolveModelFieldsForMutationUnchecked(
  resolver: ModelSelectionResolver | undefined,
  requested: ModelSelectionFields,
  effective: ModelSelectionFields,
): Promise<ModelResolutionOutcome> {
  if (isExplicitModelReset(requested)) {
    if (hasModelFieldsBesidesModel(requested)) {
      return {
        ok: false,
        reason: "validation",
        message:
          "An empty 'model' clears the model selection, so no other model field can be set in the same call. Send model='' alone, or send a model id from scheduler_query kind=list_models.",
      };
    }
    return { ok: true, selection: toExplicitModelSelection({}), warnings: [] };
  }

  if (
    !resolver ||
    (!hasModelSelection(requested) &&
      requested.modelConfiguration === undefined)
  ) {
    return { ok: true, warnings: [] };
  }

  const normalizedEffective = normalizeModelSelection(effective);
  if (
    normalizedEffective.modelConfiguration !== undefined &&
    normalizedEffective.modelReasoningEffort
  ) {
    return {
      ok: false,
      reason: "validation",
      message:
        "modelConfiguration cannot be combined with legacy modelReasoningEffort.",
    };
  }
  if (
    !normalizedEffective.model &&
    !normalizedEffective.modelName &&
    !normalizedEffective.modelFamily
  ) {
    if (
      normalizedEffective.modelConfiguration !== undefined &&
      Object.keys(normalizedEffective.modelConfiguration).length === 0 &&
      !normalizedEffective.modelReasoningEffort
    ) {
      return {
        ok: true,
        selection: toExplicitModelSelection(normalizedEffective),
        warnings: [],
      };
    }
    return {
      ok: false,
      reason: "validation",
      message:
        "A reasoning effort cannot be set while the task has no model. Send a 'model' id from scheduler_query kind=list_models in the same call.",
    };
  }

  const resolution = await resolver(effective);
  if (!resolution.ok) {
    return { ok: false, reason: "validation", message: resolution.message };
  }
  return {
    ok: true,
    selection: toExplicitModelSelection(resolution.selection),
    warnings: resolution.warnings,
  };
}

function withWarnings(
  task: ScheduledTask,
  candidates: ReadonlyArray<string | undefined>,
): MutationResult {
  const warnings = candidates.filter(
    (candidate): candidate is string => !!candidate && !!candidate.trim(),
  );
  if (warnings.length === 0) {
    return { ok: true, task };
  }
  return { ok: true, task, warning: warnings.join("\n"), warnings };
}

/**
 * Build a resolver that verifies a requested model against the live catalog and
 * expands it into the full selection so startup healing stays stable.
 */
export function createModelSelectionResolver(
  loadCatalog: ModelCatalogLoader,
): ModelSelectionResolver {
  return async (requested) => {
    const normalized = normalizeModelSelection(requested);
    if (
      !normalized.model &&
      requested.modelConfiguration !== undefined &&
      Object.keys(requested.modelConfiguration).length === 0 &&
      (requested.model === "" || !normalized.modelName) &&
      !normalized.modelReasoningEffort
    ) {
      return { ok: true, selection: { modelConfiguration: {} }, warnings: [] };
    }

    let catalog: Awaited<ReturnType<ModelCatalogLoader>>;
    try {
      catalog = await loadCatalog();
    } catch (error) {
      return {
        ok: true,
        selection: normalized,
        warnings: [
          `Could not load the model catalog (${sanitizeAbsolutePathDetails(toMessage(error))}); the requested model was saved without verification.`,
          ...(normalized.modelConfiguration &&
          Object.keys(normalized.modelConfiguration).length > 0
            ? [
                "Dynamic settings will be revalidated before execution; invalid or unavailable source models stop without fallback.",
              ]
            : []),
        ],
      };
    }

    const providerModels = normalized.modelVendor
      ? catalog.models.filter(
          (model) => model.vendor === normalized.modelVendor,
        )
      : catalog.models;
    const exactModels = normalized.model
      ? providerModels.filter((model) => model.id === normalized.model)
      : [];
    const candidateModels =
      exactModels.length > 0 ? exactModels : providerModels;
    if (!normalized.modelVendor) {
      const vendors = new Set(
        candidateModels
          .filter((model) => !!findBestMatchingModel(normalized, [model]))
          .map((model) => model.vendor),
      );
      if (vendors.size > 1) {
        return {
          ok: false,
          message: `Ambiguous model selection: ${normalized.model || normalized.modelName}. Specify modelVendor from scheduler_query kind=list_models (${Array.from(vendors).join(", ")}).`,
        };
      }
    }
    const matched = findBestMatchingModel(normalized, candidateModels);
    if (!matched) {
      if (catalog.source !== "api") {
        return {
          ok: true,
          selection: normalized,
          warnings: [
            "The Language Model API is unavailable, so the requested model could not be verified. It is resolved again at execution time; explicitly selected additional providers block the run if unavailable instead of falling back to the default model.",
          ],
        };
      }
      const availableModelIds = catalog.models
        .map((model) => model.id)
        .filter((id) => typeof id === "string" && id.trim().length > 0);
      return {
        ok: false,
        message: [
          `Unknown model: ${normalized.model || normalized.modelName || "(unspecified)"}.`,
          availableModelIds.length > 0
            ? `Available model ids: ${availableModelIds.join(", ")}.`
            : "No models are currently available.",
          "Call scheduler_query with kind=list_models for valid ids, or send an empty model to use the default.",
        ].join(" "),
      };
    }

    const matchedSelection = {
      ...modelInfoToSelection(matched),
      modelReasoningEffort: normalized.modelReasoningEffort,
      modelConfiguration: normalized.modelConfiguration,
    };
    const resolved = normalizeModelSelection(
      supportsConfiguredModelExecution()
        ? migrateLegacyModelConfiguration(matchedSelection, matched)
        : matchedSelection,
    );
    if (resolved.modelConfiguration !== undefined) {
      if (resolved.modelReasoningEffort)
        return {
          ok: false,
          message:
            "modelConfiguration cannot be combined with legacy modelReasoningEffort.",
        };
      try {
        validateModelConfiguration(matched, resolved.modelConfiguration);
      } catch {
        return {
          ok: false,
          message:
            "The model options are unavailable or invalid. Query kind=list_models and choose advertised configurationOptions.",
        };
      }
    }
    const warnings: string[] = [];
    if (
      resolved.modelConfiguration &&
      Object.keys(resolved.modelConfiguration).length > 0
    ) {
      warnings.push(
        "Dynamic options execute through a per-request configured model on VS Code 1.141 or later. Source-provider authorization is required; invalid or unavailable settings stop without fallback.",
      );
    }
    if (
      normalized.modelReasoningEffort &&
      !resolved.modelReasoningEffort &&
      resolved.modelConfiguration?.reasoningEffort !==
        normalized.modelReasoningEffort
    ) {
      warnings.push(
        `Reasoning effort '${normalized.modelReasoningEffort}' is not supported by ${matched.name || matched.id}; it was ignored.`,
      );
    }
    return { ok: true, selection: resolved, warnings };
  };
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
  const { scheduleManager, resolveModelSelection } = deps;

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
        const modelOutcome = await resolveModelFieldsForMutation(
          resolveModelSelection,
          input,
          mergeModelSelection({}, input),
        );
        if (!modelOutcome.ok) {
          return {
            ok: false,
            reason: modelOutcome.reason,
            message: modelOutcome.message,
          };
        }
        const warning = collectCronWarning(
          scheduleManager,
          input.cronExpression,
        );
        const task = await scheduleManager.createTask(
          modelOutcome.selection
            ? { ...input, ...modelOutcome.selection }
            : input,
        );
        return withWarnings(task, [warning, ...modelOutcome.warnings]);
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
        const modelOutcome = await resolveModelFieldsForMutation(
          resolveModelSelection,
          updates,
          buildEffectiveModelSelection(existing, updates),
        );
        if (!modelOutcome.ok) {
          return {
            ok: false,
            reason: modelOutcome.reason,
            message: modelOutcome.message,
          };
        }
        const warning = collectCronWarning(
          scheduleManager,
          updates.cronExpression,
        );
        const updated = await scheduleManager.updateTask(
          id,
          modelOutcome.selection
            ? { ...updates, ...modelOutcome.selection }
            : updates,
        );
        if (!updated) {
          return {
            ok: false,
            reason: "not_found",
            message: `Task not found: ${id}`,
          };
        }
        return withWarnings(updated, [warning, ...modelOutcome.warnings]);
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
