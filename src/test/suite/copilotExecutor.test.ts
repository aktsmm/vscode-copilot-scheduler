import * as assert from "assert";
import * as vscode from "vscode";
import { CopilotExecutor, __testOnly } from "../../copilotExecutor";
import { messages } from "../../i18n";
import * as configuredModels from "../../configured-model-provider";

suite("CopilotExecutor Agent Prefix Tests", () => {
  test("effective System permission permits native explicit dispatch without dropping options", async () => {
    const originalModels = CopilotExecutor.getAvailableModelsWithSource;
    const originalExtension = vscode.extensions.getExtension;
    const originalResolve = configuredModels.resolveConfiguredTaskModel;
    const originalCommand = vscode.commands.executeCommand;
    const requests: Record<string, unknown>[] = [];
    CopilotExecutor.getAvailableModelsWithSource = async () => ({
      source: "api",
      models: [
        {
          id: "source",
          vendor: "copilot",
          name: "Source",
          description: "",
          configurationStatus: "available",
          configurationOptions: [
            {
              key: "reasoningEffort",
              label: "Thinking",
              choices: [{ value: "high", label: "High" }],
            },
          ],
        },
      ],
    });
    Object.defineProperty(vscode.extensions, "getExtension", {
      configurable: true,
      value: () => ({
        packageJSON: { enabledApiProposals: ["languageModelSystem"] },
      }),
    });
    Object.defineProperty(configuredModels, "resolveConfiguredTaskModel", {
      configurable: true,
      value: async (_model: unknown, configuration: unknown) => {
        assert.deepStrictEqual(configuration, { reasoningEffort: "high" });
        return {
          id: "bound",
          vendor: "copilot-scheduler-configured",
          name: "Bound",
          description: "",
        };
      },
    });
    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: async (_command: string, args: Record<string, unknown>) => {
        requests.push(args);
        return {};
      },
    });
    try {
      const options = {
        agent: "agent",
        model: "source",
        modelVendor: "copilot",
        modelConfiguration: { reasoningEffort: "high" },
        chatSession: "continue" as const,
      };
      const before = JSON.stringify(options);
      await new CopilotExecutor().executePrompt("synthetic", options);
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0].mode, "agent");
      assert.deepStrictEqual(requests[0].modelSelector, {
        id: "bound",
        vendor: "copilot-scheduler-configured",
      });
      assert.strictEqual(requests[0].modelConfiguration, undefined);
      assert.strictEqual(requests[0].blockOnResponse, true);
      assert.strictEqual(JSON.stringify(options), before);
    } finally {
      CopilotExecutor.getAvailableModelsWithSource = originalModels;
      Object.defineProperty(vscode.extensions, "getExtension", {
        configurable: true,
        value: originalExtension,
      });
      Object.defineProperty(configuredModels, "resolveConfiguredTaskModel", {
        configurable: true,
        value: originalResolve,
      });
      Object.defineProperty(vscode.commands, "executeCommand", {
        configurable: true,
        value: originalCommand,
      });
    }
  });
  test("explicit selections stop at executor failure without legacy fallback or attachment retries", async () => {
    const originalModels = CopilotExecutor.getAvailableModelsWithSource;
    const originalCommand = vscode.commands.executeCommand;
    const originalWarning = vscode.window.showWarningMessage;
    CopilotExecutor.getAvailableModelsWithSource = async () => ({
      source: "api",
      models: [
        {
          id: "fixed",
          vendor: "copilot",
          name: "Fixed",
          description: "",
          configurationStatus: "unsupported",
          configurationOptions: [],
        },
      ],
    });
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: async () => undefined,
    });
    try {
      for (const effort of [undefined, "high"]) {
        for (const attachments of [[], ["synthetic.md"]]) {
          const commands: string[] = [];
          Object.defineProperty(vscode.commands, "executeCommand", {
            configurable: true,
            value: async (command: string) => {
              commands.push(command);
              throw new Error("Synthetic dispatch failure");
            },
          });
          const executor = new CopilotExecutor();
          const internal = executor as unknown as {
            syncExperimentalModelQuality: () => Promise<void>;
            executePromptLegacy: () => Promise<void>;
          };
          let legacyCalls = 0;
          let qualitySyncCalls = 0;
          internal.syncExperimentalModelQuality = async () => {
            qualitySyncCalls++;
          };
          internal.executePromptLegacy = async () => {
            legacyCalls++;
          };
          const options = {
            model: "fixed",
            modelVendor: "copilot",
            modelReasoningEffort: effort,
            agent: "agent",
            chatSession: "continue" as const,
            attachFilePaths: attachments,
          };
          const before = JSON.stringify(options);
          await assert.rejects(
            executor.executePrompt("synthetic", options),
            (error: unknown) =>
              (error as Record<string, unknown>)
                .copilotSchedulerPromptBlocked ===
              "providerModelDispatchFailed",
          );
          assert.deepStrictEqual(commands, ["workbench.action.chat.open"]);
          assert.strictEqual(legacyCalls, 0);
          assert.strictEqual(qualitySyncCalls, effort ? 1 : 0);
          assert.strictEqual(JSON.stringify(options), before);
        }
      }
    } finally {
      CopilotExecutor.getAvailableModelsWithSource = originalModels;
      Object.defineProperty(vscode.commands, "executeCommand", {
        configurable: true,
        value: originalCommand,
      });
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: originalWarning,
      });
    }
  });
  test("explicit model and legacy effort dispatch never relax selectors or settings after failure", async () => {
    const original = vscode.commands.executeCommand;
    const executor = new CopilotExecutor() as unknown as {
      tryOpenChatWithPrompt(
        prompt: string,
        mode: string,
        selection: unknown,
        model: undefined,
        attachments: vscode.Uri[],
      ): Promise<{ opened: boolean }>;
    };
    try {
      for (const failure of ["throw", "errorDetails"]) {
        for (const effort of [undefined, "high"]) {
          for (const mode of ["agent", "custom-agent"]) {
            const requests: Record<string, unknown>[] = [];
            Object.defineProperty(vscode.commands, "executeCommand", {
              configurable: true,
              value: async (
                _command: string,
                args: Record<string, unknown>,
              ) => {
                requests.push(args);
                if (failure === "throw") throw new Error("Synthetic rejection");
                return { errorDetails: { message: "Synthetic rejection" } };
              },
            });
            const selection = {
              model: "fixed",
              modelVendor: "copilot",
              modelFamily: "fixed-family",
              modelVersion: "1",
              modelReasoningEffort: effort,
            };
            const before = JSON.stringify(selection);
            const result = await executor.tryOpenChatWithPrompt(
              "synthetic",
              mode,
              selection,
              undefined,
              [],
            );
            assert.strictEqual(result.opened, false);
            assert.strictEqual(requests.length, 1);
            assert.deepStrictEqual(requests[0].modelSelector, {
              id: "fixed",
              vendor: "copilot",
              family: "fixed-family",
              version: "1",
            });
            assert.strictEqual(requests[0].mode, mode);
            assert.deepStrictEqual(
              requests[0].modelConfiguration,
              effort ? { reasoningEffort: effort } : undefined,
            );
            assert.strictEqual(JSON.stringify(selection), before);
          }
        }
      }
    } finally {
      Object.defineProperty(vscode.commands, "executeCommand", {
        configurable: true,
        value: original,
      });
    }
  });
  test("system-bearing chat routes block advertised overrides across vendors before commands", async () => {
    const originalModels = CopilotExecutor.getAvailableModelsWithSource;
    const originalCommand = vscode.commands.executeCommand;
    const calls: string[] = [];
    let vendor = "copilot";
    CopilotExecutor.getAvailableModelsWithSource = async () => ({
      source: "api",
      models: [
        {
          id: "synthetic",
          name: "Synthetic",
          vendor,
          description: "",
          configurationStatus: "available",
          configurationOptions: [
            {
              key: "reasoningEffort",
              label: "Reasoning",
              choices: [{ value: "high", label: "High" }],
            },
            {
              key: "speedMode",
              label: "Speed",
              choices: [{ value: "normal", label: "Normal" }],
            },
            {
              key: "contextSize",
              label: "Context",
              choices: [{ value: 4096, label: "4096" }],
            },
          ],
        },
      ],
    });
    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: async (command: string) => {
        calls.push(command);
      },
    });
    const executor = new CopilotExecutor();
    const internal = executor as unknown as {
      syncExperimentalModelQuality: () => Promise<void>;
    };
    internal.syncExperimentalModelQuality = async () => {
      throw new Error("Must not write shared settings");
    };
    try {
      for (vendor of [
        "copilot",
        "openai-codex",
        "synthetic-byok",
        "synthetic-local",
      ]) {
        for (const agent of [
          undefined,
          "ask",
          "agent",
          "edit",
          "@custom-agent",
          "@workspace",
          "@terminal",
          "@vscode",
        ]) {
          for (const configuration of [
            { reasoningEffort: "high" },
            { speedMode: "normal" },
            { contextSize: 4096 },
          ]) {
            const before = JSON.stringify(configuration);
            await assert.rejects(
              executor.executePrompt("synthetic", {
                agent,
                model: "synthetic",
                modelVendor: vendor,
                modelConfiguration: configuration,
                chatSession: "new",
              }),
              (error: unknown) =>
                (error as Record<string, unknown>)
                  .copilotSchedulerPromptBlocked ===
                  "modelConfigurationUnavailable" &&
                (error as Error).message ===
                  (require("../../configured-model-provider").hasSystemMessageDeclaration()
                    ? messages.dynamicConfigurationSystemMessagesUnsupported()
                    : messages.detailedOptionsRequirePreview()),
            );
            assert.strictEqual(JSON.stringify(configuration), before);
          }
        }
        await executor.executePrompt("synthetic", {
          agent: "ask",
          model: "synthetic",
          modelVendor: vendor,
          modelConfiguration: {},
          chatSession: "continue",
        });
      }
      assert.deepStrictEqual(
        calls,
        Array(4).fill("workbench.action.chat.open"),
      );
    } finally {
      CopilotExecutor.getAvailableModelsWithSource = originalModels;
      Object.defineProperty(vscode.commands, "executeCommand", {
        configurable: true,
        value: originalCommand,
      });
    }
  });
  test("configured model dispatch waits once and never drops its fixed selector after failure", async () => {
    const original = vscode.commands.executeCommand;
    const requests: Record<string, unknown>[] = [];
    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: async (_command: string, args: Record<string, unknown>) => {
        requests.push(args);
        return { errorDetails: { message: "synthetic failure" } };
      },
    });
    try {
      const executor = new CopilotExecutor() as unknown as {
        tryOpenChatWithPrompt(
          prompt: string,
          mode: string,
          selection: unknown,
          model: undefined,
          attachments: vscode.Uri[],
        ): Promise<{ opened: boolean }>;
      };
      const result = await executor.tryOpenChatWithPrompt(
        "prompt",
        "ask",
        {
          model: "binding",
          modelVendor: "copilot-scheduler-configured",
          modelConfiguration: { mode: "fast:high" },
        },
        undefined,
        [],
      );
      assert.strictEqual(result.opened, false);
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0].blockOnResponse, true);
      assert.deepStrictEqual(requests[0].modelSelector, {
        id: "binding",
        vendor: "copilot-scheduler-configured",
      });
    } finally {
      Object.defineProperty(vscode.commands, "executeCommand", {
        configurable: true,
        value: original,
      });
    }
  });
  test("dynamic overrides block before commands; inherit avoids syncing shared options", async () => {
    const originalModels = CopilotExecutor.getAvailableModelsWithSource;
    const originalCommand = vscode.commands.executeCommand;
    const calls: string[] = [];
    CopilotExecutor.getAvailableModelsWithSource = async () => ({
      source: "api",
      models: [
        {
          id: "dynamic",
          name: "Dynamic",
          vendor: "copilot",
          description: "",
          configurationStatus: "available",
          configurationOptions: [
            {
              key: "reasoningEffort",
              label: "Thinking",
              choices: [{ value: "high", label: "High" }],
            },
          ],
        },
      ],
    });
    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: async (command: string) => {
        calls.push(command);
        return undefined;
      },
    });
    const executor = new CopilotExecutor();
    const internal = executor as unknown as {
      syncExperimentalModelQuality: () => Promise<void>;
    };
    internal.syncExperimentalModelQuality = async () => {
      throw new Error("Must not sync inherited shared configuration");
    };
    try {
      await assert.rejects(
        executor.executePrompt("synthetic", {
          agent: "ask",
          model: "dynamic",
          modelVendor: "copilot",
          modelConfiguration: { reasoningEffort: "high" },
          chatSession: "continue",
        }),
        (error: unknown) =>
          (error as Record<string, unknown>).copilotSchedulerPromptBlocked ===
          "modelConfigurationUnavailable",
      );
      assert.strictEqual(calls.length, 0);
      for (const malformed of [null, { futureBudget: "x" }]) {
        await assert.rejects(
          executor.executePrompt("synthetic", {
            model: "dynamic",
            modelVendor: "copilot",
            modelConfiguration: malformed as never,
          }),
          (error: unknown) =>
            (error as Record<string, unknown>).copilotSchedulerPromptBlocked ===
            "modelConfigurationUnavailable",
        );
      }
      assert.strictEqual(calls.length, 0);
      await executor.executePrompt("synthetic", {
        agent: "ask",
        model: "dynamic",
        modelVendor: "copilot",
        modelConfiguration: {},
        chatSession: "continue",
      });
      assert.deepStrictEqual(calls, ["workbench.action.chat.open"]);
    } finally {
      CopilotExecutor.getAvailableModelsWithSource = originalModels;
      Object.defineProperty(vscode.commands, "executeCommand", {
        configurable: true,
        value: originalCommand,
      });
    }
  });
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

  test("Auto is selected by id and vendor only, because its family and version follow its routing", () => {
    assert.deepStrictEqual(
      __testOnly.buildModelSelectorCandidates({
        model: "auto",
        modelVendor: "copilot",
        modelFamily: "claude-haiku-5.5",
        modelVersion: "claude-haiku-5.5",
      }),
      [{ id: "auto", vendor: "copilot" }],
    );
    assert.deepStrictEqual(
      __testOnly.buildModelSelectorCandidates({ model: "Auto" }),
      [{ id: "Auto" }],
    );
    // Another provider's model named "auto" keeps its strict identity.
    const other = __testOnly.buildModelSelectorCandidates({
      model: "auto",
      modelVendor: "ollama",
      modelFamily: "x",
      modelVersion: "1",
    });
    assert.deepStrictEqual(other, [
      { id: "auto", vendor: "ollama", family: "x", version: "1" },
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

  suite("model fallback", () => {
    const catalog = [
      { id: "claude", name: "Claude", vendor: "copilot", description: "" },
      {
        id: "hydrafusion",
        name: "HydraFusion",
        vendor: "copilot",
        description: "",
      },
      { id: "auto", name: "Auto", vendor: "copilot", description: "" },
    ];
    type Resolver = {
      resolveRequestedModelSelection: (
        selection: { model: string; modelVendor?: string },
        allowFallback?: boolean,
      ) => Promise<{
        selection: { model?: string };
        matched?: { id: string };
        fallback?: { from: string; to: string };
      }>;
    };
    const resolver = CopilotExecutor as unknown as Resolver;
    let originalModels: typeof CopilotExecutor.getAvailableModelsWithSource;
    let source: "api" | "fallback";
    let models: typeof catalog;

    setup(() => {
      originalModels = CopilotExecutor.getAvailableModelsWithSource;
      source = "api";
      models = catalog;
      CopilotExecutor.getAvailableModelsWithSource = async () => ({
        source,
        models,
      });
    });
    teardown(() => {
      CopilotExecutor.getAvailableModelsWithSource = originalModels;
    });

    test("an unavailable model keeps the strict behavior unless the task opts in", async () => {
      const result = await resolver.resolveRequestedModelSelection({
        model: "gone",
      });
      assert.strictEqual(result.matched, undefined);
      assert.strictEqual(result.fallback, undefined);
      await assert.rejects(
        resolver.resolveRequestedModelSelection({
          model: "gone",
          modelVendor: "ollama",
        }),
        /unavailable|利用できません/,
      );
    });

    test("an opted-in task falls back to HydraFusion first", async () => {
      const result = await resolver.resolveRequestedModelSelection(
        { model: "gone" },
        true,
      );
      assert.strictEqual(result.matched?.id, "hydrafusion");
      assert.strictEqual(result.selection.model, "hydrafusion");
      assert.deepStrictEqual(result.fallback, {
        from: "gone",
        to: "HydraFusion",
      });
    });

    test("fallback continues to Auto when HydraFusion is unavailable", async () => {
      models = catalog.filter((model) => model.id !== "hydrafusion");
      const result = await resolver.resolveRequestedModelSelection(
        { model: "gone" },
        true,
      );
      assert.strictEqual(result.matched?.id, "auto");
      assert.strictEqual(result.fallback?.to, "Auto");
    });

    test("fallback also replaces an unavailable provider-pinned model", async () => {
      const result = await resolver.resolveRequestedModelSelection(
        { model: "gone", modelVendor: "ollama" },
        true,
      );
      assert.strictEqual(result.matched?.id, "hydrafusion");
    });

    test("an available model is never replaced", async () => {
      const result = await resolver.resolveRequestedModelSelection(
        { model: "claude" },
        true,
      );
      assert.strictEqual(result.matched?.id, "claude");
      assert.strictEqual(result.fallback, undefined);
    });

    test("an unreadable live catalog never triggers fallback", async () => {
      source = "fallback";
      const result = await resolver.resolveRequestedModelSelection(
        { model: "gone" },
        true,
      );
      assert.strictEqual(result.fallback, undefined);
      assert.strictEqual(result.matched, undefined);
    });

    test("no chain entry in the catalog keeps the strict failure", async () => {
      models = catalog.filter((model) => model.id === "claude");
      await assert.rejects(
        resolver.resolveRequestedModelSelection(
          { model: "gone", modelVendor: "ollama" },
          true,
        ),
        /unavailable|利用できません/,
      );
    });

    test("the configured chain order and an empty chain are honored", async () => {
      const config = vscode.workspace.getConfiguration("copilotScheduler");
      const inspected = config.inspect<string[]>("modelFallbackChain");
      try {
        await config.update(
          "modelFallbackChain",
          ["auto", "hydrafusion"],
          vscode.ConfigurationTarget.Global,
        );
        const ordered = await resolver.resolveRequestedModelSelection(
          { model: "gone" },
          true,
        );
        assert.strictEqual(ordered.matched?.id, "auto");

        await config.update(
          "modelFallbackChain",
          [],
          vscode.ConfigurationTarget.Global,
        );
        const disabled = await resolver.resolveRequestedModelSelection(
          { model: "gone" },
          true,
        );
        assert.strictEqual(disabled.fallback, undefined);
      } finally {
        await config.update(
          "modelFallbackChain",
          inspected?.globalValue,
          vscode.ConfigurationTarget.Global,
        );
      }
    });

    test("executePrompt dispatches the fallback model and reports it", async () => {
      const originalCommand = vscode.commands.executeCommand;
      const requests: Record<string, unknown>[] = [];
      Object.defineProperty(vscode.commands, "executeCommand", {
        configurable: true,
        value: async (_command: string, args: Record<string, unknown>) => {
          requests.push(args);
          return {};
        },
      });
      try {
        const result = await new CopilotExecutor().executePrompt("synthetic", {
          agent: "agent",
          model: "gone",
          modelFallback: true,
          chatSession: "continue",
        });
        assert.deepStrictEqual(result.modelFallback, {
          from: "gone",
          to: "HydraFusion",
        });
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(
          (requests[0].modelSelector as { id?: string }).id,
          "hydrafusion",
        );
      } finally {
        Object.defineProperty(vscode.commands, "executeCommand", {
          configurable: true,
          value: originalCommand,
        });
      }
    });

    test("executePrompt without opt-in reports no fallback", async () => {
      const originalCommand = vscode.commands.executeCommand;
      Object.defineProperty(vscode.commands, "executeCommand", {
        configurable: true,
        value: async () => ({}),
      });
      try {
        const result = await new CopilotExecutor().executePrompt("synthetic", {
          agent: "agent",
          model: "claude",
          chatSession: "continue",
        });
        assert.strictEqual(result.modelFallback, undefined);
      } finally {
        Object.defineProperty(vscode.commands, "executeCommand", {
          configurable: true,
          value: originalCommand,
        });
      }
    });
  });

  suite("session harness", () => {
    let originalCommand: typeof vscode.commands.executeCommand;
    let originalWarning: typeof vscode.window.showWarningMessage;
    let originalModels: typeof CopilotExecutor.getAvailableModelsWithSource;
    let commands: string[];
    let failLocal: boolean;
    let previousSetting: string | undefined;

    const setHarness = async (value: string | undefined) => {
      await vscode.workspace
        .getConfiguration("copilotScheduler")
        .update("sessionHarness", value, vscode.ConfigurationTarget.Global);
    };

    setup(async () => {
      commands = [];
      failLocal = false;
      originalCommand = vscode.commands.executeCommand;
      originalWarning = vscode.window.showWarningMessage;
      originalModels = CopilotExecutor.getAvailableModelsWithSource;
      previousSetting = vscode.workspace
        .getConfiguration("copilotScheduler")
        .inspect<string>("sessionHarness")?.globalValue;
      CopilotExecutor.getAvailableModelsWithSource = async () => ({
        source: "api",
        models: [],
      });
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: async () => undefined,
      });
      Object.defineProperty(vscode.commands, "executeCommand", {
        configurable: true,
        value: async (command: string) => {
          commands.push(command);
          if (failLocal && command === "workbench.action.chat.newLocalChat") {
            throw new Error("command not found");
          }
          return {};
        },
      });
    });

    teardown(async () => {
      Object.defineProperty(vscode.commands, "executeCommand", {
        configurable: true,
        value: originalCommand,
      });
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: originalWarning,
      });
      CopilotExecutor.getAvailableModelsWithSource = originalModels;
      await setHarness(previousSetting);
    });

    test("only the exact value local enables the Local session", () => {
      const configFor = (value: unknown) =>
        ({ get: () => value }) as unknown as vscode.WorkspaceConfiguration;
      assert.strictEqual(
        __testOnly.resolveSessionHarness(configFor("local")),
        "local",
      );
      for (const value of ["auto", "", "Local", "copilot", undefined, 1]) {
        assert.strictEqual(
          __testOnly.resolveSessionHarness(configFor(value)),
          "auto",
        );
      }
    });

    test("auto keeps the default new chat command", async () => {
      await setHarness("auto");
      await new CopilotExecutor().executePrompt("synthetic", {
        agent: "agent",
        chatSession: "new",
      });
      assert.ok(commands.includes("workbench.action.chat.newChat"));
      assert.ok(!commands.includes("workbench.action.chat.newLocalChat"));
      assert.ok(commands.includes("workbench.action.chat.open"));
    });

    test("local starts a Local session before sending", async () => {
      await setHarness("local");
      await new CopilotExecutor().executePrompt("synthetic", {
        agent: "agent",
        chatSession: "new",
      });
      const local = commands.indexOf("workbench.action.chat.newLocalChat");
      const open = commands.indexOf("workbench.action.chat.open");
      assert.ok(local >= 0 && open > local, commands.join(","));
      assert.ok(!commands.includes("workbench.action.chat.newChat"));
    });

    test("local never sends when the Local session cannot be started", async () => {
      await setHarness("local");
      failLocal = true;
      await assert.rejects(
        new CopilotExecutor().executePrompt("synthetic", {
          agent: "agent",
          chatSession: "new",
        }),
        (error: unknown) =>
          (error as Record<string, unknown>).copilotSchedulerPromptBlocked ===
          "sessionHarnessUnavailable",
      );
      assert.ok(!commands.includes("workbench.action.chat.open"));
      assert.ok(!commands.includes("workbench.action.chat.newChat"));
    });

    test("local does not touch the session when continuing", async () => {
      await setHarness("local");
      await new CopilotExecutor().executePrompt("synthetic", {
        agent: "agent",
        chatSession: "continue",
      });
      assert.ok(!commands.includes("workbench.action.chat.newLocalChat"));
      assert.ok(!commands.includes("workbench.action.chat.newChat"));
      assert.ok(commands.includes("workbench.action.chat.open"));
    });
  });

  test("Codex Bridge quality sync failures block dispatch instead of ignoring the effort", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "scheduler-bridge-block-"),
    );
    const executorClass = CopilotExecutor as unknown as {
      extensionGlobalStorageUri?: vscode.Uri;
    };
    const previous = executorClass.extensionGlobalStorageUri;
    executorClass.extensionGlobalStorageUri = vscode.Uri.file(
      path.join(root, "globalStorage", "scheduler"),
    );
    const executor = new CopilotExecutor() as unknown as {
      syncExperimentalModelQuality: (
        selection: {
          model: string;
          modelVendor: string;
          modelFamily: string;
          modelReasoningEffort: string;
        },
        matched: undefined,
      ) => Promise<void>;
    };
    try {
      await assert.rejects(
        executor.syncExperimentalModelQuality(
          {
            model: "default::gpt-6-luna",
            modelVendor: "openai-codex",
            modelFamily: "gpt-6-luna",
            modelReasoningEffort: "high",
          },
          undefined,
        ),
        (error: unknown) =>
          (error as Record<string, unknown>).copilotSchedulerPromptBlocked ===
          "providerModelDispatchFailed",
      );
    } finally {
      executorClass.extensionGlobalStorageUri = previous;
      fs.rmSync(root, { recursive: true, force: true });
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

  test("legacy argument formatting can omit modelConfiguration without changing the selector", () => {
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
