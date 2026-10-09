import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  getLanguageModelsConfigUriFromGlobalStorageUri,
  applyExperimentalModelQualitySelection,
  getExperimentalModelQualityVariants,
  getSupportedExperimentalReasoningEfforts,
  normalizeExperimentalReasoningEffort,
  supportsExperimentalModelQuality,
  updateLanguageModelsConfigText,
} from "../../modelQualityExperiment";

suite("Model Quality Experiment Tests", () => {
  test("Codex Bridge exposes only scoped Luna Low and High variants", () => {
    assert.deepStrictEqual(
      getSupportedExperimentalReasoningEfforts({
        vendor: "openai-codex",
        id: "default::gpt-6-luna",
        family: "gpt-6-luna",
      }),
      ["low", "high"],
    );
    for (const vendor of ["openai-codex", "other-provider"]) {
      assert.deepStrictEqual(
        getSupportedExperimentalReasoningEfforts({
          vendor,
          id: "default::unknown",
          family: "gpt-6-unknown",
        }),
        [],
      );
    }
  });

  test("Codex Bridge updates the existing profile mode and retains speed and context", () => {
    const groups = [
      {
        name: "personal",
        vendor: "openai-codex",
        configuration: { profile: "personal" },
        settings: {
          "personal::gpt-6-luna": { mode: "normal:low", contextSize: "auto" },
        },
      },
      {
        name: "work",
        vendor: "openai-codex",
        configuration: { profile: "work" },
        settings: {
          "work::gpt-6-luna": {
            mode: "fast:low",
            reasoningEffort: "low",
            contextSize: 131072,
          },
          "work::another": { mode: "normal:high" },
        },
      },
    ];
    const nextText = updateLanguageModelsConfigText(JSON.stringify(groups), {
      vendor: "openai-codex",
      modelId: "work::gpt-6-luna",
      reasoningEffort: "high",
    });
    const updated = JSON.parse(nextText);
    assert.deepStrictEqual(updated[0], groups[0]);
    assert.deepStrictEqual(
      updated[1].settings["work::another"],
      groups[1].settings["work::another"],
    );
    assert.deepStrictEqual(updated[1].settings["work::gpt-6-luna"], {
      mode: "fast:high",
      reasoningEffort: "high",
      contextSize: 131072,
    });
    assert.strictEqual(
      updateLanguageModelsConfigText(nextText, {
        vendor: "openai-codex",
        modelId: "work::gpt-6-luna",
        reasoningEffort: "high",
      }),
      nextText,
    );
    const cleared = JSON.parse(
      updateLanguageModelsConfigText(nextText, {
        vendor: "openai-codex",
        modelId: "work::gpt-6-luna",
      }),
    );
    assert.deepStrictEqual(cleared[1].settings["work::gpt-6-luna"], {
      mode: "fast",
      contextSize: 131072,
    });
  });

  test("Codex Bridge refuses a missing model entry or an unknown mode", () => {
    assert.throws(
      () =>
        updateLanguageModelsConfigText(undefined, {
          vendor: "openai-codex",
          modelId: "default::gpt-6-luna",
          reasoningEffort: "high",
        }),
      /entry is missing or ambiguous/u,
    );
    assert.throws(
      () =>
        updateLanguageModelsConfigText(
          JSON.stringify([
            {
              name: "Bridge",
              vendor: "openai-codex",
              settings: {
                "default::gpt-6-luna": { mode: "unknown:low" },
              },
            },
          ]),
          {
            vendor: "openai-codex",
            modelId: "default::gpt-6-luna",
            reasoningEffort: "high",
          },
        ),
      /mode is not recognized/u,
    );
  });

  test("Codex Bridge initializes settings only inside the matching profile", () => {
    const original = [
      {
        name: "other",
        vendor: "openai-codex",
        configuration: { profile: "other" },
      },
      {
        name: "default",
        vendor: "openai-codex",
        configuration: { profile: "" },
      },
    ];
    const updated = JSON.parse(
      updateLanguageModelsConfigText(JSON.stringify(original), {
        vendor: "openai-codex",
        modelId: "default::gpt-6-luna",
        reasoningEffort: "high",
      }),
    );
    assert.deepStrictEqual(updated[0], original[0]);
    assert.deepStrictEqual(updated[1].settings, {
      "default::gpt-6-luna": { mode: "normal:high", reasoningEffort: "high" },
    });
    assert.throws(
      () =>
        updateLanguageModelsConfigText(
          JSON.stringify([original[1], original[1]]),
          {
            vendor: "openai-codex",
            modelId: "default::gpt-6-luna",
            reasoningEffort: "high",
          },
        ),
      /ambiguous/u,
    );
  });

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

  test("Codex Bridge applies High, Low and Default to a real isolated config file", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "scheduler-bridge-quality-"),
    );
    const globalStorageUri = vscode.Uri.file(
      path.join(root, "globalStorage", "scheduler"),
    );
    const configPath = path.join(root, "chatLanguageModels.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify([
        {
          name: "Bridge",
          vendor: "openai-codex",
          configuration: { profile: "default" },
          settings: {
            "default::gpt-6-luna": { mode: "fast:low", contextSize: "auto" },
          },
        },
      ]),
    );
    try {
      for (const effort of ["high", "low", undefined]) {
        const result = await applyExperimentalModelQualitySelection({
          globalStorageUri,
          selection: {
            model: "default::gpt-6-luna",
            modelVendor: "openai-codex",
            modelFamily: "gpt-6-luna",
            modelReasoningEffort: effort,
          },
        });
        assert.strictEqual(result.effectiveReasoningEffort, effort);
        const settings = JSON.parse(fs.readFileSync(configPath, "utf8"))[0]
          .settings["default::gpt-6-luna"];
        assert.strictEqual(settings.mode, effort ? `fast:${effort}` : "fast");
        assert.strictEqual(settings.reasoningEffort, effort);
        assert.strictEqual(settings.contextSize, "auto");
      }
      const previous = fs.readFileSync(configPath, "utf8");
      await applyExperimentalModelQualitySelection({
        globalStorageUri,
        selection: {
          model: "unknown",
          modelVendor: "another-provider",
        },
      });
      assert.strictEqual(fs.readFileSync(configPath, "utf8"), previous);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex Bridge preserves workspace Fast and legacy effort-only modes", () => {
    for (const mode of [undefined, "low"]) {
      const next = JSON.parse(
        updateLanguageModelsConfigText(
          JSON.stringify([
            {
              name: "Bridge",
              vendor: "openai-codex",
              settings: { "default::gpt-6-luna": { mode } },
            },
          ]),
          {
            vendor: "openai-codex",
            modelId: "default::gpt-6-luna",
            reasoningEffort: "high",
            defaultSpeedMode: "fast",
          },
        ),
      );
      assert.strictEqual(
        next[0].settings["default::gpt-6-luna"].mode,
        "fast:high",
      );
    }
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
