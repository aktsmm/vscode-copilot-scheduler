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

  test("isExecutionHistoryEntry accepts blocked status", () => {
    assert.strictEqual(
      isExecutionHistoryEntry(entry({ status: "blocked" })),
      true,
    );
    assert.strictEqual(
      isExecutionHistoryEntry({ ...entry(), status: "bogus" }),
      false,
    );
  });

  test("isExecutionHistoryEntry treats prompt metadata as optional", () => {
    assert.strictEqual(
      isExecutionHistoryEntry(
        entry({
          promptSource: "file",
          promptPathDisplay: "prompts/daily.md",
          promptHash: "abc123def456",
          promptResolvedAt: new Date().toISOString(),
        }),
      ),
      true,
    );
    // Legacy entries without the new fields must still validate.
    assert.strictEqual(isExecutionHistoryEntry(entry()), true);
    assert.strictEqual(
      isExecutionHistoryEntry({ ...entry(), promptHash: 42 }),
      false,
    );
  });

  test("getExecutionHistoryEntries normalizes invalid prompt metadata", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    await ctx.globalState.update("executionHistory", [
      entry({
        promptSource: "invalid" as never,
        promptPathDisplay: "C:\\Users\\someone\\daily.prompt.md",
        promptHash: "ABC123DEF456",
        promptResolvedAt: "2026-07-30T09:00:00Z",
        promptFallbackReason: "invalid",
      }),
    ]);

    const [normalized] = getExecutionHistoryEntries();
    assert.strictEqual(normalized.promptSource, undefined);
    assert.strictEqual(normalized.promptPathDisplay, "daily.prompt.md");
    assert.strictEqual(normalized.promptHash, "abc123def456");
    assert.strictEqual(normalized.promptResolvedAt, "2026-07-30T09:00:00.000Z");
    assert.strictEqual(normalized.promptFallbackReason, undefined);
  });

  test("normalizes valid timestamps and marks malformed legacy timestamps", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    await ctx.globalState.update("executionHistory", [
      entry({
        taskId: "valid-date",
        executedAt: "2026-07-30T09:00:00Z",
        nextRunAt: "2026-07-30T10:00:00Z",
      }),
      entry({
        taskId: "invalid-date",
        executedAt: "2026-07-30 09:00:00",
        nextRunAt: "2026-07-30T10:00:00",
      }),
    ]);

    const [valid, invalid] = getExecutionHistoryEntries();
    assert.strictEqual(valid.executedAt, "2026-07-30T09:00:00.000Z");
    assert.strictEqual(valid.nextRunAt, "2026-07-30T10:00:00.000Z");
    assert.strictEqual(valid.executedAtInvalid, undefined);
    assert.strictEqual(valid.nextRunAtInvalid, undefined);
    assert.strictEqual(invalid.executedAt, "2026-07-30 09:00:00");
    assert.strictEqual(invalid.executedAtInvalid, true);
    assert.strictEqual(invalid.nextRunAt, undefined);
    assert.strictEqual(invalid.nextRunAtInvalid, true);
  });

  test("rejects calendar overflow and ambiguous audit timestamps", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    await ctx.globalState.update("executionHistory", [
      entry({
        taskId: "overflow-date",
        executedAt: "2026-02-30T09:00:00Z",
        nextRunAt: "2026-07-30T25:00:00Z",
        promptResolvedAt: "2026-07-30 09:00:00",
      }),
      entry({
        taskId: "valid-offset",
        executedAt: "2026-07-30T09:00:00.12+02:30",
        nextRunAt: "2026-07-30T09:00:00-05:00",
        promptResolvedAt: "2026-07-30T09:00:00.123Z",
      }),
      entry({
        taskId: "invalid-time-parts",
        executedAt: "2026-07-30T09:00:60Z",
        nextRunAt: "2026-07-30T09:00:00+24:00",
      }),
      entry({
        taskId: "overflow-upper-year",
        executedAt: "9999-12-31T23:30:00-01:00",
      }),
      entry({
        taskId: "overflow-lower-year",
        executedAt: "0000-01-01T00:30:00+01:00",
      }),
    ]);

    const [overflow, validOffset, invalidParts, upperYear, lowerYear] =
      getExecutionHistoryEntries();
    assert.strictEqual(overflow.executedAtInvalid, true);
    assert.strictEqual(overflow.nextRunAt, undefined);
    assert.strictEqual(overflow.nextRunAtInvalid, true);
    assert.strictEqual(overflow.promptResolvedAt, undefined);
    assert.strictEqual(validOffset.executedAt, "2026-07-30T06:30:00.120Z");
    assert.strictEqual(validOffset.nextRunAt, "2026-07-30T14:00:00.000Z");
    assert.strictEqual(
      validOffset.promptResolvedAt,
      "2026-07-30T09:00:00.123Z",
    );
    assert.strictEqual(invalidParts.executedAtInvalid, true);
    assert.strictEqual(invalidParts.nextRunAtInvalid, true);
    assert.strictEqual(upperYear.executedAtInvalid, true);
    assert.strictEqual(lowerYear.executedAtInvalid, true);
  });

  test("append strips excess fields and heals existing entries", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    await ctx.globalState.update("executionHistory", [
      entry({
        taskId: "legacy",
        executedAt: "2026-07-30T08:00:00Z",
        promptPathDisplay: "C:\\Users\\someone\\legacy.prompt.md",
        promptHash: "ABC123DEF456",
      }),
    ]);
    const incoming = entry({
      taskId: "new",
      executedAt: "2026-07-30T09:00:00Z",
    }) as ExecutionHistoryEntry & { unexpected?: unknown };
    incoming.unexpected = incoming;

    await enqueueExecutionHistoryEntry(incoming);

    const persisted = ctx.globalState.get<ExecutionHistoryEntry[]>(
      "executionHistory",
      [],
    );
    assert.strictEqual(persisted.length, 2);
    assert.strictEqual("unexpected" in persisted[0], false);
    assert.strictEqual(persisted[0].executedAt, "2026-07-30T09:00:00.000Z");
    assert.strictEqual(persisted[1].promptPathDisplay, "legacy.prompt.md");
    assert.strictEqual(persisted[1].promptHash, "abc123def456");
  });

  test("preserves next-run invalid marker after normalized writeback", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    await ctx.globalState.update("executionHistory", [
      entry({
        taskId: "invalid-next-run",
        nextRunAt: "not-a-date",
      }),
    ]);

    await enqueueExecutionHistoryEntry(
      entry({ taskId: "new-entry", executedAt: "2026-07-30T10:00:00Z" }),
    );

    const firstRead = getExecutionHistoryEntries();
    const legacy = firstRead.find((item) => item.taskId === "invalid-next-run");
    assert.strictEqual(legacy?.nextRunAt, undefined);
    assert.strictEqual(legacy?.nextRunAtInvalid, true);

    const secondRead = getExecutionHistoryEntries();
    const roundTripped = secondRead.find(
      (item) => item.taskId === "invalid-next-run",
    );
    assert.strictEqual(roundTripped?.nextRunAtInvalid, true);
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
