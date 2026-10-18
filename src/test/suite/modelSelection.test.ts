import * as assert from "assert";
import {
  buildModelPickerGroups,
  filterExpandedPickerModelCatalog,
  filterPickerModelCatalog,
  findBestMatchingModel,
  findFallbackModel,
  MODEL_FALLBACK_CHAIN_MAX,
  normalizeModelFallbackChain,
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

  test("findBestMatchingModel preserves exact opaque ids and rejects ambiguous providers", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "shared_model",
        name: "Shared",
        description: "",
        vendor: "copilot",
        family: "shared",
        version: "9",
      },
      {
        id: "shared-model",
        name: "Shared",
        description: "",
        vendor: "ollama",
        family: "shared",
        version: "1",
      },
    ]);
    assert.strictEqual(
      findBestMatchingModel({ model: "shared-model" }, catalog)?.vendor,
      "ollama",
    );
    assert.strictEqual(
      findBestMatchingModel({ model: "SHARED MODEL" }, catalog),
      undefined,
    );
    assert.strictEqual(
      findBestMatchingModel({ modelName: "Shared" }, catalog),
      undefined,
    );
    assert.strictEqual(
      findBestMatchingModel(
        { model: "SHARED MODEL", modelVendor: "ollama" },
        catalog,
      )?.vendor,
      "ollama",
    );
    assert.strictEqual(
      findBestMatchingModel(
        { model: "shared" },
        catalog.map((model) => ({ ...model, id: "shared" })),
      ),
      undefined,
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

  test("filterPickerModelCatalog excludes CLI provider groups without removing ordinary providers", () => {
    const models = [
      "copilotcli",
      "agent-host-copilotcli",
      "CopilotCLI",
      "copilot",
      "openai-codex",
      "azure",
      "ollama",
      "copilot-client-demo",
    ].map((vendor) => ({
      id: "gpt-6-luna",
      name: "GPT 6 Luna",
      vendor,
      family: "gpt-6-luna",
      description: "",
    }));
    const before = JSON.stringify(models);
    const picker = filterPickerModelCatalog(models);
    assert.deepStrictEqual(
      picker.map((model) => model.vendor),
      ["copilot", "openai-codex", "azure", "ollama", "copilot-client-demo"],
    );
    assert.strictEqual(JSON.stringify(models), before);
  });

  test("filterPickerModelCatalog includes extension and BYOK providers", () => {
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
      [
        "claude-sonnet-4.6-copilot",
        "claude-sonnet-4.6-claude-code",
        "azure-gpt-5.4",
      ],
    );
  });

  test("provider selections never resolve to a different provider", () => {
    const models = normalizeModelCatalog([
      {
        id: "shared-model",
        name: "Shared Model",
        description: "",
        vendor: "copilot",
      },
      {
        id: "shared-model",
        name: "Shared Model",
        description: "",
        vendor: "openai-codex",
      },
      {
        id: "local-model",
        name: "Local Model",
        description: "",
        vendor: "ollama",
      },
    ]);
    assert.strictEqual(filterPickerModelCatalog(models).length, 3);
    const groups = buildModelPickerGroups(models);
    assert.strictEqual(groups.length, 3);
    assert.strictEqual(new Set(groups.map((group) => group.key)).size, 3);
    assert.deepStrictEqual(
      groups.map((group) => group.vendor),
      ["copilot", "openai-codex", "ollama"],
    );
    assert.strictEqual(
      findBestMatchingModel(
        { model: "shared-model", modelVendor: "openai-codex" },
        models,
      )?.vendor,
      "openai-codex",
    );
    assert.strictEqual(
      findBestMatchingModel(
        { model: "shared-model", modelVendor: "missing-provider" },
        models,
      ),
      undefined,
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
        [
          "Claude Opus 4.7",
          ["Default", "Low", "Medium", "High", "Xhigh", "Max"],
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
      [
        "copilot-gpt-5-4",
        "openai/gpt-5-4-low",
        "openai/gpt-5-4-high",
        "azure-gpt-5-4",
      ],
    );
    assert.strictEqual(groups.length, 3);
    assert.strictEqual(groups[0]?.label, "GPT-5.4");
    assert.deepStrictEqual(
      groups[1]?.variants.map((variant) => variant.label),
      ["Low", "High"],
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
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0]?.label, "Claude Opus 4.6");
    assert.deepStrictEqual(
      groups[1]?.variants.map((variant) => variant.label),
      ["High", "Medium"],
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
        ["Max", "max"],
      ],
    );
  });

  test("buildModelPickerGroups exposes keyed thinking effort variants for Claude Opus 4.8", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.8",
        version: "claude-opus-4.8",
      },
    ]);

    const groups = buildModelPickerGroups(catalog, {
      includeExperimentalModelQualityVariants: true,
    });

    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(
      groups[0]?.variants.map((variant) => ({
        label: variant.label,
        reasoningEffort: variant.reasoningEffort || "default",
        hasReasoningKey: variant.key.includes("::reasoning-effort:"),
      })),
      [
        {
          label: "Default",
          reasoningEffort: "default",
          hasReasoningKey: true,
        },
        { label: "Low", reasoningEffort: "low", hasReasoningKey: true },
        {
          label: "Medium",
          reasoningEffort: "medium",
          hasReasoningKey: true,
        },
        { label: "High", reasoningEffort: "high", hasReasoningKey: true },
        { label: "Xhigh", reasoningEffort: "xhigh", hasReasoningKey: true },
        { label: "Max", reasoningEffort: "max", hasReasoningKey: true },
      ],
    );
  });

  test("buildModelPickerGroups synthesizes preview thinking effort variants for Claude Opus 4.7", () => {
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
      [
        ["Default", "default"],
        ["Low", "low"],
        ["Medium", "medium"],
        ["High", "high"],
        ["Xhigh", "xhigh"],
        ["Max", "max"],
      ],
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
      [
        ["Default", "default"],
        ["Low", "low"],
        ["Medium", "medium"],
        ["High", "high"],
      ],
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
        ["Max", "max"],
      ],
    );
  });

  test("normalizeModelSelection keeps supported reasoning effort for Claude Opus 4.7", () => {
    const selection = normalizeModelSelection({
      model: "claude-opus-4.7",
      modelVendor: "copilot",
      modelFamily: "claude-opus-4.7",
      modelReasoningEffort: "high",
    });

    assert.strictEqual(selection.modelReasoningEffort, "high");
  });

  test("Codex Bridge picker and normalization retain Luna task reasoning", () => {
    const catalog = [
      {
        id: "default::gpt-6-luna",
        name: "GPT 6 Luna",
        description: "",
        vendor: "openai-codex",
        family: "gpt-6-luna",
      },
    ];
    const groups = buildModelPickerGroups(catalog, {
      includeExperimentalModelQualityVariants: true,
    });
    assert.deepStrictEqual(
      groups[0].variants.map((variant) => variant.reasoningEffort),
      [undefined, "low", "high"],
    );
    for (const effort of ["low", "high", "xhigh"]) {
      const selection = normalizeModelSelection({
        model: catalog[0].id,
        modelVendor: "openai-codex",
        modelFamily: "gpt-6-luna",
        modelReasoningEffort: effort,
      });
      assert.strictEqual(
        selection.modelReasoningEffort,
        effort === "xhigh" ? undefined : effort,
      );
    }
  });

  test("normalizeModelSelection retains explicit GPT-6 Sol reasoning after model migration", () => {
    for (const effort of ["none", "xhigh"]) {
      const selection = normalizeModelSelection({
        model: "gpt-6-sol",
        modelVendor: "copilot",
        modelFamily: "gpt-6-sol",
        modelReasoningEffort: effort,
      });

      assert.strictEqual(selection.modelReasoningEffort, effort);
    }
  });

  test("normalizeModelSelection accepts verified GPT-6 Astra and Luna levels only", () => {
    for (const family of ["gpt-6-astra", "gpt-6-luna"]) {
      for (const [effort, expected] of [
        ["high", "high"],
        ["max", undefined],
      ] as const) {
        const selection = normalizeModelSelection({
          model: family,
          modelVendor: "copilot",
          modelFamily: family,
          modelReasoningEffort: effort,
        });

        assert.strictEqual(selection.modelReasoningEffort, expected);
      }
    }
  });

  test("normalizeModelSelection drops reasoning effort for automatic and utility aliases", () => {
    for (const model of [
      { model: "auto", modelName: "Auto", modelFamily: "claude-opus-4.7" },
      {
        model: "copilot-utility",
        modelName: "GPT-5.3-Codex",
        modelFamily: "copilot-utility",
      },
      {
        model: "copilot-dictation-cleanup-luna",
        modelName: "GPT-5.6 Luna",
        modelFamily: "copilot-dictation-cleanup-luna",
      },
    ]) {
      const selection = normalizeModelSelection({
        ...model,
        modelVendor: "copilot",
        modelReasoningEffort: "high",
      });

      assert.strictEqual(
        selection.modelReasoningEffort,
        undefined,
        model.model,
      );
    }
  });

  test("normalizeModelSelection clears unsupported reasoning effort for Claude Opus 4.6", () => {
    const selection = normalizeModelSelection({
      model: "claude-opus-4.6",
      modelVendor: "copilot",
      modelFamily: "claude-opus-4.6",
      modelReasoningEffort: "xhigh",
    });

    assert.strictEqual(selection.modelReasoningEffort, undefined);
  });

  test("normalizeModelSelection keeps supported reasoning effort for Claude Opus 4.7 even when family is coarse", () => {
    const selection = normalizeModelSelection({
      model: "copilot-claude-opus-4.7",
      modelName: "Claude Opus 4.7",
      modelVendor: "copilot",
      modelFamily: "claude-opus",
      modelReasoningEffort: "medium",
    });

    assert.strictEqual(selection.modelReasoningEffort, "medium");
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

  test("Auto is only matched when it is requested by id or name", () => {
    const catalog = normalizeModelCatalog([
      {
        id: "auto",
        name: "Auto",
        description: "",
        vendor: "copilot",
        family: "claude-haiku-5.5",
        version: "claude-haiku-5.5",
      },
      {
        id: "claude-haiku-5.5",
        name: "Claude Haiku 5.5",
        description: "",
        vendor: "copilot",
        family: "claude-haiku-5.5",
        version: "claude-haiku-5.5",
      },
    ]);

    assert.strictEqual(
      findBestMatchingModel({ modelFamily: "claude-haiku-5.5" }, catalog)?.id,
      "claude-haiku-5.5",
    );
    assert.strictEqual(
      findBestMatchingModel(
        { model: "claude-haiku-5.5", modelFamily: "claude-haiku-5.5" },
        catalog,
      )?.id,
      "claude-haiku-5.5",
    );
    assert.strictEqual(
      findBestMatchingModel({ model: "auto", modelVendor: "copilot" }, catalog)
        ?.id,
      "auto",
    );
    assert.strictEqual(
      findBestMatchingModel({ modelName: "Auto" }, catalog)?.id,
      "auto",
    );
    assert.strictEqual(
      findBestMatchingModel({ model: "gone", modelFamily: "gone" }, catalog),
      undefined,
    );
  });

  test("normalizeModelFallbackChain trims, de-duplicates, ignores junk and caps the length", () => {
    assert.deepStrictEqual(normalizeModelFallbackChain(undefined), []);
    assert.deepStrictEqual(normalizeModelFallbackChain("auto"), []);
    assert.deepStrictEqual(
      normalizeModelFallbackChain([
        " hydrafusion ",
        "Hydra-Fusion",
        "",
        42,
        null,
        "auto",
      ]),
      ["hydrafusion", "auto"],
    );
    assert.strictEqual(
      normalizeModelFallbackChain(["a", "b", "c", "d", "e", "f", "g"]).length,
      MODEL_FALLBACK_CHAIN_MAX,
    );
  });

  test("findFallbackModel picks the first chain entry present in the catalog", () => {
    const models = normalizeModelCatalog([
      { id: "claude", name: "Claude", description: "", vendor: "copilot" },
      {
        id: "hydrafusion",
        name: "HydraFusion",
        description: "",
        vendor: "copilot",
      },
      { id: "auto", name: "Auto", description: "", vendor: "copilot" },
    ]);

    assert.strictEqual(
      findFallbackModel(["hydrafusion", "auto"], models)?.id,
      "hydrafusion",
    );
    assert.strictEqual(
      findFallbackModel(["Hydra Fusion", "auto"], models)?.id,
      "hydrafusion",
    );
    assert.strictEqual(
      findFallbackModel(["missing", "auto"], models)?.id,
      "auto",
    );
    assert.strictEqual(findFallbackModel(["missing"], models), undefined);
    assert.strictEqual(findFallbackModel([], models), undefined);
  });

  test("findFallbackModel skips entries that are the unavailable model and Default", () => {
    const models = normalizeModelCatalog([
      { id: "", name: "Default", description: "", vendor: "" },
      { id: "auto", name: "Auto", description: "", vendor: "copilot" },
    ]);

    assert.strictEqual(
      findFallbackModel(["auto"], models, { model: "auto" }),
      undefined,
    );
    assert.strictEqual(findFallbackModel([""], models), undefined);
  });
});
