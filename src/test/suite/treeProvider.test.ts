import * as assert from "assert";
import * as vscode from "vscode";
import { messages } from "../../i18n";
import { ScheduledTaskItem } from "../../treeProvider";
import type { ScheduledTask } from "../../types";

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-test",
    name: "Review docs",
    cronExpression: "*/20 * * * *",
    prompt: "Check the docs",
    enabled: true,
    scope: "workspace",
    promptSource: "inline",
    createdAt: new Date("2026-05-15T00:00:00Z"),
    updatedAt: new Date("2026-05-15T00:00:00Z"),
    nextRun: new Date("2026-05-15T01:20:00Z"),
    ...overrides,
  };
}

suite("ScheduledTaskItem", () => {
  test("description uses human-readable schedule summary", () => {
    const item = new ScheduledTaskItem(createTask(), true);
    const expectedSchedule = messages
      .cronPreviewEveryNMinutes()
      .replace("{n}", "20");

    assert.ok(
      String(item.description).includes(expectedSchedule),
      "TreeView description should prefer a human schedule summary.",
    );
    assert.ok(
      !String(item.description).includes("*/20 * * * *"),
      "TreeView description should not expose raw cron for known schedules.",
    );
  });

  test("tooltip keeps raw cron as detailed information", () => {
    const item = new ScheduledTaskItem(createTask(), true);
    const tooltip = (item.tooltip as vscode.MarkdownString).value;
    const expectedSchedule = messages
      .cronPreviewEveryNMinutes()
      .replace("{n}", "20");
    const expectedMarkdownSchedule = expectedSchedule.replace(/ /g, "&nbsp;");

    assert.ok(tooltip.includes(expectedMarkdownSchedule), tooltip);
    assert.ok(tooltip.includes(messages.labelCronExpression()));
    assert.ok(tooltip.includes("*/20 * * * *"));
  });

  test("tooltip includes task-level chat session override", () => {
    const item = new ScheduledTaskItem(
      createTask({ chatSession: "continue" }),
      true,
    );
    const tooltip = (item.tooltip as vscode.MarkdownString).value;
    const expectedChatSession = messages
      .labelChatSessionContinue()
      .replace(/ /g, "&nbsp;");

    assert.ok(tooltip.includes(messages.labelChatSession()), tooltip);
    assert.ok(tooltip.includes(expectedChatSession), tooltip);
  });

  test("other workspace task keeps workspace context in description", () => {
    const item = new ScheduledTaskItem(
      createTask({ workspacePath: "C:\\Workspaces\\other-project" }),
      false,
    );

    assert.ok(String(item.description).includes("other-project"));
  });
});
