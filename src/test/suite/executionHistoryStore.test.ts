import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import {
  enqueueExecutionHistoryEntry,
  getExecutionHistoryEntries,
  isExecutionHistoryEntry,
  recordExecutionHistoryBestEffort,
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

  test("appends newest first and enforces the limit per task", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    for (let i = 0; i < 51; i++) {
      await enqueueExecutionHistoryEntry(
        entry({
          taskId: "frequent",
          executedAt: new Date(Date.UTC(2026, 6, 8, 0, i)).toISOString(),
        }),
      );
    }
    await enqueueExecutionHistoryEntry(
      entry({ taskId: "weekly", executedAt: "2026-07-01T00:00:00Z" }),
    );
    const entries = getExecutionHistoryEntries();
    const frequentEntries = entries.filter(
      (historyEntry) => historyEntry.taskId === "frequent",
    );
    assert.strictEqual(entries.length, 51);
    assert.strictEqual(frequentEntries.length, 50);
    assert.strictEqual(entries[0].taskId, "weekly", "newest should be first");
    assert.strictEqual(
      frequentEntries[0].executedAt,
      "2026-07-08T00:50:00.000Z",
    );
    assert.strictEqual(
      frequentEntries[49].executedAt,
      "2026-07-08T00:01:00.000Z",
      "the oldest entry for one task should be evicted without removing other tasks",
    );
  });

  test("persists route and reported model evidence without claiming backend verification", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    await enqueueExecutionHistoryEntry(
      entry({
        taskId: "host-match",
        modelExecution: {
          route: "agentHost",
          requestedModel: "vendor/group/model",
          reportedModel: "vendor/group/model",
          verification: "reported_match",
        },
      }),
    );
    await enqueueExecutionHistoryEntry(
      entry({
        taskId: "queued",
        turnOutcome: "queued",
        modelExecution: {
          route: "agentHost",
          requestedModel: "vendor/group/model",
          verification: "unverified",
        },
      }),
    );
    await enqueueExecutionHistoryEntry(
      entry({
        taskId: "chat",
        modelExecution: {
          route: "chat",
          requestedModel: "model",
          verification: "unverified",
        },
      }),
    );
    const entries = getExecutionHistoryEntries();
    assert.deepStrictEqual(entries.find((item) => item.taskId === "host-match")?.modelExecution, {
      route: "agentHost",
      requestedModel: "vendor/group/model",
      reportedModel: "vendor/group/model",
      verification: "reported_match",
    });
    assert.strictEqual(
      entries.find((item) => item.taskId === "queued")?.modelExecution?.verification,
      "unverified",
    );
    assert.strictEqual(
      entries.find((item) => item.taskId === "chat")?.modelExecution?.verification,
      "unverified",
    );
    await enqueueExecutionHistoryEntry(entry({ taskId: "legacy" }));
    assert.strictEqual(getExecutionHistoryEntries()[0].modelExecution, undefined);
  });

  test("does not turn a truncated mismatch or a queued report into a match", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    const prefix = `vendor/${"a".repeat(512)}`;
    await enqueueExecutionHistoryEntry(
      entry({
        taskId: "truncated",
        turnOutcome: "completed",
        modelExecution: {
          route: "agentHost",
          requestedModel: `${prefix}x`,
          reportedModel: `${prefix}y`,
          verification: "reported_mismatch",
        },
      }),
    );
    await enqueueExecutionHistoryEntry(
      entry({
        taskId: "queued-report",
        turnOutcome: "queued",
        modelExecution: {
          route: "agentHost",
          requestedModel: "vendor/model",
          reportedModel: "vendor/model",
          verification: "reported_match",
        },
      }),
    );
    for (const id of ["truncated", "queued-report"]) {
      assert.strictEqual(
        getExecutionHistoryEntries().find((item) => item.taskId === id)
          ?.modelExecution?.verification,
        "unverified",
      );
    }
  });

  test("a rejected history write does not block an already queued append", async () => {
    const ctx = stubContext();
    const update = ctx.globalState.update.bind(ctx.globalState);
    await update("executionHistory", [entry({ taskId: "existing" })]);
    let attempts = 0;
    ctx.globalState.update = (key, value) => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("history write rejected"))
        : update(key, value);
    };
    setExecutionHistoryContextForTests(ctx);
    const failed = enqueueExecutionHistoryEntry(entry({ taskId: "failed" }));
    const recovered = enqueueExecutionHistoryEntry(
      entry({ taskId: "recovered" }),
    );
    await assert.rejects(failed, /history write rejected/);
    await recovered;
    assert.strictEqual(attempts, 2);
    assert.deepStrictEqual(
      getExecutionHistoryEntries().map((historyEntry) => historyEntry.taskId),
      ["recovered", "existing"],
    );
  });

  test("separate windows append to the shared history without losing entries", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-history-"));
    let release!: () => void;
    let firstWrite: Promise<void> | undefined;
    let secondWrite: Promise<void> | undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    try {
      const stateA = new MockMemento();
      const stateB = new MockMemento();
      await stateA.update("executionHistory", [entry({ taskId: "legacy" })]);
      await stateB.update("executionHistory", [entry({ taskId: "legacy" })]);
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const updateA = stateA.update.bind(stateA);
      stateA.update = async (key, value) => {
        if (key === "executionHistoryFileInitialized") {
          entered();
          await hold;
        }
        await updateA(key, value);
      };
      const contextA = {
        globalState: stateA as unknown as vscode.ExtensionContext["globalState"],
        globalStorageUri: vscode.Uri.file(tmp),
      };
      const contextB = {
        globalState: stateB as unknown as vscode.ExtensionContext["globalState"],
        globalStorageUri: vscode.Uri.file(tmp),
      };

      setExecutionHistoryContextForTests(contextA);
      firstWrite = enqueueExecutionHistoryEntry(entry({ taskId: "window-a" }));
      await started;
      resetExecutionHistoryQueueForTests();
      setExecutionHistoryContextForTests(contextB);
      secondWrite = enqueueExecutionHistoryEntry(entry({ taskId: "window-b" }));
      release();
      await Promise.all([firstWrite, secondWrite]);
      assert.deepStrictEqual(
        getExecutionHistoryEntries().map((item) => item.taskId),
        ["window-b", "window-a", "legacy"],
      );
      setExecutionHistoryContextForTests(contextA);
      assert.deepStrictEqual(
        getExecutionHistoryEntries().map((item) => item.taskId),
        ["window-b", "window-a", "legacy"],
      );
    } finally {
      release();
      await Promise.allSettled([firstWrite, secondWrite]);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("history remains available when its global-state mirror fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-history-"));
    try {
      const state = new MockMemento();
      state.update = async () => { throw new Error("mirror unavailable"); };
      setExecutionHistoryContextForTests({
        globalState: state as unknown as vscode.ExtensionContext["globalState"],
        globalStorageUri: vscode.Uri.file(tmp),
      });
      await enqueueExecutionHistoryEntry(entry({ taskId: "file-saved" }));
      assert.deepStrictEqual(
        getExecutionHistoryEntries().map((item) => item.taskId),
        ["file-saved"],
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a missing shared history cannot be replaced by a stale window after a mirror failure", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-history-"));
    try {
      const state = new MockMemento();
      state.update = async () => { throw new Error("mirror unavailable"); };
      setExecutionHistoryContextForTests({
        globalState: state as unknown as vscode.ExtensionContext["globalState"],
        globalStorageUri: vscode.Uri.file(tmp),
      });
      await enqueueExecutionHistoryEntry(entry({ taskId: "file-saved" }));
      fs.unlinkSync(path.join(tmp, "executionHistory.json"));
      assert.throws(() => getExecutionHistoryEntries(), /Cannot safely read/);
      await assert.rejects(
        () => enqueueExecutionHistoryEntry(entry({ taskId: "new" })),
        /Cannot safely read/,
      );
      assert.strictEqual(fs.existsSync(path.join(tmp, "executionHistory.json")), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("failed initial history migration can retry without losing legacy entries", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-history-"));
    const rename = fs.promises.rename;
    try {
      const state = new MockMemento();
      await state.update("executionHistory", [entry({ taskId: "legacy" })]);
      setExecutionHistoryContextForTests({
        globalState: state as unknown as vscode.ExtensionContext["globalState"],
        globalStorageUri: vscode.Uri.file(tmp),
      });
      let fail = true;
      fs.promises.rename = async (source, target) => {
        if (
          fail &&
          String(target).toLowerCase() ===
            path.join(tmp, "executionHistory.json").toLowerCase()
        ) {
          fail = false;
          throw new Error("history write unavailable");
        }
        await rename(source, target);
      };
      await assert.rejects(
        () => enqueueExecutionHistoryEntry(entry({ taskId: "failed" })),
        /history write unavailable/,
      );
      assert.deepStrictEqual(
        getExecutionHistoryEntries().map((item) => item.taskId),
        ["legacy"],
      );
      await enqueueExecutionHistoryEntry(entry({ taskId: "retried" }));
      assert.deepStrictEqual(
        getExecutionHistoryEntries().map((item) => item.taskId),
        ["retried", "legacy"],
      );
    } finally {
      fs.promises.rename = rename;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an invalid history file is preserved rather than replaced by stale global state", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-history-"));
    try {
      const filePath = path.join(tmp, "executionHistory.json");
      fs.writeFileSync(filePath, "{broken");
      setExecutionHistoryContextForTests({
        ...stubContext(),
        globalStorageUri: vscode.Uri.file(tmp),
      });
      assert.throws(() => getExecutionHistoryEntries(), /Cannot safely read/);
      await assert.rejects(
        () => enqueueExecutionHistoryEntry(entry({ taskId: "new" })),
        /Cannot safely read/,
      );
      assert.strictEqual(fs.readFileSync(filePath, "utf8"), "{broken");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("best-effort history failure resolves and later records still persist", async () => {
    const ctx = stubContext();
    const update = ctx.globalState.update.bind(ctx.globalState);
    let rejectNext = true;
    ctx.globalState.update = (key, value) => {
      if (rejectNext) {
        rejectNext = false;
        return Promise.reject(new Error("best-effort history write rejected"));
      }
      return update(key, value);
    };
    setExecutionHistoryContextForTests(ctx);
    await assert.doesNotReject(
      recordExecutionHistoryBestEffort(entry({ taskId: "failed" })),
    );
    assert.deepStrictEqual(getExecutionHistoryEntries(), []);
    await recordExecutionHistoryBestEffort(entry({ taskId: "recovered" }));
    assert.deepStrictEqual(
      getExecutionHistoryEntries().map((historyEntry) => historyEntry.taskId),
      ["recovered"],
    );
  });

  test("returns [] when store not initialised", () => {
    resetExecutionHistoryQueueForTests();
    setExecutionHistoryContextForTests(undefined);
    assert.deepStrictEqual(getExecutionHistoryEntries(), []);
  });

  test("retains one-time schedule and task name without the task", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    await enqueueExecutionHistoryEntry(
      entry({
        taskId: "deleted-task",
        taskName: "One-time review",
        runAt: "2030-09-26T21:00:00+09:00",
      }),
    );
    const [record] = getExecutionHistoryEntries();
    assert.strictEqual(record.taskName, "One-time review");
    assert.strictEqual(record.runAt, "2030-09-26T12:00:00.000Z");
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

  test("preserves observed Agent Host outcomes and tolerates old or invalid metadata", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    await ctx.globalState.update("executionHistory", [
      entry({ taskId: "legacy" }),
      entry({
        taskId: "complete",
        turnOutcome: "completed",
        responseText: "observed",
      }),
      entry({ taskId: "unknown", status: "failed", turnOutcome: "unknown" }),
      { ...entry({ taskId: "invalid" }), turnOutcome: 7, responseText: "observed" },
      {
        ...entry({ taskId: "inconsistent", status: "failed" }),
        turnOutcome: "cancelled",
        responseText: "observed",
      },
    ]);

    const [legacy, complete, unknown, invalid, inconsistent] =
      getExecutionHistoryEntries();
    assert.strictEqual(legacy.turnOutcome, undefined);
    assert.strictEqual(legacy.responseText, undefined);
    assert.strictEqual(complete.turnOutcome, "completed");
    assert.strictEqual(complete.responseText, "observed");
    assert.strictEqual(unknown.turnOutcome, "unknown");
    assert.strictEqual(invalid.turnOutcome, undefined);
    assert.strictEqual(invalid.responseText, undefined);
    assert.strictEqual(inconsistent.turnOutcome, "cancelled");
    assert.strictEqual(inconsistent.responseText, undefined);
  });

  test("round-trips confirmed and unapplied workspace preferences without conflating them", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    for (const workspaceMode of ["folder", "worktree"] as const) {
      for (const workspaceModeApplication of [
        "new_session_config_confirmed",
        "not_applied_resumed",
      ] as const) {
        await enqueueExecutionHistoryEntry(entry({
          taskId: `${workspaceMode}-${workspaceModeApplication}`,
          turnOutcome: "completed",
          workspaceMode,
          workspaceModeApplication,
        }));
      }
    }
    const persisted = JSON.parse(JSON.stringify(
      ctx.globalState.get<ExecutionHistoryEntry[]>("executionHistory", []),
    )) as ExecutionHistoryEntry[];
    assert.strictEqual(persisted.length, 4);
    await ctx.globalState.update("executionHistory", persisted);
    const reloaded = getExecutionHistoryEntries();
    for (const record of persisted) {
      const restored = reloaded.find((item) => item.taskId === record.taskId);
      assert.strictEqual(restored?.workspaceMode, record.workspaceMode);
      assert.strictEqual(restored?.workspaceModeApplication, record.workspaceModeApplication);
      assert.strictEqual(record.taskId, `${record.workspaceMode}-${record.workspaceModeApplication}`);
    }
  });

  test("strips invalid workspace enums and orphaned application metadata while retaining legacy history", async () => {
    const ctx = stubContext();
    setExecutionHistoryContextForTests(ctx);
    const invalid = [
      { taskId: "invalid-mode", workspaceMode: "FOLDER", workspaceModeApplication: "new_session_config_confirmed" },
      { taskId: "invalid-application", workspaceMode: "folder", workspaceModeApplication: "confirmed" },
      { taskId: "non-string-mode", workspaceMode: 1, workspaceModeApplication: "not_applied_resumed" },
      { taskId: "non-string-application", workspaceMode: "worktree", workspaceModeApplication: {} },
      { taskId: "orphaned-application", workspaceModeApplication: "not_applied_resumed" },
      { taskId: "legacy" },
    ];
    await ctx.globalState.update(
      "executionHistory",
      invalid.map((metadata) => ({ ...entry(), ...metadata })),
    );
    const assertSanitized = (records: ExecutionHistoryEntry[]) => {
      for (const metadata of invalid) {
        const record = records.find((item) => item.taskId === metadata.taskId);
        assert.ok(record, metadata.taskId);
        assert.strictEqual(record.workspaceModeApplication, undefined, metadata.taskId);
        assert.strictEqual(
          record.workspaceMode,
          metadata.workspaceMode === "folder" || metadata.workspaceMode === "worktree"
            ? metadata.workspaceMode
            : undefined,
          metadata.taskId,
        );
      }
    };
    assertSanitized(getExecutionHistoryEntries());
    await enqueueExecutionHistoryEntry(entry({
      taskId: "invalid-append",
      workspaceMode: "Folder" as never,
      workspaceModeApplication: "not_applied_resumed",
    }));
    const persisted = ctx.globalState.get<ExecutionHistoryEntry[]>("executionHistory", []);
    assertSanitized(persisted);
    assert.strictEqual(persisted[0].workspaceMode, undefined);
    assert.strictEqual(persisted[0].workspaceModeApplication, undefined);
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
        dueAt: "2026-07-30T08:30:00+09:00",
        nextRunAt: "2026-07-30T10:00:00Z",
      }),
      entry({
        taskId: "invalid-date",
        executedAt: "2026-07-30 09:00:00",
        dueAt: "2026-07-30 08:30:00",
        nextRunAt: "2026-07-30T10:00:00",
      }),
    ]);

    const [valid, invalid] = getExecutionHistoryEntries();
    assert.strictEqual(valid.executedAt, "2026-07-30T09:00:00.000Z");
    assert.strictEqual(valid.dueAt, "2026-07-29T23:30:00.000Z");
    assert.strictEqual(valid.nextRunAt, "2026-07-30T10:00:00.000Z");
    assert.strictEqual(valid.executedAtInvalid, undefined);
    assert.strictEqual(valid.nextRunAtInvalid, undefined);
    assert.strictEqual(invalid.executedAt, "2026-07-30 09:00:00");
    assert.strictEqual(invalid.executedAtInvalid, true);
    assert.strictEqual(invalid.dueAt, undefined);
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

  test("queued history append waits for in-flight persistence before reading", async () => {
    const ctx = stubContext();
    const update = ctx.globalState.update.bind(ctx.globalState);
    let releaseFirst: (() => void) | undefined;
    let attempts = 0;
    ctx.globalState.update = (key, value) => {
      attempts += 1;
      if (attempts !== 1) return update(key, value);
      return new Promise<void>((resolve, reject) => {
        releaseFirst = () => {
          void Promise.resolve(update(key, value)).then(resolve, reject);
        };
      });
    };
    setExecutionHistoryContextForTests(ctx);
    const first = enqueueExecutionHistoryEntry(entry({ taskId: "first" }));
    const second = enqueueExecutionHistoryEntry(entry({ taskId: "second" }));
    await Promise.resolve();
    await Promise.resolve();
    try {
      assert.strictEqual(
        attempts,
        1,
        "second write must not overtake the first",
      );
      assert.deepStrictEqual(getExecutionHistoryEntries(), []);
    } finally {
      assert.ok(releaseFirst, "first persistence must have started");
      releaseFirst();
      await Promise.all([first, second]);
    }
    assert.strictEqual(attempts, 2);
    assert.deepStrictEqual(
      getExecutionHistoryEntries().map((historyEntry) => historyEntry.taskId),
      ["second", "first"],
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
