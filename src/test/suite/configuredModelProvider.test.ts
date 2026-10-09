import * as assert from "assert";
import * as vscode from "vscode";
import {
  buildConfiguredRequestOptions,
  ConfiguredModelProvider,
} from "../../configured-model-provider";
import type { ModelInfo } from "../../types";
import { enrichModelConfigurationCatalog } from "../../model-configuration";

suite("Configured Model Provider", () => {
  test("advertised zero context keeps a usable source input budget", () => {
    const provider = new ConfiguredModelProvider();
    try {
      const source: ModelInfo = {
        id: "zero",
        name: "Zero",
        vendor: "source",
        description: "",
        maxInputTokens: 10000,
        configurationStatus: "available",
        configurationOptions: [
          {
            key: "contextSize",
            label: "Context",
            choices: [{ value: 0, label: "Auto" }],
          },
        ],
      };
      const binding = provider.bind(source, { contextSize: 0 });
      assert.strictEqual(binding.maxInputTokens, 10000);
      assert.deepStrictEqual(binding.configuration, { contextSize: 0 });
    } finally {
      provider.dispose();
    }
  });
  test("unversioned sources remain usable after fresh schema validation", async () => {
    for (const version of [undefined, ""]) {
      const token = new vscode.CancellationTokenSource();
      let calls = 0;
      const source = {
        id: "source",
        name: "Source",
        vendor: "provider",
        family: "source",
        version: "new",
        maxInputTokens: 10000,
        countTokens: async () => {
          calls++;
          return 1;
        },
      } as unknown as vscode.LanguageModelChat;
      const provider = new ConfiguredModelProvider(
        async () => [source],
        async (infos) =>
          infos.map((info) => ({
            ...info,
            configurationStatus: "available",
            configurationOptions: model.configurationOptions,
          })),
      );
      try {
        const binding = provider.bind(
          { ...model, version },
          { mode: "normal:low" },
        );
        assert.strictEqual(
          await provider.provideTokenCount(binding, "prompt", token.token),
          1,
        );
        assert.strictEqual(calls, 1);
      } finally {
        provider.dispose();
        token.dispose();
      }
    }
  });

  test("request options and input configuration are not mutated by fixed overrides", () => {
    const tools = Object.freeze([
      { name: "inspect", description: "inspect", inputSchema: {} },
    ]);
    const stale = Object.freeze({ mode: "normal:low" });
    const configuration = Object.freeze({
      mode: "fast:high",
      contextSize: 4096,
    });
    const incoming = Object.freeze({
      modelConfiguration: stale,
      modelOptions: { custom: "value" },
      tools,
    });
    const forwarded = buildConfiguredRequestOptions(
      incoming as never,
      configuration,
    );
    assert.deepStrictEqual(incoming.modelConfiguration, { mode: "normal:low" });
    assert.strictEqual(incoming.tools, tools);
    assert.notStrictEqual(forwarded.tools, tools);
    assert.strictEqual(forwarded.modelOptions?.custom, "value");
    assert.deepStrictEqual(configuration, {
      mode: "fast:high",
      contextSize: 4096,
    });
  });
  test("reselected source identity and pinned version must match before any downstream call", async () => {
    for (const mismatch of [
      { id: "other" },
      { vendor: "other" },
      { version: "2" },
    ]) {
      for (const operation of ["response", "count"]) {
        const token = new vscode.CancellationTokenSource();
        let calls = 0;
        const source = {
          id: "source",
          name: "Source",
          vendor: "provider",
          family: "source",
          version: "1",
          maxInputTokens: 10000,
          ...mismatch,
          countTokens: async () => {
            calls++;
            return 1;
          },
          sendRequest: async () => {
            calls++;
            return { stream: (async function* () {})() };
          },
        } as unknown as vscode.LanguageModelChat;
        const provider = new ConfiguredModelProvider(
          async () => [source],
          async (infos) =>
            infos.map((info) => ({
              ...info,
              configurationStatus: "available",
              configurationOptions: model.configurationOptions,
            })),
        );
        try {
          const binding = provider.bind(model, { mode: "normal:low" });
          await assert.rejects(
            operation === "response"
              ? provider.provideLanguageModelChatResponse(
                  binding,
                  [],
                  { toolMode: vscode.LanguageModelChatToolMode.Auto },
                  { report() {} },
                  token.token,
                )
              : provider.provideTokenCount(binding, "prompt", token.token),
          );
          assert.strictEqual(calls, 0);
        } finally {
          provider.dispose();
          token.dispose();
        }
      }
    }
  });
  test("cancellation during response or token-count completion is not reported as success", async () => {
    for (const stage of ["response", "stream", "count"]) {
      const token = new vscode.CancellationTokenSource();
      let calls = 0;
      let reported = 0;
      const source = {
        id: "source",
        name: "Source",
        vendor: "provider",
        version: "1",
        family: "source",
        maxInputTokens: 10000,
        countTokens: async () => {
          calls++;
          token.cancel();
          return 1;
        },
        sendRequest: async () => {
          calls++;
          if (stage === "response") token.cancel();
          return {
            stream: (async function* () {
              if (stage === "stream") token.cancel();
            })(),
          };
        },
      } as unknown as vscode.LanguageModelChat;
      const provider = new ConfiguredModelProvider(
        async () => [source],
        async () => [model],
      );
      try {
        const binding = provider.bind(model, { mode: "normal:low" });
        await assert.rejects(
          stage === "count"
            ? provider.provideTokenCount(binding, "prompt", token.token)
            : provider.provideLanguageModelChatResponse(
                binding,
                [],
                { toolMode: vscode.LanguageModelChatToolMode.Auto },
                {
                  report() {
                    reported++;
                  },
                },
                token.token,
              ),
          vscode.CancellationError,
        );
        assert.strictEqual(calls, 1);
        assert.strictEqual(reported, 0);
      } finally {
        provider.dispose();
        token.dispose();
      }
    }
  });
  test("cancellation during source preparation never sends or counts tokens", async () => {
    for (const operation of ["response", "count"]) {
      for (const stage of ["select", "schema"]) {
        const token = new vscode.CancellationTokenSource();
        let calls = 0;
        const source = {
          id: "source",
          name: "Source",
          vendor: "provider",
          version: "1",
          family: "source",
          maxInputTokens: 10000,
          countTokens: async () => {
            calls++;
            return 1;
          },
          sendRequest: async () => {
            calls++;
            return { stream: (async function* () {})() };
          },
        } as unknown as vscode.LanguageModelChat;
        const provider = new ConfiguredModelProvider(
          async () => {
            if (stage === "select") token.cancel();
            return [source];
          },
          async () => {
            if (stage === "schema") token.cancel();
            return [model];
          },
        );
        try {
          const binding = provider.bind(model, { mode: "normal:low" });
          await assert.rejects(
            operation === "response"
              ? provider.provideLanguageModelChatResponse(
                  binding,
                  [],
                  { toolMode: vscode.LanguageModelChatToolMode.Auto },
                  { report() {} },
                  token.token,
                )
              : provider.provideTokenCount(binding, "prompt", token.token),
            vscode.CancellationError,
          );
          assert.strictEqual(calls, 0, `${operation}/${stage}`);
        } finally {
          provider.dispose();
          token.dispose();
        }
      }
    }
  });
  const model: ModelInfo = {
    id: "source",
    name: "Source",
    vendor: "provider",
    version: "1",
    description: "",
    configurationStatus: "available",
    configurationOptions: [
      {
        key: "mode",
        label: "Reasoning",
        choices: [
          { value: "normal:low", label: "Low" },
          { value: "fast:high", label: "High Fast" },
        ],
      },
      {
        key: "contextSize",
        label: "Context",
        choices: [
          { value: "auto", label: "Auto" },
          { value: 4096, label: "4096" },
        ],
      },
    ],
  };
  test("fixes per-request values independently of stale Chat model configuration", () => {
    const options = buildConfiguredRequestOptions(
      { modelConfiguration: { mode: "normal:low" } } as never,
      { mode: "fast:high", contextSize: 4096 },
    );
    assert.deepStrictEqual(options.configuration, {
      mode: "fast:high",
      contextSize: 4096,
    });
    assert.ok(!Object.hasOwn(options, "modelConfiguration"));
  });
  test("different task settings have immutable distinct model bindings", () => {
    const provider = new ConfiguredModelProvider();
    try {
      const low = provider.bind(model, {
        mode: "normal:low",
        contextSize: "auto",
      });
      const high = provider.bind(model, {
        mode: "fast:high",
        contextSize: 4096,
      });
      assert.notStrictEqual(low.id, high.id);
      assert.deepStrictEqual(low.configuration, {
        mode: "normal:low",
        contextSize: "auto",
      });
      assert.strictEqual(
        provider.bind(model, { contextSize: 4096, mode: "fast:high" }).id,
        high.id,
      );
      assert.throws(() => provider.bind(model, { mode: "invented" }));
      assert.strictEqual(high.maxInputTokens, 4096);
      assert.deepStrictEqual(high.capabilities, {
        toolCalling: false,
        imageInput: false,
      });
      const capable = provider.bind(
        { ...model, supportsToolCalling: true, supportsImageInput: true },
        { mode: "fast:high", contextSize: 4096 },
      );
      assert.notStrictEqual(capable.id, high.id);
      assert.deepStrictEqual(capable.capabilities, {
        toolCalling: true,
        imageInput: true,
      });
    } finally {
      provider.dispose();
    }
  });

  test("forwards tools and streamed parts with fixed settings; cancellation and missing sources stop", async () => {
    const token = new vscode.CancellationTokenSource();
    let sends = 0;
    let observed: vscode.LanguageModelChatRequestOptions & {
      configuration?: unknown;
    } = {};
    let missing = false;
    const text = new vscode.LanguageModelTextPart("OK");
    const call = new vscode.LanguageModelToolCallPart("call-1", "inspect", {
      value: 1,
    });
    const source = {
      id: "source",
      vendor: "provider",
      name: "Source",
      family: "source",
      version: "1",
      maxInputTokens: 10000,
      countTokens: async () => 3,
      sendRequest: async (_messages: unknown, options: typeof observed) => {
        sends++;
        observed = options;
        return {
          stream: (async function* () {
            yield text;
            yield call;
          })(),
        };
      },
    } as unknown as vscode.LanguageModelChat;
    const rawSchema = {
      items: {
        allOf: [
          {
            if: { properties: { vendor: { const: "provider" } } },
            then: {
              properties: {
                settings: {
                  properties: {
                    source: {
                      properties: {
                        mode: {
                          type: "string",
                          enum: ["normal:low", "fast:high"],
                        },
                        contextSize: {
                          type: ["string", "number"],
                          enum: ["auto", 4096],
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
    };
    const provider = new ConfiguredModelProvider(
      async () => (missing ? [] : [source]),
      async (models) =>
        enrichModelConfigurationCatalog(models, JSON.stringify(rawSchema)),
    );
    try {
      const binding = provider.bind(model, {
        mode: "fast:high",
        contextSize: 4096,
      });
      const parts: vscode.LanguageModelResponsePart[] = [];
      await provider.provideLanguageModelChatResponse(
        binding,
        [
          {
            role: vscode.LanguageModelChatMessageRole.User,
            name: undefined,
            content: [new vscode.LanguageModelTextPart("prompt")],
          },
        ],
        {
          toolMode: vscode.LanguageModelChatToolMode.Auto,
          tools: [{ name: "inspect", description: "inspect", inputSchema: {} }],
        },
        { report: (part) => parts.push(part) },
        token.token,
      );
      assert.deepStrictEqual(observed.configuration, {
        mode: "fast:high",
        contextSize: 4096,
      });
      assert.strictEqual(observed.tools?.[0].name, "inspect");
      assert.deepStrictEqual(parts, [text, call]);
      missing = true;
      await assert.rejects(
        provider.provideLanguageModelChatResponse(
          binding,
          [],
          { toolMode: vscode.LanguageModelChatToolMode.Auto },
          { report() {} },
          token.token,
        ),
      );
      assert.strictEqual(sends, 1);
      missing = false;
      rawSchema.items.allOf[0].then.properties.settings.properties.source.properties.mode.enum =
        ["normal:low"];
      await assert.rejects(
        provider.provideLanguageModelChatResponse(
          binding,
          [],
          { toolMode: vscode.LanguageModelChatToolMode.Auto },
          { report() {} },
          token.token,
        ),
      );
      assert.strictEqual(sends, 1);
      token.cancel();
      await assert.rejects(
        provider.provideLanguageModelChatResponse(
          binding,
          [],
          { toolMode: vscode.LanguageModelChatToolMode.Auto },
          { report() {} },
          token.token,
        ),
      );
      assert.strictEqual(sends, 1);
    } finally {
      token.dispose();
      provider.dispose();
    }
  });
});
