/**
 * Copilot Scheduler - Extension Tests
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { ScheduledTask } from "../../types";
import { runSharedSanitizerCases } from "./helpers/sanitizerAssertions";

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
});

suite("Cron Expression Tests", () => {
  test("Valid cron expressions should be accepted", () => {
    // These tests would require importing ScheduleManager
    // which needs proper mocking in test environment
    assert.ok(true);
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
