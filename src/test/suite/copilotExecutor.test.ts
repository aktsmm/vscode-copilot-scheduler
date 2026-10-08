import * as assert from "assert";
import * as vscode from "vscode";
import { CopilotExecutor, __testOnly } from "../../copilotExecutor";

suite("CopilotExecutor Agent Prefix Tests", () => {
  test("task chatSession override wins over configuration", async () => {
    const originalGetConfiguration = vscode.workspace.getConfiguration;

    Object.defineProperty(vscode.workspace, "getConfiguration", {
      value: ((section?: string) => {
        const config = originalGetConfiguration.call(vscode.workspace, section);
        if (section !== "copilotScheduler") {
          return config;
        }
        return {
          ...config,
          get<T>(key: string, defaultValue?: T): T {
            if (key === "chatSession") {
              return "new" as T;
            }
            return config.get<T>(key, defaultValue as T);
          },
        } as vscode.WorkspaceConfiguration;
      }) as typeof vscode.workspace.getConfiguration,
      configurable: true,
    });

    try {
      const config = vscode.workspace.getConfiguration("copilotScheduler");
      assert.strictEqual(
        __testOnly.resolveChatSessionBehavior("continue", config),
        "continue",
      );
      assert.strictEqual(
        __testOnly.resolveChatSessionBehavior(undefined, config),
        "new",
      );
    } finally {
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        value: originalGetConfiguration,
        configurable: true,
      });
    }
  });

  test("Parses custom agent name from frontmatter", async () => {
    const parsed = __testOnly.parseAgentFrontmatterName(
      ["---", "name: Fact Checker", "description: test", "---", "# body"].join(
        "\n",
      ),
    );

    assert.strictEqual(parsed, "Fact Checker");
  });

  test("Parses quoted custom agent names from frontmatter", () => {
    const doubleQuoted = __testOnly.parseAgentFrontmatterName(
      ["---", 'name: "Fact Checker"', "---"].join("\n"),
    );
    const singleQuoted = __testOnly.parseAgentFrontmatterName(
      ["---", "name: 'Fact Checker'", "---"].join("\n"),
    );

    assert.strictEqual(doubleQuoted, "Fact Checker");
    assert.strictEqual(singleQuoted, "Fact Checker");
  });

  test("Returns undefined when agent frontmatter has no name", () => {
    const parsed = __testOnly.parseAgentFrontmatterName(
      ["---", "description: test", "---", "# body"].join("\n"),
    );

    assert.strictEqual(parsed, undefined);
  });

  test("Treats agents as user-invocable unless explicitly disabled", () => {
    const noFlag = __testOnly.parseAgentFrontmatter(
      ["---", "name: Orchestrator", "---", "# body"].join("\n"),
    );
    const noFrontmatter = __testOnly.parseAgentFrontmatter("# just a body");

    assert.strictEqual(noFlag.userInvocable, true);
    assert.strictEqual(noFrontmatter.userInvocable, true);
  });

  test("Parses user-invocable: false as not user-invocable", () => {
    for (const raw of ["false", "no", "0", '"false"', "'false'", "FALSE"]) {
      const parsed = __testOnly.parseAgentFrontmatter(
        ["---", "name: Subagent", `user-invocable: ${raw}`, "---"].join("\n"),
      );
      assert.strictEqual(
        parsed.userInvocable,
        false,
        `expected user-invocable ${raw} to be false`,
      );
      assert.strictEqual(parsed.name, "Subagent");
    }
  });

  test("Parses user-invocable: true as user-invocable", () => {
    const parsed = __testOnly.parseAgentFrontmatter(
      ["---", "name: Helper", "user-invocable: true", "---"].join("\n"),
    );
    assert.strictEqual(parsed.userInvocable, true);
  });

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

  test("Resolves built-in agents to chat.open modes", () => {
    assert.strictEqual(__testOnly.resolveChatOpenMode("edit"), "edit");
    assert.strictEqual(__testOnly.resolveChatOpenMode("/ask"), "ask");
  });

  test("Resolves custom agents to chat.open custom mode names", () => {
    assert.strictEqual(
      __testOnly.resolveChatOpenMode("customReviewer"),
      "customReviewer",
    );
    assert.strictEqual(
      __testOnly.resolveChatOpenMode("@Code Review"),
      "Code Review",
    );
  });

  test("Does not resolve participant agents to chat.open modes", () => {
    assert.strictEqual(__testOnly.resolveChatOpenMode("@workspace"), undefined);
    assert.strictEqual(__testOnly.resolveChatOpenMode("@terminal"), undefined);
  });

  test("Prompt routing uses chat.open mode for built-in agents", () => {
    const routing = __testOnly.buildPromptRouting("Implement this", "edit");

    assert.deepStrictEqual(routing, {
      requestedAgent: "/edit",
      runtimeAgent: "/edit",
      chatOpenMode: "edit",
      chatOpenPrompt: "Implement this",
      legacyPrompt: "/edit Implement this",
    });
  });

  test("Prompt routing uses chat.open mode for custom agents", () => {
    const routing = __testOnly.buildPromptRouting(
      "Review recent changes",
      "customReviewer",
    );

    assert.deepStrictEqual(routing, {
      requestedAgent: "@customReviewer",
      runtimeAgent: "@customReviewer",
      chatOpenMode: "customReviewer",
      chatOpenPrompt: "Review recent changes",
      legacyPrompt: "@customReviewer Review recent changes",
    });
  });

  test("Prompt routing preserves participant prefixes in query", () => {
    const routing = __testOnly.buildPromptRouting(
      "Search the codebase",
      "@workspace",
    );

    assert.deepStrictEqual(routing, {
      requestedAgent: "@workspace",
      runtimeAgent: "@workspace",
      chatOpenMode: undefined,
      chatOpenPrompt: "@workspace Search the codebase",
      legacyPrompt: "@workspace Search the codebase",
    });
  });

  test("Prompt routing strips matching custom prefix from chat.open prompt", () => {
    const routing = __testOnly.buildPromptRouting(
      "@planner inspect the architecture",
      "@planner",
    );

    assert.deepStrictEqual(routing, {
      requestedAgent: "@planner",
      runtimeAgent: "@planner",
      chatOpenMode: "planner",
      chatOpenPrompt: "inspect the architecture",
      legacyPrompt: "@planner inspect the architecture",
    });
  });

  test("Prompt routing rewrites saved custom id to runtime agent name", () => {
    const routing = __testOnly.buildPromptRouting(
      "Review this claim",
      "@fact-checker",
      "@Fact Checker",
    );

    assert.deepStrictEqual(routing, {
      requestedAgent: "@fact-checker",
      runtimeAgent: "@Fact Checker",
      chatOpenMode: "Fact Checker",
      chatOpenPrompt: "Review this claim",
      legacyPrompt: "@Fact Checker Review this claim",
    });
  });

  test("Prompt routing rewrites prefixed saved custom id to runtime agent name", () => {
    const routing = __testOnly.buildPromptRouting(
      "@fact-checker Review this claim",
      "@fact-checker",
      "@Fact Checker",
    );

    assert.deepStrictEqual(routing, {
      requestedAgent: "@fact-checker",
      runtimeAgent: "@Fact Checker",
      chatOpenMode: "Fact Checker",
      chatOpenPrompt: "Review this claim",
      legacyPrompt: "@Fact Checker Review this claim",
    });
  });

  test("Prompt routing keeps non-agent prompts when only runtime override exists", () => {
    const routing = __testOnly.buildPromptRouting(
      "@workspace Review this claim",
      undefined,
      "@Fact Checker",
    );

    assert.deepStrictEqual(routing, {
      requestedAgent: "",
      runtimeAgent: "@Fact Checker",
      chatOpenMode: "Fact Checker",
      chatOpenPrompt: "@workspace Review this claim",
      legacyPrompt: "@workspace Review this claim",
    });
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

  test("provider selector candidates never discard the vendor", () => {
    for (const selection of [
      { model: "shared", modelVendor: "openai-codex", modelFamily: "gpt" },
      { modelVendor: "ollama", modelFamily: "llama" },
    ]) {
      const selectors = __testOnly.buildModelSelectorCandidates(selection);
      assert.ok(selectors.length > 0);
      assert.ok(
        selectors.every(
          (selector) => selector.vendor === selection.modelVendor,
        ),
      );
      assert.strictEqual(
        __testOnly.hasStrictProviderSelection(selection),
        true,
      );
    }
    assert.strictEqual(
      __testOnly.hasStrictProviderSelection({ modelVendor: "copilot" }),
      false,
    );
    assert.strictEqual(__testOnly.hasStrictProviderSelection({}), false);
  });

  test("provider dispatch failures never retry without a model selector", async () => {
    const original = vscode.commands.executeCommand;
    const attempts: Record<string, unknown>[] = [];
    Object.defineProperty(vscode.commands, "executeCommand", {
      value: async (_command: string, args: Record<string, unknown>) => {
        attempts.push(args);
        throw new Error("provider offline");
      },
      configurable: true,
    });
    try {
      const executor = new CopilotExecutor() as unknown as {
        tryOpenChatWithPrompt: (
          prompt: string,
          mode: string,
          selection: { model: string; modelVendor: string },
          model: undefined,
          attachments: vscode.Uri[],
        ) => Promise<{ opened: boolean }>;
      };
      const result = await executor.tryOpenChatWithPrompt(
        "synthetic probe",
        "ask",
        { model: "shared", modelVendor: "openai-codex" },
        undefined,
        [],
      );
      assert.strictEqual(result.opened, false);
      assert.ok(attempts.length > 0);
      assert.ok(
        attempts.every(
          (args) =>
            (args.modelSelector as { vendor?: string })?.vendor ===
            "openai-codex",
        ),
      );
    } finally {
      Object.defineProperty(vscode.commands, "executeCommand", {
        value: original,
        configurable: true,
      });
    }
  });

  test("missing provider models block rather than resolve to another provider", async () => {
    const original = CopilotExecutor.getAvailableModelsWithSource;
    CopilotExecutor.getAvailableModelsWithSource = async () => ({
      source: "api",
      models: [
        { id: "shared", name: "Shared", vendor: "copilot", description: "" },
      ],
    });
    try {
      const resolver = CopilotExecutor as unknown as {
        resolveRequestedModelSelection: (selection: {
          model: string;
          modelVendor: string;
        }) => Promise<unknown>;
      };
      await assert.rejects(
        resolver.resolveRequestedModelSelection({
          model: "shared",
          modelVendor: "ollama",
        }),
        /unavailable|利用できません/,
      );
    } finally {
      CopilotExecutor.getAvailableModelsWithSource = original;
    }
  });

  test("chat.open args include attachFiles only when attachments exist", () => {
    const withoutAttachments = __testOnly.buildChatOpenArgs(
      "Review this",
      "agent",
      {},
      undefined,
      false,
      [],
    );
    assert.ok(!("attachFiles" in withoutAttachments));

    const attachments = [
      vscode.Uri.file("/tmp/a.md"),
      vscode.Uri.file("/tmp/b.md"),
    ];
    const withAttachments = __testOnly.buildChatOpenArgs(
      "Review this",
      "agent",
      {},
      undefined,
      false,
      attachments,
    );
    assert.deepStrictEqual(withAttachments.attachFiles, attachments);
  });

  test("attachment-bearing runs never fall back to the legacy chat path", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/copilotExecutor.ts"),
      "utf8",
    );

    assert.ok(
      /if \(attachFiles\.length > 0\) \{[\s\S]*?createPromptBlockedError\(\s*messages\.attachmentsRequireChatOpen\(\),/.test(
        source,
      ),
      "chat.open failure with attachments must block instead of using the legacy path",
    );
    assert.ok(
      source.indexOf('if (chatSession === "new")') <
        source.indexOf("let chatOpenResult = await this.tryOpenChatWithPrompt"),
      "a new chat session must be created before chat.open attaches files",
    );
  });

  test("chat.open args include modelConfiguration for reasoning effort selections", () => {
    const args = __testOnly.buildChatOpenArgs(
      "Review this",
      "agent",
      {
        model: "claude-opus-4.8",
        modelVendor: "copilot",
        modelFamily: "claude-opus-4.8",
        modelVersion: "claude-opus-4.8",
        modelReasoningEffort: "high",
      },
      {
        id: "claude-opus-4.8",
        vendor: "copilot",
        family: "claude-opus-4.8",
        version: "claude-opus-4.8",
      },
    );

    assert.deepStrictEqual(args, {
      query: "Review this",
      isPartialQuery: false,
      mode: "agent",
      modelSelector: {
        id: "claude-opus-4.8",
        vendor: "copilot",
        family: "claude-opus-4.8",
        version: "claude-opus-4.8",
      },
      modelConfiguration: {
        reasoningEffort: "high",
      },
    });
  });

  test("chat.open args keep the agent mode but drop reasoning effort when modelConfiguration is omitted", () => {
    const args = __testOnly.buildChatOpenArgs(
      "Review this",
      "agent",
      {
        model: "claude-opus-4.8",
        modelVendor: "copilot",
        modelFamily: "claude-opus-4.8",
        modelVersion: "claude-opus-4.8",
        modelReasoningEffort: "high",
      },
      undefined,
      true,
    );

    // The custom agent mode survives so it can still be applied, but the
    // reasoning-effort knob that some models reject is dropped.
    assert.deepStrictEqual(args, {
      query: "Review this",
      isPartialQuery: false,
      mode: "agent",
    });
  });

  test("chat.open args keep the model selector but drop reasoning effort on the first reasoning-free retry", () => {
    const selector = {
      id: "claude-opus-4.8",
      vendor: "copilot",
      family: "claude-opus-4.8",
      version: "claude-opus-4.8",
    };
    const args = __testOnly.buildChatOpenArgs(
      "Review this",
      "agent",
      {
        model: "claude-opus-4.8",
        modelVendor: "copilot",
        modelFamily: "claude-opus-4.8",
        modelVersion: "claude-opus-4.8",
        modelReasoningEffort: "high",
      },
      selector,
      true,
    );

    // First retry tier: the user's selected model (modelSelector) is preserved
    // so we do not silently fall back to the default chat model; only the
    // reasoning-effort knob that some models reject is dropped.
    assert.deepStrictEqual(args, {
      query: "Review this",
      isPartialQuery: false,
      mode: "agent",
      modelSelector: selector,
    });
  });

  test("chat.open args omit modelConfiguration when reasoning effort is default", () => {
    const args = __testOnly.buildChatOpenArgs(
      "Ask this",
      undefined,
      {},
      {
        id: "gpt-5.5",
        vendor: "copilot",
      },
    );

    assert.deepStrictEqual(args, {
      query: "Ask this",
      isPartialQuery: false,
      mode: undefined,
      modelSelector: {
        id: "gpt-5.5",
        vendor: "copilot",
      },
    });
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

  test("model discovery recovers additional providers after a Copilot lookup failure", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      vscode.lm,
      "selectChatModels",
    );
    assert.ok(descriptor);
    const calls: vscode.LanguageModelChatSelector[] = [];
    Object.defineProperty(vscode.lm, "selectChatModels", {
      configurable: true,
      value: async (selector: vscode.LanguageModelChatSelector) => {
        calls.push(selector);
        if (selector.vendor === "copilot") {
          throw new Error("synthetic Copilot discovery failure");
        }
        return [
          {
            id: "local-model",
            name: "Local Model",
            vendor: "ollama",
            family: "local",
            version: "1",
          },
        ];
      },
    });
    try {
      const result = await CopilotExecutor.getAvailableModelsWithSource();
      assert.strictEqual(result.source, "api");
      assert.ok(
        result.models.some(
          (model) => model.id === "local-model" && model.vendor === "ollama",
        ),
      );
      assert.deepStrictEqual(calls, [{ vendor: "copilot" }, {}]);
    } finally {
      Object.defineProperty(vscode.lm, "selectChatModels", descriptor);
    }
  });

  for (const scenario of [
    {
      name: "keeps Copilot models when full lookup fails",
      copilot: "models",
      all: "error",
      source: "api",
      vendor: "copilot",
    },
    {
      name: "discovers providers when Copilot is empty",
      copilot: "empty",
      all: "models",
      source: "api",
      vendor: "ollama",
    },
    {
      name: "uses fallback when both lookups fail",
      copilot: "error",
      all: "error",
      source: "fallback",
      vendor: undefined,
    },
    {
      name: "uses fallback when both lookups are empty",
      copilot: "empty",
      all: "empty",
      source: "fallback",
      vendor: undefined,
    },
  ]) {
    test(`model discovery ${scenario.name}`, async () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        vscode.lm,
        "selectChatModels",
      );
      assert.ok(descriptor);
      let calls = 0;
      Object.defineProperty(vscode.lm, "selectChatModels", {
        configurable: true,
        value: async (selector: vscode.LanguageModelChatSelector) => {
          calls++;
          const outcome = selector.vendor ? scenario.copilot : scenario.all;
          if (outcome === "error")
            throw new Error("synthetic discovery failure");
          if (outcome === "empty") return [];
          return [
            {
              id: "test-model",
              name: "Test Model",
              vendor: selector.vendor || "ollama",
              family: "test",
              version: "1",
            },
          ];
        },
      });
      try {
        const result = await CopilotExecutor.getAvailableModelsWithSource();
        assert.strictEqual(calls, 2);
        assert.strictEqual(result.source, scenario.source);
        assert.strictEqual(result.models[0].id, "");
        assert.strictEqual(result.models.length, scenario.vendor ? 2 : 1);
        if (scenario.vendor)
          assert.strictEqual(result.models[1].vendor, scenario.vendor);
      } finally {
        Object.defineProperty(vscode.lm, "selectChatModels", descriptor);
      }
    });
  }

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

  test("mergeChatModelLists keeps entries that differ only by maxInputTokens", () => {
    const merged = __testOnly.mergeChatModelLists(
      [
        {
          id: "copilot-gpt-5-4",
          name: "GPT-5.4",
          vendor: "copilot",
          family: "gpt-5.4",
          maxInputTokens: 32000,
        },
      ],
      [
        {
          id: "copilot-gpt-5-4",
          name: "GPT-5.4",
          vendor: "copilot",
          family: "gpt-5.4",
          maxInputTokens: 128000,
        },
      ],
    );

    assert.deepStrictEqual(
      merged.map((model) => model.maxInputTokens),
      [32000, 128000],
    );
  });

  test("getAllAgents caches results until invalidated", async () => {
    CopilotExecutor.invalidateAgentCache();

    const first = await CopilotExecutor.getAllAgents();
    const second = await CopilotExecutor.getAllAgents();
    // A cache hit returns the very same array instance (no rescan).
    assert.strictEqual(second, first);

    CopilotExecutor.invalidateAgentCache();
    const third = await CopilotExecutor.getAllAgents();
    // After invalidation the list is rebuilt (new instance, equal content).
    assert.notStrictEqual(third, first);
    assert.deepStrictEqual(third, first);
  });

  test("getAllAgents force refresh bypasses the cache", async () => {
    const cached = await CopilotExecutor.getAllAgents();
    const forced = await CopilotExecutor.getAllAgents(true);
    // Forcing a refresh rescans and returns a fresh instance.
    assert.notStrictEqual(forced, cached);
    assert.deepStrictEqual(forced, cached);
  });

  test("getAllAgents does not let an in-flight scan poison a forced refresh", async () => {
    CopilotExecutor.invalidateAgentCache();

    // Start a non-forced scan, then immediately force a refresh while the first
    // scan may still be in flight. The forced scan's result must win the cache;
    // the older scan must not write a stale snapshot back afterwards.
    const stalePromise = CopilotExecutor.getAllAgents();
    const forced = await CopilotExecutor.getAllAgents(true);
    await stalePromise;

    const afterwards = await CopilotExecutor.getAllAgents();
    // The cache reflects the forced refresh, not the earlier in-flight scan.
    assert.strictEqual(afterwards, forced);
  });
});
