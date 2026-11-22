import * as vscode from "vscode";

import { messages } from "../../i18n";
import type { ScheduleManager } from "../../scheduleManager";
import { diagnoseSkillPrompt } from "../../skillResolver";
import type { LmToolMutationClient } from "../../taskMutationService";
import { buildJsonTextResult } from "../shared";
import { createSchedulerCreateTaskTool, type CreateTaskToolInput } from "./createTask";
import { createSchedulerDeleteTaskTool } from "./deleteTask";
import { createSchedulerRunTaskTool, type ManualTaskRunner } from "./runTask";
import { createSchedulerSetTaskEnabledTool } from "./setTaskEnabled";
import { createSchedulerUpdateTaskTool, RECOGNIZED_UPDATE_KEYS, type UpdateTaskToolInput } from "./updateTask";

type ManageInput =
  | { action: "create"; task: CreateTaskToolInput }
  | { action: "update"; id: string; updates: NonNullable<UpdateTaskToolInput["updates"]> }
  | { action: "delete" | "run"; id: string }
  | { action: "enable"; id: string; enabled: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const STRING_FIELDS = new Set([
  "name", "cronExpression", "runAt", "afterRun", "scope", "promptSource",
  "prompt", "promptPath", "agent", "model", "modelVendor", "agentHostModelId",
  "modelReasoningEffort", "chatSession", "agentHostWorkspaceMode", "targetChatId",
  "allowedTimeStart", "allowedTimeEnd",
]);
const BOOLEAN_FIELDS = new Set([
  "enabled", "autoMode", "modelFallback", "preventAgentHostFallback", "allowOverlappingRuns",
]);
const NUMBER_FIELDS = new Set(["jitterSeconds", "maxExecutionsPerDay"]);
const OBJECT_FIELDS = new Set(["modelConfiguration", "timeout"]);

/** Returns the name of the first field that is unknown or has the wrong type. */
function findInvalidTaskField(value: Record<string, unknown>): string | undefined {
  return Object.entries(value).find(([key, field]) => {
    if (!RECOGNIZED_UPDATE_KEYS.has(key)) return true;
    if (STRING_FIELDS.has(key)) return typeof field !== "string";
    if (BOOLEAN_FIELDS.has(key)) return typeof field !== "boolean";
    if (NUMBER_FIELDS.has(key)) return typeof field !== "number" || !Number.isFinite(field);
    if (OBJECT_FIELDS.has(key)) return !isRecord(field);
    return !(key === "attachments" && Array.isArray(field));
  })?.[0];
}

type ParsedManageInput = { input: ManageInput } | { error: string };

function invalid(error: string): ParsedManageInput {
  return { error };
}

function parseManageInput(value: unknown): ParsedManageInput {
  if (!isRecord(value) || typeof value.action !== "string") {
    return invalid("Field 'action' is required: create, update, delete, run or enable.");
  }
  const unexpected = (...allowed: string[]) =>
    Object.keys(value).find((key) => !allowed.includes(key));
  const rejectKey = (...allowed: string[]) => {
    const key = unexpected(...allowed);
    return key === undefined
      ? undefined
      : invalid(`Field '${key}' is not allowed for action '${String(value.action)}'.`);
  };
  const needId = () =>
    typeof value.id === "string" && value.id.trim() ? undefined : invalid("Missing required field: id.");
  const taskFields = (name: string, fields: unknown) => {
    if (!isRecord(fields)) return invalid(`Field '${name}' must be an object.`);
    const bad = findInvalidTaskField(fields);
    return bad === undefined
      ? undefined
      : invalid(`Field '${name}.${bad}' is unknown or has the wrong type.`);
  };
  switch (value.action) {
    case "create": {
      const error = rejectKey("action", "task") ?? taskFields("task", value.task);
      if (error) return error;
      return { input: { action: "create", task: value.task as CreateTaskToolInput } };
    }
    case "update": {
      const error = rejectKey("action", "id", "updates") ?? needId() ?? taskFields("updates", value.updates);
      if (error) return error;
      return {
        input: {
          action: "update",
          id: value.id as string,
          updates: value.updates as UpdateTaskToolInput["updates"] & object,
        },
      };
    }
    case "delete":
    case "run": {
      const error = rejectKey("action", "id") ?? needId();
      if (error) return error;
      return { input: { action: value.action, id: value.id as string } };
    }
    case "enable": {
      const error = rejectKey("action", "id", "enabled") ?? needId() ??
        (typeof value.enabled === "boolean" ? undefined : invalid("Field 'enabled' must be a boolean."));
      if (error) return error;
      return { input: { action: "enable", id: value.id as string, enabled: value.enabled as boolean } };
    }
    default:
      return invalid("Field 'action' must be create, update, delete, run or enable.");
  }
}

export function createSchedulerManageTool(
  scheduleManager: ScheduleManager,
  client: LmToolMutationClient,
  runTask: ManualTaskRunner,
): vscode.LanguageModelTool<unknown> {
  const create = createSchedulerCreateTaskTool(client, diagnoseSkillPrompt);
  const update = createSchedulerUpdateTaskTool(client, diagnoseSkillPrompt);
  const remove = createSchedulerDeleteTaskTool(scheduleManager, client);
  const run = createSchedulerRunTaskTool(scheduleManager, runTask);
  const enable = createSchedulerSetTaskEnabledTool(client);
  return {
    async prepareInvocation(options, token) {
      const parsed = parseManageInput(options.input);
      if ("error" in parsed) return { invocationMessage: messages.lmToolInvalidAction() };
      const input = parsed.input;
      switch (input.action) {
        case "create": return create.prepareInvocation!({ ...options, input: input.task }, token);
        case "update": return update.prepareInvocation!({ ...options, input: { id: input.id, updates: input.updates } }, token);
        case "delete": return remove.prepareInvocation!({ ...options, input: { id: input.id } }, token);
        case "run": return run.prepareInvocation!({ ...options, input: { id: input.id } }, token);
        case "enable": return enable.prepareInvocation!({ ...options, input: { id: input.id, enabled: input.enabled } }, token);
      }
    },
    async invoke(options, token) {
      const parsed = parseManageInput(options.input);
      if ("error" in parsed) {
        return buildJsonTextResult({ ok: false, reason: "validation", message: parsed.error });
      }
      const input = parsed.input;
      switch (input.action) {
        case "create": return create.invoke({ ...options, input: input.task }, token);
        case "update": return update.invoke({ ...options, input: { id: input.id, updates: input.updates } }, token);
        case "delete": return remove.invoke({ ...options, input: { id: input.id } }, token);
        case "run": return run.invoke({ ...options, input: { id: input.id } }, token);
        case "enable": return enable.invoke({ ...options, input: { id: input.id, enabled: input.enabled } }, token);
      }
    },
  };
}
