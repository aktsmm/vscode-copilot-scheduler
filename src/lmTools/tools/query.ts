import * as vscode from "vscode";

import {
  getFirstDistinctCronRuns,
  validateCronExpressions,
} from "../../cronExpressions";
import { getExecutionHistoryEntries } from "../../executionHistoryStore";
import type { ScheduleManager } from "../../scheduleManager";
import type { ScheduledTask, TaskScope } from "../../types";
import { buildJsonTextResult, buildTextResult } from "../shared";

type QueryKind = "list" | "get" | "history" | "preview_cron";

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

const VALID_KINDS: readonly QueryKind[] = [
  "list",
  "get",
  "history",
  "preview_cron",
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
};

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
    tasks: filtered,
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
  return buildJsonTextResult({
    ok: true,
    count: Math.min(filtered.length, limit),
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

export function createSchedulerQueryTool(
  scheduleManager: ScheduleManager,
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
        default:
          return buildTextResult("Unhandled query kind.");
      }
    },
  };
}
