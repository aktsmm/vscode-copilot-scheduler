import * as assert from "assert";
import * as vscode from "vscode";

import {
  enqueueExecutionHistoryEntry,
  getExecutionHistoryEntries,
  isExecutionHistoryEntry,
  resetExecutionHistoryQueueForTests,
  setExecutionHistoryContextForTests,
  type ExecutionHistoryEntry,
} from "../../executionHistoryStore";

class MockMemento {
  private readonly store = new Map<string, unknown>();
  keys(): readonly string[] {
    return Array.from(this.store.keys());
  }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.store.has(key)) {
      return defaultValue;
    }
    return this.store.get(key) as T;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
  setKeysForSync(_keys: readonly string[]): void {
    // no-op
  }
}

function stubContext(): {
  globalState: vscode.ExtensionContext["globalState"];
} {
  return {
    globalState:
      new MockMemento() as unknown as vscode.ExtensionContext["globalState"],
  };
}

function entry(
  overrides: Partial<ExecutionHistoryEntry> = {},
): ExecutionHistoryEntry {
  return {
    taskId: "t1",
    taskName: "sample",
    trigger: "manual",
    status: "success",
    executedAt: new Date().toISOString(),
    ...overrides,
  };
}

suite("executionHistoryStore", () => {
  teardown(() => {
    resetExecutionHistoryQueueForTests();
    setExecutionHistoryContextForTests(undefined);
  });

  test("appends newest first and enforces limit", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    for (let i = 0; i < 3; i++) {
      await enqueueExecutionHistoryEntry(
        entry({ taskId: `t${i}`, executedAt: `2026-07-08T00:00:0${i}Z` }),
      );
    }
    const entries = getExecutionHistoryEntries();
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].taskId, "t2", "newest should be first");
    assert.strictEqual(entries[2].taskId, "t0", "oldest should be last");
  });

  test("returns [] when store not initialised", () => {
    resetExecutionHistoryQueueForTests();
    setExecutionHistoryContextForTests(undefined);
    assert.deepStrictEqual(getExecutionHistoryEntries(), []);
  });

  test("filters invalid entries when reading", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    await ctx.globalState.update("executionHistory", [
      entry({ taskId: "good" }),
      { taskId: "missing-fields" },
      null,
    ]);
    const entries = getExecutionHistoryEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].taskId, "good");
  });

  test("isExecutionHistoryEntry validates required fields", () => {
    assert.strictEqual(isExecutionHistoryEntry(entry()), true);
    assert.strictEqual(isExecutionHistoryEntry(null), false);
    assert.strictEqual(isExecutionHistoryEntry({}), false);
    assert.strictEqual(
      isExecutionHistoryEntry({ ...entry(), trigger: "bogus" }),
      false,
    );
  });

  test("serialises concurrent appends via internal queue", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    await Promise.all(
      Array.from({ length: 5 }, (_v, i) =>
        enqueueExecutionHistoryEntry(
          entry({ taskId: `t${i}`, executedAt: `2026-07-08T00:00:0${i}Z` }),
        ),
      ),
    );
    const entries = getExecutionHistoryEntries();
    assert.strictEqual(entries.length, 5, "all 5 entries persisted");
  });
});
