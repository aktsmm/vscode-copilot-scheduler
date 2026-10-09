import * as assert from "assert";
import {
  enrichModelConfigurationCatalog,
  normalizeModelConfiguration,
  validateModelConfiguration,
} from "../../model-configuration";
import type { ModelInfo } from "../../types";
import { createModelSelectionResolver } from "../../taskMutationService";
import {
  normalizeModelSelection,
  areModelSelectionsEqual,
  normalizeModelCatalog,
} from "../../modelSelection";

suite("Dynamic Model Configuration", () => {
  test("default model inherits without resolving a synthetic identity", async () => {
    const resolver = createModelSelectionResolver(async () => {
      throw new Error("Should not load catalog");
    });
    const result = await resolver({
      model: "",
      modelName: "Default",
      modelConfiguration: {},
    });
    assert.strictEqual(result.ok, true);
    if (result.ok)
      assert.deepStrictEqual(result.selection, { modelConfiguration: {} });
  });
  test("compares typed maps independently of property insertion order", () => {
    assert.strictEqual(
      areModelSelectionsEqual(
        { modelConfiguration: { mode: "fast:high", contextSize: 4096 } },
        { modelConfiguration: { contextSize: 4096, mode: "fast:high" } },
      ),
      true,
    );
  });
  const model: ModelInfo = {
    id: "shared",
    name: "Shared",
    vendor: "bridge",
    description: "",
  };
  function schema() {
    return {
      items: {
        allOf: [
          {
            if: { $ref: "#/$defs/vendor" },
            then: {
              properties: {
                settings: {
                  properties: {
                    shared: {
                      properties: {
                        mode: {
                          type: "string",
                          enum: ["normal:low", "fast:high"],
                          enumItemLabels: ["Low", "High Fast"],
                          default: "normal:low",
                        },
                        contextSize: {
                          type: ["string", "number"],
                          enum: ["auto", 4096, "4096"],
                          enumItemLabels: ["Auto", "Maximum", "String cap"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      $defs: { vendor: { properties: { vendor: { const: "bridge" } } } },
    };
  }
  test("extracts dynamic labels and preserves numeric versus string values by vendor", () => {
    const models = enrichModelConfigurationCatalog(
      [model, { ...model, vendor: "copilot" }],
      JSON.stringify(schema()),
    );
    assert.strictEqual(models[0].configurationStatus, "available");
    assert.strictEqual(models[1].configurationStatus, "unsupported");
    assert.deepStrictEqual(
      models[0].configurationOptions?.[0].choices.map((choice) => choice.label),
      ["Low", "High Fast"],
    );
    assert.deepStrictEqual(
      models[0].configurationOptions?.[1].choices.map((choice) => choice.value),
      ["auto", 4096, "4096"],
    );
    validateModelConfiguration(models[0], {
      mode: "fast:high",
      contextSize: 4096,
    });
    assert.throws(() =>
      validateModelConfiguration(models[0], { mode: "fast:medium" }),
    );
  });
  test("rejects invalid defaults and malformed schema instead of inventing choices", () => {
    const raw = schema();
    raw.items.allOf[0].then.properties.settings.properties.shared.properties.mode.default =
      "unknown";
    assert.strictEqual(
      enrichModelConfigurationCatalog([model], JSON.stringify(raw))[0]
        .configurationStatus,
      "invalid",
    );
    assert.strictEqual(
      enrichModelConfigurationCatalog([model], "not JSON")[0]
        .configurationStatus,
      "invalid",
    );
  });
  test("does not expose secret-marked or password model options", () => {
    for (const marker of [{ secret: true }, { format: "password" }]) {
      const raw = schema();
      Object.assign(
        raw.items.allOf[0].then.properties.settings.properties.shared.properties
          .mode,
        marker,
      );
      const result = enrichModelConfigurationCatalog(
        [model],
        JSON.stringify(raw),
      )[0];
      assert.strictEqual(result.configurationStatus, "invalid");
      assert.deepStrictEqual(result.configurationOptions, []);
    }
  });
  test("normalization and tool resolution retain typed dynamic settings", async () => {
    const models = normalizeModelCatalog(
      enrichModelConfigurationCatalog([model], JSON.stringify(schema())),
    );
    const resolver = createModelSelectionResolver(async () => ({
      source: "api",
      models,
    }));
    const result = await resolver({
      model: "shared",
      modelVendor: "bridge",
      modelConfiguration: { mode: "fast:high", contextSize: 4096 },
    });
    assert.strictEqual(result.ok, true);
    if (result.ok)
      assert.deepStrictEqual(result.selection.modelConfiguration, {
        mode: "fast:high",
        contextSize: 4096,
      });
    assert.strictEqual(
      (
        await resolver({
          model: "shared",
          modelConfiguration: { mode: "made-up" },
        })
      ).ok,
      false,
    );
    assert.strictEqual(
      (
        await resolver({
          model: "shared",
          modelConfiguration: {},
          modelReasoningEffort: "low",
        })
      ).ok,
      false,
    );
    assert.deepStrictEqual(
      normalizeModelSelection({ modelConfiguration: {} }).modelConfiguration,
      {},
    );
    assert.strictEqual(
      areModelSelectionsEqual(
        { model: "shared" },
        { model: "shared", modelConfiguration: {} },
      ),
      false,
    );
  });
  test("rejects remote and cyclic references", () => {
    for (const ref of ["https://example.test/schema", "#/$defs/vendor"]) {
      const raw = schema() as unknown as Record<string, unknown>;
      raw.$defs = { vendor: { $ref: ref } };
      assert.strictEqual(
        enrichModelConfigurationCatalog([model], JSON.stringify(raw))[0]
          .configurationStatus,
        "invalid",
      );
    }
  });
  test("rejects conflicting duplicate model schemas and unsafe inputs", () => {
    const raw = schema();
    const conflict = structuredClone(raw.items.allOf[0]);
    conflict.then.properties.settings.properties.shared.properties.mode.enum = [
      "normal:low",
    ];
    conflict.then.properties.settings.properties.shared.properties.mode.enumItemLabels =
      ["Low"];
    raw.items.allOf.push(conflict);
    assert.strictEqual(
      enrichModelConfigurationCatalog([model], JSON.stringify(raw))[0]
        .configurationStatus,
      "invalid",
    );
    for (const value of [
      [],
      null,
      { contextSize: NaN },
      { secret: "x" },
      JSON.parse('{"__proto__":"x"}'),
    ]) {
      assert.throws(() => normalizeModelConfiguration(value));
    }
    assert.deepStrictEqual(normalizeModelConfiguration({}), {});
  });
});
