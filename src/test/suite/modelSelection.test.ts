import * as assert from "assert";
import {
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
});
