import * as assert from "assert";

import { filterPickerModelCatalog } from "../../modelSelection";
import type { ScheduleManager } from "../../scheduleManager";
import {
  createLmToolMutationClient,
  createModelSelectionResolver,
  type ModelSelectionResolver,
  type MutationResult,
} from "../../taskMutationService";
import type { CreateTaskInput, ModelInfo, ScheduledTask } from "../../types";

type MutableTask = ScheduledTask;

class FakeScheduleManager {
  private readonly tasks = new Map<string, MutableTask>();
  private disclaimerAccepted = true;
  public throwOnCreate = false;
  public lastCreateInput: CreateTaskInput | undefined;
  public lastUpdates: Partial<CreateTaskInput> | undefined;

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
    this.lastCreateInput = input;
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
      // Mirrors ScheduleManager: normalized model fields are persisted on the task.
      model: input.model || undefined,
      modelName: input.modelName || undefined,
      modelVendor: input.modelVendor || undefined,
      modelFamily: input.modelFamily || undefined,
      modelVersion: input.modelVersion || undefined,
      modelReasoningEffort: input.modelReasoningEffort || undefined,
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
    this.lastUpdates = updates;
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

function client(
  fake: FakeScheduleManager,
  resolveModelSelection?: ModelSelectionResolver,
) {
  return createLmToolMutationClient({
    scheduleManager: fake as unknown as ScheduleManager,
    resolveModelSelection,
  });
}

function fakeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    description: "",
    vendor: "copilot",
    family: "claude-sonnet-4",
    version: "2026-01-01",
    ...overrides,
  };
}

function catalogResolver(
  models: ModelInfo[],
  source: "api" | "fallback" = "api",
): ModelSelectionResolver {
  return createModelSelectionResolver(async () => ({ source, models }));
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

suite("taskMutationService model resolution", () => {
  test("createTask expands a bare model id into the full selection", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake, catalogResolver([fakeModel()]));
    const result = await c.createTask({
      ...baseInput(),
      model: "claude-sonnet-4",
    });
    assertOk(result);
    assert.strictEqual(fake.lastCreateInput?.model, "claude-sonnet-4");
    assert.strictEqual(fake.lastCreateInput?.modelName, "Claude Sonnet 4");
    assert.strictEqual(fake.lastCreateInput?.modelVendor, "copilot");
    assert.strictEqual(fake.lastCreateInput?.modelFamily, "claude-sonnet-4");
    assert.strictEqual(fake.lastCreateInput?.modelVersion, "2026-01-01");
  });

  test("createTask rejects an unknown model id and lists valid ids", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake, catalogResolver([fakeModel()]));
    const result = await c.createTask({
      ...baseInput(),
      model: "does-not-exist",
    });
    assertFail(result);
    assert.strictEqual(result.reason, "validation");
    assert.match(result.message, /claude-sonnet-4/);
    assert.match(result.message, /list_models/);
  });

  test("createTask keeps an unverified model with a warning on a fallback catalog", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake, catalogResolver([fakeModel()], "fallback"));
    const result = await c.createTask({
      ...baseInput(),
      model: "does-not-exist",
    });
    assertOk(result);
    assert.strictEqual(fake.lastCreateInput?.model, "does-not-exist");
    assert.ok(result.warnings && result.warnings.length === 1);
    assert.match(result.warning ?? "", /Language Model API is unavailable/);
  });

  test("createTask merges cron and model warnings into both fields", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake, catalogResolver([fakeModel()], "fallback"));
    const result = await c.createTask({
      ...baseInput(),
      cronExpression: "* * * * *",
      model: "does-not-exist",
    });
    assertOk(result);
    assert.strictEqual(result.warnings?.length, 2);
    assert.strictEqual(result.warnings?.[0], "runs every minute");
    assert.strictEqual(result.warning, result.warnings?.join("\n"));
  });

  test("createTask drops an unsupported reasoning effort with a warning", async () => {
    const fake = new FakeScheduleManager();
    const c = client(
      fake,
      catalogResolver([
        fakeModel({ id: "gpt-4o", name: "GPT-4o", family: "gpt-4o" }),
      ]),
    );
    const result = await c.createTask({
      ...baseInput(),
      model: "gpt-4o",
      modelReasoningEffort: "max",
    });
    assertOk(result);
    assert.strictEqual(fake.lastCreateInput?.modelReasoningEffort, "");
    assert.match(result.warning ?? "", /not supported/);
  });

  test("updateTask keeps the existing model when only the reasoning effort changes", async () => {
    const fake = new FakeScheduleManager();
    const resolver = catalogResolver([fakeModel()]);
    const c = client(fake, resolver);
    const created = await c.createTask({
      ...baseInput(),
      model: "claude-sonnet-4",
    });
    assertOk(created);
    const result = await c.updateTask(created.task.id, {
      modelReasoningEffort: "high",
    });
    assertOk(result);
    assert.strictEqual(fake.lastUpdates?.model, "claude-sonnet-4");
    assert.strictEqual(fake.lastUpdates?.modelName, "Claude Sonnet 4");
  });

  test("updateTask with an empty model clears every model field", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake, catalogResolver([fakeModel()]));
    const created = await c.createTask({
      ...baseInput(),
      model: "claude-sonnet-4",
    });
    assertOk(created);
    const result = await c.updateTask(created.task.id, { model: "" });
    assertOk(result);
    assert.deepStrictEqual(
      {
        model: fake.lastUpdates?.model,
        modelName: fake.lastUpdates?.modelName,
        modelVendor: fake.lastUpdates?.modelVendor,
        modelFamily: fake.lastUpdates?.modelFamily,
        modelVersion: fake.lastUpdates?.modelVersion,
        modelReasoningEffort: fake.lastUpdates?.modelReasoningEffort,
      },
      {
        model: "",
        modelName: "",
        modelVendor: "",
        modelFamily: "",
        modelVersion: "",
        modelReasoningEffort: "",
      },
    );
  });

  test("updateTask rejects an empty model combined with other model fields", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake, catalogResolver([fakeModel()]));
    const created = await c.createTask(baseInput());
    assertOk(created);
    const result = await c.updateTask(created.task.id, {
      model: "",
      modelReasoningEffort: "high",
    });
    assertFail(result);
    assert.strictEqual(result.reason, "validation");
  });

  test("updateTask explains that a reasoning effort needs a model first", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake, catalogResolver([fakeModel()]));
    const created = await c.createTask(baseInput());
    assertOk(created);
    const result = await c.updateTask(created.task.id, {
      modelReasoningEffort: "high",
    });
    assertFail(result);
    assert.strictEqual(result.reason, "validation");
    assert.match(result.message, /no model/i);
    assert.strictEqual(
      result.message.includes("Unknown model"),
      false,
      "the misleading unknown-model message must not be used here",
    );
  });

  test("createTask skips model verification when no resolver is injected", async () => {
    const fake = new FakeScheduleManager();
    const c = client(fake);
    const result = await c.createTask({
      ...baseInput(),
      model: "does-not-exist",
    });
    assertOk(result);
    assert.strictEqual(fake.lastCreateInput?.model, "does-not-exist");
  });

  test("resolver keeps the requested model when the catalog cannot be loaded", async () => {
    const fake = new FakeScheduleManager();
    const resolver = createModelSelectionResolver(async () => {
      throw new Error("catalog offline");
    });
    const c = client(fake, resolver);
    const result = await c.createTask({
      ...baseInput(),
      model: "claude-sonnet-4",
    });
    assertOk(result);
    assert.strictEqual(fake.lastCreateInput?.model, "claude-sonnet-4");
    assert.match(result.warning ?? "", /catalog offline/);
  });

  test("resolver rejects models the Webview picker hides", async () => {
    const rawCatalog: ModelInfo[] = [
      fakeModel(),
      fakeModel({
        id: "claude-code-opus",
        name: "Claude Code Opus",
        family: "claude-code",
      }),
    ];
    // Same catalog shaping the Webview picker and startup healing use.
    const resolver = createModelSelectionResolver(async () => ({
      source: "api" as const,
      models: filterPickerModelCatalog(rawCatalog),
    }));
    const fake = new FakeScheduleManager();
    const c = client(fake, resolver);

    const hidden = await c.createTask({
      ...baseInput(),
      model: "claude-code-opus",
    });
    assertFail(hidden);
    assert.strictEqual(hidden.reason, "validation");
    const offeredIds = hidden.message.split("Available model ids:")[1] ?? "";
    assert.match(offeredIds, /claude-sonnet-4/);
    assert.strictEqual(
      offeredIds.includes("claude-code-opus"),
      false,
      "a picker-hidden model must not be offered back as a valid id",
    );

    const visible = await c.createTask({
      ...baseInput(),
      model: "claude-sonnet-4",
    });
    assertOk(visible);
  });

  test("updating a non-model field leaves a picker-hidden saved model alone", async () => {
    const fake = new FakeScheduleManager();
    const resolver = createModelSelectionResolver(async () => ({
      source: "api" as const,
      models: filterPickerModelCatalog([fakeModel()]),
    }));
    // Saved before the model was filtered out of the picker.
    const seeded = await client(fake).createTask({
      ...baseInput(),
      model: "claude-code-opus",
    });
    assertOk(seeded);

    const result = await client(fake, resolver).updateTask(seeded.task.id, {
      cronExpression: "0 10 * * *",
    });
    assertOk(result);
    assert.strictEqual(fake.lastUpdates?.model, undefined);
    assert.strictEqual(result.task.model, "claude-code-opus");
  });
});
