import * as assert from "assert";
import {
  buildModelPickerGroups,
  filterExpandedPickerModelCatalog,
  filterPickerModelCatalog,
  findBestMatchingModel,
  normalizeModelSelection,
  normalizeModelCatalog,
} from "../../modelSelection";

suite("Model Selection Catalog Tests", () => {
  test("normalizeModelCatalog removes exact duplicates and labels id variants", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "gpt-4o-high",
        name: "GPT-4o",
        description: "",
        vendor: "OpenAI",
        family: "gpt-4o",
      },
      {
        id: "gpt-4o-high",
        name: "GPT-4o",
        description: "",
        vendor: "OpenAI",
        family: "gpt-4o",
      },
      {
        id: "gpt-4o-low",
        name: "GPT-4o",
        description: "",
        vendor: "OpenAI",
        family: "gpt-4o",
      },
    ]);

    assert.strictEqual(catalog.length, 2);
    assert.deepStrictEqual(
      catalog.map((model) => model.label),
      ["GPT-4o (High)", "GPT-4o (Low)"],
    );
  });

  test("findBestMatchingModel prefers the exact versioned variant", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "copilot-gpt-4o",
        name: "GPT-4o",
        description: "",
        vendor: "OpenAI",
        family: "gpt-4o",
        version: "low",
      },
      {
        id: "copilot-gpt-4o",
        name: "GPT-4o",
        description: "",
        vendor: "OpenAI",
        family: "gpt-4o",
        version: "high",
      },
    ]);

    const match = findBestMatchingModel(
      {
        model: "copilot-gpt-4o",
        modelName: "GPT-4o",
        modelFamily: "gpt-4o",
        modelVersion: "high",
      },
      catalog,
    );

    assert.strictEqual(match?.version, "high");
    assert.strictEqual(match?.label, "GPT-4o (High)");
  });

  test("findBestMatchingModel does not downgrade to another variant", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "copilot-gpt-4o",
        name: "GPT-4o",
        description: "",
        vendor: "OpenAI",
        family: "gpt-4o",
        version: "low",
      },
    ]);

    const match = findBestMatchingModel(
      {
        model: "copilot-gpt-4o",
        modelName: "GPT-4o",
        modelFamily: "gpt-4o",
        modelVersion: "high",
      },
      catalog,
    );

    assert.strictEqual(match, undefined);
  });

  test("normalizeModelCatalog keeps Copilot CLI variants for restore and healing", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-opus-4.6-copilot",
        name: "Claude Opus 4.6 (Copilot)",
        description: "",
        vendor: "Anthropic",
      },
      {
        id: "claude-opus-4.6-copilotcli",
        name: "Claude Opus 4.6 (Copilotcli)",
        description: "",
        vendor: "Anthropic",
      },
    ]);

    assert.strictEqual(catalog.length, 2);
    assert.deepStrictEqual(
      catalog.map((model) => model.label),
      ["Claude Opus 4.6", "Claude Opus 4.6 (Copilotcli)"],
    );
  });

  test("filterPickerModelCatalog excludes Copilot CLI variants from the picker", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-opus-4.6-copilot",
        name: "Claude Opus 4.6 (Copilot)",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.6",
      },
      {
        id: "claude-opus-4.6-copilotcli-high",
        name: "Claude Opus 4.6 High (Copilotcli)",
        description: "",
        vendor: "Anthropic",
        family: "claude-opus-4.6",
      },
    ]);

    const pickerCatalog = filterPickerModelCatalog(catalog);

    assert.strictEqual(catalog.length, 2);
    assert.strictEqual(pickerCatalog.length, 1);
    assert.strictEqual(pickerCatalog[0]?.id, "claude-opus-4.6-copilot");
  });

  test("filterPickerModelCatalog keeps only Copilot picker models", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-sonnet-4.6-copilot",
        name: "Claude Sonnet 4.6 (Copilot)",
        description: "",
        vendor: "copilot",
        family: "claude-sonnet-4.6",
      },
      {
        id: "claude-sonnet-4.6-claude-code",
        name: "Claude Sonnet 4.6 (claude-code)",
        description: "",
        vendor: "claude-code",
        family: "claude-sonnet-4.6",
      },
      {
        id: "azure-gpt-5.4",
        name: "GPT-5.4",
        description: "",
        vendor: "azure",
        family: "gpt-5.4",
      },
    ]);

    const pickerCatalog = filterPickerModelCatalog(catalog);
    assert.deepStrictEqual(
      pickerCatalog.map((model) => model.id),
      ["claude-sonnet-4.6-copilot"],
    );
  });

  test("filterPickerModelCatalog keeps Internal only Copilot models in the default picker", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.7",
      },
      {
        id: "claude-opus-4.7-1m-internal",
        name: "Claude Opus 4.7 (1M context)(Internal only)",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.7-1m-internal",
      },
      {
        id: "claude-opus-4.7-high",
        name: "Claude Opus 4.7 (High reasoning)(Internal only)",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.7-high",
      },
      {
        id: "claude-opus-4.7-xhigh",
        name: "Claude Opus 4.7 (Extra high reasoning)(Internal only)",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.7-xhigh",
      },
    ]);

    const pickerCatalog = filterPickerModelCatalog(catalog);
    const groups = buildModelPickerGroups(pickerCatalog);

    assert.deepStrictEqual(
      pickerCatalog.map((model) => model.id),
      [
        "claude-opus-4.7",
        "claude-opus-4.7-1m-internal",
        "claude-opus-4.7-high",
        "claude-opus-4.7-xhigh",
      ],
    );
    assert.deepStrictEqual(
      groups.map((group) => [
        group.label,
        group.variants.map((variant) => variant.label),
      ]),
      [
        ["Claude Opus 4.7", ["Claude Opus 4.7"]],
        [
          "Claude Opus 4.7 (1M context, Internal only)",
          ["Claude Opus 4.7 (1M context, Internal only)"],
        ],
        [
          "Claude Opus 4.7 (High reasoning, Internal only)",
          ["Claude Opus 4.7 (High reasoning, Internal only)"],
        ],
        [
          "Claude Opus 4.7 (Extra high reasoning, Internal only)",
          ["Claude Opus 4.7 (Extra high reasoning, Internal only)"],
        ],
      ],
    );
  });

  test("buildModelPickerGroups keeps Claude Opus 4.7 runtime reasoning variants as separate models", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.7",
      },
      {
        id: "claude-opus-4.7-high",
        name: "Claude Opus 4.7 (High reasoning)(Internal only)",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.7-high",
      },
      {
        id: "claude-opus-4.7-xhigh",
        name: "Claude Opus 4.7 (Extra high reasoning)(Internal only)",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.7-xhigh",
      },
    ]);

    const groups = buildModelPickerGroups(catalog, {
      includeExperimentalModelQualityVariants: true,
    });

    assert.deepStrictEqual(
      groups.map((group) => [
        group.label,
        group.variants.map((variant) => variant.label),
      ]),
      [
        ["Claude Opus 4.7", ["Claude Opus 4.7"]],
        [
          "Claude Opus 4.7 (High reasoning, Internal only)",
          ["Claude Opus 4.7 (High reasoning, Internal only)"],
        ],
        [
          "Claude Opus 4.7 (Extra high reasoning, Internal only)",
          ["Claude Opus 4.7 (Extra high reasoning, Internal only)"],
        ],
      ],
    );
  });

  test("filterPickerModelCatalog keeps runtime quality variants for Copilot-exposed groups", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "copilot-gpt-5-4",
        name: "GPT-5.4",
        description: "",
        vendor: "copilot",
        family: "gpt-5.4",
      },
      {
        id: "openai/gpt-5-4-low",
        name: "GPT-5.4",
        description: "",
        vendor: "openai",
        family: "gpt-5.4",
      },
      {
        id: "openai/gpt-5-4-high",
        name: "GPT-5.4",
        description: "",
        vendor: "openai",
        family: "gpt-5.4",
      },
      {
        id: "azure-gpt-5-4",
        name: "GPT-5.4",
        description: "",
        vendor: "azure",
        family: "gpt-5.4",
      },
    ]);

    const pickerCatalog = filterPickerModelCatalog(catalog);
    const groups = buildModelPickerGroups(pickerCatalog);

    assert.deepStrictEqual(
      pickerCatalog.map((model) => model.id),
      ["copilot-gpt-5-4", "openai/gpt-5-4-low", "openai/gpt-5-4-high"],
    );
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0]?.label, "GPT-5.4");
    assert.deepStrictEqual(
      groups[0]?.variants.map((variant) => variant.label),
      ["Default", "Low", "High"],
    );
  });

  test("filterPickerModelCatalog keeps raw-id runtime variants for Copilot-exposed Claude groups", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.6",
      },
      {
        id: "anthropic/claude-opus-4.6/versions/high",
        name: "anthropic/claude-opus-4.6/versions/high",
        description: "",
        vendor: "Anthropic",
        family: "claude-opus-4.6",
        version: "high",
      },
      {
        id: "anthropic/claude-opus-4.6/versions/medium",
        name: "anthropic/claude-opus-4.6/versions/medium",
        description: "",
        vendor: "Anthropic",
        family: "claude-opus-4.6",
        version: "medium",
      },
    ]);

    const pickerCatalog = filterPickerModelCatalog(catalog);
    const groups = buildModelPickerGroups(pickerCatalog);

    assert.deepStrictEqual(
      pickerCatalog.map((model) => model.id),
      [
        "claude-opus-4.6",
        "anthropic/claude-opus-4.6/versions/high",
        "anthropic/claude-opus-4.6/versions/medium",
      ],
    );
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0]?.label, "Claude Opus 4.6");
    assert.deepStrictEqual(
      groups[0]?.variants.map((variant) => variant.label),
      ["Default", "High", "Medium"],
    );
  });

  // This helper remains part of the internal picker filtering pipeline even
  // after the expanded-toggle UI was removed in v1.0.35.
  test("filterExpandedPickerModelCatalog keeps additional discovered providers available to the internal expanded filter", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-sonnet-4.6-copilot",
        name: "Claude Sonnet 4.6 (Copilot)",
        description: "",
        vendor: "copilot",
        family: "claude-sonnet-4.6",
      },
      {
        id: "claude-sonnet-4.6-claude-code",
        name: "Claude Sonnet 4.6 (claude-code)",
        description: "",
        vendor: "claude-code",
        family: "claude-sonnet-4.6",
      },
      {
        id: "claude-sonnet-4.6-copilotcli",
        name: "Claude Sonnet 4.6 (Copilotcli)",
        description: "",
        vendor: "Copilotcli",
        family: "claude-sonnet-4.6",
      },
      {
        id: "azure-gpt-5.4",
        name: "GPT-5.4",
        description: "",
        vendor: "azure",
        family: "gpt-5.4",
      },
    ]);

    const expandedCatalog = filterExpandedPickerModelCatalog(catalog);
    assert.deepStrictEqual(
      expandedCatalog.map((model) => model.id),
      [
        "claude-sonnet-4.6-copilot",
        "claude-sonnet-4.6-claude-code",
        "azure-gpt-5.4",
      ],
    );
  });

  test("buildModelPickerGroups groups runtime variants under a single base label", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "gpt-5-4-low",
        name: "GPT-5.4 Low",
        description: "",
        vendor: "Copilot",
        family: "gpt-5.4",
      },
      {
        id: "gpt-5-4-high",
        name: "GPT-5.4 High",
        description: "",
        vendor: "Copilot",
        family: "gpt-5.4",
      },
    ]);

    const groups = buildModelPickerGroups(catalog);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0]?.label, "GPT-5.4");
    assert.deepStrictEqual(
      groups[0]?.variants.map((variant) => variant.label),
      ["Low", "High"],
    );
  });

  test("buildModelPickerGroups keeps internal-only context models separate from base models", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6 (Copilot)",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.6",
      },
      {
        id: "claude-opus-4.6-1m",
        name: "Claude Opus 4.6 (1M context)(Internal only)",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.6",
      },
    ]);

    const groups = buildModelPickerGroups(catalog);
    assert.deepStrictEqual(
      groups.map((group) => group.label),
      ["Claude Opus 4.6", "Claude Opus 4.6 (1M context, Internal only)"],
    );
    assert.deepStrictEqual(
      groups.map((group) => group.variants.map((variant) => variant.label)),
      [["Claude Opus 4.6"], ["Claude Opus 4.6 (1M context, Internal only)"]],
    );
  });

  test("buildModelPickerGroups synthesizes experimental quality variants for single eligible Copilot groups", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "copilot-gpt-5-2-codex",
        name: "GPT-5.2-Codex",
        description: "",
        vendor: "copilot",
        family: "gpt-5.2-codex",
      },
    ]);

    const groups = buildModelPickerGroups(catalog, {
      includeExperimentalModelQualityVariants: true,
    });

    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(
      groups[0]?.variants.map((variant) => [
        variant.label,
        variant.reasoningEffort || "default",
      ]),
      [
        ["Default", "default"],
        ["Low", "low"],
        ["Medium", "medium"],
        ["High", "high"],
        ["Xhigh", "xhigh"],
      ],
    );
  });

  test("buildModelPickerGroups does not synthesize quality variants for families outside the allowlist", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-haiku-4.5",
        name: "Claude Haiku 4.5",
        description: "",
        vendor: "copilot",
        family: "claude-haiku-4.5",
      },
    ]);

    const groups = buildModelPickerGroups(catalog, {
      includeExperimentalModelQualityVariants: true,
    });

    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(
      groups[0]?.variants.map((variant) => [
        variant.label,
        variant.reasoningEffort || "default",
      ]),
      [["Claude Haiku 4.5", "default"]],
    );
  });

  test("buildModelPickerGroups synthesizes preview thinking effort variants for Claude Opus families", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.6",
      },
    ]);

    const groups = buildModelPickerGroups(catalog, {
      includeExperimentalModelQualityVariants: true,
    });

    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(
      groups[0]?.variants.map((variant) => [
        variant.label,
        variant.reasoningEffort || "default",
      ]),
      [
        ["Default", "default"],
        ["Low", "low"],
        ["Medium", "medium"],
        ["High", "high"],
      ],
    );
  });

  test("buildModelPickerGroups does not synthesize preview thinking effort variants for Claude Opus 4.7", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.7",
      },
    ]);

    const groups = buildModelPickerGroups(catalog, {
      includeExperimentalModelQualityVariants: true,
    });

    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(
      groups[0]?.variants.map((variant) => [
        variant.label,
        variant.reasoningEffort || "default",
      ]),
      [["Claude Opus 4.7", "default"]],
    );
  });

  test("buildModelPickerGroups keeps Claude Opus 4.7 at default when runtime family is coarse", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "copilot-claude-opus-4.7",
        name: "Claude Opus 4.7",
        description: "",
        vendor: "copilot",
        family: "claude-opus",
      },
    ]);

    const groups = buildModelPickerGroups(catalog, {
      includeExperimentalModelQualityVariants: true,
    });

    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(
      groups[0]?.variants.map((variant) => [
        variant.label,
        variant.reasoningEffort || "default",
      ]),
      [["Claude Opus 4.7", "default"]],
    );
  });

  test("buildModelPickerGroups synthesizes preview thinking effort variants for Claude Opus 4.7 1M internal", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-opus-4.7-1m-internal",
        name: "Claude Opus 4.7 (1M context)(Internal only)",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.7-1m-internal",
      },
    ]);

    const groups = buildModelPickerGroups(catalog, {
      includeExperimentalModelQualityVariants: true,
    });

    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(
      groups[0]?.variants.map((variant) => [
        variant.label,
        variant.reasoningEffort || "default",
      ]),
      [
        ["Default", "default"],
        ["Low", "low"],
        ["Medium", "medium"],
        ["High", "high"],
        ["Xhigh", "xhigh"],
      ],
    );
  });

  test("normalizeModelSelection clears unsupported reasoning effort for Claude Opus 4.7", () => {
    const selection = normalizeModelSelection({
      model: "claude-opus-4.7",
      modelVendor: "copilot",
      modelFamily: "claude-opus-4.7",
      modelReasoningEffort: "high",
    });

    assert.strictEqual(selection.modelReasoningEffort, undefined);
  });

  test("normalizeModelSelection clears unsupported reasoning effort for Claude Opus 4.7 even when family is coarse", () => {
    const selection = normalizeModelSelection({
      model: "copilot-claude-opus-4.7",
      modelName: "Claude Opus 4.7",
      modelVendor: "copilot",
      modelFamily: "claude-opus",
      modelReasoningEffort: "medium",
    });

    assert.strictEqual(selection.modelReasoningEffort, undefined);
  });

  test("filterExpandedPickerModelCatalog keeps internal-only context models available to the internal expanded filter", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6 (Copilot)",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.6",
      },
      {
        id: "claude-opus-4.6-1m",
        name: "Claude Opus 4.6 (1M context)(Internal only)",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.6",
      },
      {
        id: "claude-opus-4.6-copilotcli",
        name: "Claude Opus 4.6 (Copilotcli)",
        description: "",
        vendor: "copilotcli",
        family: "claude-opus-4.6",
      },
    ]);

    const expandedGroups = buildModelPickerGroups(
      filterExpandedPickerModelCatalog(catalog),
    );

    assert.deepStrictEqual(
      expandedGroups.map((group) => group.label),
      ["Claude Opus 4.6", "Claude Opus 4.6 (1M context, Internal only)"],
    );
  });

  test("findBestMatchingModel infers variant from display name when version is missing", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-opus-4.6-copilot-high",
        name: "Claude Opus 4.6 High (Copilot)",
        description: "",
        vendor: "Anthropic",
      },
      {
        id: "claude-opus-4.6-copilot-low",
        name: "Claude Opus 4.6 Low (Copilot)",
        description: "",
        vendor: "Anthropic",
      },
    ]);

    const match = findBestMatchingModel(
      {
        modelName: "Claude Opus 4.6 High (Copilot)",
      },
      catalog,
    );

    assert.strictEqual(match?.id, "claude-opus-4.6-copilot-high");
  });

  test("normalizeModelCatalog derives extra-high variants from id tails", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "anthropic/claude-opus-4.6-extra-high",
        name: "Claude Opus 4.6 (Copilot)",
        description: "",
        vendor: "Anthropic",
        family: "claude-opus-4.6",
      },
      {
        id: "anthropic/claude-opus-4.6-low",
        name: "Claude Opus 4.6 (Copilot)",
        description: "",
        vendor: "Anthropic",
        family: "claude-opus-4.6",
      },
    ]);

    assert.deepStrictEqual(
      catalog.map((model) => model.label),
      ["Claude Opus 4.6 (Extra High)", "Claude Opus 4.6 (Low)"],
    );
  });

  test("normalizeModelCatalog derives version labels from path segments", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "anthropic/claude-opus-4.6/versions/2025-02-19",
        name: "Claude Opus 4.6 (Copilot)",
        description: "",
        vendor: "Anthropic",
        family: "claude-opus-4.6",
      },
      {
        id: "anthropic/claude-opus-4.6/versions/2025-03-01",
        name: "Claude Opus 4.6 (Copilot)",
        description: "",
        vendor: "Anthropic",
        family: "claude-opus-4.6",
      },
    ]);

    assert.deepStrictEqual(
      catalog.map((model) => model.label),
      ["Claude Opus 4.6 (2025-02-19)", "Claude Opus 4.6 (2025-03-01)"],
    );
  });

  test("normalizeModelCatalog keeps display labels unique for indistinguishable ids", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "provider-a-gpt-5-4",
        name: "GPT-5.4",
        description: "",
        vendor: "OpenAI",
      },
      {
        id: "provider-b-gpt-5-4",
        name: "GPT-5.4",
        description: "",
        vendor: "OpenAI",
      },
    ]);

    assert.strictEqual(catalog.length, 2);
    assert.notStrictEqual(catalog[0]?.label, catalog[1]?.label);
  });

  test("normalizeModelCatalog keeps token-distinct entries separate", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "copilot-gpt-5-4",
        name: "GPT-5.4",
        description: "",
        vendor: "copilot",
        family: "gpt-5.4",
        maxInputTokens: 32000,
      },
      {
        id: "copilot-gpt-5-4",
        name: "GPT-5.4",
        description: "",
        vendor: "copilot",
        family: "gpt-5.4",
        maxInputTokens: 128000,
      },
    ]);

    assert.strictEqual(catalog.length, 2);
    assert.deepStrictEqual(
      catalog.map((model) => model.label),
      ["GPT-5.4 (32k)", "GPT-5.4 (128k)"],
    );
  });
});
