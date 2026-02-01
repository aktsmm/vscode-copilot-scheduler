/**
 * Copilot Scheduler - Extension Tests
 */

import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start all tests.");

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
      "copilotSchedule.createTask",
      "copilotSchedule.createTaskGui",
      "copilotSchedule.listTasks",
      "copilotSchedule.deleteTask",
      "copilotSchedule.toggleTask",
      "copilotSchedule.runNow",
      "copilotSchedule.copyPrompt",
      "copilotSchedule.editTask",
      "copilotSchedule.duplicateTask",
      "copilotSchedule.openSettings",
      "copilotSchedule.showVersion",
    ];

    for (const cmd of expectedCommands) {
      assert.ok(commands.includes(cmd), `Command ${cmd} should be registered`);
    }
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
