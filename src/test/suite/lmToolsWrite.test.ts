import * as assert from "assert";
import * as vscode from "vscode";

import { createSchedulerCreateTaskTool } from "../../lmTools/tools/createTask";
import { createSchedulerDeleteTaskTool } from "../../lmTools/tools/deleteTask";
import { createSchedulerSetTaskEnabledTool } from "../../lmTools/tools/setTaskEnabled";
import { createSchedulerUpdateTaskTool } from "../../lmTools/tools/updateTask";
import type {
  LmToolMutationClient,
  MutationDeleteResult,
  MutationResult,
} from "../../taskMutationService";
import type { ScheduleManager } from "../../scheduleManager";
import type { CreateTaskInput, ScheduledTask } from "../../types";

function fakeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Morning summary",
    cronExpression: "0 9 * * *",
    prompt: "Summarize the workspace",
    enabled: true,
    scope: "workspace",
    workspacePath: "workspace-a",
    promptSource: "inline",
    createdAt: new Date("2026-07-08T00:00:00Z"),
    updatedAt: new Date("2026-07-08T00:00:00Z"),
    ...overrides,
  } as ScheduledTask;
}

class FakeClient implements LmToolMutationClient {
  public createInput: CreateTaskInput | undefined;
  public updateArgs:
    | { id: string; updates: Partial<CreateTaskInput> }
    | undefined;
  public enabledArgs: { id: string; enabled: boolean } | undefined;
  public deletedId: string | undefined;

  constructor(private readonly task = fakeTask()) {}

  async createTask(input: CreateTaskInput): Promise<MutationResult> {
    this.createInput = input;
    return { ok: true, task: this.task };
  }

  async updateTask(
    id: string,
    updates: Partial<CreateTaskInput>,
  ): Promise<MutationResult> {
    this.updateArgs = { id, updates };
    return { ok: true, task: { ...this.task, ...updates } as ScheduledTask };
  }

  async setTaskEnabled(id: string, enabled: boolean): Promise<MutationResult> {
    this.enabledArgs = { id, enabled };
    return { ok: true, task: { ...this.task, enabled } };
  }

  async deleteTaskConfirmed(id: string): Promise<MutationDeleteResult> {
    this.deletedId = id;
    return { ok: true, deletedId: id };
  }
}

class FailingClient implements LmToolMutationClient {
  async createTask(_input: CreateTaskInput): Promise<MutationResult> {
    return { ok: false, reason: "validation", message: "create failed" };
  }
  async updateTask(
    _id: string,
    _updates: Partial<CreateTaskInput>,
  ): Promise<MutationResult> {
    return { ok: false, reason: "validation", message: "update failed" };
  }
  async setTaskEnabled(
    _id: string,
    _enabled: boolean,
  ): Promise<MutationResult> {
    return { ok: false, reason: "validation", message: "toggle failed" };
  }
  async deleteTaskConfirmed(_id: string): Promise<MutationDeleteResult> {
    return { ok: false, reason: "internal_error", message: "delete failed" };
  }
}

function fakeScheduleManager(task: ScheduledTask | undefined): ScheduleManager {
  return {
    getTask: (id: string) => (task?.id === id ? task : undefined),
  } as unknown as ScheduleManager;
}

function cancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
  } as unknown as vscode.CancellationToken;
}

async function invoke<T>(
  tool: vscode.LanguageModelTool<T>,
  input: T,
): Promise<vscode.LanguageModelToolResult> {
  const result = await tool.invoke(
    { input } as vscode.LanguageModelToolInvocationOptions<T>,
    cancellationToken(),
  );
  assert.ok(result, "tool returned no result");
  return result;
}

async function prepare<T>(
  tool: vscode.LanguageModelTool<T>,
  input: T,
): Promise<vscode.PreparedToolInvocation> {
  assert.ok(tool.prepareInvocation, "tool has no prepareInvocation");
  const prepared = await tool.prepareInvocation({ input }, cancellationToken());
  assert.ok(prepared, "prepareInvocation returned no result");
  return prepared;
}

function textOf(result: vscode.LanguageModelToolResult): string {
  const parts = (result as unknown as { content: Array<{ value?: string }> })
    .content;
  return parts.map((part) => part.value ?? "").join("\n");
}

function parseJson(
  result: vscode.LanguageModelToolResult,
): Record<string, unknown> {
  return JSON.parse(textOf(result));
}

async function withWriteToolsDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const originalGetConfiguration = vscode.workspace.getConfiguration;
  Object.defineProperty(vscode.workspace, "getConfiguration", {
    value: ((section?: string) => {
      const config = originalGetConfiguration.call(vscode.workspace, section);
      if (section !== "copilotScheduler") {
        return config;
      }
      return {
        ...config,
        get<U>(key: string, defaultValue?: U): U {
          if (key === "lmTools.enableWriteTools") {
            return false as U;
          }
          return config.get<U>(key, defaultValue as U);
        },
      } as vscode.WorkspaceConfiguration;
    }) as typeof vscode.workspace.getConfiguration,
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      value: originalGetConfiguration,
      configurable: true,
    });
  }
}

async function withWorkspaceTrust<T>(
  trusted: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    vscode.workspace,
    "isTrusted",
  );
  Object.defineProperty(vscode.workspace, "isTrusted", {
    value: trusted,
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(vscode.workspace, "isTrusted", originalDescriptor);
    }
  }
}

function confirmationMessageText(
  prepared: vscode.PreparedToolInvocation,
): string {
  const message = prepared.confirmationMessages?.message;
  return typeof message === "string" ? message : (message?.value ?? "");
}

suite("lmTools write wrappers", () => {
  test("create task prepareInvocation includes explicit missing scope", async () => {
    const tool = createSchedulerCreateTaskTool(new FakeClient());
    const prepared = await prepare(tool, {
      name: "Daily review",
      cronExpression: "0 9 * * *",
      prompt: "Review the workspace",
    });
    assert.strictEqual(
      prepared.confirmationMessages?.title,
      "Create scheduler task",
    );
    assert.match(confirmationMessageText(prepared), /scope: \(missing\)/);
  });

  test("create task rejects missing scope before calling client", async () => {
    const client = new FakeClient();
    const tool = createSchedulerCreateTaskTool(client);
    const result = await invoke(tool, {
      name: "Daily review",
      cronExpression: "0 9 * * *",
      prompt: "Review the workspace",
    });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, "validation");
    assert.strictEqual(client.createInput, undefined);
  });

  test("create task passes prompt and explicit scope to mutation client", async () => {
    const client = new FakeClient();
    const tool = createSchedulerCreateTaskTool(client);
    const result = await invoke(tool, {
      name: "Daily review",
      cronExpression: "0 9 * * *",
      prompt: "Review the workspace",
      scope: "workspace",
      promptSource: "inline",
      enabled: false,
    });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(client.createInput?.prompt, "Review the workspace");
    assert.strictEqual(client.createInput?.scope, "workspace");
    assert.strictEqual(client.createInput?.enabled, false);
  });

  test("create task write-disabled gate blocks before calling client", async () => {
    const client = new FakeClient();
    const tool = createSchedulerCreateTaskTool(client);
    const result = await withWriteToolsDisabled(() =>
      invoke(tool, {
        name: "Daily review",
        cronExpression: "0 9 * * *",
        prompt: "Review the workspace",
        scope: "workspace",
      }),
    );
    assert.match(textOf(result), /Write scheduler tools are disabled/);
    assert.strictEqual(client.createInput, undefined);
  });

  test("create task trust gate blocks before calling client", async () => {
    const client = new FakeClient();
    const tool = createSchedulerCreateTaskTool(client);
    const result = await withWorkspaceTrust(false, () =>
      invoke(tool, {
        name: "Daily review",
        cronExpression: "0 9 * * *",
        prompt: "Review the workspace",
        scope: "workspace",
      }),
    );
    assert.match(textOf(result), /workspace is not trusted/);
    assert.strictEqual(client.createInput, undefined);
  });

  test("create task forwards mutation client failure", async () => {
    const tool = createSchedulerCreateTaskTool(new FailingClient());
    const result = await invoke(tool, {
      name: "Daily review",
      cronExpression: "0 9 * * *",
      prompt: "Review the workspace",
      scope: "workspace",
    });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, "validation");
    assert.strictEqual(payload.message, "create failed");
  });

  test("update task prepareInvocation lists changed fields", async () => {
    const tool = createSchedulerUpdateTaskTool(new FakeClient());
    const prepared = await prepare(tool, {
      id: "task-1",
      updates: { name: "Renamed", cronExpression: "0 10 * * *" },
    });
    const message = confirmationMessageText(prepared);
    assert.match(message, /`name`/);
    assert.match(message, /`cronExpression`/);
  });

  test("update task forwards updates to mutation client", async () => {
    const client = new FakeClient();
    const tool = createSchedulerUpdateTaskTool(client);
    const result = await invoke(tool, {
      id: "task-1",
      updates: { name: "Renamed" },
    });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, true);
    assert.deepStrictEqual(client.updateArgs, {
      id: "task-1",
      updates: { name: "Renamed" },
    });
  });

  test("update task forwards mutation client failure", async () => {
    const tool = createSchedulerUpdateTaskTool(new FailingClient());
    const result = await invoke(tool, {
      id: "task-1",
      updates: { name: "Renamed" },
    });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, "validation");
    assert.strictEqual(payload.message, "update failed");
  });

  test("delete task prepareInvocation includes task name scope and workspace", async () => {
    const task = fakeTask();
    const tool = createSchedulerDeleteTaskTool(
      fakeScheduleManager(task),
      new FakeClient(task),
    );
    const prepared = await prepare(tool, { id: task.id });
    const message = confirmationMessageText(prepared);
    assert.strictEqual(
      prepared.confirmationMessages?.title,
      "⚠️ Delete scheduler task",
    );
    assert.match(message, /Morning summary/);
    assert.match(message, /scope: workspace/);
    assert.match(message, /workspace: workspace-a/);
  });

  test("delete task forwards confirmed id to mutation client", async () => {
    const client = new FakeClient();
    const tool = createSchedulerDeleteTaskTool(
      fakeScheduleManager(fakeTask()),
      client,
    );
    const result = await invoke(tool, { id: "task-1" });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(client.deletedId, "task-1");
  });

  test("delete task forwards mutation client failure", async () => {
    const tool = createSchedulerDeleteTaskTool(
      fakeScheduleManager(fakeTask()),
      new FailingClient(),
    );
    const result = await invoke(tool, { id: "task-1" });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, "internal_error");
    assert.strictEqual(payload.message, "delete failed");
  });

  test("set task enabled rejects missing boolean before client call", async () => {
    const client = new FakeClient();
    const tool = createSchedulerSetTaskEnabledTool(client);
    const result = await invoke(tool, { id: "task-1" });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, "validation");
    assert.strictEqual(client.enabledArgs, undefined);
  });

  test("set task enabled forwards id and enabled state", async () => {
    const client = new FakeClient();
    const tool = createSchedulerSetTaskEnabledTool(client);
    const result = await invoke(tool, { id: "task-1", enabled: false });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, true);
    assert.deepStrictEqual(client.enabledArgs, {
      id: "task-1",
      enabled: false,
    });
  });

  test("set task enabled forwards mutation client failure", async () => {
    const tool = createSchedulerSetTaskEnabledTool(new FailingClient());
    const result = await invoke(tool, { id: "task-1", enabled: false });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, "validation");
    assert.strictEqual(payload.message, "toggle failed");
  });
});
