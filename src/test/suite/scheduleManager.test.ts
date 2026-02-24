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

function createManagerWithInvalidTimezone(storageRoot: string): ScheduleManager {
  const manager = new ScheduleManager(createMockContext(storageRoot));
  // Avoid VS Code configuration writes in tests; patch the instance instead.
  (manager as unknown as { getTimeZone: () => string | undefined }).getTimeZone =
    () => "Invalid/Timezone";
  return manager;
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
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-ws-"));
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });

    const templatePath = path.join(promptsDir, "__test_prompt_source_migration__.md");

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
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-ws-"));
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });

    const templatePath = path.join(promptsDir, "__test_prompt_source_heal__.md");

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
