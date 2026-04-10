import * as assert from "assert";
import { CopilotExecutor, __testOnly } from "../../copilotExecutor";

suite("CopilotExecutor Agent Prefix Tests", () => {
  test("Converts slash-command agents without prefix", () => {
    assert.strictEqual(__testOnly.normalizeAgentPrefix("ask"), "/ask");
    assert.strictEqual(__testOnly.normalizeAgentPrefix("agent"), "/agent");
  });

  test("Preserves explicit prefixes", () => {
    assert.strictEqual(__testOnly.normalizeAgentPrefix("/ask"), "/ask");
    assert.strictEqual(
      __testOnly.normalizeAgentPrefix("@workspace"),
      "@workspace",
    );
  });

  test("Uses @ for non-slash custom agents", () => {
    assert.strictEqual(
      __testOnly.normalizeAgentPrefix("customReviewer"),
      "@customReviewer",
    );
  });

  test("Trims and handles empty values", () => {
    assert.strictEqual(__testOnly.normalizeAgentPrefix("  /edit  "), "/edit");
    assert.strictEqual(__testOnly.normalizeAgentPrefix("   "), "");
  });

  test("strict variant selector candidates do not fall back to plain id", () => {
    const selectors = __testOnly.buildModelSelectorCandidates({
      model: "copilot-gpt-4o",
      modelFamily: "gpt-4o",
      modelVersion: "high",
    });

    assert.deepStrictEqual(selectors, [
      {
        id: "copilot-gpt-4o",
        family: "gpt-4o",
        version: "high",
      },
    ]);
  });

  test("fallback models only expose the default option", () => {
    const models = CopilotExecutor.getFallbackModels();
    assert.strictEqual(models.length, 1);
    assert.strictEqual(models[0]?.id, "");
  });

  test("legacy model picker candidates prefer disambiguated labels", () => {
    const candidates = __testOnly.buildLegacyModelPickerCandidates(
      {
        id: "claude-opus-4.6-copilot-high",
        name: "Claude Opus 4.6 High (Copilot)",
        label: "Claude Opus 4.6 (High, Copilot)",
        description: "",
        vendor: "Anthropic",
      },
      {
        model: "claude-opus-4.6-copilot-high",
        modelName: "Claude Opus 4.6 High (Copilot)",
      },
    );

    assert.deepStrictEqual(candidates, [
      "Claude Opus 4.6 (High, Copilot)",
      "Claude Opus 4.6 High (Copilot)",
      "claude-opus-4.6-copilot-high",
    ]);
  });

  test("vendor-scoped model lists are supplemented with discovered variant entries", () => {
    const merged = __testOnly.mergeChatModelLists(
      [
        {
          id: "copilot-gpt-5-4",
          name: "GPT-5.4",
          vendor: "copilot",
          family: "gpt-5.4",
        },
      ],
      [
        {
          id: "copilot-gpt-5-4",
          name: "GPT-5.4",
          vendor: "copilot",
          family: "gpt-5.4",
        },
        {
          id: "openai/gpt-5-4-low",
          name: "GPT-5.4",
          vendor: "openai",
          family: "gpt-5.4",
        },
        {
          id: "openai/gpt-5-4-high",
          name: "GPT-5.4",
          vendor: "openai",
          family: "gpt-5.4",
        },
      ],
    );

    assert.deepStrictEqual(
      merged.map((model) => model.id),
      ["copilot-gpt-5-4", "openai/gpt-5-4-low", "openai/gpt-5-4-high"],
    );
  });
});
