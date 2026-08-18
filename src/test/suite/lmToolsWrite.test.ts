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

class WarningClient extends FakeClient {
  private readonly warnings = ["first", "second"];

  async updateTask(
    id: string,
    updates: Partial<CreateTaskInput>,
  ): Promise<MutationResult> {
    const base = await super.updateTask(id, updates);
    assert.ok(base.ok);
    return {
      ...base,
      warning: this.warnings.join("\n"),
      warnings: this.warnings,
    };
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

async function withConfirmationMode<T>(
  mode: unknown,
  fn: () => Promise<T>,
): Promise<T> {
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
          if (key === "lmTools.confirmationMode") {
            return mode as U;
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
    const prepared = await withConfirmationMode("always", () =>
      prepare(tool, {
        name: "Daily review",
        cronExpression: "0 9 * * *",
        prompt: "Review the workspace",
      }),
    );
    assert.strictEqual(
      prepared.confirmationMessages?.title,
      "Create scheduler task",
    );
    assert.match(confirmationMessageText(prepared), /scope: \(missing\)/);
  });

  test("default confirmation mode suppresses non-destructive custom confirmations", async () => {
    const createTool = createSchedulerCreateTaskTool(new FakeClient());
    const updateTool = createSchedulerUpdateTaskTool(new FakeClient());
    const setEnabledTool = createSchedulerSetTaskEnabledTool(new FakeClient());
    const createPrepared = await prepare(createTool, {
      name: "Daily review",
      cronExpression: "0 9 * * *",
      prompt: "Review the workspace",
      scope: "workspace",
    });
    const updatePrepared = await prepare(updateTool, {
      id: "task-1",
      updates: { name: "Renamed" },
    });
    const setEnabledPrepared = await prepare(setEnabledTool, {
      id: "task-1",
      enabled: false,
    });
    assert.strictEqual(createPrepared.confirmationMessages, undefined);
    assert.strictEqual(updatePrepared.confirmationMessages, undefined);
    assert.strictEqual(setEnabledPrepared.confirmationMessages, undefined);
  });

  test("always confirmation mode includes enable-disable custom confirmation", async () => {
    const tool = createSchedulerSetTaskEnabledTool(new FakeClient());
    const prepared = await withConfirmationMode("always", () =>
      prepare(tool, { id: "task-1", enabled: false }),
    );
    assert.strictEqual(
      prepared.confirmationMessages?.title,
      "Disable scheduler task",
    );
    assert.match(confirmationMessageText(prepared), /\*\*disable\*\*/);
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
    const prepared = await withConfirmationMode("always", () =>
      prepare(tool, {
        id: "task-1",
        updates: { name: "Renamed", cronExpression: "0 10 * * *" },
      }),
    );
    const message = confirmationMessageText(prepared);
    assert.match(message, /`name`/);
    assert.match(message, /`cronExpression`/);
  });

  test("attachment confirmations name every file that will be sent", async () => {
    const createTool = createSchedulerCreateTaskTool(new FakeClient());
    const createPrepared = await withConfirmationMode("always", () =>
      prepare(createTool, {
        name: "Daily review",
        cronExpression: "0 9 * * *",
        prompt: "Review the workspace",
        scope: "workspace",
        attachments: [
          { source: "local", path: ".github/instructions/style.md" },
          { source: "global", path: "shared/notes.md" },
        ],
      }),
    );
    const createMessage = confirmationMessageText(createPrepared);
    assert.match(createMessage, /attachments \(2\)/);
    assert.match(createMessage, /local: `\.github\/instructions\/style\.md`/);
    assert.match(createMessage, /global: `shared\/notes\.md`/);

    const updateTool = createSchedulerUpdateTaskTool(new FakeClient());
    const updatePrepared = await withConfirmationMode("always", () =>
      prepare(updateTool, {
        id: "task-1",
        updates: {
          attachments: [{ source: "local", path: "docs/secret-ish.md" }],
        },
      }),
    );
    const updateMessage = confirmationMessageText(updatePrepared);
    assert.match(updateMessage, /attachment list is replaced/i);
    assert.match(updateMessage, /local: `docs\/secret-ish\.md`/);

    const clearPrepared = await withConfirmationMode("always", () =>
      prepare(updateTool, { id: "task-1", updates: { attachments: [] } }),
    );
    assert.match(
      confirmationMessageText(clearPrepared),
      /all attachments will be removed/i,
      "clearing the list must be stated, not silently shown as an empty change",
    );

    const hostilePrepared = await withConfirmationMode("always", () =>
      prepare(updateTool, {
        id: "task-1",
        updates: {
          attachments: [
            { source: "local", path: "a.md`\n- local: `b.md" },
          ] as unknown as CreateTaskInput["attachments"],
        },
      }),
    );
    const hostileMessage = confirmationMessageText(hostilePrepared);
    assert.ok(
      !/a\.md`/.test(hostileMessage),
      "a model-supplied path must not close the code span and forge extra rows",
    );
    assert.ok(
      !hostileMessage.includes("a.md`\n"),
      "a model-supplied path must not inject line breaks into the confirmation",
    );
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

  test("create task forwards model and execution controls", async () => {
    const client = new FakeClient();
    const tool = createSchedulerCreateTaskTool(client);
    const result = await invoke(tool, {
      name: "Daily review",
      cronExpression: "0 9 * * *",
      prompt: "Review the workspace",
      scope: "workspace",
      model: "claude-sonnet-4",
      modelReasoningEffort: "high",
      autoMode: true,
      jitterSeconds: 120,
      maxExecutionsPerDay: 3,
      allowedTimeStart: "09:00",
      allowedTimeEnd: "18:00",
    });
    assert.strictEqual(parseJson(result).ok, true);
    assert.strictEqual(client.createInput?.model, "claude-sonnet-4");
    assert.strictEqual(client.createInput?.modelReasoningEffort, "high");
    assert.strictEqual(client.createInput?.autoMode, true);
    assert.strictEqual(client.createInput?.jitterSeconds, 120);
    assert.strictEqual(client.createInput?.maxExecutionsPerDay, 3);
    assert.strictEqual(client.createInput?.allowedTimeStart, "09:00");
    assert.strictEqual(client.createInput?.allowedTimeEnd, "18:00");
  });

  test("create task prepareInvocation shows the requested model", async () => {
    const tool = createSchedulerCreateTaskTool(new FakeClient());
    const prepared = await withConfirmationMode("always", () =>
      prepare(tool, {
        name: "Daily review",
        cronExpression: "0 9 * * *",
        prompt: "Review the workspace",
        scope: "workspace",
        model: "claude-sonnet-4",
      }),
    );
    assert.match(confirmationMessageText(prepared), /claude-sonnet-4/);
  });

  test("update task forwards model and execution controls", async () => {
    const client = new FakeClient();
    const tool = createSchedulerUpdateTaskTool(client);
    const result = await invoke(tool, {
      id: "task-1",
      updates: { model: "", scope: "global", maxExecutionsPerDay: 0 },
    });
    assert.strictEqual(parseJson(result).ok, true);
    assert.deepStrictEqual(client.updateArgs, {
      id: "task-1",
      updates: { model: "", scope: "global", maxExecutionsPerDay: 0 },
    });
  });

  test("update task rejects unknown fields in updates", async () => {
    const client = new FakeClient();
    const tool = createSchedulerUpdateTaskTool(client);
    const result = await invoke(tool, {
      id: "task-1",
      updates: {
        name: "Renamed",
        workspacePath: "C:/elsewhere",
      } as never,
    });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, "validation");
    assert.match(String(payload.message), /workspacePath/);
    assert.strictEqual(client.updateArgs, undefined);
  });

  test("update task still delegates enabled to the mutation client", async () => {
    const client = new FakeClient();
    const tool = createSchedulerUpdateTaskTool(client);
    await invoke(tool, {
      id: "task-1",
      updates: { enabled: false } as never,
    });
    assert.deepStrictEqual(client.updateArgs?.updates, { enabled: false });
  });

  test("update task surfaces multiple warnings", async () => {
    const client = new WarningClient();
    const tool = createSchedulerUpdateTaskTool(client);
    const payload = parseJson(
      await invoke(tool, { id: "task-1", updates: { name: "Renamed" } }),
    );
    assert.strictEqual(payload.ok, true);
    assert.deepStrictEqual(payload.warnings, ["first", "second"]);
    assert.strictEqual(payload.warning, "first\nsecond");
  });

  test("mutation results omit prompt bodies", async () => {
    const body = "y".repeat(4000);
    const client = new FakeClient(fakeTask({ prompt: body }));

    const created = parseJson(
      await invoke(createSchedulerCreateTaskTool(client), {
        name: "Daily review",
        cronExpression: "0 9 * * *",
        prompt: body,
        scope: "workspace",
      }),
    );
    const updated = parseJson(
      await invoke(createSchedulerUpdateTaskTool(client), {
        id: "task-1",
        updates: { name: "Renamed" },
      }),
    );
    const toggled = parseJson(
      await invoke(createSchedulerSetTaskEnabledTool(client), {
        id: "task-1",
        enabled: false,
      }),
    );

    for (const [label, payload] of [
      ["create", created],
      ["update", updated],
      ["setEnabled", toggled],
    ] as const) {
      assert.strictEqual(payload.ok, true, `${label} should succeed`);
      assert.strictEqual(
        payload.promptTextOmitted,
        true,
        `${label} must advertise that the prompt body was dropped`,
      );
      const task = payload.task as Record<string, unknown>;
      assert.strictEqual(
        "prompt" in task,
        false,
        `${label} must not echo the prompt body back into the model context`,
      );
      assert.strictEqual(task.promptLength, body.length);
    }
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

  test("minimal confirmation mode suppresses delete custom confirmation", async () => {
    const task = fakeTask();
    const tool = createSchedulerDeleteTaskTool(
      fakeScheduleManager(task),
      new FakeClient(task),
    );
    const prepared = await withConfirmationMode("minimal", () =>
      prepare(tool, { id: task.id }),
    );
    assert.strictEqual(prepared.confirmationMessages, undefined);
  });

  test("invalid confirmation mode falls back to destructive-only", async () => {
    const createTool = createSchedulerCreateTaskTool(new FakeClient());
    const task = fakeTask();
    const deleteTool = createSchedulerDeleteTaskTool(
      fakeScheduleManager(task),
      new FakeClient(task),
    );
    const createPrepared = await withConfirmationMode("bogus", () =>
      prepare(createTool, {
        name: "Daily review",
        cronExpression: "0 9 * * *",
        prompt: "Review the workspace",
        scope: "workspace",
      }),
    );
    const deletePrepared = await withConfirmationMode("bogus", () =>
      prepare(deleteTool, { id: task.id }),
    );
    assert.strictEqual(createPrepared.confirmationMessages, undefined);
    assert.strictEqual(
      deletePrepared.confirmationMessages?.title,
      "⚠️ Delete scheduler task",
    );
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
