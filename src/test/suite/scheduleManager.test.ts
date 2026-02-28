import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ScheduleManager } from "../../scheduleManager";
import { messages } from "../../i18n";

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

suite("ScheduleManager Minimum Interval Tests", () => {
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
});

suite("ScheduleManager Auto Mode Tests", () => {
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
