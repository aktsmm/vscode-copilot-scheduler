import * as assert from "assert";

import type { ScheduleManager } from "../../scheduleManager";
import {
  createLmToolMutationClient,
  type MutationResult,
} from "../../taskMutationService";
import type { CreateTaskInput, ScheduledTask } from "../../types";

type MutableTask = ScheduledTask;

class FakeScheduleManager {
  private readonly tasks = new Map<string, MutableTask>();
  private disclaimerAccepted = true;
  public throwOnCreate = false;

  constructor(seed: ScheduledTask[] = []) {
    for (const t of seed) {
      this.tasks.set(t.id, { ...t });
    }
  }

  setDisclaimer(v: boolean): void {
    this.disclaimerAccepted = v;
  }

  isDisclaimerAccepted(): boolean {
    return this.disclaimerAccepted;
  }

  checkMinimumInterval(cronExpression: string): string | undefined {
    if (cronExpression.includes("* * * * *")) {
      return "runs every minute";
    }
    return undefined;
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  async createTask(input: CreateTaskInput): Promise<ScheduledTask> {
    if (this.throwOnCreate) {
      throw new Error("boom");
    }
    const now = new Date();
    const task: ScheduledTask = {
      id: `id-${this.tasks.size + 1}`,
      name: input.name,
      cronExpression: input.cronExpression,
      prompt: input.prompt,
      scope: input.scope ?? "global",
      promptSource: input.promptSource ?? "inline",
      promptPath: input.promptPath,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    } as ScheduledTask;
    this.tasks.set(task.id, task);
    return task;
  }

  async updateTask(
    id: string,
    updates: Partial<CreateTaskInput>,
  ): Promise<ScheduledTask | undefined> {
    const existing = this.tasks.get(id);
    if (!existing) {
      return undefined;
    }
    const merged = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    } as ScheduledTask;
    this.tasks.set(id, merged);
    return merged;
  }

  async setTaskEnabled(
    id: string,
    enabled: boolean,
  ): Promise<ScheduledTask | undefined> {
    const existing = this.tasks.get(id);
    if (!existing) {
      return undefined;
    }
    const merged = { ...existing, enabled } as ScheduledTask;
    this.tasks.set(id, merged);
    return merged;
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.tasks.delete(id);
  }
}

function client(fake: FakeScheduleManager) {
  return createLmToolMutationClient({
    scheduleManager: fake as unknown as ScheduleManager,
  });
}

function baseInput(): CreateTaskInput {
  return {
    name: "sample",
    cronExpression: "0 9 * * *",
    prompt: "hello",
    scope: "global",
    promptSource: "inline",
    enabled: true,
  } as CreateTaskInput;
}

function assertOk<T>(
  result: MutationResult<T>,
): asserts result is Extract<MutationResult<T>, { ok: true }> {
  assert.strictEqual(
    result.ok,
    true,
    `expected ok, got: ${JSON.stringify(result)}`,
  );
}

function assertFail<T>(
  result: MutationResult<T>,
): asserts result is Extract<MutationResult<T>, { ok: false }> {
  assert.strictEqual(
    result.ok,
    false,
    `expected fail, got: ${JSON.stringify(result)}`,
  );
}

suite("taskMutationService lmToolClient", () => {
  test("createTask blocks when disclaimer not accepted and enabled=true", async () => {
    const fake = new FakeScheduleManager();
    fake.setDisclaimer(false);
    const c = client(fake);
    const result = await c.createTask(baseInput());
    assertFail(result);
    assert.strictEqual(result.reason, "disclaimer_not_accepted");
  });

  test("createTask allows enabled=false when disclaimer not accepted", async () => {
    const fake = new FakeScheduleManager();
    fake.setDisclaimer(false);
    const c = client(fake);
    const result = await c.createTask({ ...baseInput(), enabled: false });
    assertOk(result);
    assert.strictEqual(result.task.enabled, false);
  });

  test("createTask returns warning for high-frequency cron", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake);
    const result = await c.createTask({
      ...baseInput(),
      cronExpression: "* * * * *",
    });
    assertOk(result);
    assert.strictEqual(result.warning, "runs every minute");
  });

  test("updateTask rejects enabled in updates", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake);
    const created = await c.createTask(baseInput());
    assertOk(created);
    const result = await c.updateTask(created.task.id, {
      // deliberately hostile: LLM tried to shortcut
      enabled: false,
    } as unknown as Partial<CreateTaskInput>);
    assertFail(result);
    assert.strictEqual(result.reason, "enabled_not_allowed");
  });

  test("updateTask returns not_found for unknown id", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake);
    const result = await c.updateTask("missing", { name: "x" });
    assertFail(result);
    assert.strictEqual(result.reason, "not_found");
  });

  test("setTaskEnabled(true) blocks when disclaimer not accepted", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake);
    const created = await c.createTask({ ...baseInput(), enabled: false });
    assertOk(created);
    fake.setDisclaimer(false);
    const result = await c.setTaskEnabled(created.task.id, true);
    assertFail(result);
    assert.strictEqual(result.reason, "disclaimer_not_accepted");
  });

  test("setTaskEnabled(false) works even when disclaimer not accepted", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake);
    const created = await c.createTask(baseInput());
    assertOk(created);
    fake.setDisclaimer(false);
    const result = await c.setTaskEnabled(created.task.id, false);
    assertOk(result);
    assert.strictEqual(result.task.enabled, false);
  });

  test("deleteTaskConfirmed returns not_found if task disappeared", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake);
    const result = await c.deleteTaskConfirmed("missing");
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.reason, "not_found");
    }
  });

  test("deleteTaskConfirmed deletes when task exists", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake);
    const created = await c.createTask(baseInput());
    assertOk(created);
    const result = await c.deleteTaskConfirmed(created.task.id);
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.deletedId, created.task.id);
    }
    assert.strictEqual(fake.getTask(created.task.id), undefined);
  });
});
