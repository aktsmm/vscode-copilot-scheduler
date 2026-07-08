/**
 * Copilot Scheduler - Extension Tests
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { parseExpression } from "cron-parser";
import type { ScheduledTask } from "../../types";
import { runSharedSanitizerCases } from "./helpers/sanitizerAssertions";

function findMatchingBraceEnd(source: string, braceStart: number): number {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inSingleQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (inTemplate) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "`") {
        inTemplate = false;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (ch === "`") {
      inTemplate = true;
      continue;
    }

    if (ch === "{") {
      depth++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return -1;
}

function extractBlockFromStartToken(
  source: string,
  startToken: string,
): string {
  const start = source.indexOf(startToken);
  assert.ok(start >= 0, `Start token not found: ${startToken}`);

  const braceStart = source.indexOf("{", start);
  assert.ok(braceStart >= 0, `Opening brace not found for: ${startToken}`);

  const end = findMatchingBraceEnd(source, braceStart);
  assert.ok(end > braceStart, `Closing brace not found for: ${startToken}`);

  return source.slice(start, end);
}

suite("Extension Test Suite", () => {
  test("Extension should be present", () => {
    assert.ok(vscode.extensions.getExtension("yamapan.copilot-scheduler"));
  });

  test("Extension should activate", async () => {
    const extension = vscode.extensions.getExtension(
      "yamapan.copilot-scheduler",
    );
    if (extension) {
      await extension.activate();
      assert.strictEqual(extension.isActive, true);
    }
  });

  test("Commands should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);

    const expectedCommands = [
      "copilotScheduler.createTask",
      "copilotScheduler.createTaskGui",
      "copilotScheduler.listTasks",
      "copilotScheduler.deleteTask",
      "copilotScheduler.toggleTask",
      "copilotScheduler.enableTask",
      "copilotScheduler.disableTask",
      "copilotScheduler.runNow",
      "copilotScheduler.copyPrompt",
      "copilotScheduler.editTask",
      "copilotScheduler.duplicateTask",
      "copilotScheduler.moveToCurrentWorkspace",
      "copilotScheduler.openSettings",
      "copilotScheduler.showVersion",
      "copilotScheduler.showExecutionHistory",
      "copilotScheduler.dumpModelCatalog",
    ];

    for (const cmd of expectedCommands) {
      assert.ok(commands.includes(cmd), `Command ${cmd} should be registered`);
    }

    // Verify no unexpected copilotScheduler commands exist (P6)
    const registeredSchedulerCommands = commands.filter((cmd) =>
      cmd.startsWith("copilotScheduler."),
    );
    assert.strictEqual(
      registeredSchedulerCommands.length,
      expectedCommands.length,
      `Expected ${expectedCommands.length} copilotScheduler commands but found ${registeredSchedulerCommands.length}. Update expectedCommands when adding new commands.`,
    );
  });

  test("FULL_SPECIFICATION stays aligned with package manifest basics", () => {
    const root = path.resolve(__dirname, "../../..");
    const specPath = path.join(root, "FULL_SPECIFICATION.md");
    if (!fs.existsSync(specPath)) {
      return;
    }

    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      version: string;
      contributes?: {
        commands?: Array<{ command?: string }>;
        configuration?: { properties?: Record<string, unknown> };
      };
    };
    const spec = fs.readFileSync(specPath, "utf8");

    assert.match(
      spec,
      new RegExp(`\\|\\s*バージョン\\s*\\|\\s*${packageJson.version}\\s*\\|`),
      "FULL_SPECIFICATION.md should document the current package version",
    );

    for (const item of packageJson.contributes?.commands ?? []) {
      assert.ok(
        item.command && spec.includes(item.command),
        `FULL_SPECIFICATION.md should mention contributed command ${item.command}`,
      );
    }

    for (const settingKey of Object.keys(
      packageJson.contributes?.configuration?.properties ?? {},
    )) {
      if (settingKey === "copilotScheduler.reportIssue") {
        continue;
      }
      assert.ok(
        spec.includes(settingKey),
        `FULL_SPECIFICATION.md should mention contributed setting ${settingKey}`,
      );
    }

    for (const staleToken of [
      "0.1.0",
      "sidebar-icon.svg",
      "tsc -watch -p ./",
      "executePromptViaCLI",
      "setDefaultScope",
    ]) {
      assert.ok(
        !spec.includes(staleToken),
        `FULL_SPECIFICATION.md contains stale token: ${staleToken}`,
      );
    }
  });

  test("README command tables stay aligned with contributed commands", () => {
    const root = path.resolve(__dirname, "../../..");
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      contributes?: { commands?: Array<{ title?: string }> };
    };
    const nls = JSON.parse(
      fs.readFileSync(path.join(root, "package.nls.json"), "utf8"),
    ) as Record<string, string>;
    const readmes = [
      fs.readFileSync(path.join(root, "README.md"), "utf8"),
      fs.readFileSync(path.join(root, "README_ja.md"), "utf8"),
    ];

    for (const item of packageJson.contributes?.commands ?? []) {
      const titleKey = item.title?.match(/^%(.+)%$/)?.[1];
      const title = titleKey ? nls[titleKey] : item.title;
      assert.ok(title, `Command title should resolve: ${item.title}`);
      for (const readme of readmes) {
        assert.ok(
          readme.includes(`Copilot Scheduler: ${title}`),
          `README command table should mention: ${title}`,
        );
      }
    }
  });

  test("README documents natural-language Copilot Chat examples", () => {
    const root = path.resolve(__dirname, "../../..");
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const readmeJa = fs.readFileSync(path.join(root, "README_ja.md"), "utf8");

    assert.match(readme, /natural-language requests/i);
    assert.match(readme, /Schedule a workspace task/i);
    assert.match(readme, /Change the daily summary task/i);
    assert.match(readme, /Pause the release reminder task/i);
    assert.match(readme, /Show my scheduled Copilot tasks/i);
    assert.match(readme, /multiple tasks could match/i);
    assert.match(readmeJa, /自然文の依頼/);
    assert.match(readmeJa, /スケジュール設定して/);
    assert.match(readmeJa, /変更して/);
    assert.match(readmeJa, /一時停止して/);
    assert.match(readmeJa, /見せて/);
    assert.match(readmeJa, /同じ名前のタスク/);
  });

  test("LM write tool descriptions keep natural-language intent", () => {
    const root = path.resolve(__dirname, "../../..");
    const nls = JSON.parse(
      fs.readFileSync(path.join(root, "package.nls.json"), "utf8"),
    ) as Record<string, string>;
    const nlsJa = JSON.parse(
      fs.readFileSync(path.join(root, "package.nls.ja.json"), "utf8"),
    ) as Record<string, string>;
    const createDescription =
      nls["tool.scheduler_create_task.modelDescription"] ?? "";
    const createDescriptionJa =
      nlsJa["tool.scheduler_create_task.modelDescription"] ?? "";
    const updateDescription =
      nls["tool.scheduler_update_task.modelDescription"] ?? "";
    const updateDescriptionJa =
      nlsJa["tool.scheduler_update_task.modelDescription"] ?? "";
    const deleteDescription =
      nls["tool.scheduler_delete_task.modelDescription"] ?? "";
    const deleteDescriptionJa =
      nlsJa["tool.scheduler_delete_task.modelDescription"] ?? "";
    const setEnabledDescription =
      nls["tool.scheduler_set_task_enabled.modelDescription"] ?? "";
    const setEnabledDescriptionJa =
      nlsJa["tool.scheduler_set_task_enabled.modelDescription"] ?? "";

    assert.match(createDescription, /Use when the user asks/i);
    assert.match(createDescription, /schedule|set up|register|automate/i);
    assert.match(
      createDescriptionJa,
      /スケジュール設定|定期実行|タスク登録|自動化/,
    );
    assert.match(updateDescription, /Use when the user asks/i);
    assert.match(updateDescription, /change|edit|reschedule|revise/i);
    assert.match(updateDescriptionJa, /変更|編集|リスケジュール|見直し/);
    assert.match(deleteDescription, /Use when the user asks/i);
    assert.match(deleteDescription, /delete|remove|cancel/i);
    assert.match(deleteDescriptionJa, /削除|除去|キャンセル/);
    assert.match(setEnabledDescription, /Use when the user asks/i);
    assert.match(
      setEnabledDescription,
      /enable|disable|pause|resume|turn on|turn off/i,
    );
    assert.match(
      setEnabledDescriptionJa,
      /有効化|無効化|一時停止|再開|オン|オフ/,
    );
  });

  test("LM tools manifest keeps prompt references and avoids proposed toolsets", () => {
    const root = path.resolve(__dirname, "../../..");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      contributes?: {
        languageModelTools?: Array<{
          name?: string;
          toolReferenceName?: string;
          canBeReferencedInPrompt?: boolean;
          tags?: string[];
        }>;
        languageModelToolSets?: unknown;
      };
    };
    const tools = manifest.contributes?.languageModelTools ?? [];
    const expectedToolNames = [
      "scheduler_query",
      "scheduler_create_task",
      "scheduler_update_task",
      "scheduler_delete_task",
      "scheduler_set_task_enabled",
    ];

    assert.deepStrictEqual(
      tools.map((tool) => tool.name),
      expectedToolNames,
      "Update the expected LM tool surface only after reviewing picker, prompt-reference, and docs impact.",
    );
    assert.strictEqual(
      manifest.contributes?.languageModelToolSets,
      undefined,
      "Do not add proposed languageModelToolSets as a picker workaround without a dedicated compatibility review.",
    );

    for (const tool of tools) {
      assert.strictEqual(
        tool.canBeReferencedInPrompt,
        true,
        `${tool.name} must remain prompt-referenceable for #scheduler_* usage.`,
      );
      assert.strictEqual(tool.toolReferenceName, tool.name);
      assert.deepStrictEqual(
        tool.tags,
        ["copilot-scheduler"],
        `${tool.name} tags should not be removed as an unverified picker workaround; update this guard only after the A/B picker evidence is reviewed.`,
      );
    }
  });

  test("VSIX package ignore keeps local research and repro artifacts out", () => {
    const root = path.resolve(__dirname, "../../..");
    const ignoreLines = fs
      .readFileSync(path.join(root, ".vscodeignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    for (const pattern of [
      "*.vsix",
      "research/**",
      "artifacts/**",
      "output_sessions/**",
      "session/**",
      ".github/**",
      "scripts/**",
    ]) {
      assert.ok(
        ignoreLines.includes(pattern),
        `.vscodeignore must exclude ${pattern} from published VSIX packages.`,
      );
    }
  });
});

suite("Execution History Queue Tests", () => {
  test("enqueueExecutionHistory rejects the failed write and recovers the queue", async () => {
    const { __testOnly } = await import("../../extension");
    const enqueueExecutionHistory =
      __testOnly.enqueueExecutionHistory as (entry: {
        taskId: string;
        taskName: string;
        trigger: "manual" | "auto";
        status: "success" | "failed";
        executedAt: string;
        nextRunAt?: string;
        detail?: string;
      }) => Promise<void>;
    const getExecutionHistoryEntries =
      __testOnly.getExecutionHistoryEntries as () => Array<{
        taskId: string;
        taskName: string;
      }>;
    const setExtensionContextForTests =
      __testOnly.setExtensionContextForTests as (
        context:
          | {
              globalState: {
                get<T>(key: string, defaultValue?: T): T;
                update(key: string, value: unknown): Thenable<void>;
              };
            }
          | undefined,
      ) => void;
    const resetExecutionHistoryQueueForTests =
      __testOnly.resetExecutionHistoryQueueForTests as () => void;

    const storedEntries: unknown[] = [];
    let updateCalls = 0;

    try {
      setExtensionContextForTests({
        globalState: {
          get<T>(_key: string, defaultValue?: T): T {
            return ((storedEntries as unknown) || defaultValue) as T;
          },
          update(_key: string, value: unknown): Thenable<void> {
            updateCalls += 1;
            if (updateCalls === 1) {
              return Promise.reject(new Error("history write failed"));
            }
            storedEntries.splice(
              0,
              storedEntries.length,
              ...((value as unknown[]) || []),
            );
            return Promise.resolve();
          },
        },
      });
      resetExecutionHistoryQueueForTests();

      await assert.rejects(
        () =>
          enqueueExecutionHistory({
            taskId: "task-1",
            taskName: "Task 1",
            trigger: "manual",
            status: "success",
            executedAt: "2026-04-10T00:00:00.000Z",
          }),
        /history write failed/,
      );

      await enqueueExecutionHistory({
        taskId: "task-2",
        taskName: "Task 2",
        trigger: "manual",
        status: "failed",
        executedAt: "2026-04-10T00:01:00.000Z",
        detail: "second call should still persist",
      });

      const entries = getExecutionHistoryEntries();
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]?.taskId, "task-2");
      assert.strictEqual(updateCalls, 2);
    } finally {
      setExtensionContextForTests(undefined);
      resetExecutionHistoryQueueForTests();
    }
  });

  test("getExecutionHistoryEntries ignores persisted entries with invalid trigger or status", async () => {
    const { __testOnly } = await import("../../extension");
    const getExecutionHistoryEntries =
      __testOnly.getExecutionHistoryEntries as () => Array<{
        taskId: string;
        taskName: string;
        trigger: "manual" | "auto";
        status: "success" | "failed";
      }>;
    const setExtensionContextForTests =
      __testOnly.setExtensionContextForTests as (
        context:
          | {
              globalState: {
                get<T>(key: string, defaultValue?: T): T;
                update(key: string, value: unknown): Thenable<void>;
              };
            }
          | undefined,
      ) => void;

    try {
      setExtensionContextForTests({
        globalState: {
          get<T>(_key: string, defaultValue?: T): T {
            void defaultValue;
            return [
              {
                taskId: "task-valid",
                taskName: "Valid",
                trigger: "manual",
                status: "success",
                executedAt: "2026-04-10T00:00:00.000Z",
              },
              {
                taskId: "task-invalid-trigger",
                taskName: "Invalid Trigger",
                trigger: "scheduled",
                status: "success",
                executedAt: "2026-04-10T00:01:00.000Z",
              },
              {
                taskId: "task-invalid-status",
                taskName: "Invalid Status",
                trigger: "auto",
                status: "done",
                executedAt: "2026-04-10T00:02:00.000Z",
              },
            ] as unknown as T;
          },
          update(): Thenable<void> {
            return Promise.resolve();
          },
        },
      });

      const entries = getExecutionHistoryEntries();
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]?.taskId, "task-valid");
      assert.strictEqual(entries[0]?.trigger, "manual");
      assert.strictEqual(entries[0]?.status, "success");
    } finally {
      setExtensionContextForTests(undefined);
    }
  });
});

suite("Cron Expression Tests", () => {
  test("Valid cron expressions should be accepted", () => {
    const validCronExpressions = [
      "* * * * *",
      "0 * * * *",
      "15 9 * * 1-5",
      "0 0 1 * *",
    ];

    for (const expression of validCronExpressions) {
      assert.doesNotThrow(
        () => parseExpression(expression).next().toDate(),
        `Expected cron expression to be accepted: ${expression}`,
      );
    }
  });
});

suite("i18n Tests", () => {
  test("Messages should be defined", async () => {
    // Import dynamically to avoid activation issues
    const { messages } = await import("../../i18n");

    assert.ok(typeof messages.extensionActive === "function");
    assert.ok(typeof messages.taskCreated === "function");
    assert.ok(typeof messages.taskDeleted === "function");
  });

  test("formatCronForDisplay renders common schedules as human summaries", async () => {
    const { formatCronForDisplay, messages } = await import("../../i18n");

    assert.strictEqual(
      formatCronForDisplay("*/20 * * * *"),
      messages.cronPreviewEveryNMinutes().replace("{n}", "20"),
    );
    assert.strictEqual(
      formatCronForDisplay("0 */2 * * *"),
      messages.cronPreviewEveryNHours().replace("{n}", "2"),
    );
    assert.strictEqual(
      formatCronForDisplay("0 * * * *"),
      messages.cronPreviewEveryHour(),
    );
    assert.strictEqual(
      formatCronForDisplay("0 9 * * *"),
      messages.cronPreviewDailyAt().replace("{t}", "09:00"),
    );
    assert.strictEqual(
      formatCronForDisplay("0 9 * * 1-5"),
      messages.cronPreviewWeekdaysAt().replace("{t}", "09:00"),
    );
    assert.strictEqual(
      formatCronForDisplay("0 9 * * 1"),
      messages
        .cronPreviewWeeklyOnAt()
        .replace("{d}", messages.dayMon())
        .replace("{t}", "09:00"),
    );
    assert.strictEqual(
      formatCronForDisplay("0 9 1 * *"),
      messages
        .cronPreviewMonthlyOnAt()
        .replace("{dom}", "1")
        .replace("{t}", "09:00"),
    );
  });

  test("formatCronForDisplay summarizes multi-line strict intervals", async () => {
    const { formatCronForDisplay, messages } = await import("../../i18n");

    assert.strictEqual(
      formatCronForDisplay(
        ["0 0,3,6,9,12,15,18,21 * * *", "30 1,4,7,10,13,16,19,22 * * *"].join(
          "\n",
        ),
      ),
      messages.cronPreviewEveryNMinutes().replace("{n}", "90"),
    );
    assert.strictEqual(
      formatCronForDisplay("0 0,3 * * *\n30 1,4 * * *"),
      messages.cronPreviewMultipleExpressions(),
    );
  });
});

suite("Webview Test Prompt Wiring Tests", () => {
  test("List/Edit webview commands pass test-prompt callback", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const createGuiStart = source.indexOf(
      "function registerCreateTaskGuiCommand(",
    );
    assert.ok(createGuiStart >= 0, "registerCreateTaskGuiCommand not found");
    const createGuiEnd = source.indexOf(
      "function registerListTasksCommand(",
      createGuiStart,
    );
    assert.ok(
      createGuiEnd > createGuiStart,
      "registerCreateTaskGuiCommand end not found",
    );
    const createGuiBlock = source.slice(createGuiStart, createGuiEnd);
    assert.ok(
      createGuiBlock.includes("handleTestPromptAction"),
      "registerCreateTaskGuiCommand should pass handleTestPromptAction to SchedulerWebview.show",
    );

    const listCmdStart = createGuiEnd;
    assert.ok(listCmdStart >= 0, "registerListTasksCommand not found");
    const listCmdEnd = source.indexOf(
      "function registerEditTaskCommand(",
      listCmdStart,
    );
    assert.ok(
      listCmdEnd > listCmdStart,
      "registerListTasksCommand end not found",
    );
    const listCmdBlock = source.slice(listCmdStart, listCmdEnd);
    assert.ok(
      listCmdBlock.includes("handleTestPromptAction"),
      "registerListTasksCommand should pass handleTestPromptAction to SchedulerWebview.show",
    );

    const editCmdStart = listCmdEnd;
    const editCmdEnd = source.indexOf(
      "function registerDeleteTaskCommand()",
      editCmdStart,
    );
    assert.ok(
      editCmdEnd > editCmdStart,
      "registerEditTaskCommand end not found",
    );
    const editCmdBlock = source.slice(editCmdStart, editCmdEnd);
    assert.ok(
      editCmdBlock.includes("handleTestPromptAction"),
      "registerEditTaskCommand should pass handleTestPromptAction to SchedulerWebview.show",
    );
  });

  test("Task QuickPick items include workspace/scope metadata", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    assert.ok(
      source.includes(
        "function buildTaskQuickPickMeta(task: ScheduledTask): string",
      ),
      "extension should define a shared helper for task QuickPick metadata",
    );
    assert.ok(
      source.includes("detail: buildTaskQuickPickMeta(task),"),
      "task QuickPick items should include workspace/scope metadata in detail",
    );
    assert.ok(
      source.includes("messages.labelScopeWorkspace()") &&
        source.includes("messages.labelScopeGlobal()"),
      "task QuickPick metadata should distinguish global and workspace tasks",
    );
  });

  test("buildPromptExecutionOptions keeps structured model selection fields", async () => {
    const { __testOnly } = await import("../../extension");
    const buildPromptExecutionOptions =
      __testOnly.buildPromptExecutionOptions as
        | ((request: ScheduledTask) => Record<string, string | undefined>)
        | undefined;

    assert.ok(typeof buildPromptExecutionOptions === "function");

    const options = buildPromptExecutionOptions({
      id: "t-model-options",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      agent: "edit",
      chatSession: "continue",
      model: "gpt-5.4",
      modelName: "GPT-5.4",
      modelVendor: "OpenAI",
      modelFamily: "gpt-5.4",
      modelVersion: "high",
      modelReasoningEffort: "high",
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    assert.deepStrictEqual(options, {
      agent: "edit",
      chatSession: "continue",
      model: "gpt-5.4",
      modelName: "GPT-5.4",
      modelVendor: "OpenAI",
      modelFamily: "gpt-5.4",
      modelVersion: "high",
      modelReasoningEffort: "high",
    });
  });

  test("resolveNotificationMode normalizes invalid values and keeps legacy silentStatus", async () => {
    const { __testOnly } = await import("../../extension");
    const resolveNotificationMode = __testOnly.resolveNotificationMode as
      | ((showNotificationsEnabled: boolean, mode: unknown) => string)
      | undefined;

    assert.ok(typeof resolveNotificationMode === "function");
    assert.strictEqual(resolveNotificationMode(true, "sound"), "sound");
    assert.strictEqual(
      resolveNotificationMode(true, "silentToast"),
      "silentToast",
    );
    assert.strictEqual(resolveNotificationMode(true, "invalid-mode"), "sound");
    assert.strictEqual(resolveNotificationMode(true, undefined), "sound");
    assert.strictEqual(
      resolveNotificationMode(false, "invalid-mode"),
      "silentStatus",
    );
  });

  test("ensureCreatedTaskAcceptedAfterDisclaimer rolls back new task when disclaimer is declined", async () => {
    const { __testOnly } = await import("../../extension");
    const ensureCreatedTaskAcceptedAfterDisclaimer =
      __testOnly.ensureCreatedTaskAcceptedAfterDisclaimer as
        | ((
            task: ScheduledTask,
            deps: {
              maybeShowDisclaimer: (task: ScheduledTask) => Promise<boolean>;
              deleteTask: (id: string) => Promise<boolean>;
              disableTask: (id: string) => Promise<ScheduledTask | undefined>;
              onTasksChanged: () => void;
              notifyInfo: (message: string) => void;
              notifyError: (message: string) => void;
            },
          ) => Promise<boolean>)
        | undefined;

    assert.ok(typeof ensureCreatedTaskAcceptedAfterDisclaimer === "function");

    const task: ScheduledTask = {
      id: "t-created-decline",
      name: "New task",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let deletedId: string | undefined;
    let disabledId: string | undefined;
    let updateCount = 0;
    let infoMessage: string | undefined;

    const accepted = await ensureCreatedTaskAcceptedAfterDisclaimer!(task, {
      maybeShowDisclaimer: async () => false,
      deleteTask: async (id) => {
        deletedId = id;
        return true;
      },
      disableTask: async (id) => {
        disabledId = id;
        return undefined;
      },
      onTasksChanged: () => {
        updateCount += 1;
      },
      notifyInfo: (message) => {
        infoMessage = message;
      },
      notifyError: () => {
        assert.fail("notifyError should not be called when delete succeeds");
      },
    });

    assert.strictEqual(accepted, false);
    assert.strictEqual(deletedId, task.id);
    assert.strictEqual(disabledId, undefined);
    assert.strictEqual(updateCount, 1);
    assert.strictEqual(
      infoMessage,
      (await import("../../i18n")).messages.disclaimerDeclinedTaskCanceled(
        task.name,
      ),
    );
  });

  test("ensureCreatedTaskAcceptedAfterDisclaimer falls back to disable when rollback fails", async () => {
    const { __testOnly } = await import("../../extension");
    const ensureCreatedTaskAcceptedAfterDisclaimer =
      __testOnly.ensureCreatedTaskAcceptedAfterDisclaimer as
        | ((
            task: ScheduledTask,
            deps: {
              maybeShowDisclaimer: (task: ScheduledTask) => Promise<boolean>;
              deleteTask: (id: string) => Promise<boolean>;
              disableTask: (id: string) => Promise<ScheduledTask | undefined>;
              onTasksChanged: () => void;
              notifyInfo: (message: string) => void;
              notifyError: (message: string) => void;
            },
          ) => Promise<boolean>)
        | undefined;

    assert.ok(typeof ensureCreatedTaskAcceptedAfterDisclaimer === "function");

    const task: ScheduledTask = {
      id: "t-created-disable-fallback",
      name: "Fallback task",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let deleteCount = 0;
    let disabledId: string | undefined;
    let updateCount = 0;
    let infoMessage: string | undefined;

    const accepted = await ensureCreatedTaskAcceptedAfterDisclaimer!(task, {
      maybeShowDisclaimer: async () => false,
      deleteTask: async () => {
        deleteCount += 1;
        return false;
      },
      disableTask: async (id) => {
        disabledId = id;
        return task;
      },
      onTasksChanged: () => {
        updateCount += 1;
      },
      notifyInfo: (message) => {
        infoMessage = message;
      },
      notifyError: () => {
        assert.fail("notifyError should not be called when disable succeeds");
      },
    });

    assert.strictEqual(accepted, false);
    assert.strictEqual(deleteCount, 1);
    assert.strictEqual(disabledId, task.id);
    assert.strictEqual(updateCount, 1);
    assert.strictEqual(
      infoMessage,
      (await import("../../i18n")).messages.disclaimerDeclinedTaskDisabled(
        task.name,
      ),
    );
  });

  test("Configuration and workspace watchers keep webview defaults and templates in sync", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const configWatcherStart = source.indexOf(
      "const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {",
    );
    assert.ok(configWatcherStart >= 0, "configWatcher not found");

    const workspaceWatcherStart = source.indexOf(
      "const workspaceFoldersWatcher = vscode.workspace.onDidChangeWorkspaceFolders(",
      configWatcherStart,
    );
    assert.ok(
      workspaceWatcherStart > configWatcherStart,
      "workspaceFoldersWatcher not found",
    );

    const configWatcherBlock = source.slice(
      configWatcherStart,
      workspaceWatcherStart,
    );
    const configTokens = [
      'e.affectsConfiguration("copilotScheduler.defaultScope")',
      'e.affectsConfiguration("copilotScheduler.autoModeDefault")',
      'e.affectsConfiguration("copilotScheduler.chatSession")',
      'e.affectsConfiguration("copilotScheduler.jitterSeconds")',
      "SchedulerWebview.refreshFormDefaults();",
      'e.affectsConfiguration("copilotScheduler.globalPromptsPath")',
      'e.affectsConfiguration("copilotScheduler.globalAgentsPath")',
      "registerPromptResourceWatchers();",
    ];

    for (const token of configTokens) {
      assert.ok(
        configWatcherBlock.includes(token),
        `Config watcher should include token: ${token}`,
      );
    }

    const subscriptionsStart = source.indexOf(
      "  // Register subscriptions",
      workspaceWatcherStart,
    );
    assert.ok(
      subscriptionsStart > workspaceWatcherStart,
      "subscriptions anchor not found",
    );

    const workspaceWatcherBlock = source.slice(
      workspaceWatcherStart,
      subscriptionsStart,
    );
    assert.ok(
      workspaceWatcherBlock.includes(
        "void SchedulerWebview.refreshCachesAndNotifyPanel(true);",
      ),
      "workspaceFoldersWatcher should refresh cached webview data",
    );
    assert.ok(
      workspaceWatcherBlock.includes("registerPromptResourceWatchers();"),
      "workspaceFoldersWatcher should re-register prompt resource watchers",
    );
  });

  test("Prompt resource watchers cover workspace prompts and global prompt roots", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const watcherBlock = extractBlockFromStartToken(
      source,
      "function registerPromptResourceWatchers(): void {",
    );

    const watcherTokens = [
      'watchPattern("**/.github/prompts/**/*.md");',
      'resolveGlobalPromptsRoot(config.get<string>("globalPromptsPath", ""))',
      'resolveGlobalAgentRoots(config.get<string>("globalAgentsPath", ""))',
      'new vscode.RelativePattern(vscode.Uri.file(root), "**/*.md")',
      "watcher.onDidCreate(refreshCaches)",
      "watcher.onDidChange(refreshCaches)",
      "watcher.onDidDelete(refreshCaches)",
    ];

    for (const token of watcherTokens) {
      assert.ok(
        watcherBlock.includes(token),
        `Prompt resource watcher block should include token: ${token}`,
      );
    }
  });

  test("Command move-to-current-workspace errors stay out of webview inline errors", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const commandStart = source.indexOf(
      "function registerMoveToCurrentWorkspaceCommand(): vscode.Disposable {",
    );
    assert.ok(
      commandStart >= 0,
      "registerMoveToCurrentWorkspaceCommand not found",
    );

    const commandEnd = source.indexOf(
      "function registerOpenSettingsCommand(): vscode.Disposable {",
      commandStart,
    );
    assert.ok(
      commandEnd > commandStart,
      "registerMoveToCurrentWorkspaceCommand end not found",
    );

    const commandBlock = source.slice(commandStart, commandEnd);
    assert.ok(
      commandBlock.includes("notifyError(errorMessage);"),
      "move-to-current-workspace command should still notify VS Code errors",
    );
    assert.ok(
      !commandBlock.includes("SchedulerWebview.showError(errorMessage);"),
      "move-to-current-workspace command should not push command errors into the webview",
    );
  });

  test("Manual run failure paths resync task lists after run-state rollback", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const webviewRunBlock = extractBlockFromStartToken(source, 'case "run": {');
    assert.ok(
      webviewRunBlock.includes(
        "SchedulerWebview.updateTasks(scheduleManager.getAllTasks());",
      ),
      "webview manual-run failure should refresh cached task state",
    );

    const commandStart = source.indexOf('"copilotScheduler.runNow",');
    assert.ok(commandStart >= 0, "runNow command registration not found");

    const commandEnd = source.indexOf(
      "function registerCopyPromptCommand(): vscode.Disposable {",
      commandStart,
    );
    assert.ok(commandEnd > commandStart, "runNow command end not found");

    const commandBlock = source.slice(commandStart, commandEnd);
    assert.ok(
      commandBlock.includes(
        "SchedulerWebview.updateTasks(scheduleManager.getAllTasks());",
      ),
      "command manual-run failure should refresh cached task state",
    );
  });

  test("Webview move-to-current-workspace reports taskNotFound inline on move failure", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const actionBlock = extractBlockFromStartToken(
      source,
      'case "moveToCurrentWorkspace": {',
    );
    assert.ok(
      actionBlock.includes(
        "const moved = await scheduleManager.moveTaskToCurrentWorkspace(task.id);",
      ),
      "webview action should attempt to move the task",
    );
    assert.ok(
      actionBlock.includes("const msg = messages.taskNotFound();"),
      "webview action should build a localized task-not-found error",
    );
    assert.ok(
      actionBlock.includes("notifyError(msg);"),
      "webview action should notify VS Code when move fails",
    );
    assert.ok(
      actionBlock.includes("SchedulerWebview.showError(msg);"),
      "webview action should surface inline error when move fails inside the webview",
    );
  });
});

suite("Error Message Sanitization Tests", () => {
  test("Sanitizes absolute paths to basenames (Windows and POSIX)", async () => {
    const { __testOnly } = await import("../../extension");
    const { messages } = await import("../../i18n");
    const sanitize = __testOnly.sanitizeErrorDetailsForLog as
      | ((message: string) => string)
      | undefined;

    assert.ok(typeof sanitize === "function");
    runSharedSanitizerCases(sanitize!, messages.redactedPlaceholder());
  });

  test("Falls back to localized unknown on empty/whitespace outputs", async () => {
    const { __testOnly } = await import("../../extension");
    const { messages } = await import("../../i18n");
    const sanitize = __testOnly.sanitizeErrorDetailsForLog as
      | ((message: string) => string)
      | undefined;

    assert.ok(typeof sanitize === "function");
    assert.strictEqual(sanitize!(""), messages.webviewUnknown());
    assert.strictEqual(sanitize!("   \t\n"), messages.webviewUnknown());
  });
});

suite("Error Message Display Fallback Tests", () => {
  test("Falls back to localized unknown when message is whitespace only", async () => {
    const { __testOnly } = await import("../../extension");
    const { messages } = await import("../../i18n");
    const resolveDisplay = __testOnly.resolveDisplayErrorMessage as
      | ((message: string) => string)
      | undefined;

    assert.ok(typeof resolveDisplay === "function");
    assert.strictEqual(resolveDisplay!("   \t\n"), messages.webviewUnknown());
  });

  test("Keeps non-empty message after sanitization", async () => {
    const { __testOnly } = await import("../../extension");
    const resolveDisplay = __testOnly.resolveDisplayErrorMessage as
      | ((message: string) => string)
      | undefined;

    assert.ok(typeof resolveDisplay === "function");
    const display = resolveDisplay!(
      "ENOENT: no such file or directory, open 'C:\\Users\\me\\secret folder\\a b.md'",
    );
    assert.ok(display.includes("a b.md"));
    assert.ok(!display.includes("C:\\Users\\me"));
  });

  test("Uses first line only for multi-line errors", async () => {
    const { __testOnly } = await import("../../extension");
    const resolveDisplay = __testOnly.resolveDisplayErrorMessage as
      | ((message: string) => string)
      | undefined;

    assert.ok(typeof resolveDisplay === "function");
    const display = resolveDisplay!("First line\nSecond line");
    assert.strictEqual(display, "First line");
  });
});

suite("toSafeErrorDetails Fallback Tests", () => {
  test("CopilotExecutor toSafeErrorDetails falls back to localized unknown on whitespace", async () => {
    const { __testOnly } = await import("../../copilotExecutor");
    const { messages } = await import("../../i18n");
    const toSafe = __testOnly.toSafeErrorDetails as
      | ((error: unknown) => string)
      | undefined;

    assert.ok(typeof toSafe === "function");
    assert.strictEqual(toSafe!(""), messages.webviewUnknown());
    assert.strictEqual(toSafe!("   \t\n"), messages.webviewUnknown());

    const sanitized = toSafe!("Authorization:Bearer abc.def.ghi");
    assert.ok(!sanitized.includes("abc.def.ghi"));
    assert.ok(
      sanitized.includes(
        `Authorization:Bearer ${messages.redactedPlaceholder()}`,
      ),
    );
  });

  test("ScheduleManager toSafeErrorDetails masks Authorization and falls back on empty", async () => {
    const { __testOnly } = await import("../../scheduleManager");
    const { messages } = await import("../../i18n");
    const toSafe = __testOnly.toSafeErrorDetails as
      | ((error: unknown) => string)
      | undefined;

    assert.ok(typeof toSafe === "function");
    assert.strictEqual(toSafe!(""), messages.webviewUnknown());

    const sanitized = toSafe!("Authorization:Bearer abc.def.ghi");
    assert.ok(!sanitized.includes("abc.def.ghi"));
    assert.ok(
      sanitized.includes(
        `Authorization:Bearer ${messages.redactedPlaceholder()}`,
      ),
    );
  });
});

suite("resolvePromptText Tests", () => {
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
      // Best-effort; tests will fail if the host disallows patching.
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

  test("Prefers open document text when preferOpenDocument=true", async () => {
    const wsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-ws-"),
    );
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");

    const fileName = `__test_resolvePromptText_openDoc_${Date.now()}.md`;
    const absPath = path.join(promptsDir, fileName);
    const relPath = path.join(".github", "prompts", fileName);
    const uri = vscode.Uri.file(absPath);
    let doc: vscode.TextDocument | undefined;

    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(absPath, "DISK", "utf8");

      doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      assert.ok(editor, "An editor should be available");

      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      await editor!.edit((b) => b.replace(fullRange, "UNSAVED"));
      assert.strictEqual(doc.isDirty, true);

      const { __testOnly } = await import("../../extension");
      const task = {
        id: "t-open-doc",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "FALLBACK",
        enabled: true,
        scope: "global",
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      const resolved = await __testOnly.resolvePromptText(task, true);
      assert.strictEqual(resolved, "UNSAVED");
    } finally {
      restoreWs();
      try {
        if (doc) {
          await vscode.window.showTextDocument(doc);
          if (vscode.window.activeTextEditor?.document === doc) {
            try {
              await vscode.commands.executeCommand(
                "workbench.action.revertAndCloseActiveEditor",
              );
            } catch {
              await doc.save();
              await vscode.commands.executeCommand(
                "workbench.action.closeActiveEditor",
              );
            }
          }
        }
      } catch {
        // ignore
      }
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

  test("Reads persisted file when preferOpenDocument=false", async () => {
    const wsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-ws-"),
    );
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");

    const fileName = `__test_resolvePromptText_diskOnly_${Date.now()}.md`;
    const absPath = path.join(promptsDir, fileName);
    const relPath = path.join(".github", "prompts", fileName);
    const uri = vscode.Uri.file(absPath);
    let doc: vscode.TextDocument | undefined;

    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(absPath, "DISK", "utf8");

      doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      assert.ok(editor, "An editor should be available");

      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      await editor!.edit((b) => b.replace(fullRange, "UNSAVED"));
      assert.strictEqual(doc.isDirty, true);

      const { __testOnly } = await import("../../extension");
      const task = {
        id: "t-disk-only",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "FALLBACK",
        enabled: true,
        scope: "global",
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      const resolved = await __testOnly.resolvePromptText(task, false);
      assert.strictEqual(resolved, "DISK");
    } finally {
      restoreWs();
      try {
        if (doc) {
          await vscode.window.showTextDocument(doc);
          if (vscode.window.activeTextEditor?.document === doc) {
            try {
              await vscode.commands.executeCommand(
                "workbench.action.revertAndCloseActiveEditor",
              );
            } catch {
              await doc.save();
              await vscode.commands.executeCommand(
                "workbench.action.closeActiveEditor",
              );
            }
          }
        }
      } catch {
        // ignore
      }
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

  test("Throws when open prompt template is empty instead of falling back to stored prompt", async () => {
    const wsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-ws-"),
    );
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");

    const fileName = `__test_resolvePromptText_emptyOpenDoc_${Date.now()}.md`;
    const absPath = path.join(promptsDir, fileName);
    const relPath = path.join(".github", "prompts", fileName);
    const uri = vscode.Uri.file(absPath);
    let doc: vscode.TextDocument | undefined;

    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(absPath, "DISK", "utf8");

      doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      assert.ok(editor, "An editor should be available");

      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      await editor!.edit((b) => b.replace(fullRange, "   \n"));
      assert.strictEqual(doc.isDirty, true);

      const { __testOnly } = await import("../../extension");
      const { messages } = await import("../../i18n");
      const task = {
        id: "t-empty-open-doc",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "FALLBACK",
        enabled: true,
        scope: "global",
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      await assert.rejects(
        () => __testOnly.resolvePromptText(task, true),
        (error: unknown) =>
          error instanceof Error &&
          error.message === messages.promptTemplateEmpty(fileName),
      );
    } finally {
      restoreWs();
      try {
        if (doc) {
          await vscode.window.showTextDocument(doc);
          if (vscode.window.activeTextEditor?.document === doc) {
            try {
              await vscode.commands.executeCommand(
                "workbench.action.revertAndCloseActiveEditor",
              );
            } catch {
              await doc.save();
              await vscode.commands.executeCommand(
                "workbench.action.closeActiveEditor",
              );
            }
          }
        }
      } catch {
        // ignore
      }
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

  test("Throws when persisted prompt template is empty instead of falling back to stored prompt", async () => {
    const wsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-ws-"),
    );
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");

    const fileName = `__test_resolvePromptText_emptyFile_${Date.now()}.md`;
    const absPath = path.join(promptsDir, fileName);
    const relPath = path.join(".github", "prompts", fileName);

    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(absPath, "  \n", "utf8");

      const { __testOnly } = await import("../../extension");
      const { messages } = await import("../../i18n");
      const task = {
        id: "t-empty-file",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "FALLBACK",
        enabled: true,
        scope: "global",
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      await assert.rejects(
        () => __testOnly.resolvePromptText(task, false),
        (error: unknown) =>
          error instanceof Error &&
          error.message === messages.promptTemplateEmpty(fileName),
      );
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

suite("Frontmatter Resolution Tests", () => {
  test("Uses frontmatter agent/model when task options are not set", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-frontmatter-default",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: '---\nagent: "edit"\nmodel: gpt-4o\n---\nBody',
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "Body");
    assert.strictEqual(resolved.agent, "edit");
    assert.strictEqual(resolved.model, "gpt-4o");
  });

  test("Task agent/model override frontmatter values", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-frontmatter-override",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "---\nagent: ask\nmodel: gpt-4o\n---\nBody",
      enabled: true,
      agent: "edit",
      model: "claude-sonnet-4",
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "Body");
    assert.strictEqual(resolved.agent, "edit");
    assert.strictEqual(resolved.model, "claude-sonnet-4");
  });

  test("Preserves structured model selection metadata from task", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{
          prompt: string;
          agent?: string;
          model?: string;
          modelName?: string;
          modelVendor?: string;
          modelFamily?: string;
          modelVersion?: string;
          modelReasoningEffort?: string;
        }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-frontmatter-structured-model",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      agent: "edit",
      model: "gpt-5.4",
      modelName: "GPT-5.4",
      modelVendor: "OpenAI",
      modelFamily: "gpt-5.4",
      modelVersion: "high",
      modelReasoningEffort: "high",
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "Body");
    assert.strictEqual(resolved.agent, "edit");
    assert.strictEqual(resolved.model, "gpt-5.4");
    assert.strictEqual(resolved.modelName, "GPT-5.4");
    assert.strictEqual(resolved.modelVendor, "OpenAI");
    assert.strictEqual(resolved.modelFamily, "gpt-5.4");
    assert.strictEqual(resolved.modelVersion, "high");
    assert.strictEqual(resolved.modelReasoningEffort, "high");
  });

  test("Explicit empty task agent/model fallback to frontmatter", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-frontmatter-empty",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "---\nagent: ask\nmodel: gpt-4o\n---\nBody",
      enabled: true,
      agent: "",
      model: "",
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "Body");
    assert.strictEqual(resolved.agent, "ask");
    assert.strictEqual(resolved.model, "gpt-4o");
  });

  test("Strips frontmatter even when prompt body is empty", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const rawPrompt = "---\nagent: ask\nmodel: gpt-4o\n---\n";
    const task = {
      id: "t-frontmatter-empty-body",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: rawPrompt,
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "");
    assert.strictEqual(resolved.agent, "ask");
    assert.strictEqual(resolved.model, "gpt-4o");
  });

  test("Does not strip frontmatter block when agent/model keys are missing", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const rawPrompt = "---\ndescription: sample\ntools: []\n---\nBody";
    const task = {
      id: "t-frontmatter-no-keys",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: rawPrompt,
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, rawPrompt);
    assert.strictEqual(resolved.agent, undefined);
    assert.strictEqual(resolved.model, undefined);
  });

  test("Inserts auto hint after frontmatter when frontmatter has no agent/model", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-auto-mode-frontmatter-no-keys",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "---\ndescription: sample\ntools: []\n---\nBody",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      autoMode: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(
      resolved.prompt,
      "---\ndescription: sample\ntools: []\n---\n[auto] Proceed autonomously. Apply all changes directly without asking for confirmation.\n\nBody",
    );
  });

  test("Inserts auto hint at beginning when task.autoMode is true", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-auto-mode-on",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      autoMode: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(
      resolved.prompt,
      "[auto] Proceed autonomously. Apply all changes directly without asking for confirmation.\n\nBody",
    );
  });

  test("Does not insert auto hint when task.autoMode is false", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-auto-mode-off",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      autoMode: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "Body");
  });

  test("Does not duplicate auto hint when prompt already contains auto", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-auto-mode-no-dup",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body\n\nauto",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      autoMode: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "Body\n\nauto");
  });
});
