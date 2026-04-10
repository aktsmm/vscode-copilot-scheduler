import * as assert from "assert";
import {
  buildModelPickerGroups,
  filterExpandedPickerModelCatalog,
  filterPickerModelCatalog,
  findBestMatchingModel,
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
});
