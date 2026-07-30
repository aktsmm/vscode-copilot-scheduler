import * as assert from "assert";
import * as vscode from "vscode";

import { createSchedulerQueryTool } from "../../lmTools/tools/query";
import {
  enqueueExecutionHistoryEntry,
  resetExecutionHistoryQueueForTests,
  setExecutionHistoryContextForTests,
} from "../../executionHistoryStore";
import type { ScheduleManager } from "../../scheduleManager";
import type { ScheduledTask } from "../../types";

class FakeScheduleManager {
  constructor(private readonly seed: ScheduledTask[]) {}
  getAllTasks(): ScheduledTask[] {
    return this.seed;
  }
  getTask(id: string): ScheduledTask | undefined {
    return this.seed.find((t) => t.id === id);
  }
}

function fakeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "id-1",
    name: "task-1",
    cronExpression: "0 9 * * *",
    prompt: "hi",
    scope: "global",
    promptSource: "inline",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ScheduledTask;
}

function invoke(
  tool: vscode.LanguageModelTool<unknown>,
  input: unknown,
): Promise<vscode.LanguageModelToolResult> {
  return Promise.resolve(
    tool.invoke(
      {
        input,
        toolInvocationToken: undefined,
      } as unknown as vscode.LanguageModelToolInvocationOptions<unknown>,
      { isCancellationRequested: false } as unknown as vscode.CancellationToken,
    ),
  ) as Promise<vscode.LanguageModelToolResult>;
}

function textOf(result: vscode.LanguageModelToolResult): string {
  const parts = (result as unknown as { content: unknown[] }).content;
  return parts
    .map((p) => {
      const anyPart = p as { value?: string };
      return anyPart.value ?? "";
    })
    .join("\n");
}

function parseJson(result: vscode.LanguageModelToolResult): {
  ok: boolean;
  [key: string]: unknown;
} {
  return JSON.parse(textOf(result));
}

suite("lmTools scheduler_query", () => {
  teardown(() => {
    resetExecutionHistoryQueueForTests();
    setExecutionHistoryContextForTests(undefined);
  });

  test("rejects unknown kind", async () => {
    const tool = createSchedulerQueryTool(
      new FakeScheduleManager([]) as unknown as ScheduleManager,
    );
    const result = await invoke(tool, { kind: "bogus" });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, "validation");
  });

  test("rejects unexpected field for kind=list", async () => {
    const tool = createSchedulerQueryTool(
      new FakeScheduleManager([]) as unknown as ScheduleManager,
    );
    const result = await invoke(tool, {
      kind: "list",
      cronExpression: "0 9 * * *",
    });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, "validation");
  });

  test("kind=list returns tasks with scope filter", async () => {
    const tool = createSchedulerQueryTool(
      new FakeScheduleManager([
        fakeTask({ id: "g1", scope: "global" }),
        fakeTask({ id: "w1", scope: "workspace" }),
      ]) as unknown as ScheduleManager,
    );
    const result = await invoke(tool, { kind: "list", scope: "workspace" });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.count, 1);
  });

  test("kind=get returns not_found for missing id", async () => {
    const tool = createSchedulerQueryTool(
      new FakeScheduleManager([]) as unknown as ScheduleManager,
    );
    const result = await invoke(tool, { kind: "get", id: "missing" });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, "not_found");
  });

  test("kind=preview_cron returns run times", async () => {
    const tool = createSchedulerQueryTool(
      new FakeScheduleManager([]) as unknown as ScheduleManager,
    );
    const result = await invoke(tool, {
      kind: "preview_cron",
      cronExpression: "0 9 * * *",
      count: 3,
    });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, true);
    const runs = payload.runs as string[];
    assert.strictEqual(Array.isArray(runs), true);
    assert.strictEqual(runs.length, 3);
  });

  test("kind=preview_cron rejects invalid cron", async () => {
    const tool = createSchedulerQueryTool(
      new FakeScheduleManager([]) as unknown as ScheduleManager,
    );
    const result = await invoke(tool, {
      kind: "preview_cron",
      cronExpression: "not-a-cron",
    });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, "validation");
  });

  test("kind=history returns empty when store not initialised", async () => {
    setExecutionHistoryContextForTests(undefined);
    const tool = createSchedulerQueryTool(
      new FakeScheduleManager([]) as unknown as ScheduleManager,
    );
    const result = await invoke(tool, { kind: "history", limit: 10 });
    const payload = parseJson(result);
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.count, 0);
  });

  test("kind=history preserves prompt audit metadata", async () => {
    const entries: unknown[] = [];
    setExecutionHistoryContextForTests({
      globalState: {
        get<T>(_key: string, defaultValue?: T): T {
          return (entries.length > 0 ? entries : defaultValue) as T;
        },
        update(_key: string, value: unknown): Thenable<void> {
          entries.splice(0, entries.length, ...((value as unknown[]) || []));
          return Promise.resolve();
        },
        keys(): readonly string[] {
          return entries.length > 0 ? ["executionHistory"] : [];
        },
        setKeysForSync(): void {},
      },
    });
    await enqueueExecutionHistoryEntry({
      taskId: "audit-task",
      taskName: "Audit task",
      trigger: "manual",
      status: "success",
      executedAt: "2026-07-30T09:00:00.000Z",
      promptSource: "file",
      promptPathDisplay: "daily.prompt.md",
      promptHash: "abc123def456",
      promptResolvedAt: "2026-07-30T08:59:59.000Z",
    });

    const tool = createSchedulerQueryTool(
      new FakeScheduleManager([]) as unknown as ScheduleManager,
    );
    const payload = parseJson(
      await invoke(tool, { kind: "history", taskId: "audit-task" }),
    );
    const history = payload.entries as Array<Record<string, unknown>>;
    assert.strictEqual(payload.count, 1);
    assert.strictEqual(history[0]?.promptSource, "file");
    assert.strictEqual(history[0]?.promptPathDisplay, "daily.prompt.md");
    assert.strictEqual(history[0]?.promptHash, "abc123def456");
  });

  test("kind=history reports truncation and preserves newest-first order", async () => {
    const entries: unknown[] = [];
    setExecutionHistoryContextForTests({
      globalState: {
        get<T>(_key: string, defaultValue?: T): T {
          return (entries.length > 0 ? entries : defaultValue) as T;
        },
        update(_key: string, value: unknown): Thenable<void> {
          entries.splice(0, entries.length, ...((value as unknown[]) || []));
          return Promise.resolve();
        },
        keys(): readonly string[] {
          return entries.length > 0 ? ["executionHistory"] : [];
        },
        setKeysForSync(): void {},
      },
    });
    for (let index = 0; index < 3; index++) {
      await enqueueExecutionHistoryEntry({
        taskId: `history-${index}`,
        taskName: `History ${index}`,
        trigger: "auto",
        status: "success",
        executedAt: `2026-07-30T09:0${index}:00.000Z`,
      });
    }

    const tool = createSchedulerQueryTool(
      new FakeScheduleManager([]) as unknown as ScheduleManager,
    );
    const payload = parseJson(
      await invoke(tool, { kind: "history", limit: 2 }),
    );
    const history = payload.entries as Array<Record<string, unknown>>;
    assert.strictEqual(payload.total, 3);
    assert.strictEqual(payload.count, 2);
    assert.strictEqual(payload.hasMore, true);
    assert.deepStrictEqual(
      history.map((item) => item.taskId),
      ["history-2", "history-1"],
    );
  });
});
