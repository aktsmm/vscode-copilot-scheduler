import * as assert from "assert";
import { CopilotExecutor, __testOnly } from "../../copilotExecutor";

suite("CopilotExecutor Agent Prefix Tests", () => {
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
});
