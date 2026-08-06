import * as vscode from "vscode";

import {
  getFirstDistinctCronRuns,
  validateCronExpressions,
} from "../../cronExpressions";
import { getExecutionHistoryEntries } from "../../executionHistoryStore";
import { sanitizeAbsolutePathDetails } from "../../errorSanitizer";
import { getSupportedExperimentalReasoningEfforts } from "../../modelQualityExperiment";
import type { ScheduleManager } from "../../scheduleManager";
import type {
  AgentInfo,
  ModelInfo,
  ScheduledTask,
  TaskScope,
} from "../../types";
import { buildJsonTextResult, buildTextResult, toTaskSummary } from "../shared";

type QueryKind =
  | "list"
  | "get"
  | "history"
  | "preview_cron"
  | "list_models"
  | "list_agents";

interface QueryInput {
  kind?: QueryKind | string;
  scope?: TaskScope | "all" | string;
  enabledOnly?: boolean;
  id?: string;
  taskId?: string;
  limit?: number;
  cronExpression?: string;
  count?: number;
  timezone?: string;
}

/**
 * Read-only catalog access for discovery kinds. Injected so this module stays
 * free of the heavyweight `CopilotExecutor` dependency graph.
 */
export interface SchedulerCatalogProvider {
  listModels(): Promise<{
    source: "api" | "fallback";
    models: readonly ModelInfo[];
  }>;
  listAgents(): Promise<readonly AgentInfo[]>;
}

const VALID_KINDS: readonly QueryKind[] = [
  "list",
  "get",
  "history",
  "preview_cron",
  "list_models",
  "list_agents",
];

function invalidKindResult(input: unknown): vscode.LanguageModelToolResult {
  return buildJsonTextResult({
    ok: false,
    reason: "validation",
    message: `Invalid 'kind'. Expected one of: ${VALID_KINDS.join(", ")}.`,
    received: input,
  });
}

function unexpectedFieldResult(
  kind: QueryKind,
  unexpected: string[],
): vscode.LanguageModelToolResult {
  return buildJsonTextResult({
    ok: false,
    reason: "validation",
    message: `Fields not allowed for kind='${kind}': ${unexpected.join(", ")}. Remove them and retry.`,
  });
}

const ALLOWED_BY_KIND: Record<QueryKind, ReadonlySet<string>> = {
  list: new Set(["kind", "scope", "enabledOnly"]),
  get: new Set(["kind", "id"]),
  history: new Set(["kind", "taskId", "limit"]),
  preview_cron: new Set(["kind", "cronExpression", "count", "timezone"]),
  list_models: new Set(["kind"]),
  list_agents: new Set(["kind"]),
};

function catalogUnavailableResult(
  kind: QueryKind,
  detail?: unknown,
): vscode.LanguageModelToolResult {
  const reason =
    detail === undefined
      ? ""
      : ` (${sanitizeAbsolutePathDetails(
          detail instanceof Error ? detail.message : String(detail ?? ""),
        )})`;
  return buildJsonTextResult({
    ok: false,
    reason: "internal_error",
    message: `kind='${kind}' is unavailable in this context${reason}. Create or update the task without specifying a model or agent.`,
  });
}

function findUnexpectedFields(
  kind: QueryKind,
  input: Record<string, unknown>,
): string[] {
  const allowed = ALLOWED_BY_KIND[kind];
  return Object.keys(input).filter((key) => !allowed.has(key));
}

function handleList(
  scheduleManager: ScheduleManager,
  input: QueryInput,
): vscode.LanguageModelToolResult {
  const scope = input.scope ?? "all";
  if (scope !== "all" && scope !== "global" && scope !== "workspace") {
    return buildJsonTextResult({
      ok: false,
      reason: "validation",
      message: `Invalid 'scope' for kind=list. Expected: all | global | workspace.`,
    });
  }
  const all = scheduleManager.getAllTasks();
  const filtered = all.filter((task: ScheduledTask) => {
    if (scope !== "all" && task.scope !== scope) {
      return false;
    }
    if (input.enabledOnly && !task.enabled) {
      return false;
    }
    return true;
  });
  return buildJsonTextResult({
    ok: true,
    count: filtered.length,
    promptTextOmitted: true,
    hint: "Prompt bodies are omitted here. Use kind=get with a task id when you need the full prompt, and never write promptPreview back to a task.",
    tasks: filtered.map(toTaskSummary),
  });
}

function handleGet(
  scheduleManager: ScheduleManager,
  input: QueryInput,
): vscode.LanguageModelToolResult {
  if (!input.id || typeof input.id !== "string") {
    return buildJsonTextResult({
      ok: false,
      reason: "validation",
      message: "kind=get requires a non-empty 'id' field.",
    });
  }
  const task = scheduleManager.getTask(input.id);
  if (!task) {
    return buildJsonTextResult({
      ok: false,
      reason: "not_found",
      message: `Task not found: ${input.id}`,
    });
  }
  return buildJsonTextResult({ ok: true, task });
}

function handleHistory(input: QueryInput): vscode.LanguageModelToolResult {
  const limit =
    typeof input.limit === "number" && input.limit > 0
      ? Math.min(Math.floor(input.limit), 500)
      : 50;
  const entries = getExecutionHistoryEntries();
  const filtered =
    input.taskId && typeof input.taskId === "string"
      ? entries.filter((entry) => entry.taskId === input.taskId)
      : entries;
  const total = filtered.length;
  return buildJsonTextResult({
    ok: true,
    total,
    count: Math.min(total, limit),
    hasMore: total > limit,
    entries: filtered.slice(0, limit),
  });
}

function handlePreviewCron(input: QueryInput): vscode.LanguageModelToolResult {
  const expression = input.cronExpression;
  if (!expression || typeof expression !== "string") {
    return buildJsonTextResult({
      ok: false,
      reason: "validation",
      message: "kind=preview_cron requires 'cronExpression'.",
    });
  }
  const count =
    typeof input.count === "number" && input.count > 0
      ? Math.min(Math.floor(input.count), 20)
      : 5;

  const timezone =
    typeof input.timezone === "string" && input.timezone.trim().length > 0
      ? input.timezone
      : undefined;

  const parseOptions = { currentDate: new Date(), tz: timezone };

  try {
    validateCronExpressions(expression, parseOptions);
  } catch (error) {
    return buildJsonTextResult({
      ok: false,
      reason: "validation",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const runs = getFirstDistinctCronRuns(expression, parseOptions, count);
    return buildJsonTextResult({
      ok: true,
      timezone: timezone ?? "local",
      runs: runs.map((date) => date.toISOString()),
    });
  } catch (error) {
    return buildJsonTextResult({
      ok: false,
      reason: "validation",
      message: `Failed to compute next runs: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

async function handleListModels(
  catalogProvider: SchedulerCatalogProvider,
): Promise<vscode.LanguageModelToolResult> {
  const { source, models } = await catalogProvider.listModels();
  return buildJsonTextResult({
    ok: true,
    source,
    count: models.length,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      vendor: model.vendor,
      family: model.family,
      version: model.version,
      supportedReasoningEfforts: getSupportedExperimentalReasoningEfforts({
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        family: model.family,
      }),
    })),
  });
}

async function handleListAgents(
  catalogProvider: SchedulerCatalogProvider,
): Promise<vscode.LanguageModelToolResult> {
  const agents = await catalogProvider.listAgents();
  // `filePath` is intentionally omitted so absolute paths never reach the model.
  const selectable = agents
    .filter((agent: AgentInfo) => agent.userInvocable !== false)
    .map((agent: AgentInfo) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      isCustom: agent.isCustom,
    }));
  return buildJsonTextResult({
    ok: true,
    count: selectable.length,
    agents: selectable,
  });
}

export function createSchedulerQueryTool(
  scheduleManager: ScheduleManager,
  catalogProvider?: SchedulerCatalogProvider,
): vscode.LanguageModelTool<QueryInput> {
  return {
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<QueryInput>,
    ) {
      const input = (options.input ?? {}) as QueryInput;
      const kind = input.kind;
      if (
        typeof kind !== "string" ||
        !VALID_KINDS.includes(kind as QueryKind)
      ) {
        return invalidKindResult(kind);
      }
      const kindStrict = kind as QueryKind;
      const unexpected = findUnexpectedFields(
        kindStrict,
        input as Record<string, unknown>,
      );
      if (unexpected.length > 0) {
        return unexpectedFieldResult(kindStrict, unexpected);
      }
      switch (kindStrict) {
        case "list":
          return handleList(scheduleManager, input);
        case "get":
          return handleGet(scheduleManager, input);
        case "history":
          return handleHistory(input);
        case "preview_cron":
          return handlePreviewCron(input);
        case "list_models":
        case "list_agents": {
          if (!catalogProvider) {
            return catalogUnavailableResult(kindStrict);
          }
          try {
            return kindStrict === "list_models"
              ? await handleListModels(catalogProvider)
              : await handleListAgents(catalogProvider);
          } catch (error) {
            return catalogUnavailableResult(kindStrict, error);
          }
        }
        default:
          return buildTextResult("Unhandled query kind.");
      }
    },
  };
}
