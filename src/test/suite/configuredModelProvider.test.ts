import * as assert from "assert";
import * as vscode from "vscode";
import {
  buildConfiguredRequestOptions,
  ConfiguredModelProvider,
  hasSystemMessageDeclaration,
  supportsSystemMessageForwarding,
} from "../../configured-model-provider";
import type { ModelInfo } from "../../types";
import { enrichModelConfigurationCatalog } from "../../model-configuration";

suite("Configured Model Provider", () => {
  test("provider disposal cancels the downstream model request token", async () => {
    const token = new vscode.CancellationTokenSource();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let downstream: vscode.CancellationToken | undefined;
    let cancellations = 0;
    let subscription: vscode.Disposable | undefined;
    const source = {
      id: model.id,
      vendor: model.vendor,
      version: model.version,
      sendRequest: async (
        _messages: unknown,
        _options: unknown,
        active: vscode.CancellationToken,
      ) => {
        downstream = active;
        subscription = active.onCancellationRequested(() => {
          cancellations++;
        });
        started();
        return new Promise(() => {});
      },
    } as unknown as vscode.LanguageModelChat;
    const provider = new ConfiguredModelProvider(
      async () => [source],
      async () => [model],
    );
    try {
      const binding = provider.bind(model, { mode: "normal:low" });
      const pending = provider.provideLanguageModelChatResponse(
        binding,
        [],
        { toolMode: vscode.LanguageModelChatToolMode.Auto },
        { report() {} },
        token.token,
      );
      await ready;
      provider.dispose();
      await assert.rejects(pending, vscode.CancellationError);
      assert.strictEqual(downstream?.isCancellationRequested, true);
      assert.strictEqual(cancellations, 1);
      assert.strictEqual(token.token.isCancellationRequested, false);
    } finally {
      subscription?.dispose();
      provider.dispose();
      token.dispose();
    }
  });
  test("catalog invalidation rejects stale pending token preparation and permits a fresh lookup", async () => {
    const changed = new vscode.EventEmitter<void>();
    const token = new vscode.CancellationTokenSource();
    let release!: (models: vscode.LanguageModelChat[]) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let selections = 0;
    let counts = 0;
    const source = {
      id: model.id,
      vendor: model.vendor,
      version: model.version,
      countTokens: async () => {
        counts++;
        return 1;
      },
    } as unknown as vscode.LanguageModelChat;
    const provider = new ConfiguredModelProvider(
      () => {
        selections++;
        if (selections === 1) {
          started();
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve([source]);
      },
      async () => [model],
      changed.event,
    );
    try {
      const binding = provider.bind(model, { mode: "normal:low" });
      const pending = provider.provideTokenCount(binding, "old", token.token);
      await ready;
      changed.fire();
      assert.strictEqual(
        await provider.provideTokenCount(binding, "fresh", token.token),
        1,
      );
      release([source]);
      await assert.rejects(pending, vscode.CancellationError);
      assert.strictEqual(counts, 1);
      assert.strictEqual(selections, 2);
    } finally {
      provider.dispose();
      changed.dispose();
      token.dispose();
    }
  });
  test("cancelled token callers detach promptly without cancelling shared preparation", async () => {
    const first = new vscode.CancellationTokenSource();
    const second = new vscode.CancellationTokenSource();
    let release!: (models: vscode.LanguageModelChat[]) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let counts = 0;
    const source = {
      id: model.id,
      vendor: model.vendor,
      version: model.version,
      countTokens: async () => {
        counts++;
        return 1;
      },
    } as unknown as vscode.LanguageModelChat;
    const provider = new ConfiguredModelProvider(
      () => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      async () => [model],
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const binding = provider.bind(model, { mode: "normal:low" });
      const cancelled = provider.provideTokenCount(
        binding,
        "first",
        first.token,
      );
      await ready;
      const surviving = provider.provideTokenCount(
        binding,
        "second",
        second.token,
      );
      first.cancel();
      await Promise.race([
        assert.rejects(cancelled, vscode.CancellationError),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error("Caller cancellation waited for shared preparation"),
              ),
            300,
          );
        }),
      ]);
      assert.strictEqual(counts, 0);
      release([source]);
      assert.strictEqual(await surviving, 1);
      assert.strictEqual(counts, 1);
    } finally {
      clearTimeout(deadline);
      provider.dispose();
      first.dispose();
      second.dispose();
    }
  });

  test("disposal stops a pending stream before reporting late parts", async () => {
    const token = new vscode.CancellationTokenSource();
    let release!: (
      part: IteratorResult<vscode.LanguageModelResponsePart>,
    ) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let returned = 0;
    let reported = 0;
    const source = {
      id: model.id,
      vendor: model.vendor,
      version: model.version,
      sendRequest: async () => ({
        stream: {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              started();
              return new Promise((resolve) => {
                release = resolve;
              });
            },
            return: () => {
              returned++;
              return Promise.resolve({ done: true, value: undefined });
            },
          }),
        },
      }),
    } as unknown as vscode.LanguageModelChat;
    const provider = new ConfiguredModelProvider(
      async () => [source],
      async () => [model],
    );
    try {
      const binding = provider.bind(model, { mode: "normal:low" });
      const pending = provider.provideLanguageModelChatResponse(
        binding,
        [],
        { toolMode: vscode.LanguageModelChatToolMode.Auto },
        {
          report() {
            reported++;
          },
        },
        token.token,
      );
      await ready;
      provider.dispose();
      await assert.rejects(pending, vscode.CancellationError);
      release({ done: false, value: new vscode.LanguageModelTextPart("late") });
      assert.strictEqual(reported, 0);
      assert.strictEqual(returned, 1);
      assert.throws(
        () => provider.bind(model, { mode: "normal:low" }),
        vscode.CancellationError,
      );
    } finally {
      provider.dispose();
      token.dispose();
    }
  });
  test("disposal during response preparation prevents a late source request", async () => {
    const token = new vscode.CancellationTokenSource();
    let release!: (models: vscode.LanguageModelChat[]) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const source = {
      id: model.id,
      vendor: model.vendor,
      version: model.version,
      sendRequest: async () => {
        calls++;
        return { stream: (async function* () {})() };
      },
    } as unknown as vscode.LanguageModelChat;
    const provider = new ConfiguredModelProvider(
      () => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      async () => [model],
    );
    try {
      const binding = provider.bind(model, { mode: "normal:low" });
      const pending = provider.provideLanguageModelChatResponse(
        binding,
        [],
        { toolMode: vscode.LanguageModelChatToolMode.Auto },
        { report() {} },
        token.token,
      );
      await ready;
      provider.dispose();
      release([source]);
      await assert.rejects(pending, vscode.CancellationError);
      assert.strictEqual(calls, 0);
    } finally {
      provider.dispose();
      token.dispose();
    }
  });
  test("missing and malformed declarations do not enable runtime setup", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      vscode.extensions,
      "getExtension",
    )!;
    try {
      for (const manifest of [
        undefined,
        {},
        { enabledApiProposals: [] },
        { enabledApiProposals: "languageModelSystem" },
        {
          originalEnabledApiProposals: [],
          enabledApiProposals: ["languageModelSystem"],
        },
        {
          originalEnabledApiProposals: "languageModelSystem",
          enabledApiProposals: [],
        },
      ]) {
        Object.defineProperty(vscode.extensions, "getExtension", {
          ...descriptor,
          value: () =>
            manifest === undefined ? undefined : { packageJSON: manifest },
        });
        assert.strictEqual(hasSystemMessageDeclaration(), false);
      }
      Object.defineProperty(vscode.extensions, "getExtension", {
        ...descriptor,
        value: () => ({
          packageJSON: { enabledApiProposals: ["languageModelSystem"] },
        }),
      });
      assert.strictEqual(hasSystemMessageDeclaration(), true);
    } finally {
      Object.defineProperty(vscode.extensions, "getExtension", descriptor);
    }
  });

  test("effective proposal permissions control System forwarding independently of declarations", async () => {
    const originalExtension = vscode.extensions.getExtension;
    const token = new vscode.CancellationTokenSource();
    try {
      for (const enabled of [false, true]) {
        Object.defineProperty(vscode.extensions, "getExtension", {
          configurable: true,
          value: () => ({
            packageJSON: {
              enabledApiProposals: enabled ? ["languageModelSystem"] : [],
              originalEnabledApiProposals: ["languageModelSystem"],
            },
          }),
        });
        assert.strictEqual(hasSystemMessageDeclaration(), true);
        assert.strictEqual(supportsSystemMessageForwarding(), enabled);
        let calls = 0;
        const source = {
          id: model.id,
          vendor: model.vendor,
          version: model.version,
          sendRequest: async (messages: vscode.LanguageModelChatMessage[]) => {
            calls++;
            assert.strictEqual(Number(messages[0].role), 3);
            return { stream: (async function* () {})() };
          },
        } as unknown as vscode.LanguageModelChat;
        const provider = new ConfiguredModelProvider(
          async () => [source],
          async () => [model],
        );
        try {
          const binding = provider.bind(model, { mode: "normal:low" });
          const request = () =>
            provider.provideLanguageModelChatResponse(
              binding,
              [
                {
                  role: 3,
                  name: undefined,
                  content: [new vscode.LanguageModelTextPart("synthetic")],
                },
              ] as never,
              { toolMode: vscode.LanguageModelChatToolMode.Auto },
              { report() {} },
              token.token,
            );
          if (enabled) await request();
          else await assert.rejects(request, vscode.LanguageModelError);
          assert.strictEqual(calls, enabled ? 1 : 0);
        } finally {
          provider.dispose();
        }
      }
    } finally {
      Object.defineProperty(vscode.extensions, "getExtension", {
        configurable: true,
        value: originalExtension,
      });
      token.dispose();
    }
  });
  test("configured relays stay selectable in native Chat model compatibility checks", () => {
    const provider = new ConfiguredModelProvider();
    try {
      const binding = provider.bind(model, { mode: "normal:low" });
      const advertised = provider.provideLanguageModelChatInformation();
      assert.strictEqual(advertised.length, 1);
      assert.strictEqual(advertised[0].id, binding.id);
      assert.strictEqual(
        Object.hasOwn(advertised[0], "isUserSelectable"),
        false,
      );
    } finally {
      provider.dispose();
    }
  });
  test("token preparation is shared, invalidated on catalog changes, and recovers after lookup failure", async () => {
    const changed = new vscode.EventEmitter<void>();
    const token = new vscode.CancellationTokenSource();
    let selections = 0;
    let schemas = 0;
    let counts = 0;
    let available = true;
    const source = {
      id: model.id,
      vendor: model.vendor,
      version: model.version,
      countTokens: async () => {
        counts++;
        return 1;
      },
    } as unknown as vscode.LanguageModelChat;
    const provider = new ConfiguredModelProvider(
      async () => {
        selections++;
        return available ? [source] : [];
      },
      async () => {
        schemas++;
        return [model];
      },
      changed.event,
    );
    try {
      const binding = provider.bind(model, { mode: "normal:low" });
      await Promise.all(
        Array.from({ length: 20 }, () =>
          provider.provideTokenCount(binding, "synthetic", token.token),
        ),
      );
      assert.strictEqual(selections, 1);
      assert.strictEqual(schemas, 1);
      assert.strictEqual(counts, 20);
      available = false;
      changed.fire();
      await assert.rejects(
        provider.provideTokenCount(binding, "synthetic", token.token),
      );
      assert.strictEqual(counts, 20);
      available = true;
      assert.strictEqual(
        await provider.provideTokenCount(binding, "synthetic", token.token),
        1,
      );
      assert.strictEqual(selections, 3);
      assert.strictEqual(schemas, 2);
    } finally {
      provider.dispose();
      changed.dispose();
      token.dispose();
    }
  });
  test("unsupported message roles are blocked before source lookup or token counting", async () => {
    let calls = 0;
    const provider = new ConfiguredModelProvider(async () => {
      calls++;
      throw new Error("Unsupported roles must not reach source lookup");
    });
    const token = new vscode.CancellationTokenSource();
    try {
      const binding = provider.bind(model, { mode: "normal:low" });
      for (const role of [3, 99]) {
        const message = {
          role,
          name: undefined,
          content: [new vscode.LanguageModelTextPart("synthetic")],
        } as vscode.LanguageModelChatRequestMessage;
        for (const operation of [
          () =>
            provider.provideLanguageModelChatResponse(
              binding,
              [message],
              { toolMode: vscode.LanguageModelChatToolMode.Auto },
              { report() {} },
              token.token,
            ),
          () => provider.provideTokenCount(binding, message, token.token),
        ]) {
          await assert.rejects(
            operation,
            (error: unknown) =>
              error instanceof vscode.LanguageModelError &&
              error.code === "Blocked",
          );
        }
      }
      assert.strictEqual(calls, 0);
      assert.deepStrictEqual(binding.configuration, { mode: "normal:low" });
    } finally {
      provider.dispose();
      token.dispose();
    }
  });
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
