import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ScheduleManager, __testOnly } from "../../scheduleManager";
import { messages } from "../../i18n";
import { getFirstDistinctCronRuns } from "../../cronExpressions";

function normalizePathForAssertion(p: string): string {
  const resolved = path.normalize(path.resolve(p));
  const root = path.parse(resolved).root;
  const trimmed =
    resolved === root ? resolved : resolved.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

class MockMemento implements vscode.Memento {
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
}

function createMockContext(storageRoot: string): vscode.ExtensionContext {
  return {
    globalState: new MockMemento(),
    globalStorageUri: vscode.Uri.file(storageRoot),
  } as unknown as vscode.ExtensionContext;
}

function createMockContextWithGlobalTasks(
  storageRoot: string,
  tasks: unknown[],
): vscode.ExtensionContext {
  const memento = new MockMemento();
  // Seed globalState before ScheduleManager constructor runs.
  void memento.update("scheduledTasks", tasks);
  return {
    globalState: memento,
    globalStorageUri: vscode.Uri.file(storageRoot),
  } as unknown as vscode.ExtensionContext;
}

function createMockContextWithGlobalStateValue(
  storageRoot: string,
  value: unknown,
): vscode.ExtensionContext {
  const memento = new MockMemento();
  void memento.update("scheduledTasks", value);
  return {
    globalState: memento,
    globalStorageUri: vscode.Uri.file(storageRoot),
  } as unknown as vscode.ExtensionContext;
}

function createManagerWithInvalidTimezone(
  storageRoot: string,
): ScheduleManager {
  const manager = new ScheduleManager(createMockContext(storageRoot));
  // Avoid VS Code configuration writes in tests; patch the instance instead.
  (
    manager as unknown as { getTimeZone: () => string | undefined }
  ).getTimeZone = () => "Invalid/Timezone";
  return manager;
}

function overrideWorkspaceFoldersForTest(
  value: Array<{ uri: vscode.Uri }> | undefined,
): () => void {
  const wsAny = vscode.workspace as unknown as {
    workspaceFolders?: Array<{ uri: vscode.Uri }>;
  };
  const original = wsAny.workspaceFolders;
  try {
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      value,
      configurable: true,
    });
  } catch {
    // Best-effort only.
  }
  return () => {
    try {
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        value: original,
        configurable: true,
      });
    } catch {
      // ignore
    }
  };
}

suite("ScheduleManager Time Window Helper Tests", () => {
  test("normalizeTimeWindowHHMM accepts and pads valid inputs", () => {
    const normalize = __testOnly.normalizeTimeWindowHHMM as
      | ((value: unknown) => string | undefined)
      | undefined;
    assert.ok(typeof normalize === "function");

    assert.strictEqual(normalize!("9:05"), "09:05");
    assert.strictEqual(normalize!("23:59"), "23:59");
  });

  test("normalizeTimeWindowHHMM rejects invalid values", () => {
    const normalize = __testOnly.normalizeTimeWindowHHMM as
      | ((value: unknown) => string | undefined)
      | undefined;
    assert.ok(typeof normalize === "function");

    assert.strictEqual(normalize!("24:00"), undefined);
    assert.strictEqual(normalize!("aa:bb"), undefined);
    assert.strictEqual(normalize!(""), undefined);
  });

  test("isNowWithinAllowedTimeWindow supports overnight windows", () => {
    const isWithin = __testOnly.isNowWithinAllowedTimeWindow as
      | ((now: Date, start?: string, end?: string) => boolean)
      | undefined;
    assert.ok(typeof isWithin === "function");

    const night = new Date("2026-03-01T23:00:00");
    const morning = new Date("2026-03-01T06:30:00");
    const noon = new Date("2026-03-01T12:00:00");

    assert.strictEqual(isWithin!(night, "22:00", "07:00"), true);
    assert.strictEqual(isWithin!(morning, "22:00", "07:00"), true);
    assert.strictEqual(isWithin!(noon, "22:00", "07:00"), false);
  });
});

suite("ScheduleManager Minimum Interval Tests", () => {
  test("multi-line cron expressions produce distinct strict 40 minute runs", () => {
    const expression = [
      "0,40 0,2,4,6,8,10,12,14,16,18,20,22 * * *",
      "20 1,3,5,7,9,11,13,15,17,19,21,23 * * *",
    ].join("\n");
    const runs = getFirstDistinctCronRuns(
      expression,
      { currentDate: new Date("2026-05-09T00:00:00Z"), tz: "UTC" },
      4,
    );

    assert.deepStrictEqual(
      runs.map((date) => date.toISOString()),
      [
        "2026-05-09T00:40:00.000Z",
        "2026-05-09T01:20:00.000Z",
        "2026-05-09T02:00:00.000Z",
        "2026-05-09T02:40:00.000Z",
      ],
    );
  });

  test("multi-line cron expressions produce distinct strict 90 minute runs", () => {
    const expression = [
      "0 0,3,6,9,12,15,18,21 * * *",
      "30 1,4,7,10,13,16,19,22 * * *",
    ].join("\n");
    const runs = getFirstDistinctCronRuns(
      expression,
      { currentDate: new Date("2026-05-09T00:00:00Z"), tz: "UTC" },
      4,
    );

    assert.deepStrictEqual(
      runs.map((date) => date.toISOString()),
      [
        "2026-05-09T01:30:00.000Z",
        "2026-05-09T03:00:00.000Z",
        "2026-05-09T04:30:00.000Z",
        "2026-05-09T06:00:00.000Z",
      ],
    );
  });

  test("checkMinimumInterval handles multi-line strict intervals", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const strict40 = [
        "0,40 0,2,4,6,8,10,12,14,16,18,20,22 * * *",
        "20 1,3,5,7,9,11,13,15,17,19,21,23 * * *",
      ].join("\n");
      assert.strictEqual(manager.checkMinimumInterval(strict40), undefined);
      assert.strictEqual(
        manager.checkMinimumInterval("*/20 * * * *"),
        messages.minimumIntervalWarning(),
      );
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("validateCronExpression rejects multi-line cron with invalid line", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      assert.throws(
        () => manager.validateCronExpression("*/20 * * * *\ninvalid cron"),
        /無効なcron式|Invalid cron expression/,
      );
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("checkMinimumInterval falls back to local time when timezone is invalid", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = createManagerWithInvalidTimezone(tmp);
      const warning = manager.checkMinimumInterval("*/5 * * * *");
      assert.strictEqual(warning, messages.minimumIntervalWarning());
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("checkMinimumInterval returns undefined for long intervals even with invalid timezone", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = createManagerWithInvalidTimezone(tmp);
      const warning = manager.checkMinimumInterval("0 * * * *");
      assert.strictEqual(warning, undefined);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("createTask sets valid nextRun even when timezone is invalid (U9 fallback)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = createManagerWithInvalidTimezone(tmp);
      const task = await manager.createTask({
        name: "tz-fallback-test",
        prompt: "test",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });
      assert.ok(
        task.nextRun instanceof Date && !isNaN(task.nextRun.getTime()),
        "nextRun must be a valid Date even when timezone is invalid",
      );
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });
});

suite("ScheduleManager Prompt Source Migration Tests", () => {
  function setWorkspaceFoldersForTest(root: string): () => void {
    const wsAny = vscode.workspace as unknown as {
      workspaceFolders?: Array<{ uri: vscode.Uri }>;
    };
    const original = wsAny.workspaceFolders;
    try {
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        value: [{ uri: vscode.Uri.file(root) }],
        configurable: true,
      });
    } catch {
      // Best-effort: some VS Code versions may not allow redefining; leave as-is.
    }
    return () => {
      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: original,
          configurable: true,
        });
      } catch {
        // ignore
      }
    };
  }

  test("migrates missing promptSource to local when promptPath is under .github/prompts", () => {
    const wsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-ws-"),
    );
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });

    const templatePath = path.join(
      promptsDir,
      "__test_prompt_source_migration__.md",
    );

    try {
      fs.writeFileSync(templatePath, "hello", "utf8");

      const now = new Date();
      const rawTask = {
        id: "t-migrate-missing",
        name: "t",
        prompt: "OLD",
        cronExpression: "0 * * * *",
        enabled: false,
        scope: "global",
        promptPath: templatePath,
        // promptSource intentionally missing
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
      try {
        const manager = new ScheduleManager(
          createMockContextWithGlobalTasks(tmp, [rawTask]),
        );
        const loaded = manager.getTask(rawTask.id);
        assert.ok(loaded);
        assert.strictEqual(loaded?.promptSource, "local");
        assert.strictEqual(loaded?.promptPath, templatePath);
      } finally {
        try {
          fs.rmSync(tmp, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 50,
          });
        } catch {
          // ignore
        }
      }
    } finally {
      restoreWs();
      try {
        fs.rmSync(wsRoot, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("heals inline promptSource to local when promptPath exists under .github/prompts", () => {
    const wsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-ws-"),
    );
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });

    const templatePath = path.join(
      promptsDir,
      "__test_prompt_source_heal__.md",
    );

    try {
      fs.writeFileSync(templatePath, "hello", "utf8");

      const now = new Date();
      const rawTask = {
        id: "t-migrate-inline",
        name: "t",
        prompt: "OLD",
        cronExpression: "0 * * * *",
        enabled: false,
        scope: "global",
        promptSource: "inline",
        promptPath: templatePath,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
      try {
        const manager = new ScheduleManager(
          createMockContextWithGlobalTasks(tmp, [rawTask]),
        );
        const loaded = manager.getTask(rawTask.id);
        assert.ok(loaded);
        assert.strictEqual(loaded?.promptSource, "local");
        assert.strictEqual(loaded?.promptPath, templatePath);
      } finally {
        try {
          fs.rmSync(tmp, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 50,
          });
        } catch {
          // ignore
        }
      }
    } finally {
      restoreWs();
      try {
        fs.rmSync(wsRoot, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });
});

suite("ScheduleManager Jitter Migration Tests", () => {
  test("keeps jitterSeconds undefined for legacy tasks that do not have the field", () => {
    const now = new Date();
    const rawTask = {
      id: "t-jitter-legacy",
      name: "legacy",
      prompt: "hello",
      cronExpression: "0 * * * *",
      enabled: false,
      scope: "global",
      promptSource: "inline",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(
        createMockContextWithGlobalTasks(tmp, [rawTask]),
      );
      const loaded = manager.getTask(rawTask.id);
      assert.ok(loaded);
      assert.strictEqual(loaded?.jitterSeconds, undefined);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });
});

suite("ScheduleManager Scope Migration Persistence Tests", () => {
  test("persists default scope for legacy tasks when scope is missing", async () => {
    const now = new Date();
    const rawTask = {
      id: "t-scope-legacy",
      name: "legacy-scope",
      prompt: "hello",
      cronExpression: "0 * * * *",
      enabled: false,
      promptSource: "inline",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const storageFile = path.join(tmp, "scheduledTasks.json");
      fs.writeFileSync(storageFile, JSON.stringify([rawTask]), "utf8");

      const manager = new ScheduleManager(
        createMockContextWithGlobalTasks(tmp, [rawTask]),
      );

      const loaded = manager.getTask(rawTask.id);
      assert.ok(loaded);
      assert.strictEqual(loaded?.scope, "global");

      for (let i = 0; i < 20; i++) {
        const persisted = JSON.parse(
          fs.readFileSync(storageFile, "utf8"),
        ) as Array<{ id?: string; scope?: string }>;
        const persistedTask = persisted.find((t) => t.id === rawTask.id);
        if (persistedTask?.scope === "global") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const finalPersisted = JSON.parse(
        fs.readFileSync(storageFile, "utf8"),
      ) as Array<{ id?: string; scope?: string }>;
      const finalTask = finalPersisted.find((t) => t.id === rawTask.id);
      assert.ok(finalTask);
      assert.strictEqual(finalTask?.scope, "global");
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });
});

suite("ScheduleManager Corrupted Storage Recovery Tests", () => {
  test("does not throw when globalState scheduledTasks is not an array", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      assert.doesNotThrow(() => {
        const manager = new ScheduleManager(
          createMockContextWithGlobalStateValue(tmp, { invalid: true }),
        );
        assert.strictEqual(manager.getAllTasks().length, 0);
      });
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("heals non-array globalState scheduledTasks to an array", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const context = createMockContextWithGlobalStateValue(tmp, {
        invalid: true,
      });
      const manager = new ScheduleManager(context);
      assert.strictEqual(manager.getAllTasks().length, 0);

      for (let i = 0; i < 20; i++) {
        const persisted = context.globalState.get<unknown>("scheduledTasks");
        if (Array.isArray(persisted)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const finalPersisted = context.globalState.get<unknown>("scheduledTasks");
      assert.ok(Array.isArray(finalPersisted));
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("skips invalid task entries and keeps valid persisted tasks", () => {
    const nowIso = new Date().toISOString();
    const validTask = {
      id: "t-valid",
      name: "valid",
      prompt: "hello",
      cronExpression: "0 * * * *",
      enabled: false,
      scope: "global",
      promptSource: "inline",
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(
        createMockContextWithGlobalTasks(tmp, [42, { id: "bad" }, validTask]),
      );

      const tasks = manager.getAllTasks();
      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0].id, validTask.id);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("normalizes non-boolean enabled values to false", () => {
    const nowIso = new Date().toISOString();
    const rawTask = {
      id: "t-invalid-enabled",
      name: "invalid-enabled",
      prompt: "hello",
      cronExpression: "0 * * * *",
      enabled: "false",
      scope: "global",
      promptSource: "inline",
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(
        createMockContextWithGlobalTasks(tmp, [rawTask]),
      );

      const loaded = manager.getTask(rawTask.id);
      assert.ok(loaded);
      assert.strictEqual(loaded?.enabled, false);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("normalizes invalid scope and disables task for safety", () => {
    const nowIso = new Date().toISOString();
    const rawTask = {
      id: "t-invalid-scope",
      name: "invalid-scope",
      prompt: "hello",
      cronExpression: "0 * * * *",
      enabled: true,
      scope: "broken",
      promptSource: "inline",
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(
        createMockContextWithGlobalTasks(tmp, [rawTask]),
      );

      const loaded = manager.getTask(rawTask.id);
      assert.ok(loaded);
      assert.strictEqual(loaded?.scope, "global");
      assert.strictEqual(loaded?.enabled, false);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });
});

suite("ScheduleManager Workspace Scope Validation Tests", () => {
  test("createTask rejects workspace scope when no workspace is open", async () => {
    const restoreWs = overrideWorkspaceFoldersForTest(undefined);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));

      await assert.rejects(
        manager.createTask({
          name: "workspace-without-folder",
          prompt: "hello",
          cronExpression: "0 * * * *",
          scope: "workspace",
          promptSource: "inline",
          enabled: true,
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.message === messages.noWorkspaceOpen(),
      );
    } finally {
      restoreWs();
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("updateTask rejects switching to workspace scope when no workspace is open", async () => {
    const restoreWs = overrideWorkspaceFoldersForTest(undefined);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "global-task",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      await assert.rejects(
        manager.updateTask(task.id, { scope: "workspace" }),
        (error: unknown) =>
          error instanceof Error &&
          error.message === messages.noWorkspaceOpen(),
      );
    } finally {
      restoreWs();
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("healTaskModelSelections keeps unresolved strict variants", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const now = new Date().toISOString();
      const rawTask = {
        id: "t-unresolved-model-variant",
        name: "strict-variant-task",
        prompt: "hello",
        cronExpression: "0 * * * *",
        enabled: false,
        scope: "global",
        promptSource: "inline",
        model: "copilot-gpt-4o",
        modelName: "GPT-4o High",
        modelFamily: "gpt-4o",
        modelVersion: "high",
        createdAt: now,
        updatedAt: now,
      };

      const manager = new ScheduleManager(
        createMockContextWithGlobalTasks(tmp, [rawTask]),
      );

      const changed = await manager.healTaskModelSelections([
        {
          id: "copilot-gpt-4o",
          name: "GPT-4o Low",
          description: "",
          vendor: "OpenAI",
          family: "gpt-4o",
          version: "low",
        },
      ]);

      const loaded = manager.getTask(rawTask.id);
      assert.strictEqual(changed, 0);
      assert.ok(loaded);
      assert.strictEqual(loaded?.model, "copilot-gpt-4o");
      assert.strictEqual(loaded?.modelVersion, "high");
      assert.strictEqual(loaded?.modelName, "GPT-4o High");
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("healTaskModelSelections preserves Copilot CLI selections when still available", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const now = new Date().toISOString();
      const rawTask = {
        id: "t-copilotcli-model",
        name: "copilotcli-task",
        prompt: "hello",
        cronExpression: "0 * * * *",
        enabled: false,
        scope: "global",
        promptSource: "inline",
        model: "claude-opus-4.6-copilotcli-high",
        modelName: "Claude Opus 4.6 High (Copilotcli)",
        modelFamily: "claude-opus-4.6",
        modelVersion: "high",
        createdAt: now,
        updatedAt: now,
      };

      const manager = new ScheduleManager(
        createMockContextWithGlobalTasks(tmp, [rawTask]),
      );

      const changed = await manager.healTaskModelSelections([
        {
          id: "claude-opus-4.6-copilotcli-high",
          name: "Claude Opus 4.6 High (Copilotcli)",
          description: "",
          vendor: "Anthropic",
          family: "claude-opus-4.6",
          version: "high",
        },
      ]);

      const loaded = manager.getTask(rawTask.id);
      assert.strictEqual(changed, 1);
      assert.ok(loaded);
      assert.strictEqual(loaded?.model, "claude-opus-4.6-copilotcli-high");
      assert.strictEqual(loaded?.modelVersion, "high");
      assert.strictEqual(loaded?.modelFamily, "claude-opus-4.6");
      assert.strictEqual(
        loaded?.modelName,
        "Claude Opus 4.6 High (Copilotcli)",
      );
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("healTaskModelSelections migrates hidden saved models to visible Copilot models", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const now = new Date().toISOString();
      const rawTask = {
        id: "t-hidden-model",
        name: "hidden-model-task",
        prompt: "hello",
        cronExpression: "0 * * * *",
        enabled: false,
        scope: "global",
        promptSource: "inline",
        model: "claude-opus-4.6-hidden",
        modelName: "Claude Opus 4.6 (1M context)(Internal only)",
        modelVendor: "copilot",
        modelFamily: "claude-opus-4.6",
        createdAt: now,
        updatedAt: now,
      };

      const manager = new ScheduleManager(
        createMockContextWithGlobalTasks(tmp, [rawTask]),
      );

      const changed = await manager.healTaskModelSelections([
        {
          id: "claude-opus-4.6",
          name: "Claude Opus 4.6",
          description: "",
          vendor: "copilot",
          family: "claude-opus-4.6",
        },
      ]);

      const loaded = manager.getTask(rawTask.id);
      assert.strictEqual(changed, 1);
      assert.ok(loaded);
      assert.strictEqual(loaded?.model, "claude-opus-4.6");
      assert.strictEqual(loaded?.modelName, "Claude Opus 4.6");
      assert.strictEqual(loaded?.modelVendor, "copilot");
      assert.strictEqual(loaded?.modelFamily, "claude-opus-4.6");
      assert.strictEqual(loaded?.modelVersion, undefined);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("duplicateTask preserves workspacePath for workspace-scoped tasks", async () => {
    const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-a-"));
    const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-b-"));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));

    const restoreInitialWs = overrideWorkspaceFoldersForTest([
      { uri: vscode.Uri.file(workspaceA) },
      { uri: vscode.Uri.file(workspaceB) },
    ]);

    let restoreChangedWs: (() => void) | undefined;

    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const original = await manager.createTask({
        name: "workspace-duplicate-original",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "workspace",
        promptSource: "inline",
        enabled: false,
      });

      assert.strictEqual(
        normalizePathForAssertion(original.workspacePath || ""),
        normalizePathForAssertion(workspaceA),
      );

      restoreChangedWs = overrideWorkspaceFoldersForTest([
        { uri: vscode.Uri.file(workspaceB) },
        { uri: vscode.Uri.file(workspaceA) },
      ]);

      const duplicated = await manager.duplicateTask(original.id);
      assert.ok(duplicated);
      assert.strictEqual(duplicated?.scope, "workspace");
      assert.strictEqual(
        normalizePathForAssertion(duplicated?.workspacePath || ""),
        normalizePathForAssertion(original.workspacePath || ""),
      );
    } finally {
      if (restoreChangedWs) {
        restoreChangedWs();
      }
      restoreInitialWs();
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
      try {
        fs.rmSync(workspaceA, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
      try {
        fs.rmSync(workspaceB, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });
});

suite("ScheduleManager Auto Mode Tests", () => {
  test("createTask preserves task chatSession override", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "chat-session-override",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        chatSession: "continue",
      });

      assert.strictEqual(task.chatSession, "continue");
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("updateTask can reset task chatSession override to default", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "chat-session-reset",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        chatSession: "continue",
      });

      const updated = await manager.updateTask(task.id, {
        chatSession: "default",
      });

      assert.ok(updated);
      assert.strictEqual(updated?.chatSession, undefined);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("createTask uses autoModeDefault=false when autoMode is omitted", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "auto-mode-default-off",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      assert.strictEqual(task.autoMode, false);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("updateTask can change autoMode", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "auto-mode-update",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      const updated = await manager.updateTask(task.id, { autoMode: true });
      assert.ok(updated);
      assert.strictEqual(updated?.autoMode, true);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });
});

suite("ScheduleManager Task-Level Control Tests", () => {
  function toHHmm(date: Date): string {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  test("createTask persists per-task run limit and time window", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "task-control-create",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        maxExecutionsPerDay: 3,
        allowedTimeStart: "09:00",
        allowedTimeEnd: "18:00",
      });

      assert.strictEqual(task.maxExecutionsPerDay, 3);
      assert.strictEqual(task.allowedTimeStart, "09:00");
      assert.strictEqual(task.allowedTimeEnd, "18:00");
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("updateTask rejects invalid time window format", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "task-control-update",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      await assert.rejects(
        manager.updateTask(task.id, { allowedTimeStart: "25:00" }),
        (error: unknown) =>
          error instanceof Error &&
          error.message === messages.invalidTimeWindowFormat(),
      );
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("checkAndExecuteTasks skips execution outside allowed time window", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const now = new Date();
      const start = new Date(now.getTime() + 60 * 60 * 1000);
      const end = new Date(now.getTime() + 2 * 60 * 60 * 1000);

      const task = await manager.createTask({
        name: "task-window-skip",
        prompt: "hello",
        cronExpression: "*/1 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
        allowedTimeStart: toHHmm(start),
        allowedTimeEnd: toHHmm(end),
      });

      task.nextRun = new Date(Date.now() - 60 * 1000);

      let executed = 0;
      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        executed++;
      };

      await (
        manager as unknown as {
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).checkAndExecuteTasks?.();

      assert.strictEqual(executed, 0);
      assert.strictEqual(task.lastRun, undefined);
      assert.ok(task.nextRun instanceof Date);
      assert.ok((task.nextRun as Date).getTime() > Date.now() - 1000);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("checkAndExecuteTasks re-checks allowed window after jitter", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const now = new Date();
      const initialStart = toHHmm(new Date(now.getTime() - 10 * 60 * 1000));
      const initialEnd = toHHmm(new Date(now.getTime() + 10 * 60 * 1000));
      const outsideStart = toHHmm(new Date(now.getTime() + 10 * 60 * 1000));
      const outsideEnd = toHHmm(new Date(now.getTime() + 15 * 60 * 1000));

      const task = await manager.createTask({
        name: "task-window-post-jitter-skip",
        prompt: "hello",
        cronExpression: "*/1 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 1,
        allowedTimeStart: initialStart,
        allowedTimeEnd: initialEnd,
      });

      task.nextRun = new Date(Date.now() - 60 * 1000);

      let executed = 0;
      (
        manager as unknown as {
          applyJitter?: (maxJitterSeconds: number) => Promise<void>;
          onExecuteCallback?: (task: unknown) => Promise<void>;
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).applyJitter = async () => {
        task.allowedTimeStart = outsideStart;
        task.allowedTimeEnd = outsideEnd;
      };
      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        executed++;
      };

      await (
        manager as unknown as {
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).checkAndExecuteTasks?.();

      assert.strictEqual(executed, 0);
      assert.strictEqual(task.lastRun, undefined);
      assert.ok(task.nextRun instanceof Date);
      assert.ok((task.nextRun as Date).getTime() > Date.now() - 1000);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("checkAndExecuteTasks skips execution when per-task daily limit reached", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "task-limit-skip",
        prompt: "hello",
        cronExpression: "*/1 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
        maxExecutionsPerDay: 1,
      });

      task.nextRun = new Date(Date.now() - 60 * 1000);

      const today = new Date();
      const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      (
        manager as unknown as {
          dailyTaskExecDate?: string;
          dailyTaskExecCounts?: Record<string, number>;
          onExecuteCallback?: (task: unknown) => Promise<void>;
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).dailyTaskExecDate = dateKey;
      (
        manager as unknown as {
          dailyTaskExecCounts?: Record<string, number>;
        }
      ).dailyTaskExecCounts = { [task.id]: 1 };

      let executed = 0;
      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        executed++;
      };

      await (
        manager as unknown as {
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).checkAndExecuteTasks?.();

      assert.strictEqual(executed, 0);
      assert.strictEqual(task.lastRun, undefined);
      assert.ok(task.nextRun instanceof Date);
      assert.ok((task.nextRun as Date).getTime() > Date.now() - 1000);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("checkAndExecuteTasks treats corrupted persisted daily count as zero", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const context = createMockContext(tmp);
      const today = new Date();
      const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

      await context.globalState.update("dailyExecDate", dateKey);
      await context.globalState.update("dailyExecCount", "not-a-number");

      const manager = new ScheduleManager(context);
      const task = await manager.createTask({
        name: "daily-count-corruption",
        prompt: "hello",
        cronExpression: "*/1 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
      });

      task.nextRun = new Date(Date.now() - 60 * 1000);

      const originalGetConfiguration = vscode.workspace.getConfiguration;
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        value: ((section?: string) => {
          const config = originalGetConfiguration.call(
            vscode.workspace,
            section,
          );
          if (section !== "copilotScheduler") {
            return config;
          }
          return {
            ...config,
            get<T>(key: string, defaultValue?: T): T {
              if (key === "maxDailyExecutions") {
                return 1 as T;
              }
              return config.get<T>(key, defaultValue as T);
            },
          };
        }) as typeof vscode.workspace.getConfiguration,
        configurable: true,
      });

      let executed = 0;
      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        executed++;
      };

      try {
        await (
          manager as unknown as {
            checkAndExecuteTasks?: () => Promise<void>;
          }
        ).checkAndExecuteTasks?.();
      } finally {
        Object.defineProperty(vscode.workspace, "getConfiguration", {
          value: originalGetConfiguration,
          configurable: true,
        });
      }

      assert.strictEqual(executed, 1);
      assert.ok(task.lastRun instanceof Date);
      assert.strictEqual(context.globalState.get<number>("dailyExecCount"), 1);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("checkAndExecuteTasks floors decimal maxDailyExecutions before enforcing the limit", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "daily-limit-decimal",
        prompt: "hello",
        cronExpression: "*/1 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
      });

      task.nextRun = new Date(Date.now() - 60 * 1000);

      const today = new Date();
      const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      (
        manager as unknown as {
          dailyExecDate?: string;
          dailyExecCount?: number;
          onExecuteCallback?: (task: unknown) => Promise<void>;
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).dailyExecDate = dateKey;
      (
        manager as unknown as {
          dailyExecCount?: number;
        }
      ).dailyExecCount = 1;

      const originalGetConfiguration = vscode.workspace.getConfiguration;
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        value: ((section?: string) => {
          const config = originalGetConfiguration.call(
            vscode.workspace,
            section,
          );
          if (section !== "copilotScheduler") {
            return config;
          }
          return {
            ...config,
            get<T>(key: string, defaultValue?: T): T {
              if (key === "maxDailyExecutions") {
                return 1.9 as T;
              }
              return config.get<T>(key, defaultValue as T);
            },
          };
        }) as typeof vscode.workspace.getConfiguration,
        configurable: true,
      });

      let executed = 0;
      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        executed++;
      };

      try {
        await (
          manager as unknown as {
            checkAndExecuteTasks?: () => Promise<void>;
          }
        ).checkAndExecuteTasks?.();
      } finally {
        Object.defineProperty(vscode.workspace, "getConfiguration", {
          value: originalGetConfiguration,
          configurable: true,
        });
      }

      assert.strictEqual(executed, 0);
      assert.strictEqual(task.lastRun, undefined);
      assert.ok(task.nextRun instanceof Date);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });
});

suite("ScheduleManager Invalid Cron Enable Safety Tests", () => {
  function createManagerWithDisabledInvalidCronTask(
    tmp: string,
    taskId: string,
  ): ScheduleManager {
    const nowIso = new Date().toISOString();
    const rawTask = {
      id: taskId,
      name: `task-${taskId}`,
      prompt: "hello",
      cronExpression: "invalid cron",
      enabled: false,
      scope: "global",
      promptSource: "inline",
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    return new ScheduleManager(
      createMockContextWithGlobalTasks(tmp, [rawTask]),
    );
  }

  test("toggleTask rejects enabling task with invalid cron expression", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = createManagerWithDisabledInvalidCronTask(
        tmp,
        "t-toggle-invalid-cron",
      );

      await assert.rejects(
        manager.toggleTask("t-toggle-invalid-cron"),
        (error: unknown) =>
          error instanceof Error &&
          error.message === messages.invalidCronExpression(),
      );

      const task = manager.getTask("t-toggle-invalid-cron");
      assert.ok(task);
      assert.strictEqual(task?.enabled, false);
      assert.strictEqual(task?.nextRun, undefined);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("setTaskEnabled rejects enabling task with invalid cron expression", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = createManagerWithDisabledInvalidCronTask(
        tmp,
        "t-set-enabled-invalid-cron",
      );

      await assert.rejects(
        manager.setTaskEnabled("t-set-enabled-invalid-cron", true),
        (error: unknown) =>
          error instanceof Error &&
          error.message === messages.invalidCronExpression(),
      );

      const task = manager.getTask("t-set-enabled-invalid-cron");
      assert.ok(task);
      assert.strictEqual(task?.enabled, false);
      assert.strictEqual(task?.nextRun, undefined);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("updateTask rejects enabling task with invalid cron expression", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = createManagerWithDisabledInvalidCronTask(
        tmp,
        "t-update-enabled-invalid-cron",
      );

      await assert.rejects(
        manager.updateTask("t-update-enabled-invalid-cron", { enabled: true }),
        (error: unknown) =>
          error instanceof Error &&
          error.message === messages.invalidCronExpression(),
      );

      const task = manager.getTask("t-update-enabled-invalid-cron");
      assert.ok(task);
      assert.strictEqual(task?.enabled, false);
      assert.strictEqual(task?.nextRun, undefined);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });
});

suite("ScheduleManager Task Change Callback Tests", () => {
  test("notifies both primary and additional callbacks", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      let primaryCount = 0;
      let secondaryCount = 0;

      manager.setOnTasksChangedCallback(() => {
        primaryCount++;
      });
      manager.addOnTasksChangedCallback(() => {
        secondaryCount++;
      });

      const notify = (manager as unknown as { notifyTasksChanged: () => void })
        .notifyTasksChanged;
      notify.call(manager);

      assert.strictEqual(primaryCount, 1);
      assert.strictEqual(secondaryCount, 1);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("continues notifying remaining callbacks when one callback throws", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      let secondaryCount = 0;

      manager.setOnTasksChangedCallback(() => {
        throw new Error("callback failed");
      });
      manager.addOnTasksChangedCallback(() => {
        secondaryCount++;
      });

      const notify = (manager as unknown as { notifyTasksChanged: () => void })
        .notifyTasksChanged;

      assert.doesNotThrow(() => {
        notify.call(manager);
      });
      assert.strictEqual(secondaryCount, 1);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });
});

suite("ScheduleManager RunNow Tests", () => {
  test("runTaskNowDetailed returns taskNotFound when task does not exist", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));

      const result = await manager.runTaskNowDetailed("missing-task-id");
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.reason, "taskNotFound");
      }
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("runTaskNowDetailed returns executorUnavailable when callback is missing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "run-now-detailed-executor-unavailable",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      const result = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.reason, "executorUnavailable");
      }
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("runTaskNowDetailed returns alreadyRunning when the same task is in flight", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "run-now-detailed-already-running",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      let release!: () => void;
      const blocker = new Promise<void>((resolve) => {
        release = resolve;
      });

      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
        }
      ).onExecuteCallback = async () => blocker;

      const firstRun = manager.runTaskNowDetailed(task.id);
      await Promise.resolve();

      const secondRun = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(secondRun.ok, false);
      if (!secondRun.ok) {
        assert.strictEqual(secondRun.reason, "alreadyRunning");
      }

      release();
      const firstResult = await firstRun;
      assert.strictEqual(firstResult.ok, true);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("checkAndExecuteTasks skips overlapping auto execution while a task is already running", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "auto-overlap-skip",
        prompt: "hello",
        cronExpression: "*/1 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
      });

      let release!: () => void;
      const blocker = new Promise<void>((resolve) => {
        release = resolve;
      });
      let executions = 0;

      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        executions++;
        await blocker;
      };

      const manualRun = manager.runTaskNowDetailed(task.id);
      await Promise.resolve();

      task.nextRun = new Date(Date.now() - 60 * 1000);
      await (
        manager as unknown as {
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).checkAndExecuteTasks?.();

      assert.strictEqual(executions, 1);
      assert.ok(task.nextRun instanceof Date);
      assert.ok((task.nextRun as Date).getTime() > Date.now() - 1000);

      release();
      const manualResult = await manualRun;
      assert.strictEqual(manualResult.ok, true);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("runTaskNowDetailed returns executionFailed when callback throws", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "run-now-detailed-exec-fail",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        throw new Error("execute failed");
      };

      const result = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.reason, "executionFailed");
        assert.ok(typeof result.errorMessage === "string");
        assert.ok(result.errorMessage.length > 0);
        assert.strictEqual(result.userNotified, false);
      }
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("runTaskNowDetailed returns saveFailed when saveTasks throws", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "run-now-detailed-save-fail",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
          saveTasks?: () => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        // no-op
      };
      (
        manager as unknown as {
          saveTasks?: () => Promise<void>;
        }
      ).saveTasks = async () => {
        throw new Error("save failed");
      };

      const result = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.reason, "saveFailed");
        assert.ok(typeof result.errorMessage === "string");
        assert.ok(result.errorMessage.length > 0);
      }
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("runTaskNowDetailed rolls back lastRun/nextRun when saveTasks throws", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "run-now-detailed-rollback",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      const previousLastRun = new Date(Date.now() - 20 * 60 * 1000);
      const previousNextRun = new Date(Date.now() + 15 * 60 * 1000);
      task.lastRun = previousLastRun;
      task.nextRun = previousNextRun;

      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
          saveTasks?: () => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        // no-op
      };
      (
        manager as unknown as {
          saveTasks?: () => Promise<void>;
        }
      ).saveTasks = async () => {
        throw new Error("save failed");
      };

      const result = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.reason, "saveFailed");
      }

      assert.ok(task.lastRun instanceof Date);
      assert.strictEqual(
        (task.lastRun as Date).getTime(),
        previousLastRun.getTime(),
      );
      assert.ok(task.nextRun instanceof Date);
      assert.strictEqual(
        (task.nextRun as Date).getTime(),
        previousNextRun.getTime(),
      );
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("runTaskNowDetailed keeps undefined run state when saveTasks throws", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "run-now-detailed-rollback-undefined",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      task.lastRun = undefined;
      task.nextRun = undefined;

      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
          saveTasks?: () => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        // no-op
      };
      (
        manager as unknown as {
          saveTasks?: () => Promise<void>;
        }
      ).saveTasks = async () => {
        throw new Error("save failed");
      };

      const result = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.reason, "saveFailed");
      }

      assert.strictEqual(task.lastRun, undefined);
      assert.strictEqual(task.nextRun, undefined);
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("runTaskNowDetailed preserves user-notified marker on execution failure", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "run-now-detailed-exec-fail-notified",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        const err = new Error("execute failed (notified)");
        (err as unknown as Record<string, unknown>)[
          "copilotSchedulerUserNotified"
        ] = true;
        throw err;
      };

      const result = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.reason, "executionFailed");
        assert.strictEqual(result.userNotified, true);
      }
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("runTaskNow advances nextRun when future nextRun already exists", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "run-now-next-run",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      const futureNextRun = new Date(Date.now() + 10 * 60 * 1000);
      task.nextRun = futureNextRun;

      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        // no-op
      };

      const ok = await manager.runTaskNow(task.id);
      assert.strictEqual(ok, true);
      assert.ok(task.nextRun instanceof Date);
      assert.ok((task.nextRun as Date).getTime() > futureNextRun.getTime());
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("runTaskNow recalculates from now when policy is fromNow", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "run-now-from-now",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });

      const futureNextRun = new Date(Date.now() + 10 * 60 * 1000);
      task.nextRun = futureNextRun;

      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
          getManualRunNextRunPolicy?: () => "advance" | "fromNow";
        }
      ).onExecuteCallback = async () => {
        // no-op
      };
      (
        manager as unknown as {
          getManualRunNextRunPolicy?: () => "advance" | "fromNow";
        }
      ).getManualRunNextRunPolicy = () => "fromNow";

      const ok = await manager.runTaskNow(task.id);
      assert.strictEqual(ok, true);
      assert.ok(task.nextRun instanceof Date);
      assert.ok((task.nextRun as Date).getTime() < futureNextRun.getTime());
    } finally {
      try {
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });
});

suite("ScheduleManager Scheduler Alignment Tests", () => {
  test("millisecondsUntilNextMinute returns 0 at exact minute boundary", () => {
    const delay = (
      ScheduleManager as unknown as {
        millisecondsUntilNextMinute: (now: Date) => number;
      }
    ).millisecondsUntilNextMinute(new Date("2026-02-28T10:20:00.000Z"));

    assert.strictEqual(delay, 0);
  });

  test("millisecondsUntilNextMinute returns remaining time within minute", () => {
    const delay = (
      ScheduleManager as unknown as {
        millisecondsUntilNextMinute: (now: Date) => number;
      }
    ).millisecondsUntilNextMinute(new Date("2026-02-28T10:20:12.250Z"));

    assert.strictEqual(delay, 47750);
  });
});
