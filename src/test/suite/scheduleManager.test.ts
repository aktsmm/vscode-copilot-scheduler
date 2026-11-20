import * as assert from "assert";
import type { ModelInfo, ScheduledTask } from "../../types";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ScheduleManager, __testOnly } from "../../scheduleManager";
import "./tempFolderGuard";
import { messages } from "../../i18n";
import { getFirstDistinctCronRuns } from "../../cronExpressions";
import { createSchedulerRunTaskTool } from "../../lmTools/tools/runTask";
import { createPromptBlockedError } from "../../promptExecutionErrors";

function normalizePathForAssertion(p: string): string {
  const resolved = path.normalize(path.resolve(p));
  const root = path.parse(resolved).root;
  const trimmed =
    resolved === root ? resolved : resolved.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function truncateToMinute(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
  );
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

function overrideSchedulerConfig(values: Record<string, unknown>): () => void {
  const original = vscode.workspace.getConfiguration;
  Object.defineProperty(vscode.workspace, "getConfiguration", {
    configurable: true,
    value: ((section?: string) => {
      const config = original.call(vscode.workspace, section);
      if (section !== "copilotScheduler") return config;
      return {
        ...config,
        get<T>(key: string, defaultValue?: T): T {
          return Object.prototype.hasOwnProperty.call(values, key)
            ? (values[key] as T)
            : config.get<T>(key, defaultValue as T);
        },
      };
    }) as typeof vscode.workspace.getConfiguration,
  });
  return () =>
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      value: original,
      configurable: true,
    });
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

async function waitForStartupSave(manager: ScheduleManager): Promise<void> {
  await (manager as unknown as { saveQueue: Promise<void> }).saveQueue;
}

async function waitForSignal(signal: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for a test signal")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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

suite("ScheduleManager Dynamic Model Configuration", () => {
  test("startup healing persists equivalent legacy options exactly once", async () => {
    const provider = require("../../configured-model-provider");
    const descriptor = Object.getOwnPropertyDescriptor(
      provider,
      "supportsConfiguredModelExecution",
    )!;
    const permissionDescriptor = Object.getOwnPropertyDescriptor(
      provider,
      "supportsSystemMessageForwarding",
    )!;
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "scheduler-option-migration-"),
    );
    const manager = new ScheduleManager(createMockContext(root));
    try {
      await waitForStartupSave(manager);
      const task = await manager.createTask({
        name: "legacy",
        prompt: "synthetic",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
        model: "shared",
        modelVendor: "copilot",
        modelReasoningEffort: "high",
      });
      const models: ModelInfo[] = [
        {
          id: "shared",
          name: "Shared",
          vendor: "copilot",
          description: "",
          configurationStatus: "available",
          configurationOptions: [
            {
              key: "reasoningEffort",
              label: "Thinking",
              choices: [{ value: "high", label: "High" }],
            },
          ],
        },
      ];
      Object.defineProperty(provider, "supportsConfiguredModelExecution", {
        ...descriptor,
        value: () => true,
      });
      Object.defineProperty(provider, "supportsSystemMessageForwarding", {
        ...permissionDescriptor,
        value: () => false,
      });
      await manager.healTaskModelSelections(models);
      assert.strictEqual(
        manager.getTask(task.id)?.modelConfiguration,
        undefined,
      );
      assert.strictEqual(
        manager.getTask(task.id)?.modelReasoningEffort,
        "high",
      );
      Object.defineProperty(provider, "supportsSystemMessageForwarding", {
        ...permissionDescriptor,
        value: () => true,
      });
      assert.strictEqual(await manager.healTaskModelSelections(models), 1);
      assert.deepStrictEqual(manager.getTask(task.id)?.modelConfiguration, {
        reasoningEffort: "high",
      });
      assert.strictEqual(
        manager.getTask(task.id)?.modelReasoningEffort,
        undefined,
      );
      assert.strictEqual(await manager.healTaskModelSelections(models), 0);
      const stored = JSON.parse(
        fs.readFileSync(path.join(root, "scheduledTasks.json"), "utf8"),
      );
      assert.deepStrictEqual(
        stored.find((entry: ScheduledTask) => entry.id === task.id)
          .modelConfiguration,
        { reasoningEffort: "high" },
      );
    } finally {
      Object.defineProperty(
        provider,
        "supportsSystemMessageForwarding",
        permissionDescriptor,
      );
      Object.defineProperty(
        provider,
        "supportsConfiguredModelExecution",
        descriptor,
      );
      manager.stopScheduler();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("direct dynamic updates replace legacy effort while rejecting explicit conflicts", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "scheduler-direct-migration-"),
    );
    const manager = new ScheduleManager(createMockContext(root));
    try {
      await waitForStartupSave(manager);
      const task = await manager.createTask({
        name: "legacy",
        prompt: "synthetic",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
        model: "shared",
        modelVendor: "copilot",
        modelReasoningEffort: "high",
      });
      await manager.updateTask(task.id, {
        modelConfiguration: { reasoningEffort: "low" },
      });
      assert.deepStrictEqual(manager.getTask(task.id)?.modelConfiguration, {
        reasoningEffort: "low",
      });
      assert.strictEqual(
        manager.getTask(task.id)?.modelReasoningEffort,
        undefined,
      );
      await assert.rejects(
        manager.updateTask(task.id, {
          modelConfiguration: { reasoningEffort: "low" },
          modelReasoningEffort: "high",
        }),
        /conflicts/,
      );
    } finally {
      manager.stopScheduler();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("direct model reset clears saved identity and dynamic options", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "scheduler-model-reset-"),
    );
    const manager = new ScheduleManager(createMockContext(root));
    try {
      await waitForStartupSave(manager);
      const task = await manager.createTask({
        name: "reset",
        prompt: "synthetic",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
        model: "shared",
        modelName: "Shared",
        modelVendor: "bridge",
        modelFamily: "shared",
        modelVersion: "1",
        modelConfiguration: { mode: "normal:high" },
      });
      await manager.updateTask(task.id, {
        model: "shared",
        modelVendor: "bridge",
      });
      assert.deepStrictEqual(manager.getTask(task.id)?.modelConfiguration, {
        mode: "normal:high",
      });
      await manager.updateTask(task.id, { modelVendor: "other" });
      assert.deepStrictEqual(manager.getTask(task.id)?.modelConfiguration, {});
      await manager.updateTask(task.id, {
        modelVendor: "third",
        modelConfiguration: { mode: "normal:high" },
      });
      assert.deepStrictEqual(manager.getTask(task.id)?.modelConfiguration, {
        mode: "normal:high",
      });
      await manager.updateTask(task.id, { model: "" });
      for (const key of [
        "model",
        "modelName",
        "modelVendor",
        "modelFamily",
        "modelVersion",
        "modelReasoningEffort",
        "modelConfiguration",
      ] as const) {
        assert.strictEqual(manager.getTask(task.id)?.[key], undefined, key);
      }
    } finally {
      manager.stopScheduler();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  test("retains invalid or future maps without aborting load, healing or unrelated saves", async () => {
    for (const rawMap of [null, { thinkingBudget: "future" }]) {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "scheduler-invalid-config-"),
      );
      const now = new Date().toISOString();
      const seed = ["before", "invalid", "after"].map((id) => ({
        id,
        name: id,
        prompt: "synthetic",
        cronExpression: "0 9 * * *",
        enabled: false,
        scope: "global",
        promptSource: "inline",
        createdAt: now,
        updatedAt: now,
        model: "shared",
        modelVendor: "copilot",
        ...(id === "invalid" ? { modelConfiguration: rawMap } : {}),
      }));
      const manager = new ScheduleManager(
        createMockContextWithGlobalTasks(root, seed),
      );
      try {
        await waitForStartupSave(manager);
        assert.strictEqual(manager.getAllTasks().length, 3);
        assert.deepStrictEqual(
          manager.getTask("invalid")?.modelConfiguration,
          rawMap,
        );
        await manager.healTaskModelSelections([
          { id: "shared", name: "Shared", vendor: "copilot", description: "" },
        ]);
        assert.strictEqual(manager.getAllTasks().length, 3);
        assert.deepStrictEqual(
          manager.getTask("invalid")?.modelConfiguration,
          rawMap,
        );
        const invalidBefore = JSON.stringify(manager.getTask("invalid"));
        await assert.rejects(
          manager.updateTask("invalid", {
            name: "must-not-save",
            enabled: true,
            modelVendor: "copilot",
          }),
        );
        assert.strictEqual(
          JSON.stringify(manager.getTask("invalid")),
          invalidBefore,
        );
        await manager.updateTask("after", { name: "renamed" });
        const saved = JSON.parse(
          fs.readFileSync(path.join(root, "scheduledTasks.json"), "utf8"),
        );
        assert.strictEqual(saved.length, 3);
        assert.strictEqual(
          saved.find((task: { id: string }) => task.id === "invalid").enabled,
          false,
        );
        assert.strictEqual(
          saved.find((task: { id: string }) => task.id === "invalid").name,
          "invalid",
        );
        assert.deepStrictEqual(
          saved.find((task: { id: string }) => task.id === "invalid")
            .modelConfiguration,
          rawMap,
        );
        await manager.updateTask("invalid", { modelConfiguration: {} });
        assert.deepStrictEqual(
          manager.getTask("invalid")?.modelConfiguration,
          {},
        );
      } finally {
        manager.stopScheduler();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
  test("preserves typed settings on first save, unrelated update, duplicate and reload", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "scheduler-dynamic-store-"),
    );
    const storage = path.join(root, "new-profile", "scheduler");
    const context = createMockContext(storage);
    const manager = new ScheduleManager(context);
    let reloaded: ScheduleManager | undefined;
    try {
      await waitForStartupSave(manager);
      const task = await manager.createTask({
        name: "dynamic store",
        prompt: "synthetic",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
        model: "dynamic",
        modelVendor: "bridge",
        modelConfiguration: { mode: "fast:high", contextSize: 4096 },
      });
      await manager.updateTask(task.id, { name: "renamed" });
      const duplicate = await manager.duplicateTask(task.id);
      assert.deepStrictEqual(duplicate?.modelConfiguration, {
        mode: "fast:high",
        contextSize: 4096,
      });
      reloaded = new ScheduleManager(context);
      await waitForStartupSave(reloaded);
      assert.deepStrictEqual(reloaded.getTask(task.id)?.modelConfiguration, {
        mode: "fast:high",
        contextSize: 4096,
      });
      await reloaded.updateTask(task.id, { model: "another" });
      assert.deepStrictEqual(reloaded.getTask(task.id)?.modelConfiguration, {});
    } finally {
      manager.stopScheduler();
      reloaded?.stopScheduler();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

suite("ScheduleManager Agent Host Workspace Mode", () => {
  test("creates both modes and preserves them through duplicate, reload and all stores", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".workspace-mode-test-"));
    const context = createMockContext(root);
    const manager = new ScheduleManager(context);
    let reloaded: ScheduleManager | undefined;
    try {
      await waitForStartupSave(manager);
      for (const mode of ["folder", "worktree"] as const) {
        const task = await manager.createTask({
          name: mode,
          prompt: "synthetic",
          cronExpression: "0 9 * * *",
          scope: "global",
          enabled: false,
          agentHostWorkspaceMode: mode,
        });
        assert.strictEqual(task.agentHostWorkspaceMode, mode);
        const duplicate = await manager.duplicateTask(task.id);
        assert.strictEqual(duplicate?.agentHostWorkspaceMode, mode);
      }

      const payload = JSON.parse(
        fs.readFileSync(path.join(root, "scheduledTasks.json"), "utf8"),
      ) as ScheduledTask[];
      const meta = JSON.parse(
        fs.readFileSync(path.join(root, "scheduledTasks.meta.json"), "utf8"),
      ) as { tasksSnapshot: ScheduledTask[] };
      const mirror = context.globalState.get<ScheduledTask[]>("scheduledTasks");
      const mirrorMeta = context.globalState.get<{ tasksSnapshot: ScheduledTask[] }>(
        "scheduledTasksSnapshot",
      );
      assert.ok(mirrorMeta);
      reloaded = new ScheduleManager(context);
      await waitForStartupSave(reloaded);
      for (const task of manager.getAllTasks()) {
        for (const tasks of [payload, meta.tasksSnapshot, mirror, mirrorMeta?.tasksSnapshot]) {
          assert.strictEqual(
            tasks?.find((saved) => saved.id === task.id)?.agentHostWorkspaceMode,
            task.agentHostWorkspaceMode,
          );
        }
        assert.strictEqual(
          reloaded.getTask(task.id)?.agentHostWorkspaceMode,
          task.agentHostWorkspaceMode,
        );
      }
    } finally {
      manager.stopScheduler();
      reloaded?.stopScheduler();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("omits default on create, preserves omitted updates and explicitly resets the override", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".workspace-mode-test-"));
    const context = createMockContext(root);
    const manager = new ScheduleManager(context);
    let reloaded: ScheduleManager | undefined;
    try {
      await waitForStartupSave(manager);
      for (const mode of [undefined, "default"] as const) {
        const task = await manager.createTask({
          name: "default",
          prompt: "synthetic",
          cronExpression: "0 9 * * *",
          scope: "global",
          enabled: false,
          agentHostWorkspaceMode: mode,
        });
        assert.strictEqual(Object.hasOwn(task, "agentHostWorkspaceMode"), false);
        await manager.updateTask(task.id, { agentHostWorkspaceMode: "folder" });
        await manager.updateTask(task.id, { name: "renamed" });
        await manager.updateTask(task.id, { agentHostWorkspaceMode: undefined });
        assert.strictEqual(manager.getTask(task.id)?.agentHostWorkspaceMode, "folder");
        await manager.updateTask(task.id, { agentHostWorkspaceMode: "worktree" });
        assert.strictEqual(manager.getTask(task.id)?.agentHostWorkspaceMode, "worktree");
        await manager.updateTask(task.id, { agentHostWorkspaceMode: "default" });
        assert.strictEqual(Object.hasOwn(task, "agentHostWorkspaceMode"), false);
      }
      const payload = fs.readFileSync(path.join(root, "scheduledTasks.json"), "utf8");
      const meta = fs.readFileSync(path.join(root, "scheduledTasks.meta.json"), "utf8");
      assert.strictEqual(payload.includes('"agentHostWorkspaceMode"'), false);
      assert.strictEqual(meta.includes('"agentHostWorkspaceMode"'), false);
      assert.strictEqual(
        JSON.stringify(context.globalState.get("scheduledTasks")).includes('"agentHostWorkspaceMode"'),
        false,
      );
      assert.strictEqual(
        JSON.stringify(context.globalState.get("scheduledTasksSnapshot")).includes('"agentHostWorkspaceMode"'),
        false,
      );
      reloaded = new ScheduleManager(context);
      await waitForStartupSave(reloaded);
      assert.ok(reloaded.getAllTasks().every((task) => !Object.hasOwn(task, "agentHostWorkspaceMode")));
    } finally {
      manager.stopScheduler();
      reloaded?.stopScheduler();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid incoming modes before mutating tasks or either store", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".workspace-mode-test-"));
    const context = createMockContext(root);
    const manager = new ScheduleManager(context);
    try {
      await waitForStartupSave(manager);
      const input = {
        name: "original",
        prompt: "synthetic",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
      } as const;
      const task = await manager.createTask({ ...input, agentHostWorkspaceMode: "folder" });
      const before = JSON.stringify(manager.getAllTasks());
      const payload = fs.readFileSync(path.join(root, "scheduledTasks.json"), "utf8");
      const meta = fs.readFileSync(path.join(root, "scheduledTasks.meta.json"), "utf8");
      const mirror = JSON.stringify(context.globalState.get("scheduledTasks"));
      const mirrorMeta = JSON.stringify(context.globalState.get("scheduledTasksSnapshot"));
      for (const mode of [null, "", "Folder", "future", true, 0, {}]) {
        await assert.rejects(
          manager.createTask(JSON.parse(JSON.stringify({ ...input, agentHostWorkspaceMode: mode }))),
          { message: messages.agentHostWorkspaceModeInvalid() },
        );
        await assert.rejects(
          manager.updateTask(task.id, JSON.parse(JSON.stringify({
            name: "must-not-save",
            enabled: true,
            agentHostWorkspaceMode: mode,
          }))),
          { message: messages.agentHostWorkspaceModeInvalid() },
        );
        assert.strictEqual(JSON.stringify(manager.getAllTasks()), before);
      }
      assert.strictEqual(fs.readFileSync(path.join(root, "scheduledTasks.json"), "utf8"), payload);
      assert.strictEqual(fs.readFileSync(path.join(root, "scheduledTasks.meta.json"), "utf8"), meta);
      assert.strictEqual(JSON.stringify(context.globalState.get("scheduledTasks")), mirror);
      assert.strictEqual(JSON.stringify(context.globalState.get("scheduledTasksSnapshot")), mirrorMeta);
    } finally {
      manager.stopScheduler();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("retains unknown stored modes through reload and unrelated saves until explicit repair", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".workspace-mode-test-"));
    const now = new Date().toISOString();
    const rawTasks = [null, "future", "default"].map((mode, index) => ({
      id: `workspace-${index}`,
      name: "stored",
      prompt: "synthetic",
      cronExpression: "0 9 * * *",
      scope: "global",
      promptSource: "inline",
      enabled: false,
      createdAt: now,
      updatedAt: now,
      agentHostWorkspaceMode: mode,
    }));
    const context = createMockContextWithGlobalTasks(root, rawTasks);
    const manager = new ScheduleManager(context);
    let reloaded: ScheduleManager | undefined;
    try {
      await waitForStartupSave(manager);
      for (const rawTask of rawTasks) {
        assert.strictEqual(manager.getTask(rawTask.id)?.agentHostWorkspaceMode, rawTask.agentHostWorkspaceMode);
        await manager.updateTask(rawTask.id, { name: "renamed" });
      }
      reloaded = new ScheduleManager(context);
      await waitForStartupSave(reloaded);
      for (const rawTask of rawTasks) {
        assert.strictEqual(reloaded.getTask(rawTask.id)?.agentHostWorkspaceMode, rawTask.agentHostWorkspaceMode);
        await reloaded.updateTask(rawTask.id, { agentHostWorkspaceMode: "default" });
        assert.strictEqual(Object.hasOwn(reloaded.getTask(rawTask.id)!, "agentHostWorkspaceMode"), false);
      }
    } finally {
      manager.stopScheduler();
      reloaded?.stopScheduler();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

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

  test("the allowed time window reads the scheduler timezone, not the machine clock", () => {
    const isWithin = __testOnly.isNowWithinAllowedTimeWindow as (
      now: Date,
      start?: string,
      end?: string,
      timeZone?: string,
    ) => boolean;

    // 2026-03-01T02:00Z is 11:00 in Tokyo and 21:00 the previous day in New York.
    const instant = new Date("2026-03-01T02:00:00Z");

    assert.strictEqual(isWithin(instant, "09:00", "18:00", "Asia/Tokyo"), true);
    assert.strictEqual(
      isWithin(instant, "09:00", "18:00", "America/New_York"),
      false,
    );
    assert.strictEqual(
      isWithin(instant, "20:00", "23:00", "America/New_York"),
      true,
    );
    assert.strictEqual(
      isWithin(instant, "09:00", "18:00", "Not/AZone"),
      isWithin(instant, "09:00", "18:00"),
      "an invalid timezone must fall back to local time instead of throwing",
    );
  });

  test("the scheduler wall clock resolves the day and minute of the configured zone", () => {
    const wallClock = __testOnly.getZonedWallClock as (
      date: Date,
      timeZone?: string,
    ) => { dateKey: string; minutes: number };

    const instant = new Date("2026-03-01T02:00:00Z");

    assert.deepStrictEqual(wallClock(instant, "Asia/Tokyo"), {
      dateKey: "2026-03-01",
      minutes: 11 * 60,
    });
    assert.deepStrictEqual(wallClock(instant, "America/New_York"), {
      dateKey: "2026-02-28",
      minutes: 21 * 60,
    });
    assert.deepStrictEqual(wallClock(instant, "UTC"), {
      dateKey: "2026-03-01",
      minutes: 2 * 60,
    });

    const midnight = new Date("2026-03-01T15:00:00Z");
    assert.strictEqual(
      wallClock(midnight, "Asia/Tokyo").minutes,
      0,
      "midnight must be minute 0, not minute 1440",
    );
    assert.strictEqual(wallClock(midnight, "Asia/Tokyo").dateKey, "2026-03-02");

    assert.deepStrictEqual(
      wallClock(instant, "Not/AZone"),
      wallClock(instant),
      "an invalid timezone must fall back to local time",
    );
  });

  test("daily counters use the scheduler date key instead of the machine date", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/scheduleManager.ts"),
      "utf8",
    );
    const classStart = source.indexOf("export class ScheduleManager");
    assert.ok(classStart >= 0, "ScheduleManager class not found");

    assert.ok(
      !source.slice(classStart).includes("getLocalDateKey("),
      "daily counters inside ScheduleManager must go through getSchedulerDateKey so the counter day matches the cron timezone",
    );
    assert.ok(
      source.includes("return getZonedWallClock(date, this.getTimeZone())"),
      "getSchedulerDateKey must resolve the day in the configured timezone",
    );
  });
});

suite("ScheduleManager Minimum Interval Tests", () => {
  test("cron collection stops at the requested count before iterator exhaustion", () => {
    for (const count of [1, 2]) {
      const options = {
        currentDate: new Date("2026-05-09T00:00:00Z"),
        endDate: new Date(`2026-05-09T00:0${count}:00Z`),
        tz: "UTC",
      };
      const runs = getFirstDistinctCronRuns("* * * * *", options, count);
      assert.deepStrictEqual(
        runs.map((run) => run.toISOString()),
        Array.from(
          { length: count },
          (_, index) => `2026-05-09T00:0${index + 1}:00.000Z`,
        ),
      );
    }
  });

  test("cron collection stops without advancing duplicate or second-level schedules", () => {
    const options = {
      currentDate: new Date("2026-05-09T00:00:00Z"),
      endDate: new Date("2026-05-09T00:02:00Z"),
      tz: "UTC",
    };
    const duplicates = getFirstDistinctCronRuns(
      "* * * * *\n* * * * *",
      options,
      2,
    );
    assert.deepStrictEqual(
      duplicates.map((run) => run.toISOString()),
      ["2026-05-09T00:01:00.000Z", "2026-05-09T00:02:00.000Z"],
    );
    const secondOptions = {
      ...options,
      endDate: new Date("2026-05-09T00:00:01Z"),
    };
    const seconds = getFirstDistinctCronRuns("* * * * * *", secondOptions, 1);
    assert.deepStrictEqual(
      seconds.map((run) => run.toISOString()),
      ["2026-05-09T00:00:01.000Z"],
    );
  });

  test("cron collection skips parsing for non-positive or non-finite counts", () => {
    for (const count of [0, -1, NaN, Infinity, -Infinity]) {
      assert.deepStrictEqual(
        getFirstDistinctCronRuns(
          "invalid cron expression",
          { currentDate: new Date("2026-05-09T00:00:00Z"), tz: "UTC" },
          count,
        ),
        [],
      );
    }
  });

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

  test("migrates missing promptSource to local when promptPath is under .github/prompts", async () => {
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
        await waitForStartupSave(manager);
        const persisted = JSON.parse(
          fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
        ) as Array<{ id: string; promptSource?: string }>;
        assert.strictEqual(
          persisted.find((task) => task.id === rawTask.id)?.promptSource,
          "local",
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

  test("heals inline promptSource to local when promptPath exists under .github/prompts", async () => {
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
        await waitForStartupSave(manager);
        const persisted = JSON.parse(
          fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
        ) as Array<{ id: string; promptSource?: string }>;
        assert.strictEqual(
          persisted.find((task) => task.id === rawTask.id)?.promptSource,
          "local",
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
  test("keeps jitterSeconds undefined for legacy tasks that do not have the field", async () => {
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
      await waitForStartupSave(manager);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ id: string; jitterSeconds?: number }>;
      const persistedTask = persisted.find((task) => task.id === rawTask.id);
      assert.ok(persistedTask);
      assert.strictEqual(persistedTask.jitterSeconds, undefined);
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

      await waitForStartupSave(manager);
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

suite("ScheduleManager Empty File Recovery Tests", () => {
  test("loads legacy globalState tasks when the file snapshot is whitespace", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const rawTask = {
      id: "legacy-global-task",
      name: "Legacy global task",
      prompt: "hello",
      cronExpression: "0 * * * *",
      enabled: false,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tmp, "scheduledTasks.json"), "  \r\n", "utf8");

    try {
      const manager = new ScheduleManager(
        createMockContextWithGlobalTasks(tmp, [rawTask]),
      );
      assert.ok(manager.getTask(rawTask.id));
      await waitForStartupSave(manager);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ id: string }>;
      assert.ok(persisted.some((task) => task.id === rawTask.id));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("loads legacy globalState tasks when a meta-less file contains an empty array", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const rawTask = {
      id: "legacy-global-empty-array",
      name: "Legacy global task",
      prompt: "hello",
      cronExpression: "0 * * * *",
      enabled: false,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tmp, "scheduledTasks.json"), "[]", "utf8");

    try {
      const manager = new ScheduleManager(
        createMockContextWithGlobalTasks(tmp, [rawTask]),
      );
      assert.ok(manager.getTask(rawTask.id));
      await waitForStartupSave(manager);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ id: string }>;
      assert.ok(persisted.some((task) => task.id === rawTask.id));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite("ScheduleManager Mirror Ordering Tests", () => {
  test("does not advance globalState metadata when task payload sync fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const attemptedKeys: string[] = [];
    let resolvePayloadAttempt: (() => void) | undefined;
    const payloadAttempted = new Promise<void>((resolve) => {
      resolvePayloadAttempt = resolve;
    });
    const memento = new MockMemento();
    const context = {
      globalState: {
        keys: () => memento.keys(),
        get: memento.get.bind(memento),
        update(key: string, value: unknown): Thenable<void> {
          attemptedKeys.push(key);
          if (key === "scheduledTasks") {
            resolvePayloadAttempt?.();
            return Promise.reject(new Error("payload mirror failed"));
          }
          return memento.update(key, value);
        },
        setKeysForSync(): void {},
      },
      globalStorageUri: vscode.Uri.file(tmp),
    } as unknown as vscode.ExtensionContext;

    try {
      const manager = new ScheduleManager(context);
      await manager.createTask({
        name: "mirror-order",
        cronExpression: "0 * * * *",
        prompt: "hello",
        scope: "global",
        enabled: false,
      });
      await payloadAttempted;
      await Promise.resolve();

      assert.ok(attemptedKeys.includes("scheduledTasks"));
      assert.strictEqual(
        attemptedKeys.includes("scheduledTasksRevision"),
        false,
      );
      assert.strictEqual(
        attemptedKeys.includes("scheduledTasksSavedAt"),
        false,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("serializes successive globalState mirrors by revision", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const memento = new MockMemento();
    let payloadCalls = 0;
    let releaseFirstPayload: (() => void) | undefined;
    const firstPayloadGate = new Promise<void>((resolve) => {
      releaseFirstPayload = resolve;
    });
    let resolveFirstPayloadStarted: (() => void) | undefined;
    const firstPayloadStarted = new Promise<void>((resolve) => {
      resolveFirstPayloadStarted = resolve;
    });
    let resolveSecondRevision: (() => void) | undefined;
    const secondRevisionSaved = new Promise<void>((resolve) => {
      resolveSecondRevision = resolve;
    });
    const revisions: number[] = [];
    const context = {
      globalState: {
        keys: () => memento.keys(),
        get: memento.get.bind(memento),
        async update(key: string, value: unknown): Promise<void> {
          if (key === "scheduledTasks") {
            payloadCalls += 1;
            if (payloadCalls === 1) {
              resolveFirstPayloadStarted?.();
              await firstPayloadGate;
            }
          }
          if (key === "scheduledTasksRevision") {
            revisions.push(value as number);
            if (value === 2) resolveSecondRevision?.();
          }
          await memento.update(key, value);
        },
        setKeysForSync(): void {},
      },
      globalStorageUri: vscode.Uri.file(tmp),
    } as unknown as vscode.ExtensionContext;

    try {
      const manager = new ScheduleManager(context);
      const firstSave = manager.createTask({
        name: "mirror-one",
        cronExpression: "0 * * * *",
        prompt: "one",
        scope: "global",
        enabled: false,
      });
      await firstPayloadStarted;
      const secondSave = manager.createTask({
        name: "mirror-two",
        cronExpression: "0 * * * *",
        prompt: "two",
        scope: "global",
        enabled: false,
      });

      assert.strictEqual(payloadCalls, 1);
      releaseFirstPayload?.();
      await Promise.all([firstSave, secondSave]);
      await secondRevisionSaved;

      assert.strictEqual(payloadCalls, 2);
      assert.deepStrictEqual(revisions, [1, 2]);
    } finally {
      releaseFirstPayload?.();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("orders a foreground globalState fallback after an older mirror", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const memento = new MockMemento();
    let payloadCalls = 0;
    let releaseFirstPayload: (() => void) | undefined;
    const firstPayloadGate = new Promise<void>((resolve) => {
      releaseFirstPayload = resolve;
    });
    let resolveFirstPayloadStarted: (() => void) | undefined;
    const firstPayloadStarted = new Promise<void>((resolve) => {
      resolveFirstPayloadStarted = resolve;
    });
    const revisions: number[] = [];
    const context = {
      globalState: {
        keys: () => memento.keys(),
        get: memento.get.bind(memento),
        async update(key: string, value: unknown): Promise<void> {
          if (key === "scheduledTasks") {
            payloadCalls += 1;
            if (payloadCalls === 1) {
              resolveFirstPayloadStarted?.();
              await firstPayloadGate;
            }
          }
          if (key === "scheduledTasksRevision") {
            revisions.push(value as number);
          }
          await memento.update(key, value);
        },
        setKeysForSync(): void {},
      },
      globalStorageUri: vscode.Uri.file(tmp),
    } as unknown as vscode.ExtensionContext;

    try {
      const manager = new ScheduleManager(context);
      const firstSave = manager.createTask({
        name: "mirror-revision-one",
        cronExpression: "0 * * * *",
        prompt: "one",
        scope: "global",
        enabled: false,
      });
      await firstPayloadStarted;

      const internals = manager as unknown as {
        queueFileWrite(): Promise<void>;
      };
      internals.queueFileWrite = async () => {
        throw new Error("force globalState fallback");
      };
      const secondSave = manager.createTask({
        name: "fallback-revision-two",
        cronExpression: "0 * * * *",
        prompt: "two",
        scope: "global",
        enabled: false,
      });
      await Promise.resolve();
      assert.strictEqual(payloadCalls, 1);

      releaseFirstPayload?.();
      await Promise.all([firstSave, secondSave]);

      assert.strictEqual(payloadCalls, 2);
      assert.deepStrictEqual(revisions, [1, 2]);
    } finally {
      releaseFirstPayload?.();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite("ScheduleManager Committed Snapshot Tests", () => {
  test("a failed claim during legacy migration keeps the original occurrence", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const context = createMockContext(tmp);
    try {
      const manager = new ScheduleManager(context);
      const task = await manager.createTask({
        name: "legacy one-time claim",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
        jitterSeconds: 0,
      });
      const metadataPath = path.join(tmp, "scheduledTasks.meta.json");
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        revision: number;
        savedAt: string;
      };
      fs.writeFileSync(
        metadataPath,
        JSON.stringify({ revision: metadata.revision, savedAt: metadata.savedAt }),
      );
      await context.globalState.update("scheduledTasksSnapshot", undefined);

      const internals = manager as unknown as {
        saveMetaToFile(meta: unknown): Promise<void>;
        onExecuteCallback(): Promise<void>;
      };
      const saveMeta = internals.saveMetaToFile.bind(manager);
      let metadataWrites = 0;
      let dispatches = 0;
      internals.saveMetaToFile = async (meta) => {
        metadataWrites++;
        if (metadataWrites > 1) throw new Error("metadata commit failed");
        await saveMeta(meta);
      };
      internals.onExecuteCallback = async () => { dispatches++; };

      const result = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.strictEqual(result.reason, "claimFailed");
      assert.strictEqual(dispatches, 0);
      const preserved = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        revision: number;
        tasksSnapshot: Array<{ enabled: boolean }>;
      };
      assert.strictEqual(preserved.revision, metadata.revision);
      assert.strictEqual(preserved.tasksSnapshot[0].enabled, true);

      const reloaded = new ScheduleManager(context);
      assert.strictEqual(reloaded.getTask(task.id)?.enabled, true);
      assert.strictEqual(reloaded.getTask(task.id)?.lastFiredDueAt, undefined);
      await waitForStartupSave(reloaded);
      const repairedPayload = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ enabled: boolean }>;
      assert.strictEqual(repairedPayload[0].enabled, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a missing payload is recovered from the committed file snapshot", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "snapshot recovery",
        prompt: "hello",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
        agentHostWorkspaceMode: "folder",
      });
      const payloadPath = path.join(tmp, "scheduledTasks.json");
      fs.unlinkSync(payloadPath);

      const reloaded = new ScheduleManager(createMockContext(tmp));
      assert.strictEqual(reloaded.getTask(task.id)?.name, task.name);
      assert.strictEqual(reloaded.getTask(task.id)?.agentHostWorkspaceMode, "folder");
      await waitForStartupSave(reloaded);
      const repaired = JSON.parse(fs.readFileSync(payloadPath, "utf8")) as
        Array<{ id: string; agentHostWorkspaceMode?: string }>;
      assert.strictEqual(repaired[0].id, task.id);
      assert.strictEqual(repaired[0].agentHostWorkspaceMode, "folder");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("global fallback readers ignore an uncommitted payload", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const readerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-snapshot-reader-"));
    const state = new MockMemento();
    let holdSnapshot = false;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshotStarted = new Promise<void>((resolve) => { entered = resolve; });
    const context = {
      globalState: {
        keys: () => state.keys(),
        get: state.get.bind(state),
        async update(key: string, value: unknown): Promise<void> {
          if (holdSnapshot && key === "scheduledTasksSnapshot") {
            entered();
            await gate;
          }
          await state.update(key, value);
        },
        setKeysForSync(): void {},
      },
      globalStorageUri: vscode.Uri.file(tmp),
    } as unknown as vscode.ExtensionContext;
    let writing: Promise<unknown> | undefined;
    try {
      const manager = new ScheduleManager(context);
      const task = await manager.createTask({
        name: "committed name",
        prompt: "hello",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
      });
      (manager as unknown as { queueFileWrite(): Promise<void> }).queueFileWrite =
        async () => { throw new Error("file unavailable"); };
      holdSnapshot = true;
      writing = manager.updateTask(task.id, { name: "uncommitted name" });
      await snapshotStarted;

      const payload = state.get<Array<{ name: string }>>("scheduledTasks");
      assert.strictEqual(payload?.[0].name, "uncommitted name");
      const copiedState = new MockMemento();
      for (const key of state.keys()) {
        await copiedState.update(key, state.get(key));
      }
      const reader = new ScheduleManager({
        globalState: copiedState,
        globalStorageUri: vscode.Uri.file(readerRoot),
      } as unknown as vscode.ExtensionContext);
      assert.strictEqual(reader.getTask(task.id)?.name, "committed name");
      await waitForStartupSave(reader);

      holdSnapshot = false;
      release();
      await writing;
      const committed = new ScheduleManager(context);
      assert.strictEqual(committed.getTask(task.id)?.name, "uncommitted name");
      await waitForStartupSave(committed);
    } finally {
      holdSnapshot = false;
      release();
      await writing;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(readerRoot, { recursive: true, force: true });
    }
  });

  test("invalid file metadata is retained and cannot authorize a one-time claim", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const context = createMockContext(tmp);
    try {
      const first = new ScheduleManager(context);
      const task = await first.createTask({
        name: "damaged metadata",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
      });
      const metadataPath = path.join(tmp, "scheduledTasks.meta.json");
      fs.writeFileSync(metadataPath, "{broken", "utf8");

      const reloaded = new ScheduleManager(context);
      await waitForStartupSave(reloaded);
      let dispatches = 0;
      (reloaded as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
        async () => { dispatches++; };
      const result = await reloaded.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.strictEqual(result.reason, "claimFailed");
      assert.strictEqual(dispatches, 0);
      assert.strictEqual(fs.readFileSync(metadataPath, "utf8"), "{broken");
      assert.strictEqual(reloaded.getTask(task.id)?.enabled, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("invalid legacy metadata cannot authorize or overwrite a one-time claim", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const context = createMockContext(tmp);
    try {
      const first = new ScheduleManager(context);
      const task = await first.createTask({
        name: "invalid legacy metadata",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
      });
      const metadataPath = path.join(tmp, "scheduledTasks.meta.json");
      const corrupted = JSON.stringify({ revision: "invalid", savedAt: "" });
      fs.writeFileSync(metadataPath, corrupted);

      const reloaded = new ScheduleManager(context);
      await waitForStartupSave(reloaded);
      let dispatches = 0;
      (reloaded as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
        async () => { dispatches++; };
      const result = await reloaded.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(dispatches, 0);
      assert.strictEqual(fs.readFileSync(metadataPath, "utf8"), corrupted);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("lost or empty metadata cannot restore a stale unclaimed one-time task", async () => {
    for (const [damage, modernMirror, staleFallback] of [
      ["missing", true, false],
      ["empty", true, false],
      ["missing", false, false],
      ["missing", true, true],
    ] as const) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
      const context = createMockContext(tmp);
      const update = context.globalState.update.bind(context.globalState);
      try {
        const manager = new ScheduleManager(context);
        const task = await manager.createTask({
          name: `metadata ${damage}`,
          prompt: "hello",
          cronExpression: "",
          runAt: new Date(Date.now() + 60_000).toISOString(),
          scope: "global",
        });
        if (staleFallback) {
          fs.copyFileSync(
            path.join(tmp, "scheduledTasks.meta.json"),
            path.join(tmp, "scheduledTasks.fallback.json"),
          );
        }
        if (!modernMirror) {
          await context.globalState.update("scheduledTasksSnapshot", undefined);
          await context.globalState.update("scheduledTasksSnapshotIntent", undefined);
        }
        context.globalState.update = async () => {
          throw new Error("mirror unavailable");
        };
        (manager as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
          async () => {};
        assert.strictEqual((await manager.runTaskNowDetailed(task.id)).ok, true);
        context.globalState.update = update;
        const metadataPath = path.join(tmp, "scheduledTasks.meta.json");
        const payloadPath = path.join(tmp, "scheduledTasks.json");
        const payload = fs.readFileSync(payloadPath, "utf8");
        if (damage === "missing") {
          fs.unlinkSync(metadataPath);
        } else {
          fs.writeFileSync(metadataPath, "{}");
        }

        const reloaded = new ScheduleManager(context);
        await waitForStartupSave(reloaded);
        let dispatches = 0;
        (reloaded as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
          async () => { dispatches++; };
        const result = await reloaded.runTaskNowDetailed(task.id);
        assert.strictEqual(result.ok, false, damage);
        assert.strictEqual(dispatches, 0, damage);
        assert.strictEqual(fs.readFileSync(payloadPath, "utf8"), payload, damage);
        assert.strictEqual(fs.existsSync(metadataPath), damage !== "missing", damage);
        if (damage === "empty") {
          assert.strictEqual(fs.readFileSync(metadataPath, "utf8"), "{}");
        }
      } finally {
        context.globalState.update = update;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  test("a damaged one-time claim date cannot authorize another execution", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const context = createMockContext(tmp);
    const update = context.globalState.update.bind(context.globalState);
    try {
      const manager = new ScheduleManager(context);
      const task = await manager.createTask({
        name: "damaged claim date",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
      });
      context.globalState.update = async () => { throw new Error("mirror unavailable"); };
      (manager as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
        async () => {};
      assert.strictEqual((await manager.runTaskNowDetailed(task.id)).ok, true);
      context.globalState.update = update;
      const metadataPath = path.join(tmp, "scheduledTasks.meta.json");
      const meta = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        tasksSnapshot: Array<{ id: string; lastFiredDueAt?: string }>;
      };
      const persisted = meta.tasksSnapshot.find((item) => item.id === task.id);
      assert.ok(persisted);
      persisted.lastFiredDueAt = "invalid";
      fs.writeFileSync(metadataPath, JSON.stringify(meta));

      const reloaded = new ScheduleManager(context);
      await waitForStartupSave(reloaded);
      let dispatches = 0;
      (reloaded as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
        async () => { dispatches++; };
      assert.ok(reloaded.getTask(task.id)?.lastFiredClaimId);
      const result = await reloaded.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.strictEqual(result.reason, "oneTimeCompleted");
      await assert.rejects(() => reloaded.toggleTask(task.id), /rescheduled/);
      await assert.rejects(() => reloaded.setTaskEnabled(task.id, true), /rescheduled/);
      await assert.rejects(() => reloaded.updateTask(task.id, { enabled: true }), /rescheduled/);
      assert.strictEqual(dispatches, 0);
    } finally {
      context.globalState.update = update;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a valid file snapshot repairs an invalid global snapshot at the same revision", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const context = createMockContext(tmp);
    try {
      const first = new ScheduleManager(context);
      const task = await first.createTask({
        name: "global snapshot repair",
        prompt: "hello",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
      });
      await context.globalState.update("scheduledTasksSnapshot", { invalid: true });

      const reloaded = new ScheduleManager(context);
      assert.strictEqual(reloaded.getTask(task.id)?.name, task.name);
      await waitForStartupSave(reloaded);
      const snapshot = context.globalState.get<{
        tasksSnapshot: Array<{ id: string }>;
      }>("scheduledTasksSnapshot");
      assert.strictEqual(snapshot?.tasksSnapshot[0].id, task.id);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an invalid newer global snapshot blocks claims rather than replacing unknown data", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const context = createMockContext(tmp);
    try {
      const first = new ScheduleManager(context);
      const task = await first.createTask({
        name: "unrecoverable global snapshot",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
      });
      const metadataPath = path.join(tmp, "scheduledTasks.meta.json");
      const originalMetadata = fs.readFileSync(metadataPath, "utf8");
      await context.globalState.update("scheduledTasksSnapshot", { invalid: true });
      await context.globalState.update("scheduledTasksRevision", 999);

      const reloaded = new ScheduleManager(context);
      await waitForStartupSave(reloaded);
      let dispatches = 0;
      (reloaded as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
        async () => { dispatches++; };
      const result = await reloaded.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.strictEqual(result.reason, "claimFailed");
      assert.strictEqual(dispatches, 0);
      assert.strictEqual(fs.readFileSync(metadataPath, "utf8"), originalMetadata);
      assert.deepStrictEqual(
        context.globalState.get("scheduledTasksSnapshot"),
        { invalid: true },
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("same-revision snapshots with different contents cannot be overwritten", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const context = createMockContext(tmp);
    try {
      const first = new ScheduleManager(context);
      const task = await first.createTask({
        name: "original",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
      });
      const metadataPath = path.join(tmp, "scheduledTasks.meta.json");
      const originalMetadata = fs.readFileSync(metadataPath, "utf8");
      const snapshot = context.globalState.get<{
        revision: number;
        savedAt: string;
        commitId: string;
        tasksSnapshot: Array<Record<string, unknown>>;
      }>("scheduledTasksSnapshot")!;
      const conflicting = {
        ...snapshot,
        tasksSnapshot: [{ ...snapshot.tasksSnapshot[0], name: "other branch" }],
      };
      await context.globalState.update("scheduledTasksSnapshot", conflicting);

      const reloaded = new ScheduleManager(context);
      let dispatches = 0;
      (reloaded as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
        async () => { dispatches++; };
      const result = await reloaded.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(dispatches, 0);
      assert.strictEqual(fs.readFileSync(metadataPath, "utf8"), originalMetadata);
      assert.deepStrictEqual(context.globalState.get("scheduledTasksSnapshot"), conflicting);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a damaged global snapshot recovers from a newer shared fallback", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const context = createMockContext(tmp);
    try {
      const first = new ScheduleManager(context);
      const task = await first.createTask({
        name: "older file",
        prompt: "hello",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
      });
      const metadataPath = path.join(tmp, "scheduledTasks.meta.json");
      (first as unknown as { queueFileWrite(): Promise<void> }).queueFileWrite =
        async () => { throw new Error("file unavailable"); };
      await first.updateTask(task.id, { name: "newer global" });
      await context.globalState.update("scheduledTasksSnapshot", { invalid: true });

      const reloaded = new ScheduleManager(context);
      await waitForStartupSave(reloaded);
      assert.strictEqual(reloaded.getTask(task.id)?.name, "newer global");
      const repaired = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        tasksSnapshot: Array<{ name: string }>;
      };
      assert.strictEqual(repaired.tasksSnapshot[0].name, "newer global");
      const snapshot = context.globalState.get<{
        tasksSnapshot: Array<{ name: string }>;
      }>("scheduledTasksSnapshot")!;
      assert.strictEqual(snapshot.tasksSnapshot[0].name, "newer global");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an invalid global snapshot cannot be replaced by a different same-revision commit", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const context = createMockContext(tmp);
    try {
      const first = new ScheduleManager(context);
      const task = await first.createTask({
        name: "old commit",
        prompt: "hello",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
      });
      const metadataPath = path.join(tmp, "scheduledTasks.meta.json");
      const oldMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        revision: number;
      };
      (first as unknown as { queueFileWrite(): Promise<void> }).queueFileWrite =
        async () => { throw new Error("file unavailable"); };
      await first.updateTask(task.id, { name: "new commit" });
      const currentRevision = context.globalState.get<number>("scheduledTasksRevision")!;
      fs.unlinkSync(path.join(tmp, "scheduledTasks.fallback.json"));
      const staleMetadata = JSON.stringify({ ...oldMetadata, revision: currentRevision });
      fs.writeFileSync(metadataPath, staleMetadata);
      await context.globalState.update("scheduledTasksSnapshot", { invalid: true });

      const reloaded = new ScheduleManager(context);
      await waitForStartupSave(reloaded);
      await assert.rejects(() => reloaded.updateTask(task.id, { name: "overwrite" }));
      assert.strictEqual(fs.readFileSync(metadataPath, "utf8"), staleMetadata);
      assert.deepStrictEqual(context.globalState.get("scheduledTasksSnapshot"), { invalid: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a stale window detects a newer fallback even when its global state is stale", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "shared task",
        prompt: "hello",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
      });
      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      (first as unknown as { queueFileWrite(): Promise<void> }).queueFileWrite =
        async () => { throw new Error("primary file unavailable"); };
      (second as unknown as { queueFileWrite(): Promise<void> }).queueFileWrite =
        async () => { throw new Error("primary file unavailable"); };

      await first.updateTask(task.id, { name: "first window" });
      await assert.rejects(() => second.updateTask(task.id, { name: "stale window" }));
      assert.strictEqual(second.getTask(task.id)?.name, "first window");
      await waitForStartupSave(second);
      const fallback = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.fallback.json"), "utf8"),
      ) as { tasksSnapshot: Array<{ name: string }> };
      assert.strictEqual(fallback.tasksSnapshot[0].name, "first window");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite("ScheduleManager Cross-Window Conflict Tests", () => {
  test("rejects a stale writer and reloads the latest persisted tasks", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const sharedState = new MockMemento();
    const createContext = () =>
      ({
        globalState: sharedState,
        globalStorageUri: vscode.Uri.file(tmp),
      }) as unknown as vscode.ExtensionContext;

    try {
      const managerA = new ScheduleManager(createContext());
      const managerB = new ScheduleManager(createContext());
      const taskA = await managerA.createTask({
        name: "window-a",
        cronExpression: "0 * * * *",
        prompt: "from-a",
        scope: "global",
        enabled: false,
      });

      await assert.rejects(
        () =>
          managerB.createTask({
            name: "window-b",
            cronExpression: "0 * * * *",
            prompt: "from-b",
            scope: "global",
            enabled: false,
          }),
        new RegExp(messages.taskStoreChangedExternally()),
      );

      assert.deepStrictEqual(
        managerB.getAllTasks().map((task) => task.id),
        [taskA.id],
      );
      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ id: string }>;
      assert.deepStrictEqual(
        persisted.map((task) => task.id),
        [taskA.id],
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
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

  test("skips invalid task entries and keeps valid persisted tasks", async () => {
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
      await waitForStartupSave(manager);
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

  test("normalizes non-boolean enabled values to false", async () => {
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
      await waitForStartupSave(manager);
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

  test("normalizes invalid scope and disables task for safety", async () => {
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
      await waitForStartupSave(manager);
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
      await waitForStartupSave(manager);
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

  test("migrates only opted-in legacy model fallback tasks and persists the policy", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const base = {
        name: "legacy-model-fallback",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: false,
      };
      const manager = new ScheduleManager(createMockContextWithGlobalTasks(tmp, [
        { ...base, id: "on", modelFallback: true },
        { ...base, id: "off", modelFallback: false },
        { ...base, id: "absent" },
        { ...base, id: "invalid", modelFallback: true, modelFallbackPolicy: { strategy: "future" } },
      ]));
      await waitForStartupSave(manager);
      assert.strictEqual(await manager.whenModelFallbackMigrationSaved(), true);
      const persisted = JSON.parse(fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8")) as
        Array<{ id: string; modelFallbackPolicy?: unknown }>;
      assert.deepStrictEqual(persisted.find((task) => task.id === "on")?.modelFallbackPolicy, { strategy: "diverse" });
      const restored = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(restored);
      assert.strictEqual(await restored.whenModelFallbackMigrationSaved(), false);
      assert.deepStrictEqual(restored.getTask("on")?.modelFallbackPolicy, { strategy: "diverse" });
      assert.strictEqual(restored.getTask("off")?.modelFallback, false);
      assert.strictEqual(restored.getTask("absent")?.modelFallback, undefined);
      assert.strictEqual(restored.getTask("invalid")?.modelFallback, true);
      assert.deepStrictEqual(restored.getTask("invalid")?.modelFallbackPolicy, { strategy: "future" });
      await restored.updateTask("invalid", { name: "renamed" });
      assert.deepStrictEqual(restored.getTask("invalid")?.modelFallbackPolicy, { strategy: "future" });
      const reloaded = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(reloaded);
      assert.deepStrictEqual(reloaded.getTask("invalid")?.modelFallbackPolicy, { strategy: "future" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test("a failed migration save is not reported as saved, so the notice waits for a later load", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const prototype = ScheduleManager.prototype as unknown as { saveTasks: () => Promise<void> };
    const originalSave = prototype.saveTasks;
    prototype.saveTasks = async () => {
      throw new Error("disk full");
    };
    try {
      const manager = new ScheduleManager(createMockContextWithGlobalTasks(tmp, [{
        id: "legacy",
        name: "legacy-model-fallback",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: false,
        modelFallback: true,
      }]));
      assert.strictEqual(await manager.whenModelFallbackMigrationSaved(), false);
    } finally {
      prototype.saveTasks = originalSave;
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test("model fallback opt-in persists through create, update and duplicate", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const plain = await manager.createTask({
        name: "model-fallback-default",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
      });
      assert.strictEqual(plain.modelFallback, undefined);

      const created = await manager.createTask({
        name: "model-fallback-on",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        modelFallback: true,
        modelFallbackPolicy: { strategy: "similar", chatModel: { id: "fallback", vendor: "byok" } },
      });
      assert.strictEqual(created.modelFallback, true);
      const restored = new ScheduleManager(createMockContext(tmp)).getTask(created.id);
      assert.deepStrictEqual(restored?.modelFallbackPolicy, created.modelFallbackPolicy);

      const copy = await manager.duplicateTask(created.id);
      assert.strictEqual(copy?.modelFallback, true);
      assert.deepStrictEqual(copy?.modelFallbackPolicy, created.modelFallbackPolicy);

      const cleared = await manager.updateTask(created.id, {
        modelFallback: false,
      });
      assert.strictEqual(cleared?.modelFallback, undefined);
      assert.strictEqual(cleared?.modelFallbackPolicy, undefined);
      const enabled = await manager.updateTask(plain.id, {
        modelFallback: true,
      });
      assert.strictEqual(enabled?.modelFallback, true);
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

  test("Host ID and route guard survive persistence and clear on source changes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const hostId = "vendor/group/model::variant";
      const created = await manager.createTask({
        name: "host-model",
        prompt: "synthetic",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: false,
        model: "model::variant",
        modelVendor: "vendor",
        agentHostModelId: hostId,
        preventAgentHostFallback: true,
      });
      const stored = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as ScheduledTask[];
      assert.strictEqual(stored.find((task) => task.id === created.id)?.agentHostModelId, hostId);
      assert.strictEqual(stored.find((task) => task.id === created.id)?.preventAgentHostFallback, true);

      const copy = await manager.duplicateTask(created.id);
      assert.strictEqual(copy?.agentHostModelId, hostId);
      assert.strictEqual(copy?.preventAgentHostFallback, true);
      assert.strictEqual(
        (await manager.updateTask(created.id, { model: "model::variant" }))?.agentHostModelId,
        hostId,
      );
      const changed = await manager.updateTask(created.id, { model: "other" });
      assert.strictEqual(changed?.agentHostModelId, undefined);
      assert.strictEqual(changed?.preventAgentHostFallback, true);
      const cleared = await manager.updateTask(created.id, {
        model: "",
        preventAgentHostFallback: false,
      });
      assert.strictEqual(cleared?.model, undefined);
      assert.strictEqual(cleared?.agentHostModelId, undefined);
      assert.strictEqual(cleared?.preventAgentHostFallback, undefined);
      await assert.rejects(
        manager.updateTask(created.id, { agentHostModelId: hostId }),
        /model|モデル/i,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test("skill reference persists through create, update, clear and duplicate, and malformed ones are dropped", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const ref = {
        name: "my-skill",
        scope: "user" as const,
        root: ".copilot/skills",
      };
      const created = await manager.createTask({
        name: "skill-task",
        prompt: "/my-skill x",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        skillRef: ref,
      });
      assert.deepStrictEqual(created.skillRef, ref);

      const bad = await manager.createTask({
        name: "bad-skill-ref",
        prompt: "/my-skill x",
        cronExpression: "0 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        skillRef: { name: "x", scope: "elsewhere", root: "r" } as never,
      });
      assert.strictEqual(bad.skillRef, undefined);

      const copy = await manager.duplicateTask(created.id);
      assert.deepStrictEqual(copy?.skillRef, ref);

      const untouched = await manager.updateTask(created.id, { name: "renamed" });
      assert.deepStrictEqual(untouched?.skillRef, ref);

      const cleared = await manager.updateTask(created.id, { skillRef: null });
      assert.strictEqual(cleared?.skillRef, undefined);

      const set = await manager.updateTask(bad.id, { skillRef: ref });
      assert.deepStrictEqual(set?.skillRef, ref);
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

  test("checkAndExecuteTasks does not wait for a Copilot CLI run and still records its result", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const cliTask = await manager.createTask({
        name: "task-cli-long",
        prompt: "hello",
        cronExpression: "*/1 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
        useCopilotCli: true,
      });
      const quickTask = await manager.createTask({
        name: "task-chat-quick",
        prompt: "hello",
        cronExpression: "*/1 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
      });
      cliTask.nextRun = new Date(Date.now() - 60 * 1000);
      quickTask.nextRun = new Date(Date.now() - 60 * 1000);

      let releaseCli: () => void = () => undefined;
      const cliGate = new Promise<void>((resolve) => {
        releaseCli = resolve;
      });
      const executed: string[] = [];
      const internals = manager as unknown as {
        onExecuteCallback?: (task: { id: string }) => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
        automaticRunsInFlight: number;
      };
      internals.onExecuteCallback = async (task) => {
        executed.push(task.id);
        if (task.id === cliTask.id) {
          await cliGate;
        }
      };

      const started = Date.now();
      await internals.checkAndExecuteTasks();
      assert.ok(Date.now() - started < 5000, "the tick returned while the CLI run was still going");
      assert.ok(executed.includes(quickTask.id));
      assert.ok(quickTask.lastRun instanceof Date, "the quick run is recorded without waiting");
      assert.strictEqual(cliTask.lastRun, undefined, "the CLI run has not finished yet");
      assert.ok(internals.automaticRunsInFlight >= 1, "the CLI run still holds its slot");

      releaseCli();
      await manager.waitForDetachedRuns();
      assert.ok(
        (cliTask as { lastRun?: Date }).lastRun instanceof Date,
        "the CLI run is recorded when it ends",
      );
      assert.strictEqual(internals.automaticRunsInFlight, 0);
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

  suite("Automatic executions", () => {
    suite("Overlapping occurrences", () => {
      test("overlapping runs are allowed by default and an explicit off survives updates, duplication, and reload", async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
        try {
          const manager = new ScheduleManager(createMockContext(tmp));
          const task = await manager.createTask({
            name: "overlap-settings",
            prompt: "hello",
            cronExpression: "* * * * *",
            scope: "global",
          });
          assert.strictEqual(task.allowOverlappingRuns, true);
          await manager.updateTask(task.id, { allowOverlappingRuns: false });
          await manager.updateTask(task.id, { name: "renamed-overlap-settings" });
          const copy = await manager.duplicateTask(task.id);
          assert.ok(copy);
          assert.strictEqual(copy.allowOverlappingRuns, false);

          const reloaded = new ScheduleManager(createMockContext(tmp));
          await waitForStartupSave(reloaded);
          assert.strictEqual(reloaded.getTask(task.id)?.allowOverlappingRuns, false);
          assert.strictEqual(reloaded.getTask(copy.id)?.allowOverlappingRuns, false);
          assert.strictEqual(await reloaded.whenOverlapMigrationSaved(), false);
          await reloaded.updateTask(task.id, { allowOverlappingRuns: true });
          assert.strictEqual(reloaded.getTask(task.id)?.allowOverlappingRuns, true);
          await assert.rejects(() =>
            reloaded.updateTask(task.id, {
              allowOverlappingRuns: "yes" as unknown as boolean,
            }),
          );
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });

      test("recurring tasks saved without an overlap setting migrate to allowed once and one-time tasks stay unset", async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
        try {
          const base = {
            name: "legacy-overlap",
            prompt: "hello",
            cronExpression: "0 * * * *",
            scope: "global",
            promptSource: "inline",
            enabled: false,
          };
          const manager = new ScheduleManager(createMockContextWithGlobalTasks(tmp, [
            { ...base, id: "unset" },
            { ...base, id: "on", allowOverlappingRuns: true },
            { ...base, id: "off", allowOverlappingRuns: false },
            { ...base, id: "once", cronExpression: "", runAt: new Date(Date.now() + 3_600_000).toISOString() },
          ]));
          await waitForStartupSave(manager);
          assert.strictEqual(await manager.whenOverlapMigrationSaved(), true);
          assert.strictEqual(manager.getTask("unset")?.allowOverlappingRuns, true);
          assert.strictEqual(manager.getTask("on")?.allowOverlappingRuns, true);
          assert.strictEqual(manager.getTask("off")?.allowOverlappingRuns, false);
          assert.strictEqual(manager.getTask("once")?.allowOverlappingRuns, undefined);
          const persisted = JSON.parse(fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8")) as
            Array<{ id: string; allowOverlappingRuns?: boolean }>;
          assert.strictEqual(persisted.find((item) => item.id === "unset")?.allowOverlappingRuns, true);
          assert.strictEqual(persisted.find((item) => item.id === "off")?.allowOverlappingRuns, false);

          const restored = new ScheduleManager(createMockContext(tmp));
          await waitForStartupSave(restored);
          assert.strictEqual(await restored.whenOverlapMigrationSaved(), false);
          assert.strictEqual(restored.getTask("off")?.allowOverlappingRuns, false);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        }
      });

      test("the overlap option is not kept on a one-time task", async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
        try {
          const manager = new ScheduleManager(createMockContext(tmp));
          const runAt = new Date(Date.now() + 3_600_000).toISOString();
          const once = await manager.createTask({
            name: "overlap-once",
            prompt: "hello",
            cronExpression: "",
            runAt,
            scope: "global",
            allowOverlappingRuns: true,
          });
          assert.strictEqual(once.allowOverlappingRuns, undefined);
          const recurring = await manager.createTask({
            name: "overlap-recurring",
            prompt: "hello",
            cronExpression: "* * * * *",
            scope: "global",
            allowOverlappingRuns: true,
          });
          assert.strictEqual(recurring.allowOverlappingRuns, true);
          await manager.updateTask(recurring.id, { cronExpression: "", runAt });
          assert.strictEqual(manager.getTask(recurring.id)?.allowOverlappingRuns, undefined);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });

      test("task edits advance the claim fingerprint even if the clock moves backward", async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
        try {
          const manager = new ScheduleManager(createMockContext(tmp));
          const task = await manager.createTask({
            name: "monotonic-task-update",
            prompt: "before",
            cronExpression: "* * * * *",
            scope: "global",
            allowOverlappingRuns: true,
          });
          task.updatedAt = new Date(Date.now() + 60_000);
          const originalUpdate = task.updatedAt.getTime();
          await manager.updateTask(task.id, { prompt: "changed" });
          const changedUpdate = task.updatedAt.getTime();
          await manager.updateTask(task.id, { prompt: "before" });
          assert.ok(changedUpdate > originalUpdate);
          assert.ok(task.updatedAt.getTime() > changedUpdate);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });

      for (const allowOverlappingRuns of [undefined, false]) {
        test(`a still-running automatic run ${allowOverlappingRuns === false ? "makes the next occurrence skip when overlap is off" : "does not stop the next occurrence by default"}`, async () => {
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
          const restore = overrideSchedulerConfig({
            executionRoute: "agentHost",
            maxDailyExecutions: 0,
          });
          let release!: () => void;
          const hold = new Promise<void>((resolve) => { release = resolve; });
          let manager: ScheduleManager | undefined;
          try {
            manager = new ScheduleManager(createMockContext(tmp));
            const task = await manager.createTask({
              name: "overlap-default",
              prompt: "hello",
              cronExpression: "* * * * *",
              scope: "global",
              ...(allowOverlappingRuns === false ? { allowOverlappingRuns } : {}),
              jitterSeconds: 0,
            });
            assert.strictEqual(task.allowOverlappingRuns, allowOverlappingRuns === false ? false : true);
            const internals = manager as unknown as {
              saveTasks(): Promise<void>;
              checkAndExecuteTasks(): Promise<void>;
              onExecuteCallback(
                task: ScheduledTask,
                trigger: string,
                guard?: (dispatch: () => void) => Promise<void>,
              ): Promise<void>;
            };
            await internals.saveTasks();
            let markStarted!: () => void;
            const started = new Promise<void>((resolve) => { markStarted = resolve; });
            let executions = 0;
            internals.onExecuteCallback = async (_task, _trigger, guard) => {
              executions++;
              await guard?.(() => {});
              markStarted();
              await hold;
            };
            task.nextRun = truncateToMinute(new Date(Date.now() - 120_000));
            await internals.checkAndExecuteTasks();
            await waitForSignal(started);
            task.nextRun = truncateToMinute(new Date(Date.now() - 60_000));
            await internals.checkAndExecuteTasks();
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.strictEqual(executions, allowOverlappingRuns === false ? 1 : 2);
          } finally {
            release();
            if (manager) await manager.waitForDetachedRuns();
            restore();
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        });
      }

      test("overlap opt-in does not bypass an in-flight manual run", async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
        let release!: () => void;
        const hold = new Promise<void>((resolve) => { release = resolve; });
        let manualRun: ReturnType<ScheduleManager["runTaskNowDetailed"]> | undefined;
        try {
          const manager = new ScheduleManager(createMockContext(tmp));
          const task = await manager.createTask({
            name: "overlap-manual",
            prompt: "hello",
            cronExpression: "* * * * *",
            scope: "global",
            allowOverlappingRuns: true,
            jitterSeconds: 0,
          });
          let markStarted!: () => void;
          const started = new Promise<void>((resolve) => { markStarted = resolve; });
          let executions = 0;
          const internals = manager as unknown as {
            checkAndExecuteTasks(): Promise<void>;
            onExecuteCallback(): Promise<void>;
          };
          internals.onExecuteCallback = async () => {
            executions++;
            markStarted();
            await hold;
          };
          manualRun = manager.runTaskNowDetailed(task.id);
          await waitForSignal(started);
          task.nextRun = truncateToMinute(new Date(Date.now() - 60_000));
          await internals.checkAndExecuteTasks();
          assert.strictEqual(executions, 1);
          assert.ok(task.nextRun.getTime() > Date.now() - 1000);
        } finally {
          release();
          await manualRun;
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });

      test("overlapping cron claims remain valid when a later occurrence finishes first", async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
        const restore = overrideSchedulerConfig({
          executionRoute: "agentHost",
          maxDailyExecutions: 0,
        });
        let manager: ScheduleManager | undefined;
        let releaseFirst!: () => void;
        let releaseSecond!: () => void;
        const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const holdSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
        try {
          manager = new ScheduleManager(createMockContext(tmp));
          const task = await manager.createTask({
            name: "overlap-jitter",
            prompt: "hello",
            cronExpression: "* * * * *",
            scope: "global",
            allowOverlappingRuns: true,
            jitterSeconds: 0,
          });
          const secondDue = truncateToMinute(new Date(Date.now() - 60_000));
          const firstDue = new Date(secondDue.getTime() - 60_000);
          task.nextRun = firstDue;
          const internals = manager as unknown as {
            saveTasks(): Promise<void>;
            checkAndExecuteTasks(): Promise<void>;
            applyJitter(): Promise<void>;
            detachedRuns: Set<Promise<void>>;
            onExecuteCallback(
              task: ScheduledTask,
              trigger: string,
              guard?: (dispatch: () => void) => Promise<void>,
            ): Promise<void>;
          };
          await internals.saveTasks();
          let markFirstJitter!: () => void;
          const firstJitter = new Promise<void>((resolve) => { markFirstJitter = resolve; });
          let jitterCalls = 0;
          internals.applyJitter = async () => {
            if (++jitterCalls === 1) {
              markFirstJitter();
              await holdFirst;
            }
          };
          const dispatched: number[] = [];
          let markSecondDispatched!: () => void;
          const secondDispatched = new Promise<void>((resolve) => {
            markSecondDispatched = resolve;
          });
          internals.onExecuteCallback = async (claimedTask, trigger, guard) => {
            assert.strictEqual(trigger, "auto");
            assert.ok(guard);
            await guard(() => {
              assert.ok(claimedTask.lastFiredDueAt);
              dispatched.push(claimedTask.lastFiredDueAt.getTime());
            });
            if (claimedTask.lastFiredDueAt?.getTime() === secondDue.getTime()) {
              markSecondDispatched();
              await holdSecond;
            }
          };

          await internals.checkAndExecuteTasks();
          await waitForSignal(firstJitter);
          const firstRun = [...internals.detachedRuns][0];
          assert.ok(firstRun);
          task.nextRun = secondDue;
          await internals.checkAndExecuteTasks();
          await waitForSignal(secondDispatched);
          const secondRun = [...internals.detachedRuns].find((run) => run !== firstRun);
          assert.ok(secondRun);
          releaseSecond();
          await secondRun;
          assert.deepStrictEqual(dispatched, [secondDue.getTime()]);
          const completedSecondAt = manager.getTask(task.id)?.lastRun;
          assert.ok(completedSecondAt instanceof Date);

          releaseFirst();
          await firstRun;
          assert.deepStrictEqual(dispatched, [secondDue.getTime(), firstDue.getTime()]);
          assert.strictEqual(manager.getTask(task.id)?.lastFiredDueAt?.getTime(), secondDue.getTime());
          assert.ok(
            (manager.getTask(task.id)?.lastRun?.getTime() ?? 0) >= completedSecondAt.getTime(),
          );
          const persisted = JSON.parse(
            fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
          ) as Array<{ id: string; lastFiredDueAt?: string; lastRun?: string }>;
          const saved = persisted.find((item) => item.id === task.id);
          assert.strictEqual(new Date(saved?.lastFiredDueAt ?? 0).getTime(), secondDue.getTime());
          assert.ok(new Date(saved?.lastRun ?? 0).getTime() >= completedSecondAt.getTime());
        } finally {
          releaseFirst();
          releaseSecond();
          if (manager) await manager.waitForDetachedRuns();
          restore();
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });

      for (const failFirst of [false, true]) {
        test(`overlapping runs reserve the per-task daily limit (failure=${failFirst})`, async () => {
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
          const restore = overrideSchedulerConfig({
            executionRoute: "agentHost",
            maxDailyExecutions: 0,
          });
          let manager: ScheduleManager | undefined;
          let release!: () => void;
          const hold = new Promise<void>((resolve) => { release = resolve; });
          try {
            manager = new ScheduleManager(createMockContext(tmp));
            const task = await manager.createTask({
              name: "overlap-daily-limit",
              prompt: "hello",
              cronExpression: "* * * * *",
              scope: "global",
              allowOverlappingRuns: true,
              maxExecutionsPerDay: 1,
              jitterSeconds: 0,
            });
            const secondDue = truncateToMinute(new Date(Date.now() - 60_000));
            task.nextRun = new Date(secondDue.getTime() - 60_000);
            let markStarted!: () => void;
            const started = new Promise<void>((resolve) => { markStarted = resolve; });
            let executions = 0;
            const internals = manager as unknown as {
              checkAndExecuteTasks(): Promise<void>;
              onExecuteCallback(): Promise<void>;
            };
            internals.onExecuteCallback = async () => {
              executions++;
              if (executions === 1) {
                markStarted();
                await hold;
                if (failFirst) throw new Error("dispatch failed");
              }
            };
            await internals.checkAndExecuteTasks();
            await waitForSignal(started);
            task.nextRun = secondDue;
            await internals.checkAndExecuteTasks();
            assert.strictEqual(executions, 1);
            assert.strictEqual(task.nextRun.getTime(), secondDue.getTime());

            release();
            await manager.waitForDetachedRuns();
            await internals.checkAndExecuteTasks();
            await manager.waitForDetachedRuns();
            assert.strictEqual(executions, failFirst ? 2 : 1);
          } finally {
            release();
            if (manager) await manager.waitForDetachedRuns();
            restore();
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        });
      }

      test("an edited overlapping task cannot dispatch an earlier claim", async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
        const restore = overrideSchedulerConfig({ executionRoute: "agentHost" });
        let manager: ScheduleManager | undefined;
        let release!: () => void;
        const hold = new Promise<void>((resolve) => { release = resolve; });
        try {
          manager = new ScheduleManager(createMockContext(tmp));
          const task = await manager.createTask({
            name: "overlap-edited",
            prompt: "before",
            cronExpression: "* * * * *",
            scope: "global",
            allowOverlappingRuns: true,
            jitterSeconds: 0,
          });
          task.nextRun = truncateToMinute(new Date(Date.now() - 60_000));
          let markStarted!: () => void;
          const started = new Promise<void>((resolve) => { markStarted = resolve; });
          let executions = 0;
          const internals = manager as unknown as {
            checkAndExecuteTasks(): Promise<void>;
            applyJitter(): Promise<void>;
            onExecuteCallback(): Promise<void>;
          };
          internals.applyJitter = async () => { markStarted(); await hold; };
          internals.onExecuteCallback = async () => { executions++; };
          await internals.checkAndExecuteTasks();
          await waitForSignal(started);
          await manager.updateTask(task.id, { prompt: "after" });
          release();
          await manager.waitForDetachedRuns();
          assert.strictEqual(executions, 0);
        } finally {
          release();
          if (manager) await manager.waitForDetachedRuns();
          restore();
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });

      test("two windows cannot claim the same overlapping occurrence", async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
        const restore = overrideSchedulerConfig({
          executionRoute: "agentHost",
          maxDailyExecutions: 0,
        });
        let first: ScheduleManager | undefined;
        let second: ScheduleManager | undefined;
        let release!: () => void;
        const hold = new Promise<void>((resolve) => { release = resolve; });
        try {
          first = new ScheduleManager(createMockContext(tmp));
          const task = await first.createTask({
            name: "overlap-cross-window",
            prompt: "hello",
            cronExpression: "* * * * *",
            scope: "global",
            allowOverlappingRuns: true,
            jitterSeconds: 0,
          });
          task.nextRun = truncateToMinute(new Date(Date.now() - 60_000));
          const firstInternals = first as unknown as {
            saveTasks(): Promise<void>;
            checkAndExecuteTasks(): Promise<void>;
            onExecuteCallback(): Promise<void>;
          };
          await firstInternals.saveTasks();
          second = new ScheduleManager(createMockContext(tmp));
          await waitForStartupSave(second);
          const secondInternals = second as unknown as typeof firstInternals;
          let markStarted!: () => void;
          const started = new Promise<void>((resolve) => { markStarted = resolve; });
          let executions = 0;
          firstInternals.onExecuteCallback = secondInternals.onExecuteCallback = async () => {
            executions++;
            markStarted();
            await hold;
          };
          await Promise.all([
            firstInternals.checkAndExecuteTasks(),
            secondInternals.checkAndExecuteTasks(),
          ]);
          await waitForSignal(started);
          assert.strictEqual(executions, 1);
        } finally {
          release();
          if (first) await first.waitForDetachedRuns();
          if (second) await second.waitForDetachedRuns();
          restore();
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });
    });
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
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let executions = 0;

      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        executions++;
        markStarted();
        await blocker;
      };

      const manualRun = manager.runTaskNowDetailed(task.id);
      try {
        await Promise.race([
          started,
          manualRun.then(() => {
            throw new Error("Manual execution finished before its callback started");
          }),
        ]);

        task.nextRun = new Date(Date.now() - 60 * 1000);
        await (
          manager as unknown as {
            checkAndExecuteTasks?: () => Promise<void>;
          }
        ).checkAndExecuteTasks?.();

        assert.strictEqual(executions, 1);
        assert.ok(task.nextRun instanceof Date);
        assert.ok((task.nextRun as Date).getTime() > Date.now() - 1000);
      } finally {
        release();
        await manualRun;
      }

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

  test("createTask rejects a local attachment on a global-scope task", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      await assert.rejects(
        () =>
          manager.createTask({
            name: "global-local-attachment",
            prompt: "hello",
            cronExpression: "*/5 * * * *",
            scope: "global",
            promptSource: "inline",
            enabled: false,
            attachments: [{ source: "local", path: "docs/a.md" }],
          }),
        /workspace|\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9/i,
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

  test("createTask rejects attachments that escape the root or hit the denylist", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const base = {
        name: "unsafe-attachment",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global" as const,
        promptSource: "inline" as const,
        enabled: false,
      };

      await assert.rejects(() =>
        manager.createTask({
          ...base,
          attachments: [{ source: "global", path: "../outside.md" }],
        }),
      );
      await assert.rejects(() =>
        manager.createTask({
          ...base,
          attachments: [{ source: "global", path: ".env" }],
        }),
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

  test("task mutations reject NUL prompt paths without changing persisted state", async () => {
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-path-"),
    );
    const context = createMockContext(tmp);
    const manager = new ScheduleManager(context);
    try {
      await waitForStartupSave(manager);
      const input = {
        name: "original",
        prompt: "snapshot",
        cronExpression: "*/5 * * * *",
        enabled: false,
        scope: "global" as const,
        promptSource: "global" as const,
        promptPath: "valid.prompt.md",
      };
      const task = await manager.createTask(input);
      const before = JSON.stringify(manager.getAllTasks());
      const storedPath = path.join(tmp, "scheduledTasks.json");
      const storedBefore = fs.readFileSync(storedPath, "utf8");
      const mementoBefore = JSON.stringify(
        context.globalState.get("scheduledTasks"),
      );
      for (const promptSource of ["local", "global"] as const) {
        await assert.rejects(() =>
          manager.createTask({
            ...input,
            name: "must not be created",
            promptSource,
            promptPath: "bad\0.prompt.md",
          }),
        );
        await assert.rejects(() =>
          manager.updateTask(task.id, {
            name: "must not change",
            promptSource,
            promptPath: "bad\0.prompt.md",
          }),
        );
        assert.strictEqual(JSON.stringify(manager.getAllTasks()), before);
        assert.strictEqual(fs.readFileSync(storedPath, "utf8"), storedBefore);
        assert.strictEqual(
          JSON.stringify(context.globalState.get("scheduledTasks")),
          mementoBefore,
        );
      }
    } finally {
      await waitForStartupSave(manager);
      manager.stopScheduler();
      fs.rmSync(tmp, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  });

  test("updateTask rejects switching to global scope while local attachments remain", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const now = new Date().toISOString();
      const context = createMockContextWithGlobalTasks(tmp, [
        {
          id: "task-scope-switch",
          name: "scope-switch-attachment",
          prompt: "hello",
          cronExpression: "*/5 * * * *",
          enabled: false,
          scope: "workspace",
          workspacePath: tmp,
          promptSource: "inline",
          attachments: [{ source: "local", path: "docs/a.md" }],
          createdAt: now,
          updatedAt: now,
        },
      ]);
      const manager = new ScheduleManager(context);

      assert.deepStrictEqual(
        manager.getTask("task-scope-switch")?.attachments,
        [{ source: "local", path: "docs/a.md" }],
      );

      const before = { ...manager.getTask("task-scope-switch")! };
      for (const invalidUpdate of [
        { scope: "global" as const },
        { attachments: [{ source: "local" as const, path: "../outside.md" }] },
      ]) {
        await assert.rejects(() =>
          manager.updateTask("task-scope-switch", {
            name: "must not leak",
            prompt: "changed prompt",
            cronExpression: "*/10 * * * *",
            enabled: true,
            model: "changed-model",
            promptSource: "local",
            promptPath: "changed.prompt.md",
            ...invalidUpdate,
          }),
        );
        assert.deepStrictEqual(manager.getTask("task-scope-switch"), before);
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

  test("loadTasks heals corrupted attachments", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const now = new Date().toISOString();
      const context = createMockContextWithGlobalTasks(tmp, [
        {
          id: "task-attachment-heal",
          name: "heal",
          prompt: "hello",
          cronExpression: "*/5 * * * *",
          enabled: false,
          scope: "workspace",
          promptSource: "inline",
          attachments: [
            { source: "local", path: "docs/a.md" },
            { source: "local", path: "docs/a.md" },
            { source: "bogus", path: "docs/b.md" },
            { source: "local", path: "../escape.md" },
            null,
          ],
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const manager = new ScheduleManager(context);
      const task = manager.getTask("task-attachment-heal");

      assert.ok(task);
      assert.deepStrictEqual(task.attachments, [
        { source: "local", path: "docs/a.md" },
      ]);
      await waitForStartupSave(manager);
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

  test("duplicateTask carries attachments to the copy", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const now = new Date().toISOString();
      const context = createMockContextWithGlobalTasks(tmp, [
        {
          id: "task-duplicate-attachment",
          name: "duplicate-attachment",
          prompt: "hello",
          cronExpression: "*/5 * * * *",
          enabled: false,
          scope: "global",
          promptSource: "inline",
          attachments: [{ source: "global", path: "shared/notes.md" }],
          createdAt: now,
          updatedAt: now,
        },
      ]);
      const manager = new ScheduleManager(context);

      const duplicated = await manager.duplicateTask(
        "task-duplicate-attachment",
      );

      assert.ok(duplicated);
      assert.deepStrictEqual(duplicated.attachments, [
        { source: "global", path: "shared/notes.md" },
      ]);
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

  test("moveTaskToCurrentWorkspace refuses to move local attachments to another workspace", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const now = new Date().toISOString();
      const context = createMockContextWithGlobalTasks(tmp, [
        {
          id: "task-move-attachment",
          name: "move-attachment",
          prompt: "hello",
          cronExpression: "*/5 * * * *",
          enabled: false,
          scope: "workspace",
          workspacePath: path.join(tmp, "other-workspace"),
          promptSource: "inline",
          attachments: [{ source: "local", path: "docs/a.md" }],
          createdAt: now,
          updatedAt: now,
        },
      ]);
      const manager = new ScheduleManager(context);
      (
        manager as unknown as {
          getPreferredWorkspaceRootPath: () => string | undefined;
        }
      ).getPreferredWorkspaceRootPath = () =>
        path.join(tmp, "current-workspace");

      await assert.rejects(
        () => manager.moveTaskToCurrentWorkspace("task-move-attachment"),
        (error: unknown) =>
          error instanceof Error &&
          error.message === messages.attachmentBlocksWorkspaceMove(),
      );
      assert.strictEqual(
        manager.getTask("task-move-attachment")?.workspacePath,
        path.join(tmp, "other-workspace"),
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

  test("one-time tasks dispatch once and apply the selected after-run action", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const runAt = new Date(Date.now() - 120_000).toISOString();
      let dispatched = 0;
      (
        manager as unknown as { onExecuteCallback: () => Promise<void> }
      ).onExecuteCallback = async () => {
        dispatched++;
      };
      const disabled = await manager.createTask({
        name: "disable after running",
        prompt: "hello",
        cronExpression: "",
        runAt,
        scope: "global",
        jitterSeconds: 0,
      });
      const deleted = await manager.createTask({
        name: "delete after running",
        prompt: "hello",
        cronExpression: "",
        runAt,
        afterRun: "delete",
        scope: "global",
        jitterSeconds: 0,
      });
      const tick = () =>
        (
          manager as unknown as { checkAndExecuteTasks: () => Promise<void> }
        ).checkAndExecuteTasks();
      await tick();
      await tick();
      assert.strictEqual(dispatched, 2);
      assert.strictEqual(manager.getTask(disabled.id)?.enabled, false);
      assert.strictEqual(manager.getTask(disabled.id)?.nextRun, undefined);
      assert.strictEqual(manager.getTask(deleted.id), undefined);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ id: string }>;
      assert.deepStrictEqual(
        persisted.map((task) => task.id),
        [disabled.id],
      );
      await assert.rejects(
        () => manager.setTaskEnabled(disabled.id, true),
        /rescheduled/,
      );
      const sameInstantWithOffset = new Date(
        new Date(runAt).getTime() + 9 * 60 * 60 * 1000,
      )
        .toISOString()
        .replace("Z", "+09:00");
      await assert.rejects(
        () =>
          manager.updateTask(disabled.id, {
            runAt: sameInstantWithOffset,
            enabled: true,
          }),
        /rescheduled/,
      );
      const nextRunAt = new Date(Date.now() + 86_400_000).toISOString();
      await manager.updateTask(disabled.id, {
        runAt: nextRunAt,
        enabled: true,
      });
      assert.strictEqual(disabled.enabled, true);
      assert.strictEqual(disabled.lastFiredDueAt, undefined);
      assert.strictEqual(disabled.nextRun?.toISOString(), nextRunAt);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("claimed one-time tasks remain disabled after execution failure or a post-jitter skip", async () => {
    const restore = overrideSchedulerConfig({ executionRoute: "chat" });
    try {
      for (const outcome of ["failure", "skip"] as const) {
        for (const afterRun of ["disable", "delete"] as const) {
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
          try {
            const manager = new ScheduleManager(createMockContext(tmp));
            const runAt = new Date(Date.now() - 60_000).toISOString();
            const task = await manager.createTask({
              name: `${outcome}-${afterRun}`,
              prompt: "hello",
              cronExpression: "",
              runAt,
              afterRun,
              scope: "global",
              jitterSeconds: 0,
            });
            let executions = 0;
            const internals = manager as unknown as {
              applyJitter: () => Promise<void>;
              getTimeZone: () => string | undefined;
              onExecuteCallback: () => Promise<void>;
              checkAndExecuteTasks: () => Promise<void>;
            };
            internals.getTimeZone = () => undefined;
            internals.onExecuteCallback = async () => {
              executions++;
              throw createPromptBlockedError("uncertain", "agentHostFailed", "unknown");
            };
            if (outcome === "skip") {
              internals.applyJitter = async () => {
                task.allowedTimeStart = new Date(Date.now() + 60 * 60_000)
                  .toTimeString().slice(0, 5);
                task.allowedTimeEnd = new Date(Date.now() + 120 * 60_000)
                  .toTimeString().slice(0, 5);
              };
            }
            await internals.checkAndExecuteTasks();
            await manager.waitForDetachedRuns();
            const latest = manager.getTask(task.id);
            assert.ok(latest, `${outcome}/${afterRun} should retain the task`);
            assert.strictEqual(latest.enabled, false);
            assert.strictEqual(latest.nextRun, undefined);
            const persisted = JSON.parse(
              fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
            ) as Array<{ id: string; enabled: boolean; lastFiredDueAt?: string }>;
            const stored = persisted.find((item) => item.id === task.id);
            assert.strictEqual(stored?.enabled, false);
            assert.strictEqual(stored?.lastFiredDueAt, runAt);
            await internals.checkAndExecuteTasks();
            assert.strictEqual(executions, outcome === "failure" ? 1 : 0);
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        }
      }
    } finally {
      restore();
    }
  });

  test("a manual one-time run excludes stale automatic and manual claims in another window", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    let release!: () => void;
    let manualRun: ReturnType<ScheduleManager["runTaskNowDetailed"]> | undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "cross-window claim",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() - 60_000).toISOString(),
        scope: "global",
        jitterSeconds: 0,
      });
      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      let firstExecutions = 0;
      let secondExecutions = 0;
      (first as unknown as { onExecuteCallback: () => Promise<void> }).onExecuteCallback =
        async () => { firstExecutions++; entered(); await hold; };
      const secondInternals = second as unknown as {
        onExecuteCallback: () => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      secondInternals.onExecuteCallback = async () => { secondExecutions++; };

      manualRun = first.runTaskNowDetailed(task.id);
      await started;
      await secondInternals.checkAndExecuteTasks();
      await second.waitForDetachedRuns();
      await waitForStartupSave(second);
      const competingManual = await second.runTaskNowDetailed(task.id);
      assert.strictEqual(competingManual.ok, false);
      assert.strictEqual(secondExecutions, 0);
      release();
      assert.strictEqual((await manualRun).ok, true);
      assert.strictEqual(firstExecutions, 1);
    } finally {
      release();
      await manualRun;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a queued one-time run does not dispatch after its occurrence is rescheduled", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let run: ReturnType<ScheduleManager["runTaskNowDetailed"]> | undefined;
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "queued one-time task",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      let dispatches = 0;
      (first as unknown as {
        onExecuteCallback(
          task: ScheduledTask,
          trigger: string,
          guard?: (dispatch: () => void) => Promise<void>,
        ): Promise<void>;
      }).onExecuteCallback = async (_task, _trigger, guard) => {
        entered();
        await hold;
        assert.ok(guard);
        await guard(() => { dispatches++; });
      };
      run = first.runTaskNowDetailed(task.id);
      await started;
      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      await second.updateTask(task.id, {
        runAt: new Date(Date.now() + 120_000).toISOString(),
        enabled: true,
      });
      release();
      await run;
      assert.strictEqual(dispatches, 0);
    } finally {
      release();
      await run;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an unchanged one-time reservation permits a guarded dispatch", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "guarded one-time task",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
      });
      let dispatches = 0;
      (manager as unknown as {
        onExecuteCallback(
          task: ScheduledTask,
          trigger: string,
          guard?: (dispatch: () => void) => Promise<void>,
        ): Promise<void>;
      }).onExecuteCallback = async (_task, _trigger, guard) => {
        assert.ok(guard);
        await guard(() => { dispatches++; });
      };
      assert.strictEqual((await manager.runTaskNowDetailed(task.id)).ok, true);
      assert.strictEqual(dispatches, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a stale manual cron run cannot bypass a newer one-time reservation", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "manual run of a rescheduled task",
        prompt: "hello",
        cronExpression: "* * * * *",
        scope: "global",
      });
      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      const runAt = new Date(Date.now() + 60_000).toISOString();
      await second.updateTask(task.id, { cronExpression: "", runAt, afterRun: "delete" });

      let dispatches = 0;
      (first as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
        async () => { dispatches++; };
      const result = await first.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(dispatches, 1);
      if (result.ok) {
        assert.strictEqual(result.executionInfo?.runAt, runAt);
        assert.strictEqual(result.executionInfo?.afterRun, "delete");
        assert.ok(result.claimId);
      }

      const reloaded = new ScheduleManager(createMockContext(tmp));
      const persisted = reloaded.getTask(task.id);
      if (dispatches > 0) {
        assert.strictEqual(persisted?.enabled, false);
        assert.strictEqual(persisted?.lastFiredDueAt?.toISOString(), runAt);
      }
      await waitForStartupSave(reloaded);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a changed task is not dispatched using an earlier confirmation", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "original task",
        prompt: "hello",
        cronExpression: "0 9 * * *",
        scope: "global",
      });
      const confirmedSnapshot = JSON.stringify(task);
      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      await second.updateTask(task.id, {
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        afterRun: "delete",
      });
      let dispatches = 0;
      (first as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
        async () => { dispatches++; };

      const result = await first.runTaskNowDetailed(task.id, confirmedSnapshot);
      assert.deepStrictEqual(result, { ok: false, reason: "taskChanged" });
      assert.strictEqual(dispatches, 0);
      await waitForStartupSave(first);
      await waitForStartupSave(second);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a post-run prompt snapshot does not overwrite a newer task edit", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "template task",
        prompt: "old snapshot",
        promptSource: "global",
        promptPath: "valid.prompt.md",
        cronExpression: "0 9 * * *",
        scope: "global",
      });
      const expectedSnapshot = JSON.stringify(task);
      const currentUpdate = { id: task.id, prompt: "fresh file content", expectedSnapshot };
      assert.strictEqual(await first.updateTaskPrompts([currentUpdate]), 1);
      assert.strictEqual(first.getTask(task.id)?.prompt, "fresh file content");
      const executionSnapshot = JSON.stringify(first.getTask(task.id));
      await first.updateTask(task.id, {
        promptSource: "inline",
        promptPath: "",
        prompt: "new prompt",
      });

      const update = {
        id: task.id,
        prompt: "old file content",
        expectedSnapshot: executionSnapshot,
      };
      assert.strictEqual(await first.updateTaskPrompts([update]), 0);
      const reloaded = new ScheduleManager(createMockContext(tmp));
      assert.strictEqual(reloaded.getTask(task.id)?.prompt, "new prompt");
      assert.strictEqual(reloaded.getTask(task.id)?.promptSource, "inline");
      await waitForStartupSave(reloaded);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a manual one-time run does not dispatch a task edited after its reservation", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "confirmed task",
        prompt: "original prompt",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
      });
      const confirmedSnapshot = JSON.stringify(task);
      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      const internals = first as unknown as {
        refreshPersistedTasksIfChanged(requireFile: boolean): Promise<void>;
        onExecuteCallback(): Promise<void>;
      };
      const refreshFirst = internals.refreshPersistedTasksIfChanged.bind(first);
      const refreshSecond = (
        second as unknown as {
          refreshPersistedTasksIfChanged(requireFile: boolean): Promise<void>;
        }
      ).refreshPersistedTasksIfChanged.bind(second);
      internals.refreshPersistedTasksIfChanged = async (requireFile) => {
        if (requireFile) {
          await refreshSecond(false);
          await second.updateTask(task.id, { prompt: "changed prompt" });
        }
        await refreshFirst(requireFile);
      };
      let dispatches = 0;
      internals.onExecuteCallback = async () => { dispatches++; };

      const result = await first.runTaskNowDetailed(task.id, confirmedSnapshot);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.reason, "taskChanged");
        assert.strictEqual(result.errorMessage, messages.manualRunChangedAfterClaim());
      }
      assert.strictEqual(dispatches, 0);
      assert.strictEqual(first.getTask(task.id)?.enabled, false);
      assert.ok(first.getTask(task.id)?.lastFiredClaimId);
      await waitForStartupSave(first);
      await waitForStartupSave(second);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a confirmed unchanged one-time task can still run", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "unchanged task",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
      });
      let dispatches = 0;
      (manager as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
        async () => { dispatches++; };
      const result = await manager.runTaskNowDetailed(task.id, JSON.stringify(task));
      assert.strictEqual(result.ok, true);
      assert.strictEqual(dispatches, 1);
      await waitForStartupSave(manager);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a reclaimed one-time occurrence is not dispatched by an older jittered claim", async () => {
    const restore = overrideSchedulerConfig({ executionRoute: "agentHost" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondHold = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let secondRun: ReturnType<ScheduleManager["runTaskNowDetailed"]> | undefined;
    let first: ScheduleManager | undefined;
    try {
      first = new ScheduleManager(createMockContext(tmp));
      const runAt = new Date(Date.now() - 60_000).toISOString();
      const task = await first.createTask({
        name: "reclaimed occurrence",
        prompt: "hello",
        cronExpression: "",
        runAt,
        scope: "global",
        jitterSeconds: 0,
      });
      let jitterEntered!: () => void;
      const jitterStarted = new Promise<void>((resolve) => { jitterEntered = resolve; });
      let firstDispatches = 0;
      const internals = first as unknown as {
        applyJitter(): Promise<void>;
        onExecuteCallback(): Promise<void>;
        checkAndExecuteTasks(): Promise<void>;
      };
      internals.applyJitter = async () => { jitterEntered(); await firstHold; };
      internals.onExecuteCallback = async () => { firstDispatches++; };
      await internals.checkAndExecuteTasks();
      await jitterStarted;

      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      await second.updateTask(task.id, {
        runAt: new Date(Date.now() + 3_600_000).toISOString(),
        enabled: true,
      });
      await second.updateTask(task.id, { runAt, enabled: true });
      let entered!: () => void;
      const secondStarted = new Promise<void>((resolve) => { entered = resolve; });
      (second as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
        async () => { entered(); await secondHold; };
      secondRun = second.runTaskNowDetailed(task.id);
      await secondStarted;

      releaseFirst();
      await first.waitForDetachedRuns();
      assert.strictEqual(firstDispatches, 0);
    } finally {
      releaseFirst();
      releaseSecond();
      await secondRun;
      if (first) await first.waitForDetachedRuns();
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a torn task payload and metadata read cannot claim an already dispatched one-time run", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    let release!: () => void;
    let firstRun: ReturnType<ScheduleManager["runTaskNowDetailed"]> | undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const prototype = ScheduleManager.prototype as unknown as {
      loadTasksFromFile: () => { tasks: unknown[]; ok: boolean };
    };
    const originalLoad = prototype.loadTasksFromFile;
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "torn-read claim",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
        jitterSeconds: 0,
      });
      const staleTasks = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as unknown[];
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      (first as unknown as { onExecuteCallback: () => Promise<void> }).onExecuteCallback =
        async () => { entered(); await hold; };
      firstRun = first.runTaskNowDetailed(task.id);
      await started;

      prototype.loadTasksFromFile = () => ({ tasks: staleTasks, ok: true });
      const second = new ScheduleManager(createMockContext(tmp));
      prototype.loadTasksFromFile = originalLoad;
      let duplicateDispatches = 0;
      (second as unknown as { onExecuteCallback: () => Promise<void> }).onExecuteCallback =
        async () => { duplicateDispatches++; };

      const secondRun = await second.runTaskNowDetailed(task.id);
      assert.strictEqual(secondRun.ok, false);
      assert.strictEqual(duplicateDispatches, 0);
    } finally {
      prototype.loadTasksFromFile = originalLoad;
      release();
      await firstRun;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("failed one-time claim metadata does not persist an unsent run as completed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "partial claim save",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
        jitterSeconds: 0,
      });
      const internals = manager as unknown as {
        onExecuteCallback: () => Promise<void>;
        saveMetaToFile: () => Promise<void>;
      };
      const originalSaveMeta = internals.saveMetaToFile;
      let dispatches = 0;
      internals.onExecuteCallback = async () => { dispatches++; };
      internals.saveMetaToFile = async () => { throw new Error("metadata unavailable"); };
      const result = await manager.runTaskNowDetailed(task.id);
      internals.saveMetaToFile = originalSaveMeta;
      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.strictEqual(result.reason, "claimFailed");
      assert.strictEqual(dispatches, 0);

      const reloadedManager = new ScheduleManager(createMockContext(tmp));
      const reloaded = reloadedManager.getTask(task.id);
      assert.strictEqual(reloaded?.enabled, true);
      assert.strictEqual(reloaded?.lastFiredDueAt, undefined);
      await waitForStartupSave(reloadedManager);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a cron claim changed to a future one-time schedule during jitter is not dispatched", async () => {
    const restore = overrideSchedulerConfig({ executionRoute: "chat" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "rescheduled during jitter",
        prompt: "hello",
        cronExpression: "* * * * *",
        scope: "global",
        jitterSeconds: 0,
      });
      task.nextRun = truncateToMinute(new Date(Date.now() - 60_000));
      const internals = manager as unknown as {
        saveTasks: () => Promise<void>;
        applyJitter: () => Promise<void>;
        onExecuteCallback: () => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      await internals.saveTasks();
      const runAt = new Date(Date.now() + 86_400_000).toISOString();
      let dispatches = 0;
      internals.applyJitter = async () => {
        await manager.updateTask(task.id, { cronExpression: "", runAt });
      };
      internals.onExecuteCallback = async () => { dispatches++; };

      await internals.checkAndExecuteTasks();
      assert.strictEqual(dispatches, 0);
      assert.strictEqual(manager.getTask(task.id)?.nextRun?.toISOString(), runAt);
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a queued Agent Host cron claim cannot dispatch after rescheduling", async () => {
    const restore = overrideSchedulerConfig({ executionRoute: "agentHost" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let first: ScheduleManager | undefined;
    try {
      first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "queued cron",
        prompt: "hello",
        cronExpression: "* * * * *",
        scope: "global",
        jitterSeconds: 0,
      });
      task.nextRun = truncateToMinute(new Date(Date.now() - 60_000));
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      let dispatches = 0;
      const internals = first as unknown as {
        saveTasks(): Promise<void>;
        checkAndExecuteTasks(): Promise<void>;
        onExecuteCallback(
          task: ScheduledTask,
          trigger: string,
          guard?: (dispatch: () => void) => Promise<void>,
        ): Promise<void>;
      };
      await internals.saveTasks();
      internals.onExecuteCallback = async (_task, _trigger, guard) => {
        entered();
        await hold;
        if (guard) await guard(() => { dispatches++; });
        else dispatches++;
      };
      await internals.checkAndExecuteTasks();
      await started;
      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      await second.updateTask(task.id, {
        cronExpression: "",
        runAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      release();
      await first.waitForDetachedRuns();
      assert.strictEqual(dispatches, 0);
    } finally {
      release();
      if (first) await first.waitForDetachedRuns();
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an unchanged Agent Host cron claim permits guarded dispatch", async () => {
    const restore = overrideSchedulerConfig({ executionRoute: "agentHost" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    let manager: ScheduleManager | undefined;
    try {
      manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "unchanged queued cron",
        prompt: "hello",
        cronExpression: "* * * * *",
        scope: "global",
        jitterSeconds: 0,
      });
      task.nextRun = truncateToMinute(new Date(Date.now() - 60_000));
      let dispatches = 0;
      const internals = manager as unknown as {
        saveTasks(): Promise<void>;
        checkAndExecuteTasks(): Promise<void>;
        onExecuteCallback(
          task: ScheduledTask,
          trigger: string,
          guard?: (dispatch: () => void) => Promise<void>,
        ): Promise<void>;
      };
      await internals.saveTasks();
      internals.onExecuteCallback = async (_task, _trigger, guard) => {
        assert.ok(guard);
        await guard(() => { dispatches++; });
      };
      await internals.checkAndExecuteTasks();
      await manager.waitForDetachedRuns();
      assert.strictEqual(dispatches, 1);
    } finally {
      if (manager) await manager.waitForDetachedRuns();
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a different window can reschedule a cron claim during jitter", async () => {
    const restore = overrideSchedulerConfig({ executionRoute: "chat" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "cross-window jitter reschedule",
        prompt: "hello",
        cronExpression: "* * * * *",
        scope: "global",
        jitterSeconds: 0,
      });
      task.nextRun = truncateToMinute(new Date(Date.now() - 60_000));
      const internals = first as unknown as {
        saveTasks(): Promise<void>;
        applyJitter(): Promise<void>;
        onExecuteCallback(): Promise<void>;
        checkAndExecuteTasks(): Promise<void>;
      };
      await internals.saveTasks();
      const runAt = new Date(Date.now() + 86_400_000).toISOString();
      let dispatches = 0;
      internals.applyJitter = async () => {
        const second = new ScheduleManager(createMockContext(tmp));
        await waitForStartupSave(second);
        await second.updateTask(task.id, { cronExpression: "", runAt });
      };
      internals.onExecuteCallback = async () => { dispatches++; };

      await internals.checkAndExecuteTasks();
      assert.strictEqual(dispatches, 0);
      assert.strictEqual(first.getTask(task.id)?.runAt, runAt);
      await waitForStartupSave(first);
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an old cron completion cannot delete a new one-time schedule", async () => {
    const restore = overrideSchedulerConfig({ executionRoute: "chat" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    let release!: () => void;
    let tick: Promise<void> | undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "old cron completion",
        prompt: "hello",
        cronExpression: "* * * * *",
        scope: "global",
        jitterSeconds: 0,
      });
      task.nextRun = truncateToMinute(new Date(Date.now() - 60_000));
      const internals = first as unknown as {
        saveTasks: () => Promise<void>;
        onExecuteCallback: () => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      await internals.saveTasks();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      internals.onExecuteCallback = async () => { entered(); await hold; };
      tick = internals.checkAndExecuteTasks();
      await started;

      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      const runAt = new Date(Date.now() + 86_400_000).toISOString();
      await second.updateTask(task.id, {
        cronExpression: "",
        runAt,
        afterRun: "delete",
      });
      release();
      await tick;
      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ id: string; runAt?: string }>;
      assert.strictEqual(persisted.find((entry) => entry.id === task.id)?.runAt, runAt);
    } finally {
      release();
      await tick;
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a manual cron completion preserves a new one-time run date", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "manual cron rescheduled",
        prompt: "hello",
        cronExpression: "* * * * *",
        scope: "global",
      });
      const runAt = new Date(Date.now() + 86_400_000).toISOString();
      (manager as unknown as { onExecuteCallback: () => Promise<void> }).onExecuteCallback =
        async () => { await manager.updateTask(task.id, { cronExpression: "", runAt }); };
      assert.strictEqual((await manager.runTaskNowDetailed(task.id)).ok, true);
      assert.strictEqual(manager.getTask(task.id)?.nextRun?.toISOString(), runAt);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a skipped one-time occurrence remains skipped after a conflicting claim save", async () => {
    const restore = overrideSchedulerConfig({
      executionRoute: "chat",
      missedRunPolicy: "skip",
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const skipped = await first.createTask({
        name: "missed one-time",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() - 180_000).toISOString(),
        scope: "global",
        jitterSeconds: 0,
      });
      const recurring = await first.createTask({
        name: "current recurring",
        prompt: "hello",
        cronExpression: "* * * * *",
        scope: "global",
        jitterSeconds: 0,
      });
      recurring.nextRun = truncateToMinute(new Date());
      const internals = first as unknown as {
        saveTasks: () => Promise<void>;
        onExecuteCallback: () => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
        schedulerStartedAt: Date;
      };
      await internals.saveTasks();
      internals.schedulerStartedAt = new Date(Date.now() - 120_000);
      internals.onExecuteCallback = async () => {};
      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      await second.createTask({
        name: "other window change",
        prompt: "hello",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
      });

      await internals.checkAndExecuteTasks();
      assert.strictEqual(first.getTask(skipped.id)?.enabled, false);
      const reloaded = new ScheduleManager(createMockContext(tmp));
      assert.strictEqual(reloaded.getTask(skipped.id)?.enabled, false);
      await waitForStartupSave(reloaded);
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a skipped one-time occurrence survives a conflict without other claims", async () => {
    const restore = overrideSchedulerConfig({
      executionRoute: "chat",
      missedRunPolicy: "skip",
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const skipped = await first.createTask({
        name: "only missed one-time task",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() - 180_000).toISOString(),
        scope: "global",
        jitterSeconds: 0,
      });
      const internals = first as unknown as {
        onExecuteCallback(): Promise<void>;
        checkAndExecuteTasks(): Promise<void>;
        schedulerStartedAt: Date;
      };
      internals.schedulerStartedAt = new Date(Date.now() - 120_000);
      internals.onExecuteCallback = async () => {
        assert.fail("a skipped task must not be dispatched");
      };
      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      await second.createTask({
        name: "other window change",
        prompt: "hello",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
      });

      await internals.checkAndExecuteTasks();
      assert.strictEqual(first.getTask(skipped.id)?.enabled, false);
      const reloaded = new ScheduleManager(createMockContext(tmp));
      assert.strictEqual(reloaded.getTask(skipped.id)?.enabled, false);
      await waitForStartupSave(reloaded);
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a missed one-time skip survives a concurrent rename", async () => {
    const restore = overrideSchedulerConfig({ missedRunPolicy: "skip" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "before rename",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() - 180_000).toISOString(),
        scope: "global",
      });
      const internals = first as unknown as {
        checkAndExecuteTasks(): Promise<void>;
        schedulerStartedAt: Date;
        onExecuteCallback(): Promise<void>;
      };
      internals.schedulerStartedAt = new Date(Date.now() - 120_000);
      internals.onExecuteCallback = async () => assert.fail("missed task ran");
      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      await second.updateTask(task.id, { name: "after rename" });

      await internals.checkAndExecuteTasks();
      const reloaded = new ScheduleManager(createMockContext(tmp));
      assert.strictEqual(reloaded.getTask(task.id)?.name, "after rename");
      assert.strictEqual(reloaded.getTask(task.id)?.enabled, false);
      await waitForStartupSave(reloaded);
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a one-time skip survives a same-window rename during its save", async () => {
    const restore = overrideSchedulerConfig({ missedRunPolicy: "skip" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let checking: Promise<void> | undefined;
    let renaming: Promise<ScheduledTask | undefined> | undefined;
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "before rename",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() - 180_000).toISOString(),
        scope: "global",
      });
      task.updatedAt = new Date(Date.now() - 10_000);
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const internals = manager as unknown as {
        checkAndExecuteTasks(): Promise<void>;
        schedulerStartedAt: Date;
        onExecuteCallback(): Promise<void>;
        saveMetaToFile(meta: { tasksSnapshot?: Array<ScheduledTask> }): Promise<void>;
      };
      internals.schedulerStartedAt = new Date(Date.now() - 120_000);
      internals.onExecuteCallback = async () => assert.fail("missed task ran");
      const saveMeta = internals.saveMetaToFile.bind(manager);
      internals.saveMetaToFile = async (meta) => {
        if (meta.tasksSnapshot?.some((item) => item.id === task.id && !item.enabled)) {
          entered();
          await hold;
        }
        await saveMeta(meta);
      };
      checking = internals.checkAndExecuteTasks();
      await started;
      renaming = manager.updateTask(task.id, { name: "after rename" });
      release();
      await checking;
      await renaming;
      const reloaded = new ScheduleManager(createMockContext(tmp));
      assert.strictEqual(reloaded.getTask(task.id)?.name, "after rename");
      assert.strictEqual(reloaded.getTask(task.id)?.enabled, false);
      await waitForStartupSave(reloaded);
    } finally {
      release();
      await checking;
      await renaming;
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a failed pending reservation cannot leak into an unrelated save", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let run: ReturnType<ScheduleManager["runTaskNowDetailed"]> | undefined;
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const oneTime = await manager.createTask({
        name: "pending reservation",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
      });
      const other = await manager.createTask({
        name: "other task",
        prompt: "hello",
        cronExpression: "0 9 * * *",
        scope: "global",
        enabled: false,
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const internals = manager as unknown as {
        saveMetaToFile(meta: { tasksSnapshot?: Array<ScheduledTask> }): Promise<void>;
        onExecuteCallback(): Promise<void>;
      };
      const saveMeta = internals.saveMetaToFile.bind(manager);
      let held = false;
      let dispatches = 0;
      internals.onExecuteCallback = async () => { dispatches++; };
      internals.saveMetaToFile = async (meta) => {
        if (meta.tasksSnapshot?.some((task) => task.id === oneTime.id && task.lastFiredClaimId)) {
          if (!held) {
            held = true;
            entered();
            await hold;
          }
          throw new Error("reservation commit failed");
        }
        await saveMeta(meta);
      };
      run = manager.runTaskNowDetailed(oneTime.id);
      await started;
      const update = manager.updateTask(other.id, { name: "updated independently" });
      release();
      await update;
      const result = await run;
      assert.strictEqual(result.ok, false);
      assert.strictEqual(dispatches, 0);
      const reloaded = new ScheduleManager(createMockContext(tmp));
      assert.strictEqual(reloaded.getTask(other.id)?.name, "updated independently");
      assert.strictEqual(reloaded.getTask(oneTime.id)?.enabled, true);
      assert.strictEqual(reloaded.getTask(oneTime.id)?.lastFiredDueAt, undefined);
      await waitForStartupSave(reloaded);
    } finally {
      release();
      await run;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a failed one-time reservation does not starve a due recurring task", async () => {
    const restore = overrideSchedulerConfig({
      executionRoute: "chat",
      jitterSeconds: 0,
      maxDailyExecutions: 0,
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const context = createMockContext(tmp);
      const manager = new ScheduleManager(context);
      const oneTime = await manager.createTask({
        name: "unreservable one-time",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() - 180_000).toISOString(),
        scope: "global",
        jitterSeconds: 0,
      });
      const recurring = await manager.createTask({
        name: "independent recurring",
        prompt: "hello",
        cronExpression: "* * * * *",
        scope: "global",
        jitterSeconds: 0,
      });
      recurring.nextRun = truncateToMinute(new Date(Date.now() - 60_000));
      const internals = manager as unknown as {
        saveTasks(): Promise<void>;
        queueFileWrite(): Promise<void>;
        checkAndExecuteTasks(): Promise<void>;
        onExecuteCallback(task: ScheduledTask): Promise<void>;
      };
      await internals.saveTasks();
      internals.queueFileWrite = async () => { throw new Error("file unavailable"); };
      const dispatched: string[] = [];
      internals.onExecuteCallback = async (task) => { dispatched.push(task.id); };

      await internals.checkAndExecuteTasks();
      assert.deepStrictEqual(dispatched, [recurring.id]);
      assert.strictEqual(manager.getTask(oneTime.id)?.enabled, true);
      assert.strictEqual(manager.getTask(oneTime.id)?.lastFiredDueAt, undefined);
      const snapshot = context.globalState.get<{
        tasksSnapshot: Array<{ id: string; enabled: boolean; lastFiredClaimId?: string }>;
      }>("scheduledTasksSnapshot")!;
      const persistedOneTime = snapshot.tasksSnapshot.find((task) => task.id === oneTime.id);
      assert.strictEqual(persistedOneTime?.enabled, true);
      assert.strictEqual(persistedOneTime?.lastFiredClaimId, undefined);
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("execution callbacks receive the actual manual or automatic trigger", async () => {
    const restore = overrideSchedulerConfig({ executionRoute: "chat" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "trigger origin",
        prompt: "hello",
        cronExpression: "* * * * *",
        scope: "global",
        jitterSeconds: 0,
      });
      const internals = manager as unknown as {
        onExecuteCallback: (task: ScheduledTask, trigger: string) => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      const triggers: string[] = [];
      internals.onExecuteCallback = async (_task, trigger) => { triggers.push(trigger); };
      assert.strictEqual((await manager.runTaskNowDetailed(task.id)).ok, true);
      task.nextRun = truncateToMinute(new Date(Date.now() - 60_000));
      await internals.checkAndExecuteTasks();
      assert.deepStrictEqual(triggers, ["manual", "auto"]);
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("history failure retains a one-time task without changing its after-run setting", async () => {
    const restore = overrideSchedulerConfig({ executionRoute: "chat" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "history save failed",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() - 60_000).toISOString(),
        afterRun: "delete",
        scope: "global",
        jitterSeconds: 0,
      });
      const internals = manager as unknown as {
        onExecuteCallback: () => Promise<{ retainOneTimeTask: boolean }>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      internals.onExecuteCallback = async () => ({ retainOneTimeTask: true });
      await internals.checkAndExecuteTasks();
      const retained = manager.getTask(task.id);
      assert.strictEqual(retained?.enabled, false);
      assert.strictEqual(retained?.afterRun, "delete");

      const nextRunAt = new Date(Date.now() + 86_400_000).toISOString();
      await manager.updateTask(task.id, { runAt: nextRunAt, enabled: true });
      assert.strictEqual(manager.getTask(task.id)?.afterRun, "delete");
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a running callback keeps the original schedule when a task is rescheduled", async () => {
    const restore = overrideSchedulerConfig({ executionRoute: "chat" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const oldRunAt = new Date(Date.now() - 60_000).toISOString();
      const task = await manager.createTask({
        name: "schedule snapshot",
        prompt: "hello",
        cronExpression: "",
        runAt: oldRunAt,
        scope: "global",
        jitterSeconds: 0,
      });
      const nextRunAt = new Date(Date.now() + 86_400_000).toISOString();
      let callbackRunAt: string | undefined;
      const internals = manager as unknown as {
        onExecuteCallback: (task: ScheduledTask) => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      internals.onExecuteCallback = async (executedTask) => {
        await manager.updateTask(task.id, { runAt: nextRunAt, enabled: true });
        callbackRunAt = executedTask.runAt;
      };
      await internals.checkAndExecuteTasks();
      assert.strictEqual(callbackRunAt, oldRunAt);
      assert.strictEqual(manager.getTask(task.id)?.runAt, nextRunAt);
    } finally {
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a manual one-time run updates the reloaded task rather than a stale object", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const task = await first.createTask({
        name: "reload during run",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
        jitterSeconds: 0,
      });
      (first as unknown as { onExecuteCallback: () => Promise<void> }).onExecuteCallback =
        async () => {
          const second = new ScheduleManager(createMockContext(tmp));
          await second.createTask({
            name: "other task",
            prompt: "hello",
            cronExpression: "0 9 * * *",
            scope: "global",
          });
          await assert.rejects(() => first.updateTask(task.id, { name: "stale update" }));
        };
      const result = await first.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, true);
      const latest = first.getTask(task.id);
      assert.ok(latest?.lastRun instanceof Date);
      assert.strictEqual(latest.enabled, false);
      const saved = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ id: string; enabled: boolean; lastRun?: string }>;
      assert.strictEqual(saved.find((item) => item.id === task.id)?.enabled, false);
      assert.ok(saved.find((item) => item.id === task.id)?.lastRun);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("finishing an old one-time run does not delete a rescheduled task", async () => {
    const restore = overrideSchedulerConfig({ executionRoute: "agentHost" });
    try {
      for (const trigger of ["manual", "auto"] as const) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
        let release!: () => void;
        const hold = new Promise<void>((resolve) => { release = resolve; });
        let first: ScheduleManager | undefined;
        let second: ScheduleManager | undefined;
        let manualRun: ReturnType<ScheduleManager["runTaskNowDetailed"]> | undefined;
        try {
          first = new ScheduleManager(createMockContext(tmp));
          const runAt = new Date(Date.now() - 60_000).toISOString();
          const task = await first.createTask({
            name: `${trigger} rescheduled`,
            prompt: "hello",
            cronExpression: "",
            runAt,
            afterRun: "delete",
            scope: "global",
            jitterSeconds: 0,
          });

          let entered!: () => void;
          const started = new Promise<void>((resolve) => { entered = resolve; });
          const internals = first as unknown as {
            onExecuteCallback: () => Promise<void>;
            checkAndExecuteTasks: () => Promise<void>;
          };
          internals.onExecuteCallback = async () => { entered(); await hold; };
          if (trigger === "manual") {
            manualRun = first.runTaskNowDetailed(task.id);
          } else {
            await internals.checkAndExecuteTasks();
          }
          await started;
          second = new ScheduleManager(createMockContext(tmp));
          await waitForStartupSave(second);
          const rescheduledAt = new Date(Date.now() + 3_600_000).toISOString();
          await second.updateTask(task.id, { runAt: rescheduledAt, enabled: true });
          release();
          if (manualRun) {
            assert.strictEqual((await manualRun).ok, true);
            assert.strictEqual(
              await first.deleteCompletedOneTimeTask(task.id, runAt, "obsolete-claim"),
              false,
            );
          } else {
            await first.waitForDetachedRuns();
          }
          const saved = JSON.parse(
            fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
          ) as Array<{ id: string; enabled: boolean; runAt?: string }>;
          const latest = saved.find((item) => item.id === task.id);
          assert.strictEqual(latest?.runAt, rescheduledAt);
          assert.strictEqual(latest?.enabled, true);
        } finally {
          release();
          await manualRun;
          if (first) {
            await first.waitForDetachedRuns();
            await waitForStartupSave(first);
          }
          if (second) await waitForStartupSave(second);
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
    } finally {
      restore();
    }
  });

  test("old manual completion cannot delete a new claim for the same date", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondHold = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let firstRun: ReturnType<ScheduleManager["runTaskNowDetailed"]> | undefined;
    let secondRun: ReturnType<ScheduleManager["runTaskNowDetailed"]> | undefined;
    try {
      const first = new ScheduleManager(createMockContext(tmp));
      const runAt = new Date(Date.now() - 60_000).toISOString();
      const task = await first.createTask({
        name: "reclaimed same date",
        prompt: "hello",
        cronExpression: "",
        runAt,
        afterRun: "delete",
        scope: "global",
      });
      let firstEntered!: () => void;
      const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
      (first as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
        async () => { firstEntered(); await firstHold; };
      firstRun = first.runTaskNowDetailed(task.id);
      await firstStarted;

      const second = new ScheduleManager(createMockContext(tmp));
      await waitForStartupSave(second);
      await second.updateTask(task.id, {
        runAt: new Date(Date.now() + 3_600_000).toISOString(),
        enabled: true,
      });
      await second.updateTask(task.id, { runAt, enabled: true });
      let secondEntered!: () => void;
      const secondStarted = new Promise<void>((resolve) => { secondEntered = resolve; });
      (second as unknown as { onExecuteCallback(): Promise<void> }).onExecuteCallback =
        async () => { secondEntered(); await secondHold; };
      secondRun = second.runTaskNowDetailed(task.id);
      await secondStarted;

      releaseFirst();
      const result = await firstRun;
      assert.strictEqual(result.ok, true);
      assert.ok(result.ok && result.claimId);
      if (result.ok && result.claimId) {
        assert.strictEqual(
          await first.deleteCompletedOneTimeTask(task.id, runAt, result.claimId),
          false,
        );
      }
      assert.ok(first.getTask(task.id));
      releaseSecond();
      assert.strictEqual((await secondRun).ok, true);
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.allSettled([firstRun, secondRun]);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a one-time run does not dispatch if the cross-window claim cannot be saved", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "unavailable claim store",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
      });
      let executions = 0;
      const internals = manager as unknown as {
        onExecuteCallback: () => Promise<void>;
        queueFileWrite: () => Promise<void>;
      };
      internals.onExecuteCallback = async () => { executions++; };
      internals.queueFileWrite = async () => { throw new Error("file unavailable"); };
      const result = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.strictEqual(result.reason, "claimFailed");
      assert.strictEqual(executions, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("one-time schedule validates timestamps and can switch to cron", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const input = {
        name: "once",
        prompt: "hello",
        cronExpression: "",
        scope: "global" as const,
      };
      await assert.rejects(
        () => manager.createTask({ ...input, runAt: "2026-02-31T12:00:00Z" }),
        /valid date-time/,
      );
      await assert.rejects(
        () => manager.createTask({ ...input, runAt: "2026-09-26T12:00:00" }),
        /timezone offset/,
      );
      const task = await manager.createTask({
        ...input,
        runAt: "2030-09-26T21:00:00+09:00",
      });
      assert.strictEqual(task.runAt, "2030-09-26T12:00:00.000Z");
      assert.strictEqual(task.afterRun, "disable");
      assert.strictEqual(task.nextRun?.toISOString(), task.runAt);
      await assert.rejects(
        () =>
          manager.updateTask(task.id, {
            runAt: task.runAt,
            cronExpression: "0 9 * * *",
          }),
        /cannot be combined/,
      );
      await manager.updateTask(task.id, {
        runAt: "",
        cronExpression: "0 9 * * *",
      });
      assert.strictEqual(task.runAt, undefined);
      assert.strictEqual(task.afterRun, undefined);
      assert.ok(task.nextRun);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("one-time tasks respect seconds and never re-arm after a persisted claim", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const context = createMockContext(tmp);
      const manager = new ScheduleManager(context);
      const runAt = new Date(Date.now() + 40_000).toISOString();
      const task = await manager.createTask({
        name: "future instant",
        prompt: "hello",
        cronExpression: "",
        runAt,
        scope: "global",
        jitterSeconds: 0,
      });
      let dispatched = 0;
      (
        manager as unknown as { onExecuteCallback: () => Promise<void> }
      ).onExecuteCallback = async () => {
        dispatched++;
      };
      await (
        manager as unknown as { checkAndExecuteTasks: () => Promise<void> }
      ).checkAndExecuteTasks();
      assert.strictEqual(dispatched, 0);
      assert.strictEqual(task.nextRun?.toISOString(), runAt);

      task.lastFiredDueAt = new Date(runAt);
      task.nextRun = undefined;
      await (
        manager as unknown as { saveTasks: () => Promise<void> }
      ).saveTasks();
      const reloaded = new ScheduleManager(context);
      assert.strictEqual(reloaded.getTask(task.id)?.enabled, false);
      assert.strictEqual(reloaded.getTask(task.id)?.nextRun, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("one-time deletion retries after a transient run-result save failure", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const runAt = new Date(Date.now() - 120_000).toISOString();
      const task = await manager.createTask({
        name: "delete with retry",
        prompt: "hello",
        cronExpression: "",
        runAt,
        afterRun: "delete",
        scope: "global",
        jitterSeconds: 0,
      });
      task.lastFiredDueAt = new Date(runAt);
      task.lastFiredClaimId = "test-claim";
      task.nextRun = undefined;
      task.enabled = false;
      const internals = manager as unknown as {
        saveTasks: () => Promise<void>;
        persistRunResults: (
          results: Map<string, Date>,
          claims: Map<string, {
            runAt: string;
            dueAt: Date;
            claimId: string;
            deleteAfterRun: boolean;
          }>,
        ) => Promise<void>;
      };
      await internals.saveTasks();
      const saveTasks = internals.saveTasks.bind(manager);
      let attempts = 0;
      internals.saveTasks = async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("transient save failure");
        }
        await saveTasks();
      };
      await internals.persistRunResults(
        new Map([[task.id, new Date()]]),
        new Map([[task.id, {
          runAt,
          dueAt: new Date(runAt),
          claimId: "test-claim",
          deleteAfterRun: true,
        }]]),
      );
      assert.strictEqual(attempts, 2);
      assert.strictEqual(manager.getTask(task.id), undefined);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ id: string }>;
      assert.ok(!persisted.some((entry) => entry.id === task.id));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("deleteTask restores a task when its save fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "manual cleanup",
        prompt: "hello",
        cronExpression: "",
        runAt: "2030-09-26T12:00:00Z",
        afterRun: "delete",
        scope: "global",
      });
      const internals = manager as unknown as {
        saveTasks: () => Promise<void>;
      };
      const saveTasks = internals.saveTasks.bind(manager);
      internals.saveTasks = async () => {
        throw new Error("transient save failure");
      };
      await assert.rejects(
        () => manager.deleteTask(task.id),
        /transient save failure/,
      );
      assert.strictEqual(manager.getTask(task.id)?.id, task.id);
      internals.saveTasks = saveTasks;
      assert.strictEqual(await manager.deleteTask(task.id), true);
      assert.strictEqual(manager.getTask(task.id), undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("one-time task cannot execute an unpersisted enable after a save failure", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "unpersisted enable",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() - 120_000).toISOString(),
        scope: "global",
        enabled: false,
        jitterSeconds: 0,
      });
      const internals = manager as unknown as {
        saveTasks: () => Promise<void>;
        onExecuteCallback: () => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      internals.saveTasks = async () => {
        throw new Error("transient save failure");
      };
      await assert.rejects(
        () => manager.setTaskEnabled(task.id, true),
        /transient save failure/,
      );
      let dispatched = 0;
      internals.onExecuteCallback = async () => {
        dispatched++;
      };
      await internals.checkAndExecuteTasks();
      assert.strictEqual(manager.getTask(task.id)?.enabled, false);
      assert.strictEqual(dispatched, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("one-time create and reschedule leave no unpersisted state on save failure", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const internals = manager as unknown as {
        saveTasks: () => Promise<void>;
      };
      const saveTasks = internals.saveTasks.bind(manager);
      const failSave = async () => {
        throw new Error("transient save failure");
      };
      internals.saveTasks = failSave;
      const runAt = "2030-09-26T12:00:00Z";
      await assert.rejects(
        () =>
          manager.createTask({
            name: "not saved",
            prompt: "hello",
            cronExpression: "",
            runAt,
            scope: "global",
          }),
        /transient save failure/,
      );
      assert.strictEqual(manager.getAllTasks().length, 0);

      internals.saveTasks = saveTasks;
      const task = await manager.createTask({
        name: "saved",
        prompt: "hello",
        cronExpression: "",
        runAt,
        scope: "global",
        enabled: false,
      });
      internals.saveTasks = failSave;
      await assert.rejects(
        () =>
          manager.updateTask(task.id, {
            runAt: "2031-09-26T12:00:00Z",
            enabled: true,
          }),
        /transient save failure/,
      );
      assert.strictEqual(
        manager.getTask(task.id)?.runAt,
        "2030-09-26T12:00:00.000Z",
      );
      assert.strictEqual(manager.getTask(task.id)?.enabled, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("completed one-time task reports reschedule required rather than already running", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "completed once",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() - 60_000).toISOString(),
        scope: "global",
        jitterSeconds: 0,
      });
      let dispatches = 0;
      (
        manager as unknown as { onExecuteCallback: () => Promise<void> }
      ).onExecuteCallback = async () => {
        dispatches++;
      };
      assert.strictEqual((await manager.runTaskNowDetailed(task.id)).ok, true);
      const again = await manager.runTaskNowDetailed(task.id);
      assert.deepStrictEqual(again, { ok: false, reason: "oneTimeCompleted" });
      assert.strictEqual(dispatches, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("checkAndExecuteTasks persists the run claim before executing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "claim-before-execute",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
      });

      const dueAt = truncateToMinute(new Date(Date.now() - 60 * 1000));
      task.nextRun = dueAt;

      let persistedAtExecution:
        | { lastFiredDueAt?: string; nextRun?: string }
        | undefined;
      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        const stored = JSON.parse(
          fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
        ) as Array<{
          id: string;
          lastFiredDueAt?: string;
          nextRun?: string;
        }>;
        persistedAtExecution = stored.find((entry) => entry.id === task.id);
      };

      await (
        manager as unknown as {
          checkAndExecuteTasks?: () => Promise<void>;
        }
      ).checkAndExecuteTasks?.();

      assert.ok(
        persistedAtExecution,
        "task should already be persisted when execution starts",
      );
      assert.strictEqual(
        new Date(persistedAtExecution?.lastFiredDueAt ?? 0).getTime(),
        dueAt.getTime(),
      );
      assert.ok(
        new Date(persistedAtExecution?.nextRun ?? 0).getTime() >
          dueAt.getTime(),
        "nextRun should be advanced before execution",
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

  test("checkAndExecuteTasks skips runs due before scheduler startup when configured", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const context = createMockContext(tmp);
      const manager = new ScheduleManager(context);
      const task = await manager.createTask({
        name: "skip-missed-run",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
      });
      const internals = manager as unknown as {
        schedulerStartedAt?: Date;
        getMissedRunPolicy: () => "runOnce" | "skip";
        onExecuteCallback?: (task: unknown) => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      internals.schedulerStartedAt = new Date();
      internals.getMissedRunPolicy = () => "skip";
      task.nextRun = truncateToMinute(
        new Date(internals.schedulerStartedAt.getTime() - 60 * 1000),
      );
      let executions = 0;
      internals.onExecuteCallback = async () => {
        executions++;
      };

      await internals.checkAndExecuteTasks();

      assert.strictEqual(executions, 0);
      assert.strictEqual(task.lastRun, undefined);
      assert.strictEqual(task.lastFiredDueAt, undefined);
      assert.ok((task.nextRun as Date).getTime() > Date.now());
      assert.strictEqual(
        context.globalState.get<number>("dailyExecCount", 0),
        0,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("checkAndExecuteTasks runs tasks that became due after scheduler startup", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "due-after-startup",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
      });
      const internals = manager as unknown as {
        schedulerStartedAt?: Date;
        getMissedRunPolicy: () => "runOnce" | "skip";
        onExecuteCallback?: (task: unknown) => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      const dueAt = truncateToMinute(new Date(Date.now() - 60 * 1000));
      internals.schedulerStartedAt = new Date(dueAt.getTime() - 60 * 1000);
      internals.getMissedRunPolicy = () => "skip";
      task.nextRun = dueAt;
      let executions = 0;
      internals.onExecuteCallback = async () => {
        executions++;
      };

      await internals.checkAndExecuteTasks();

      assert.strictEqual(executions, 1);
      assert.strictEqual(task.lastFiredDueAt?.getTime(), dueAt.getTime());
      assert.ok(task.lastRun instanceof Date);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("automatic runs ignore the removed concurrency setting", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const restore = overrideSchedulerConfig({
      maxConcurrentAutomaticRuns: 1,
      maxDailyExecutions: 0,
    });
    let release!: () => void;
    let tick: Promise<void> | undefined;
    let manager: ScheduleManager | undefined;
    try {
      manager = new ScheduleManager(createMockContext(tmp));
      const first = await manager.createTask({
        name: "concurrent-first",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
      });
      const second = await manager.createTask({
        name: "concurrent-second",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
      });
      const dueAt = truncateToMinute(new Date(Date.now() - 60 * 1000));
      first.nextRun = dueAt;
      second.nextRun = dueAt;

      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let bothStarted!: () => void;
      const bothStartedPromise = new Promise<void>((resolve) => {
        bothStarted = resolve;
      });
      const executed: string[] = [];
      const internals = manager as unknown as {
        onExecuteCallback?: (task: { name: string }) => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      internals.onExecuteCallback = async (task) => {
        executed.push(task.name);
        if (executed.length === 2) bothStarted();
        await blocked;
      };

      tick = internals.checkAndExecuteTasks();
      await waitForSignal(bothStartedPromise);
      assert.deepStrictEqual([...executed].sort(), [
        "concurrent-first",
        "concurrent-second",
      ]);
      assert.strictEqual(first.lastFiredDueAt?.getTime(), dueAt.getTime());
      assert.strictEqual(second.lastFiredDueAt?.getTime(), dueAt.getTime());
      assert.ok((second.nextRun as Date).getTime() > dueAt.getTime());
    } finally {
      release?.();
      await tick;
      if (manager) await manager.waitForDetachedRuns();
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("automatic runs have no ten-run concurrency ceiling", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const restore = overrideSchedulerConfig({ maxDailyExecutions: 0 });
    let release!: () => void;
    let tick: Promise<void> | undefined;
    let manager: ScheduleManager | undefined;
    try {
      manager = new ScheduleManager(createMockContext(tmp));
      const tasks = [];
      for (let index = 0; index < 11; index++) {
        tasks.push(
          await manager.createTask({
            name: `concurrent-${index}`,
            prompt: "hello",
            cronExpression: "*/5 * * * *",
            scope: "global",
            promptSource: "inline",
            enabled: true,
            jitterSeconds: 0,
          }),
        );
      }
      const dueAt = truncateToMinute(new Date(Date.now() - 60 * 1000));
      for (const task of tasks) {
        task.nextRun = dueAt;
      }

      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let allStarted!: () => void;
      const allStartedPromise = new Promise<void>((resolve) => {
        allStarted = resolve;
      });
      let active = 0;
      let maximumActive = 0;
      const internals = manager as unknown as {
        onExecuteCallback?: (task: unknown) => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      internals.onExecuteCallback = async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        if (active === 11) {
          allStarted();
        }
        await blocked;
        active--;
      };

      tick = internals.checkAndExecuteTasks();
      await waitForSignal(allStartedPromise);
      assert.strictEqual(maximumActive, 11);
    } finally {
      release?.();
      await tick;
      if (manager) await manager.waitForDetachedRuns();
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("checkAndExecuteTasks serves the oldest waiting occurrence before newer runs", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const manager = new ScheduleManager(createMockContext(tmp));
    try {
      const tasks = [];
      for (const name of ["frequent-first", "older-waiting"]) {
        tasks.push(
          await manager.createTask({
            name,
            prompt: "hello",
            cronExpression: "* * * * *",
            scope: "global",
            promptSource: "inline",
            enabled: true,
            jitterSeconds: 0,
          }),
        );
      }
      const recentDue = truncateToMinute(new Date(Date.now() - 60_000));
      const olderDue = new Date(recentDue.getTime() - 60_000);
      tasks[0].nextRun = recentDue;
      tasks[1].nextRun = olderDue;
      const internals = manager as unknown as {
        onExecuteCallback: (task: { name: string }) => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      const executed: string[] = [];
      internals.onExecuteCallback = async (task) => {
        executed.push(task.name);
      };

      await internals.checkAndExecuteTasks();
      await manager.waitForDetachedRuns();

      // With no window-wide cap both runs start together, so start order is not guaranteed.
      assert.deepStrictEqual([...executed].sort(), ["frequent-first", "older-waiting"]);
    } finally {
      manager.stopScheduler();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  for (const offset of [-1, 0, 1]) {
    test(`missed-run skip uses exact startup boundary (offset ${offset}ms)`, async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
      const restore = overrideSchedulerConfig({ missedRunPolicy: "skip" });
      const manager = new ScheduleManager(createMockContext(tmp));
      try {
        const task = await manager.createTask({
          name: "exact-startup-boundary",
          prompt: "hello",
          cronExpression: "* * * * *",
          scope: "global",
          enabled: true,
          jitterSeconds: 0,
        });
        const dueAt = new Date(truncateToMinute(new Date()).getTime() - 90_000);
        task.nextRun = dueAt;
        const internals = manager as unknown as {
          schedulerStartedAt: Date;
          onExecuteCallback: () => Promise<void>;
          checkAndExecuteTasks: () => Promise<void>;
        };
        internals.schedulerStartedAt = new Date(dueAt.getTime() + offset);
        let executions = 0;
        internals.onExecuteCallback = async () => {
          executions++;
        };
        await internals.checkAndExecuteTasks();
        assert.strictEqual(executions, offset > 0 ? 0 : 1);
      } finally {
        manager.stopScheduler();
        restore();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  for (const failFirst of [false, true]) {
    test(`automatic claims reserve remaining daily budget and release slots (failure=${failFirst})`, async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
      const restore = overrideSchedulerConfig({
        maxDailyExecutions: 1,
      });
      const context = createMockContext(tmp);
      const manager = new ScheduleManager(context);
      try {
        const tasks = [];
        for (const name of ["budget-first", "budget-waiting"]) {
          tasks.push(
            await manager.createTask({
              name,
              prompt: "hello",
              cronExpression: "0 * * * *",
              scope: "global",
              enabled: true,
              jitterSeconds: 0,
            }),
          );
        }
        const dueAt = truncateToMinute(new Date(Date.now() - 60_000));
        for (const task of tasks) task.nextRun = dueAt;
        const internals = manager as unknown as {
          automaticRunsInFlight: number;
          onExecuteCallback: (task: { name: string }) => Promise<void>;
          checkAndExecuteTasks: () => Promise<void>;
        };
        const executions: string[] = [];
        internals.onExecuteCallback = async (task) => {
          executions.push(task.name);
          if (failFirst && task.name === "budget-first")
            throw new Error("dispatch failed");
        };
        await internals.checkAndExecuteTasks();
        assert.deepStrictEqual(executions, ["budget-first"]);
        assert.strictEqual(internals.automaticRunsInFlight, 0);
        assert.strictEqual(tasks[1].nextRun?.getTime(), dueAt.getTime());
        assert.strictEqual(tasks[1].lastFiredDueAt, undefined);
        await internals.checkAndExecuteTasks();
        assert.deepStrictEqual(
          executions,
          failFirst ? ["budget-first", "budget-waiting"] : ["budget-first"],
        );
        assert.strictEqual(internals.automaticRunsInFlight, 0);
        assert.strictEqual(context.globalState.get("dailyExecCount"), 1);
      } finally {
        manager.stopScheduler();
        restore();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  test("checkAndExecuteTasks does not re-run a due time that was already claimed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "duplicate-run-guard",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
      });

      let executions = 0;
      (
        manager as unknown as {
          onExecuteCallback?: (task: unknown) => Promise<void>;
        }
      ).onExecuteCallback = async () => {
        executions++;
      };

      const dueAt = truncateToMinute(new Date(Date.now() - 60 * 1000));
      task.nextRun = dueAt;

      const tick = async () =>
        (
          manager as unknown as {
            checkAndExecuteTasks?: () => Promise<void>;
          }
        ).checkAndExecuteTasks?.();

      await tick();
      assert.strictEqual(executions, 1);

      // Simulate the rollback a conflicting save from another window causes.
      const current = manager.getTask(task.id);
      assert.ok(current);
      current.nextRun = dueAt;

      await tick();
      assert.strictEqual(executions, 1, "the same due time must not re-run");
      assert.ok(
        (current.nextRun as Date).getTime() > dueAt.getTime(),
        "nextRun should be advanced past the already executed due time",
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

  test("automatic settings normalize unknown missed-run policy", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const manager = new ScheduleManager(createMockContext(tmp));
    const restore = overrideSchedulerConfig({ missedRunPolicy: "invalid" });
    try {
      const internals = manager as unknown as {
        getMissedRunPolicy: () => string;
      };
      assert.strictEqual(internals.getMissedRunPolicy(), "runOnce");
    } finally {
      manager.stopScheduler();
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("zero daily limit leaves automatic dispatch capacity available", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const restore = overrideSchedulerConfig({
      maxDailyExecutions: 0,
    });
    const manager = new ScheduleManager(createMockContext(tmp));
    try {
      for (const name of ["unlimited-one", "unlimited-two"]) {
        const task = await manager.createTask({
          name,
          prompt: "hello",
          cronExpression: "0 * * * *",
          scope: "global",
          enabled: true,
          jitterSeconds: 0,
        });
        task.nextRun = new Date(Date.now() - 60_000);
      }
      const internals = manager as unknown as {
        automaticRunsInFlight: number;
        onExecuteCallback: () => Promise<void>;
        checkAndExecuteTasks: () => Promise<void>;
      };
      let executions = 0;
      internals.onExecuteCallback = async () => {
        executions++;
      };
      await internals.checkAndExecuteTasks();
      assert.strictEqual(executions, 2);
      assert.strictEqual(internals.automaticRunsInFlight, 0);
    } finally {
      manager.stopScheduler();
      restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("Run Now does not consume or wait for automatic dispatch slots", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const manager = new ScheduleManager(createMockContext(tmp));
    try {
      const task = await manager.createTask({
        name: "manual-independent",
        prompt: "hello",
        cronExpression: "0 * * * *",
        scope: "global",
        enabled: true,
        jitterSeconds: 0,
      });
      const internals = manager as unknown as {
        automaticRunsInFlight: number;
        onExecuteCallback: () => Promise<void>;
      };
      internals.automaticRunsInFlight = 1;
      let executions = 0;
      internals.onExecuteCallback = async () => {
        executions++;
      };
      assert.strictEqual((await manager.runTaskNowDetailed(task.id)).ok, true);
      assert.strictEqual(executions, 1);
      assert.strictEqual(internals.automaticRunsInFlight, 1);
    } finally {
      manager.stopScheduler();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("checkAndExecuteTasks skips execution when the run claim cannot be persisted", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "claim-failure",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
      });

      let executions = 0;
      let saveAttempts = 0;
      const internals = manager as unknown as {
        automaticRunsInFlight: number;
        onExecuteCallback?: (task: unknown) => Promise<void>;
        saveTasksInternal: () => Promise<void>;
        checkAndExecuteTasks?: () => Promise<void>;
      };
      internals.onExecuteCallback = async () => {
        executions++;
      };
      internals.saveTasksInternal = async () => {
        saveAttempts++;
        throw new Error("store unavailable");
      };

      const dueAt = truncateToMinute(new Date(Date.now() - 60 * 1000));
      task.nextRun = dueAt;

      await internals.checkAndExecuteTasks?.();

      assert.strictEqual(executions, 0);
      assert.strictEqual(
        saveAttempts,
        3,
        "claim should be retried immediately",
      );
      assert.strictEqual((task.nextRun as Date).getTime(), dueAt.getTime());
      assert.strictEqual(task.lastFiredDueAt, undefined);
      assert.strictEqual(internals.automaticRunsInFlight, 0);
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

  test("checkAndExecuteTasks retries persisting run results after a conflicting save", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "run-result-retry",
        prompt: "hello",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: true,
        jitterSeconds: 0,
      });

      const internals = manager as unknown as {
        onExecuteCallback?: (task: unknown) => Promise<void>;
        saveTasks: (options?: unknown) => Promise<void>;
        checkAndExecuteTasks?: () => Promise<void>;
      };
      const originalSaveTasks = internals.saveTasks.bind(manager);
      let failNextSave = false;
      let failures = 0;
      internals.saveTasks = async (options?: unknown) => {
        if (failNextSave) {
          failNextSave = false;
          failures++;
          throw new Error("conflicting save");
        }
        return originalSaveTasks(options);
      };
      internals.onExecuteCallback = async () => {
        failNextSave = true;
      };

      task.nextRun = truncateToMinute(new Date(Date.now() - 60 * 1000));

      await internals.checkAndExecuteTasks?.();

      assert.strictEqual(failures, 1);
      const stored = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ id: string; lastRun?: string }>;
      const persisted = stored.find((entry) => entry.id === task.id);
      assert.ok(
        persisted?.lastRun,
        "lastRun should be persisted by the retry after a failed save",
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

  test("a manual one-time Agent Host failure is retained disabled and is not retried", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const runAt = new Date(Date.now() + 60_000).toISOString();
      const task = await manager.createTask({
        name: "uncertain one-time task",
        prompt: "hello",
        cronExpression: "",
        runAt,
        afterRun: "delete",
        scope: "global",
        enabled: true,
      });
      let attempts = 0;
      (
        manager as unknown as { onExecuteCallback: () => Promise<void> }
      ).onExecuteCallback = async () => {
        attempts++;
        throw createPromptBlockedError("uncertain", "agentHostFailed", "unknown");
      };

      const result = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.turnOutcome, "unknown");
      }
      const latest = manager.getTask(task.id);
      assert.ok(latest);
      assert.strictEqual(latest.enabled, false);
      assert.strictEqual(latest.nextRun, undefined);
      assert.strictEqual(latest.lastFiredDueAt?.toISOString(), runAt);
      assert.strictEqual((await manager.runTaskNowDetailed(task.id)).ok, false);
      assert.strictEqual(attempts, 1);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ id: string; enabled: boolean; lastFiredDueAt?: string }>;
      const stored = persisted.find((item) => item.id === task.id);
      assert.strictEqual(stored?.enabled, false);
      assert.strictEqual(stored?.lastFiredDueAt, runAt);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a failed one-time CLI run remains disabled and cannot be dispatched again", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "unpersisted protection",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
        enabled: true,
      });
      const internals = manager as unknown as { onExecuteCallback: () => Promise<void> };
      let executions = 0;
      internals.onExecuteCallback = async () => {
        executions++;
        throw createPromptBlockedError("CLI failed", "copilotCliFailed");
      };

      const result = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.reason, "promptBlocked");
      }
      assert.strictEqual(manager.getTask(task.id)?.enabled, false);
      assert.strictEqual(manager.getTask(task.id)?.nextRun, undefined);
      assert.strictEqual((await manager.runTaskNowDetailed(task.id)).ok, false);
      assert.strictEqual(executions, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a one-time run retries a transient result-save failure after reservation", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const runAt = new Date(Date.now() + 60_000).toISOString();
      const task = await manager.createTask({
        name: "state save failed",
        prompt: "hello",
        cronExpression: "",
        runAt,
        afterRun: "delete",
        scope: "global",
        enabled: true,
      });
      const internals = manager as unknown as {
        onExecuteCallback: () => Promise<void>;
        saveTasks: () => Promise<void>;
      };
      const originalSave = internals.saveTasks.bind(manager);
      let saveAttempts = 0;
      internals.onExecuteCallback = async () => {};
      internals.saveTasks = async () => {
        if (++saveAttempts === 1) throw new Error("state save failed");
        await originalSave();
      };

      const result = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(saveAttempts, 2);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ id: string; enabled: boolean; lastFiredDueAt?: string; lastRun?: string }>;
      const stored = persisted.find((item) => item.id === task.id);
      assert.strictEqual(stored?.enabled, false);
      assert.strictEqual(stored?.lastFiredDueAt, runAt);
      assert.ok(stored?.lastRun);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a failed result save cannot erase the persisted one-time reservation on reload", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const task = await manager.createTask({
        name: "unpersisted state",
        prompt: "hello",
        cronExpression: "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "global",
        enabled: true,
      });
      const internals = manager as unknown as {
        onExecuteCallback: () => Promise<void>;
        saveTasks: () => Promise<void>;
      };
      internals.onExecuteCallback = async () => {};
      internals.saveTasks = async () => {
        throw new Error("storage unavailable\nmore details");
      };

      const result = await manager.runTaskNowDetailed(task.id);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.reason, "saveFailed");
      }
      assert.strictEqual(manager.getTask(task.id)?.enabled, false);
      await assert.rejects(() => manager.updateTask(task.id, { name: "reload" }));
      assert.strictEqual(manager.getTask(task.id)?.enabled, false);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<{ id: string; enabled: boolean }>;
      assert.strictEqual(persisted.find((item) => item.id === task.id)?.enabled, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
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

  test("run task tool dispatches a disabled task once and persists it disabled", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const context = createMockContext(tmp);
      const manager = new ScheduleManager(context);
      const task = await manager.createTask({
        name: "disabled-manual-run",
        prompt: "local test only",
        cronExpression: "*/5 * * * *",
        scope: "global",
        promptSource: "inline",
        enabled: false,
        jitterSeconds: 1800,
      });
      let calls = 0;
      (
        manager as unknown as { onExecuteCallback: () => Promise<void> }
      ).onExecuteCallback = async () => {
        calls++;
      };
      const tool = createSchedulerRunTaskTool(manager, (selected) =>
        manager.runTaskNowDetailed(selected.id),
      );
      const result = await tool.invoke(
        {
          input: { id: task.id },
        } as vscode.LanguageModelToolInvocationOptions<{ id: string }>,
        { isCancellationRequested: false } as vscode.CancellationToken,
      );
      assert.ok(result);
      const payload = JSON.parse(
        (result.content[0] as vscode.LanguageModelTextPart).value,
      );
      assert.strictEqual(payload.ok, true);
      assert.strictEqual(payload.executionSemantics, "prompt_dispatched");
      assert.strictEqual(payload.task.enabled, false);
      assert.strictEqual(payload.task.prompt, undefined);
      assert.strictEqual(calls, 1);
      assert.strictEqual(task.enabled, false);
      assert.strictEqual(task.nextRun, undefined);
      assert.ok(task.lastRun instanceof Date);
      const saved = JSON.parse(
        fs.readFileSync(path.join(tmp, "scheduledTasks.json"), "utf8"),
      ) as Array<Record<string, unknown>>;
      const persisted = saved.find((entry) => entry.id === task.id);
      assert.strictEqual(persisted?.enabled, false);
      assert.strictEqual(persisted?.nextRun, undefined);
      assert.strictEqual(persisted?.lastRun, task.lastRun.toISOString());
    } finally {
      fs.rmSync(tmp, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  });

  test("runTaskNow advances nextRun when advance is explicitly configured", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    const restoreConfig = overrideSchedulerConfig({
      manualRunNextRunPolicy: "advance",
    });
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
      restoreConfig();
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

  test("runTaskNow advance falls back to current time without a future nextRun", async () => {
    for (const existingNextRun of [
      undefined,
      new Date(Date.now() - 10 * 60 * 1000),
    ]) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
      const restoreConfig = overrideSchedulerConfig({
        manualRunNextRunPolicy: "advance",
      });
      try {
        const manager = new ScheduleManager(createMockContext(tmp));
        const task = await manager.createTask({
          name: "run-now-advance-fallback",
          prompt: "hello",
          cronExpression: "*/5 * * * *",
          scope: "global",
          promptSource: "inline",
          enabled: true,
        });
        task.nextRun = existingNextRun;
        (
          manager as unknown as {
            onExecuteCallback?: (task: unknown) => Promise<void>;
          }
        ).onExecuteCallback = async () => {};

        assert.strictEqual(await manager.runTaskNow(task.id), true);
        assert.ok(task.lastRun instanceof Date);
        assert.ok(task.nextRun instanceof Date);
        assert.ok(task.nextRun.getTime() > task.lastRun.getTime());
        assert.ok(
          task.nextRun.getTime() <= task.lastRun.getTime() + 5 * 60 * 1000,
        );
      } finally {
        restoreConfig();
        fs.rmSync(tmp, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      }
    }
  });

  test("runTaskNow recalculates from now by default", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const config = vscode.workspace.getConfiguration("copilotScheduler");
      assert.strictEqual(
        config.inspect<string>("manualRunNextRunPolicy")?.defaultValue,
        "fromNow",
      );
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
        }
      ).onExecuteCallback = async () => {
        // no-op
      };

      const ok = await manager.runTaskNow(task.id);
      assert.strictEqual(ok, true);
      assert.ok(task.nextRun instanceof Date);
      assert.ok(task.lastRun instanceof Date);
      assert.ok(task.nextRun.getTime() > task.lastRun.getTime());
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

  test("manual run policy preserves explicit choices and defaults invalid values to fromNow", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-"));
    try {
      const manager = new ScheduleManager(createMockContext(tmp));
      const resolver = manager as unknown as {
        getManualRunNextRunPolicy(): string;
      };
      for (const value of [
        undefined,
        null,
        "",
        "invalid",
        42,
        "fromNow",
        "advance",
      ]) {
        const restoreConfig = overrideSchedulerConfig({
          manualRunNextRunPolicy: value,
        });
        try {
          assert.strictEqual(
            resolver.getManualRunNextRunPolicy(),
            value === "advance" ? "advance" : "fromNow",
          );
        } finally {
          restoreConfig();
        }
      }
    } finally {
      fs.rmSync(tmp, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
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
