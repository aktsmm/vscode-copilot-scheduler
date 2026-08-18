/**
 * Copilot Scheduler - Extension Tests
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { parseExpression } from "cron-parser";
import type { ExecutionHistoryEntry } from "../../executionHistoryStore";
import { messages } from "../../i18n";
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

  test("user-facing text files carry no replacement characters or lone surrogates", () => {
    const root = path.resolve(__dirname, "../../..");
    // These surfaces are read outside the editor (Marketplace page, UI strings),
    // where a broken emoji is invisible to a compiler but visible to every user.
    const files = [
      "README.md",
      "README_ja.md",
      "CHANGELOG.md",
      "package.json",
      "package.nls.json",
      "package.nls.ja.json",
    ];

    for (const file of files) {
      const content = fs.readFileSync(path.join(root, file), "utf8");
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        assert.ok(
          !lines[i].includes("\uFFFD"),
          `${file}:${i + 1} contains a replacement character: ${lines[i].trim()}`,
        );
        assert.ok(
          !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
            lines[i],
          ),
          `${file}:${i + 1} contains a lone surrogate: ${lines[i].trim()}`,
        );
      }
    }
  });

  test("both READMEs document attachments with matching section markers", () => {
    const root = path.resolve(__dirname, "../../..");
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const readmeJa = fs.readFileSync(path.join(root, "README_ja.md"), "utf8");

    assert.ok(
      readme.includes("## \u{1F4CE} Attachments"),
      "README.md should keep the attachments section heading intact",
    );
    assert.ok(
      readmeJa.includes("## \u{1F4CE} 添付ファイル"),
      "README_ja.md should keep the attachments section heading intact",
    );
    for (const [file, content] of [
      ["README.md", readme],
      ["README_ja.md", readmeJa],
    ] as const) {
      assert.ok(
        content.includes(".env*") && content.includes("secrets/"),
        `${file} should document the attachment denylist`,
      );
      assert.ok(
        content.includes("blocked"),
        `${file} should document that an unresolvable attachment blocks the run`,
      );
    }
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

  test("LM write tool schemas expose model selection and stay closed for updates", () => {
    const root = path.resolve(__dirname, "../../..");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      contributes?: {
        languageModelTools?: Array<{
          name?: string;
          inputSchema?: {
            properties?: Record<string, Record<string, unknown>>;
          };
        }>;
      };
    };
    const tools = manifest.contributes?.languageModelTools ?? [];
    const toolByName = (name: string) =>
      tools.find((tool) => tool.name === name);

    const queryKinds = toolByName("scheduler_query")?.inputSchema?.properties
      ?.kind?.enum as string[] | undefined;
    assert.ok(queryKinds?.includes("list_models"));
    assert.ok(queryKinds?.includes("list_agents"));

    const createProperties =
      toolByName("scheduler_create_task")?.inputSchema?.properties ?? {};
    const updates = toolByName("scheduler_update_task")?.inputSchema?.properties
      ?.updates as
      | { additionalProperties?: boolean; properties?: Record<string, unknown> }
      | undefined;

    for (const key of [
      "model",
      "modelReasoningEffort",
      "autoMode",
      "jitterSeconds",
      "maxExecutionsPerDay",
      "allowedTimeStart",
      "allowedTimeEnd",
    ]) {
      assert.ok(
        createProperties[key],
        `scheduler_create_task must expose '${key}' so agent mode can set it.`,
      );
      assert.ok(
        updates?.properties?.[key],
        `scheduler_update_task updates must expose '${key}'.`,
      );
    }
    assert.ok(updates?.properties?.scope);
    assert.strictEqual(
      updates?.additionalProperties,
      false,
      "Keep 'updates' closed so unknown fields fail fast instead of being ignored.",
    );
    assert.strictEqual(
      createProperties.modelName,
      undefined,
      "Derived model metadata must stay out of the schema; it is filled in by model resolution.",
    );
  });

  test("LM tools receive the same filtered model catalog as the picker", () => {
    const root = path.resolve(__dirname, "../../..");
    const source = fs.readFileSync(
      path.join(root, "src", "extension.ts"),
      "utf8",
    );
    const contract =
      "Contract: list_models and model resolution must share one loader that applies filterPickerModelCatalog, so Chat only offers models the Webview picker also shows. Only the execution-time resolver in copilotExecutor may use the raw catalog.";

    const loaderIndex = source.indexOf("const loadPickerModelCatalog");
    assert.notStrictEqual(
      loaderIndex,
      -1,
      `loadPickerModelCatalog not found. ${contract}`,
    );
    const callIndex = source.indexOf("registerLmTools(", loaderIndex);
    assert.notStrictEqual(
      callIndex,
      -1,
      `registerLmTools call not found after the loader. ${contract}`,
    );

    const loaderBlock = source.slice(loaderIndex, callIndex);
    const call = source.slice(callIndex, source.indexOf("});", callIndex));

    assert.match(
      loaderBlock,
      /filterPickerModelCatalog/,
      `The loader no longer filters the catalog. ${contract}`,
    );
    assert.match(
      call,
      /listModels:\s*loadPickerModelCatalog/,
      `list_models no longer uses the shared loader. ${contract}`,
    );
    assert.match(
      call,
      /createModelSelectionResolver\(loadPickerModelCatalog\)/,
      `Model resolution no longer uses the shared loader. ${contract}`,
    );
    assert.strictEqual(
      /getAvailableModelsWithSource/.test(call),
      false,
      `The raw catalog is being handed to the LM tools. ${contract}`,
    );
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
  test("history quick picks expose prompt audit metadata", async () => {
    const { __testOnly } = await import("../../extension");
    const buildItems = __testOnly.buildExecutionHistoryQuickPickItems as (
      entries: ExecutionHistoryEntry[],
    ) => Array<{ description: string; detail: string }>;

    const [item] = buildItems([
      {
        taskId: "task-audit",
        taskName: "Audit task",
        trigger: "manual",
        status: "success",
        executedAt: "2026-07-30T09:00:00.000Z",
        promptSource: "snapshotFallback",
        promptPathDisplay: "daily.prompt.md",
        promptHash: "ABC123DEF456",
        promptResolvedAt: "2026-07-30T08:59:59.000Z",
        promptFallbackReason: "readFailed",
      },
    ]);

    assert.ok(item.detail.includes(messages.executionPromptSourceSnapshot()));
    assert.ok(item.detail.includes("daily.prompt.md"));
    assert.ok(item.detail.includes("abc123def456"));
    assert.ok(item.detail.includes(messages.promptBlockedReasonReadFailed()));
    assert.ok(
      item.detail.includes(messages.executionHistoryPromptResolvedAt()),
    );
  });

  test("history quick picks preserve legacy detail and tolerate malformed dates", async () => {
    const { __testOnly } = await import("../../extension");
    const buildItems = __testOnly.buildExecutionHistoryQuickPickItems as (
      entries: ExecutionHistoryEntry[],
    ) => Array<{ description: string; detail: string }>;

    const [legacy, malformed] = buildItems([
      {
        taskId: "legacy",
        taskName: "Legacy",
        trigger: "auto",
        status: "failed",
        executedAt: "2026-07-30T09:00:00.000Z",
        detail: "existing detail",
      },
      {
        taskId: "malformed",
        taskName: "Malformed",
        trigger: "auto",
        status: "success",
        executedAt: "not-a-date",
        nextRunAt: "also-not-a-date",
        promptSource: "not-valid",
        promptHash: "x",
        promptResolvedAt: "still-not-a-date",
        promptFallbackReason: "unknown-reason",
      } as unknown as ExecutionHistoryEntry,
    ]);

    assert.strictEqual(legacy.detail, "existing detail");
    assert.ok(malformed.description.includes(messages.webviewUnknown()));
    assert.ok(malformed.detail.includes(messages.webviewUnknown()));
    assert.ok(!malformed.detail.includes("not-valid"));
    assert.ok(!malformed.detail.includes("unknown-reason"));
    assert.ok(!malformed.detail.includes("Hash"));
  });

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

suite("Manual Run Workspace Confirmation Tests", () => {
  function task(scope: "global" | "workspace"): ScheduledTask {
    return {
      id: `confirm-${scope}`,
      name: "Confirm task",
      cronExpression: "0 * * * *",
      prompt: "hello",
      enabled: true,
      scope,
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  test("allows global and matching workspace tasks without prompting", async () => {
    const { __testOnly } = await import("../../extension");
    const confirm = __testOnly.confirmManualRunIfWorkspaceMismatch;
    let promptCalls = 0;
    const deps = {
      shouldRunInCurrentWorkspace: () => true,
      showWarningMessage: async () => {
        promptCalls += 1;
        return undefined;
      },
    };

    assert.strictEqual(await confirm(task("global"), deps), true);
    assert.strictEqual(await confirm(task("workspace"), deps), true);
    assert.strictEqual(promptCalls, 0);
  });

  test("requires explicit confirmation for another workspace", async () => {
    const { __testOnly } = await import("../../extension");
    const confirm = __testOnly.confirmManualRunIfWorkspaceMismatch;
    const choices: Array<string | undefined> = [
      undefined,
      messages.confirmRunAnyway(),
    ];
    const deps = {
      shouldRunInCurrentWorkspace: () => false,
      showWarningMessage: async () => choices.shift(),
    };

    assert.strictEqual(await confirm(task("workspace"), deps), false);
    assert.strictEqual(await confirm(task("workspace"), deps), true);
  });
});

suite("Execution History View Routing Tests", () => {
  test("notifies instead of opening QuickPick when history is empty", async () => {
    const { __testOnly } = await import("../../extension");
    const notifications: string[] = [];
    let quickPickCalls = 0;

    await __testOnly.showExecutionHistoryView({
      getHistoryEntries: () => [],
      notifyInfo: (message) => notifications.push(message),
      showQuickPick: async () => {
        quickPickCalls += 1;
      },
    });

    assert.deepStrictEqual(notifications, [messages.executionHistoryEmpty()]);
    assert.strictEqual(quickPickCalls, 0);
  });

  test("opens searchable QuickPick with execution history items", async () => {
    const { __testOnly } = await import("../../extension");
    let captured:
      | {
          items: Array<{ label: string; detail: string }>;
          options: {
            placeHolder: string;
            matchOnDescription: boolean;
            matchOnDetail: boolean;
          };
        }
      | undefined;

    await __testOnly.showExecutionHistoryView({
      getHistoryEntries: () => [
        {
          taskId: "history-view",
          taskName: "History view",
          trigger: "manual",
          status: "success",
          executedAt: "2026-07-30T09:00:00.000Z",
          promptSource: "file",
          promptHash: "abc123def456",
        },
      ],
      notifyInfo: () => undefined,
      showQuickPick: async (items, options) => {
        captured = { items, options };
      },
    });

    assert.ok(captured);
    assert.strictEqual(captured.items.length, 1);
    assert.ok(captured.items[0].detail.includes("abc123def456"));
    assert.deepStrictEqual(captured.options, {
      placeHolder: messages.executionHistoryPickPlaceholder(),
      matchOnDescription: true,
      matchOnDetail: true,
    });
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
    assert.ok(typeof messages.promptFileExecutionNote === "function");
    assert.ok(typeof messages.confirmReplacePromptEdits === "function");
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
    assert.ok(createGuiBlock.includes("handlePromptPreviewRequest"));
    assert.ok(createGuiBlock.includes("handleOpenPromptFile"));

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
    assert.ok(listCmdBlock.includes("handlePromptPreviewRequest"));
    assert.ok(listCmdBlock.includes("handleOpenPromptFile"));

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
    assert.ok(editCmdBlock.includes("handlePromptPreviewRequest"));
    assert.ok(editCmdBlock.includes("handleOpenPromptFile"));
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
      __testOnly.buildPromptExecutionOptions as unknown as
        | ((request: ScheduledTask) => Record<string, unknown>)
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
      attachFilePaths: undefined,
    });
  });

  test("buildPromptExecutionOptions blocks the run when an attachment disappeared after save", async () => {
    const { __testOnly } = await import("../../extension");
    const { getPromptBlockedReason, isPromptBlockedError } =
      await import("../../promptExecutionErrors");
    const buildPromptExecutionOptions =
      __testOnly.buildPromptExecutionOptions as unknown as (
        request: ScheduledTask,
        localAttachmentRoots?: string[],
      ) => { attachFilePaths?: string[] };

    assert.ok(typeof buildPromptExecutionOptions === "function");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-attach-block-"));
    const attached = path.join(root, "team.instructions.md");
    fs.writeFileSync(attached, "guidance", "utf8");

    const task: ScheduledTask = {
      id: "t-attach-block",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "workspace",
      promptSource: "inline",
      attachments: [{ source: "local", path: "team.instructions.md" }],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      assert.deepStrictEqual(
        buildPromptExecutionOptions(task, [root]).attachFilePaths,
        [attached],
        "an existing attachment must resolve to an absolute path at execution time",
      );

      fs.renameSync(attached, path.join(root, "renamed.instructions.md"));

      assert.throws(
        () => buildPromptExecutionOptions(task, [root]),
        (error: unknown) =>
          isPromptBlockedError(error) &&
          getPromptBlockedReason(error) === "attachmentMissing" &&
          String((error as Error).message).includes("team.instructions.md"),
        "a missing attachment must fail closed instead of running without it",
      );

      assert.throws(
        () => buildPromptExecutionOptions(task, []),
        (error: unknown) =>
          isPromptBlockedError(error) &&
          getPromptBlockedReason(error) === "attachmentMissing",
        "a local attachment with no local root must fail closed",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a blocked attachment warns once per attachment set and clears after a successful run", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    assert.ok(
      /getPromptBlockedReason\(error\) === "attachmentMissing" &&\s*attachmentBlockNotifications\.get\(task\.id\) !== attachmentSignature\s*\)\s*\{\s*attachmentBlockNotifications\.set\(task\.id, attachmentSignature\);\s*void vscode\.window\.showWarningMessage\(/.test(
        source,
      ),
      "the attachment warning must be keyed by the failing attachment set so a scheduled task cannot warn on every tick",
    );
    assert.ok(
      source.includes("attachmentBlockNotifications.delete(task.id);"),
      "a successful run must clear the notification so a later block warns again",
    );
  });

  test("editing a blocked task's attachments makes the next failure audible again", async () => {
    const { __testOnly } = await import("../../extension");
    const getAttachmentSignature =
      __testOnly.getAttachmentSignature as unknown as (
        task: ScheduledTask,
      ) => string;
    const notifications =
      __testOnly.attachmentBlockNotifications as unknown as Map<string, string>;

    const base: ScheduledTask = {
      id: "t-attach-signature",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "workspace",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    assert.strictEqual(getAttachmentSignature(base), "");
    assert.strictEqual(
      getAttachmentSignature({
        ...base,
        attachments: [
          { source: "local", path: "a.md" },
          { source: "global", path: "b.md" },
        ],
      }),
      "local:a.md|global:b.md",
    );

    const broken = {
      ...base,
      attachments: [{ source: "local" as const, path: "gone.md" }],
    };
    const repaired = {
      ...base,
      attachments: [{ source: "local" as const, path: "other.md" }],
    };

    notifications.delete(base.id);
    try {
      const shouldWarn = (task: ScheduledTask): boolean =>
        notifications.get(task.id) !== getAttachmentSignature(task);

      assert.strictEqual(shouldWarn(broken), true);
      notifications.set(broken.id, getAttachmentSignature(broken));
      assert.strictEqual(
        shouldWarn(broken),
        false,
        "the same broken attachment set must not warn twice",
      );
      assert.strictEqual(
        shouldWarn(repaired),
        true,
        "a changed attachment set must warn again instead of failing silently",
      );
    } finally {
      notifications.delete(base.id);
    }
  });

  test("runtime caches drop tasks that no longer exist", async () => {
    const { __testOnly } = await import("../../extension");
    const prune = __testOnly.pruneRuntimeCachesForRemovedTasks as unknown as (
      taskIds: Set<string>,
    ) => void;
    const notifications =
      __testOnly.attachmentBlockNotifications as unknown as Map<string, string>;

    notifications.set("t-kept", "local:a.md");
    notifications.set("t-deleted", "local:b.md");
    try {
      prune(new Set(["t-kept"]));

      assert.strictEqual(notifications.get("t-kept"), "local:a.md");
      assert.strictEqual(
        notifications.has("t-deleted"),
        false,
        "a deleted task must not keep leaking its notification state",
      );
    } finally {
      notifications.delete("t-kept");
      notifications.delete("t-deleted");
    }
  });

  test("the tasks-changed hook prunes runtime caches before refreshing the webview", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    assert.ok(
      /addOnTasksChangedCallback\(\(\) => \{\s*const tasks = scheduleManager\.getAllTasks\(\);\s*pruneRuntimeCachesForRemovedTasks\(/.test(
        source,
      ),
      "task deletions must prune per-task runtime caches",
    );
  });

  test("deactivate clears every per-task runtime cache", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");
    const start = source.indexOf("export function deactivate(): void {");
    assert.ok(start >= 0, "deactivate not found");
    const body = source.slice(start, source.indexOf("\n}", start));

    for (const cache of [
      "manualRunInFlightTaskIds",
      "attachmentBlockNotifications",
      "lastPromptResolutionByTaskId",
    ]) {
      assert.ok(
        body.includes(`${cache}.clear();`),
        `deactivate must clear ${cache} so a reactivated host does not inherit stale per-task state`,
      );
    }
  });

  test("every successful run records how many files it attached", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const payloads = [
      ...source.matchAll(/recordExecutionHistoryBestEffort\(\{([^}]*)\}\)/g),
    ].map((match) => match[1]);

    const successPayloads = payloads.filter((payload) =>
      payload.includes('status: "success"'),
    );

    assert.ok(
      successPayloads.length >= 2,
      "both the scheduled and the manual success paths should write history",
    );
    for (const payload of successPayloads) {
      assert.ok(
        payload.includes("attachmentCount:"),
        `a success history entry must record attachmentCount: ${payload.trim()}`,
      );
    }
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
      'watchPattern("**/.github/prompts/**/*.md", schedulePromptPreviewRefresh);',
      'resolveGlobalPromptsRoot(config.get<string>("globalPromptsPath", ""))',
      'resolveGlobalAgentRoots(config.get<string>("globalAgentsPath", ""))',
      'new vscode.RelativePattern(vscode.Uri.file(root), "**/*.md")',
      "watcher.onDidCreate(handle)",
      "watcher.onDidChange(handle)",
      "watcher.onDidDelete(handle)",
      "onPromptFileChanged?.(uri)",
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

  function setMultiRootWorkspaceFoldersForTest(roots: string[]): () => void {
    const wsAny = vscode.workspace as unknown as {
      workspaceFolders?: Array<{ uri: vscode.Uri }>;
    };
    const original = wsAny.workspaceFolders;
    try {
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        value: roots.map((root) => ({ uri: vscode.Uri.file(root) })),
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

  test("Falls through to the workspace folder that actually has the file", async () => {
    const ws1 = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-a-"));
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-b-"));
    const restoreWs = setMultiRootWorkspaceFoldersForTest([ws1, ws2]);

    const fileName = `__test_multiroot_${Date.now()}.md`;
    const relPath = path.join(".github", "prompts", fileName);

    try {
      // Only ws2 has the file, but ws1 comes first in the folder list.
      fs.mkdirSync(path.join(ws2, ".github", "prompts"), { recursive: true });
      fs.writeFileSync(
        path.join(ws2, ".github", "prompts", fileName),
        "WS2_CONTENT",
        "utf8",
      );

      const { __testOnly } = await import("../../extension");
      const task = {
        id: "t-multiroot-fallthrough",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "SNAPSHOT",
        enabled: true,
        scope: "workspace",
        workspacePath: ws2,
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      const resolved = await __testOnly.resolvePromptText(task, false);
      assert.strictEqual(resolved, "WS2_CONTENT");
    } finally {
      restoreWs();
      for (const root of [ws1, ws2]) {
        try {
          fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 50,
          });
        } catch {
          // ignore
        }
      }
    }
  });

  test("Prefers the task's own workspace when both folders have the file", async () => {
    const ws1 = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-a-"));
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-b-"));
    const restoreWs = setMultiRootWorkspaceFoldersForTest([ws1, ws2]);

    const fileName = `__test_multiroot_same_${Date.now()}.md`;
    const relPath = path.join(".github", "prompts", fileName);

    try {
      for (const [root, content] of [
        [ws1, "WS1_CONTENT"],
        [ws2, "WS2_CONTENT"],
      ] as const) {
        fs.mkdirSync(path.join(root, ".github", "prompts"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(root, ".github", "prompts", fileName),
          content,
          "utf8",
        );
      }

      const { __testOnly } = await import("../../extension");
      const task = {
        id: "t-multiroot-preferred",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "SNAPSHOT",
        enabled: true,
        scope: "workspace",
        workspacePath: ws2,
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      const resolved = await __testOnly.resolvePromptText(task, false);
      assert.strictEqual(resolved, "WS2_CONTENT");
    } finally {
      restoreWs();
      for (const root of [ws1, ws2]) {
        try {
          fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 50,
          });
        } catch {
          // ignore
        }
      }
    }
  });

  test("resolvePromptSnapshot reports file source, hash, and path", async () => {
    const wsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-ws-"),
    );
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");

    const fileName = `__test_snapshot_meta_${Date.now()}.md`;
    const absPath = path.join(promptsDir, fileName);
    const relPath = path.join(".github", "prompts", fileName);

    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(absPath, "FILE_CONTENT", "utf8");

      const { __testOnly } = await import("../../extension");
      const { computePromptHash } = await import("../../promptResolver");
      const resolvePromptSnapshot = __testOnly.resolvePromptSnapshot as (
        task: ScheduledTask,
        preferOpenDocument?: boolean,
      ) => Promise<{
        text: string;
        source: string;
        resolvedPath?: string;
        hash: string;
        candidateCount: number;
        fallbackReason?: string;
      }>;

      const task = {
        id: "t-snapshot-meta",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "SNAPSHOT",
        enabled: true,
        scope: "global",
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      const resolution = await resolvePromptSnapshot(task, false);
      assert.strictEqual(resolution.source, "file");
      assert.strictEqual(resolution.text, "FILE_CONTENT");
      assert.strictEqual(resolution.hash, computePromptHash("FILE_CONTENT"));
      assert.strictEqual(resolution.candidateCount, 1);
      assert.strictEqual(resolution.fallbackReason, undefined);
      assert.ok(resolution.resolvedPath);

      fs.rmSync(absPath, { force: true });
      const missing = await resolvePromptSnapshot(task, false);
      assert.strictEqual(missing.source, "snapshotFallback");
      assert.strictEqual(missing.text, "SNAPSHOT");
      assert.ok(
        missing.fallbackReason === "readFailed" ||
          missing.fallbackReason === "pathUnresolved",
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

  test("unavailable prompt preview clears stale file actions", async () => {
    const { __testOnly } = await import("../../extension");
    const buildUnavailable = __testOnly.buildUnavailablePromptPreview as (
      task: ScheduledTask,
    ) => {
      source: string;
      prompt?: string;
      canOpenPromptFile: boolean;
      hasSnapshotDiff: boolean;
      hash: string;
    };
    const task = {
      id: "unavailable-preview",
      name: "Unavailable",
      cronExpression: "0 * * * *",
      prompt: "SAVED_SNAPSHOT",
      enabled: true,
      scope: "workspace",
      promptSource: "local",
      promptPath: ".github/prompts/empty.md",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const preview = buildUnavailable(task);
    assert.strictEqual(preview.source, "snapshotFallback");
    assert.strictEqual(preview.prompt, undefined);
    assert.strictEqual(preview.canOpenPromptFile, false);
    assert.strictEqual(preview.hasSnapshotDiff, false);
    assert.strictEqual(preview.hash.length, 12);
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
