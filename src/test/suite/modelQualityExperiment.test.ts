import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import {
  getLanguageModelsConfigUriFromGlobalStorageUri,
  getExperimentalModelQualityVariants,
  getSupportedExperimentalReasoningEfforts,
  normalizeExperimentalReasoningEffort,
  supportsExperimentalModelQuality,
  updateLanguageModelsConfigText,
} from "../../modelQualityExperiment";

suite("Model Quality Experiment Tests", () => {
  test("getLanguageModelsConfigUriFromGlobalStorageUri resolves the current profile file", () => {
    const profileRoot = path.join(path.sep, "tmp", "Code", "User");
    const configUri = getLanguageModelsConfigUriFromGlobalStorageUri(
      vscode.Uri.file(
        path.join(profileRoot, "globalStorage", "yamapan.copilot-scheduler"),
      ),
    );

    assert.strictEqual(
      configUri.fsPath,
      path.join(profileRoot, "chatLanguageModels.json"),
    );
  });

  test("updateLanguageModelsConfigText adds a reasoning effort override", () => {
    const nextText = updateLanguageModelsConfigText(undefined, {
      vendor: "copilot",
      modelId: "copilot-gpt-5-4",
      reasoningEffort: "high",
    });

    assert.deepStrictEqual(JSON.parse(nextText), [
      {
        name: "copilot",
        vendor: "copilot",
        settings: {
          "copilot-gpt-5-4": {
            reasoningEffort: "high",
          },
        },
      },
    ]);
  });

  test("updateLanguageModelsConfigText preserves explicit none separately from default", () => {
    const nextText = updateLanguageModelsConfigText(undefined, {
      vendor: "copilot",
      modelId: "gpt-6-sol",
      reasoningEffort: "none",
    });

    assert.strictEqual(
      JSON.parse(nextText)[0].settings["gpt-6-sol"].reasoningEffort,
      "none",
    );
    assert.strictEqual(
      updateLanguageModelsConfigText(nextText, {
        vendor: "copilot",
        modelId: "gpt-6-sol",
        reasoningEffort: "none",
      }),
      nextText,
    );
    assert.deepStrictEqual(
      JSON.parse(
        updateLanguageModelsConfigText(nextText, {
          vendor: "copilot",
          modelId: "gpt-6-sol",
        }),
      ),
      [{ name: "copilot", vendor: "copilot" }],
    );
  });

  test("updateLanguageModelsConfigText clears only the reasoning effort override", () => {
    const existingText = JSON.stringify(
      [
        {
          name: "copilot",
          vendor: "copilot",
          settings: {
            "copilot-gpt-5-4": {
              reasoningEffort: "high",
              temperature: 0.2,
            },
          },
        },
      ],
      undefined,
      "\t",
    );

    const nextText = updateLanguageModelsConfigText(existingText, {
      vendor: "copilot",
      modelId: "copilot-gpt-5-4",
    });

    assert.deepStrictEqual(JSON.parse(nextText), [
      {
        name: "copilot",
        vendor: "copilot",
        settings: {
          "copilot-gpt-5-4": {
            temperature: 0.2,
          },
        },
      },
    ]);
  });

  test("updateLanguageModelsConfigText preserves contextSize when setting reasoning effort", () => {
    const existingText = JSON.stringify(
      [
        {
          name: "Copilot",
          vendor: "copilot",
          settings: {
            "claude-opus-4.8": {
              contextSize: 936000,
            },
          },
        },
      ],
      undefined,
      "\t",
    );

    const nextText = updateLanguageModelsConfigText(existingText, {
      vendor: "copilot",
      modelId: "claude-opus-4.8",
      reasoningEffort: "high",
    });

    assert.deepStrictEqual(JSON.parse(nextText), [
      {
        name: "Copilot",
        vendor: "copilot",
        settings: {
          "claude-opus-4.8": {
            contextSize: 936000,
            reasoningEffort: "high",
          },
        },
      },
    ]);
  });

  test("updateLanguageModelsConfigText clears reasoning effort but keeps contextSize", () => {
    const existingText = JSON.stringify(
      [
        {
          name: "Copilot",
          vendor: "copilot",
          settings: {
            "claude-opus-4.8": {
              contextSize: 936000,
              reasoningEffort: "high",
            },
          },
        },
      ],
      undefined,
      "\t",
    );

    const nextText = updateLanguageModelsConfigText(existingText, {
      vendor: "copilot",
      modelId: "claude-opus-4.8",
    });

    assert.deepStrictEqual(JSON.parse(nextText), [
      {
        name: "Copilot",
        vendor: "copilot",
        settings: {
          "claude-opus-4.8": {
            contextSize: 936000,
          },
        },
      },
    ]);
  });

  test("normalizeExperimentalReasoningEffort accepts xhigh", () => {
    assert.strictEqual(normalizeExperimentalReasoningEffort("xhigh"), "xhigh");
    assert.strictEqual(normalizeExperimentalReasoningEffort("none"), "none");
  });

  test("recent Copilot models expose only their supported reasoning levels", () => {
    const cases: Array<[string, readonly string[]]> = [
      ["gpt-5.6-luna", ["low", "medium", "high", "xhigh"]],
      ["gpt-5.6-sol", ["low", "medium", "high", "xhigh"]],
      ["gpt-5.6-terra", ["low", "medium", "high", "xhigh"]],
      ["gpt-6-astra", ["low", "medium", "high"]],
      ["gpt-6-luna", ["low", "medium", "high"]],
      ["gpt-6-sol", ["none", "low", "medium", "high", "xhigh", "max"]],
      ["claude-opus-5", ["low", "medium", "high"]],
      ["claude-opus-5.5", ["low", "medium", "high"]],
      ["claude-sonnet-5", ["low", "medium", "high"]],
      ["gpt-6-unknown", []],
    ];

    for (const [family, expected] of cases) {
      assert.deepStrictEqual(
        getSupportedExperimentalReasoningEfforts({ vendor: "copilot", family }),
        expected,
        family,
      );
    }
  });

  test("automatic and utility aliases do not inherit fixed-model reasoning levels", () => {
    for (const model of [
      { id: "auto", name: "Auto", family: "claude-opus-4.7" },
      {
        id: "copilot-utility",
        name: "GPT-5.3-Codex",
        family: "copilot-utility",
      },
      {
        id: "copilot-utility-small",
        name: "GPT-5.3-Codex",
        family: "copilot-utility-small",
      },
      {
        id: "copilot-dictation-cleanup-luna",
        name: "GPT-5.6 Luna",
        family: "copilot-dictation-cleanup-luna",
      },
    ]) {
      assert.deepStrictEqual(
        getSupportedExperimentalReasoningEfforts({
          vendor: "copilot",
          ...model,
        }),
        [],
        model.id,
      );
    }

    assert.deepStrictEqual(
      getSupportedExperimentalReasoningEfforts({
        id: "claude-opus-4.7",
        vendor: "copilot",
        family: "claude-opus-4.7",
      }),
      ["low", "medium", "high", "xhigh", "max"],
    );
  });

  test("getExperimentalModelQualityVariants uses the family rules", () => {
    assert.deepStrictEqual(
      getExperimentalModelQualityVariants({
        id: "gpt-6-sol",
        name: "GPT-6 Sol",
        description: "",
        vendor: "copilot",
        family: "gpt-6-sol",
      }).map((variant) => [
        variant.label,
        variant.reasoningEffort || "default",
      ]),
      [
        ["Default", "default"],
        ["None", "none"],
        ["Low", "low"],
        ["Medium", "medium"],
        ["High", "high"],
        ["Xhigh", "xhigh"],
        ["Max", "max"],
      ],
    );

    assert.deepStrictEqual(
      getExperimentalModelQualityVariants({
        id: "copilot-gpt-5.5",
        name: "GPT-5.5",
        description: "",
        vendor: "copilot",
        family: "gpt-5.5",
      }).map((variant) => [
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

    assert.deepStrictEqual(
      getExperimentalModelQualityVariants({
        id: "copilot-gpt-5-mini",
        name: "GPT-5 mini",
        description: "",
        vendor: "copilot",
        family: "gpt-5-mini",
      }).map((variant) => [
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

    assert.deepStrictEqual(
      getExperimentalModelQualityVariants({
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.6",
      }).map((variant) => [
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

    assert.deepStrictEqual(
      getExperimentalModelQualityVariants({
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.8",
      }).map((variant) => [
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

    assert.deepStrictEqual(
      getExperimentalModelQualityVariants({
        id: "claude-haiku-4.5",
        name: "Claude Haiku 4.5",
        description: "",
        vendor: "copilot",
        family: "claude-haiku-4.5",
      }),
      [],
    );

    assert.strictEqual(
      supportsExperimentalModelQuality({
        vendor: "copilot",
        family: "claude-opus-4.7",
      }),
      true,
    );

    assert.deepStrictEqual(
      getSupportedExperimentalReasoningEfforts({
        vendor: "copilot",
        family: "claude-opus-4.7",
      }),
      ["low", "medium", "high", "xhigh", "max"],
    );

    assert.deepStrictEqual(
      getExperimentalModelQualityVariants({
        id: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.7",
      }).map((variant) => [
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

    assert.strictEqual(
      supportsExperimentalModelQuality({
        vendor: "copilot",
        family: "claude-opus-4.7-1m-internal",
        id: "claude-opus-4.7-1m-internal",
        name: "Claude Opus 4.7 (1M context)(Internal only)",
      }),
      true,
    );

    assert.deepStrictEqual(
      getSupportedExperimentalReasoningEfforts({
        vendor: "copilot",
        family: "claude-opus-4.7-1m-internal",
        id: "claude-opus-4.7-1m-internal",
      }),
      ["low", "medium", "high", "xhigh", "max"],
    );

    assert.deepStrictEqual(
      getExperimentalModelQualityVariants({
        id: "claude-opus-4.7-1m-internal",
        name: "Claude Opus 4.7 (1M context)(Internal only)",
        description: "",
        vendor: "copilot",
        family: "claude-opus-4.7-1m-internal",
      }).map((variant) => [
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

    assert.deepStrictEqual(
      getExperimentalModelQualityVariants({
        id: "mai-code-1-flash-internal",
        name: "MAI-Code-1-Flash",
        description: "",
        vendor: "copilot",
        family: "oswe-vscode-modelD",
      }).map((variant) => [
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
});
