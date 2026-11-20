import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CopilotExecutor, __testOnly } from "../../copilotExecutor";
import * as agentHostClient from "../../agentHostClient";
import * as copilotCliRunner from "../../copilotCliRunner";
import { withAgentHostDispatchJournal } from "../../agentHostDispatchJournal";
import { messages } from "../../i18n";
import * as configuredModels from "../../configured-model-provider";
import { createPromptBlockedError, getPromptBlockedReason } from "../../promptExecutionErrors";
import type { ExecuteOptions } from "../../types";

function useAgentHostTestStorage(): () => void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-host-test-"));
  const previous = Object.getOwnPropertyDescriptor(CopilotExecutor, "extensionGlobalStorageUri")!;
  Object.defineProperty(CopilotExecutor, "extensionGlobalStorageUri", {
    configurable: true, value: vscode.Uri.file(directory),
  });
  return () => {
    Object.defineProperty(CopilotExecutor, "extensionGlobalStorageUri", previous);
    fs.rmSync(directory, { recursive: true, force: true });
  };
}

suite("CopilotExecutor Agent Prefix Tests", () => {
  test("dispatch storage follows the global storage path whatever scheme VS Code reports", () => {
    const previous = Object.getOwnPropertyDescriptor(CopilotExecutor, "extensionGlobalStorageUri")!;
    const directory = path.join(os.tmpdir(), "scheduler-userdata-scheme");
    const storage = (): string => Reflect.get(CopilotExecutor, "agentHostDispatchStorage").call(CopilotExecutor);
    try {
      Object.defineProperty(CopilotExecutor, "extensionGlobalStorageUri", {
        configurable: true,
        value: vscode.Uri.file(directory).with({ scheme: "vscode-userdata" }),
      });
      assert.strictEqual(storage().toLowerCase(), directory.toLowerCase());

      Object.defineProperty(CopilotExecutor, "extensionGlobalStorageUri", {
        configurable: true, value: undefined,
      });
      assert.throws(
        storage,
        (error: unknown) =>
          error instanceof agentHostClient.AgentHostError && error.turnOutcome === "failed",
      );
    } finally {
      Object.defineProperty(CopilotExecutor, "extensionGlobalStorageUri", previous);
    }
  });

  test("workspace preferences reject invalid input and non-Host routes but preserve an explicit CLI model", async () => {
    const getConfig = vscode.workspace.getConfiguration;
    const warning = vscode.window.showWarningMessage;
    let local = false;
    let cliCalls = 0;
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      configurable: true,
      value: ((section?: string) => {
        const config = getConfig.call(vscode.workspace, section);
        if (section !== "copilotScheduler") return config;
        return {
          ...config,
          get<T>(key: string, defaultValue?: T): T {
            if (key === "executionRoute") return (local ? "agentHost" : "chat") as T;
            if (key === "sessionHarness") return (local ? "local" : "auto") as T;
            return config.get<T>(key, defaultValue as T);
          },
        } as vscode.WorkspaceConfiguration;
      }) as typeof vscode.workspace.getConfiguration,
    });
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: async () => undefined,
    });
    try {
      const executor = new CopilotExecutor();
      const internals = executor as unknown as {
        tryExecuteViaAgentHost(): Promise<never>;
        tryOpenChatWithPrompt(): Promise<never>;
        executePromptViaCopilotCli(): Promise<undefined>;
      };
      internals.tryExecuteViaAgentHost = async () => assert.fail("Host must not run");
      internals.tryOpenChatWithPrompt = async () => assert.fail("chat must not run");
      internals.executePromptViaCopilotCli = async () => { cliCalls++; return undefined; };
      for (const mode of ["FOLDER", "", null, 7]) {
        await assert.rejects(
          executor.executePrompt("synthetic", {
            agentHostWorkspaceMode: mode as never,
            useCopilotCli: true,
            model: "selected",
          }),
          (error: unknown) => getPromptBlockedReason(error) === "agentHostUnavailable",
        );
      }
      for (const route of ["chat", "local"]) {
        local = route === "local";
        for (const useCopilotCli of [false, true]) {
          await assert.rejects(
            executor.executePrompt("synthetic", {
              agentHostWorkspaceMode: "folder",
              useCopilotCli,
              model: "  ",
              chatSession: "continue",
            }),
            (error: unknown) => getPromptBlockedReason(error) === "agentHostUnavailable",
          );
        }
      }
      assert.strictEqual(cliCalls, 0, "an empty CLI model must not bypass the Host requirement");
      await executor.executePrompt("synthetic", {
        agentHostWorkspaceMode: "worktree",
        useCopilotCli: true,
        model: "selected",
      });
      assert.strictEqual(cliCalls, 1, "an actual CLI run keeps its existing route");
    } finally {
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: getConfig,
      });
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: warning,
      });
    }
  });

  test("explicit workspace preferences never fall back when the Host, folder or capability is unavailable", async () => {
    const releaseStorage = useAgentHostTestStorage();
    const getConfig = vscode.workspace.getConfiguration;
    const workspaceFolders = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders")!;
    const warning = vscode.window.showWarningMessage;
    const findEndpoint = Object.getOwnPropertyDescriptor(agentHostClient, "findAgentHostEndpoint")!;
    const runTurn = Object.getOwnPropertyDescriptor(agentHostClient, "runAgentHostTurn")!;
    const userDataDir = Object.getOwnPropertyDescriptor(CopilotExecutor, "agentHostUserDataDir")!;
    let hostAvailable = false;
    let hostCalls = 0;
    let failureKind: "unsupported" | "workspaceMode" = "unsupported";
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      configurable: true,
      value: ((section?: string) => {
        const config = getConfig.call(vscode.workspace, section);
        if (section !== "copilotScheduler") return config;
        return {
          ...config,
          get<T>(key: string, defaultValue?: T): T {
            if (key === "executionRoute") return "agentHost" as T;
            if (key === "sessionHarness") return "auto" as T;
            if (key === "executionFallback") return "chat" as T;
            return config.get<T>(key, defaultValue as T);
          },
        } as vscode.WorkspaceConfiguration;
      }) as typeof vscode.workspace.getConfiguration,
    });
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: async () => undefined,
    });
    Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", {
      configurable: true,
      value: "test",
    });
    Object.defineProperty(agentHostClient, "findAgentHostEndpoint", {
      configurable: true,
      value: () => hostAvailable
        ? { socketPath: "test", token: "test", protocolVersion: "1.1.0" }
        : undefined,
    });
    Object.defineProperty(agentHostClient, "runAgentHostTurn", {
      configurable: true,
      value: async () => {
        hostCalls++;
        throw new agentHostClient.AgentHostError(failureKind, "workspace configuration unavailable");
      },
    });
    try {
      const executor = new CopilotExecutor();
      const internals = executor as unknown as {
        tryOpenChatWithPrompt(): Promise<never>;
        executePromptViaCopilotCli(): Promise<never>;
      };
      internals.tryOpenChatWithPrompt = async () => assert.fail("chat fallback must not run");
      internals.executePromptViaCopilotCli = async () => assert.fail("CLI fallback must not run");
      for (const agentHostWorkspaceMode of ["folder", "worktree"] as const) {
        const options: ExecuteOptions = {
          agentHostWorkspaceMode,
          chatSession: "continue",
          workingDirectory: __dirname,
          useCopilotCli: true,
          model: "",
        };
        hostAvailable = false;
        const before = hostCalls;
        await assert.rejects(
          executor.executePrompt("synthetic", options),
          (error: unknown) => getPromptBlockedReason(error) === "agentHostUnavailable",
        );
        hostAvailable = true;
        await assert.rejects(
          executor.executePrompt("synthetic", { ...options, workingDirectory: __filename }),
          (error: unknown) => getPromptBlockedReason(error) === "agentHostUnavailable",
        );
        assert.strictEqual(hostCalls, before, "invalid prerequisites must stop before the Host turn");
        for (const kind of ["unsupported", "workspaceMode"] as const) {
          failureKind = kind;
          await assert.rejects(
            executor.executePrompt("synthetic", options),
            (error: unknown) => getPromptBlockedReason(error) === "agentHostUnavailable",
          );
        }
        assert.strictEqual(hostCalls, before + 2);
      }
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        configurable: true,
        value: [
          { uri: vscode.Uri.file(__dirname), name: "first", index: 0 },
          { uri: vscode.Uri.joinPath(vscode.Uri.file(__dirname), ".."), name: "second", index: 1 },
        ],
      });
      const beforeAmbiguousRun = hostCalls;
      await assert.rejects(
        executor.executePrompt("synthetic", {
          agentHostWorkspaceMode: "folder",
          chatSession: "new",
        }),
        (error: unknown) => {
          assert.strictEqual(getPromptBlockedReason(error), "agentHostUnavailable");
          const text = (error as Error).message;
          // The reason must say the prompt was not sent and what to change.
          assert.ok(text.includes(messages.agentHostWorkspaceUnavailable("").trim()), text);
          assert.ok(text.includes(agentHostClient.WORKSPACE_FOLDER_REQUIRED_DETAIL), text);
          return true;
        },
      );
      assert.strictEqual(hostCalls, beforeAmbiguousRun, "multiple local roots must not select the first folder");
    } finally {
      Object.defineProperty(vscode.workspace, "workspaceFolders", workspaceFolders);
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: getConfig,
      });
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: warning,
      });
      Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", userDataDir);
      Object.defineProperty(agentHostClient, "findAgentHostEndpoint", findEndpoint);
      Object.defineProperty(agentHostClient, "runAgentHostTurn", runTurn);
      releaseStorage();
    }
  });

  test("forwards workspace metadata and reuses the cached session across creation preferences", async () => {
    const releaseStorage = useAgentHostTestStorage();
    const findEndpoint = Object.getOwnPropertyDescriptor(agentHostClient, "findAgentHostEndpoint")!;
    const runTurn = Object.getOwnPropertyDescriptor(agentHostClient, "runAgentHostTurn")!;
    const queueMessage = Object.getOwnPropertyDescriptor(agentHostClient, "queueAgentHostMessage")!;
    const userDataDir = Object.getOwnPropertyDescriptor(CopilotExecutor, "agentHostUserDataDir")!;
    const workspaceFolders = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders")!;
    const sessions: Map<string, unknown> = Reflect.get(CopilotExecutor, "agentHostSessions");
    const previousSessions = new Map(sessions);
    const requests: agentHostClient.AgentHostTurnRequest[] = [];
    const queuedRequests: agentHostClient.AgentHostQueuedMessageRequest[] = [];
    Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", {
      configurable: true,
      value: "test",
    });
    Object.defineProperty(agentHostClient, "findAgentHostEndpoint", {
      configurable: true,
      value: () => ({ socketPath: "test", token: "test", protocolVersion: "1.1.0" }),
    });
    Object.defineProperty(agentHostClient, "runAgentHostTurn", {
      configurable: true,
      value: async (request: agentHostClient.AgentHostTurnRequest) => {
        requests.push(request);
        request.onSessionStarted?.(
          { sessionUri: "test-session", chatUri: "test-chat" },
          "test-turn",
          "2026-01-01T00:00:00.001Z",
        );
        return {
          sessionUri: "test-session",
          chatUri: "test-chat",
          responseText: "observed",
          workspaceMode: request.workspaceMode,
          workspaceModeApplication: request.resume
            ? "not_applied_resumed"
            : "new_session_config_confirmed",
        };
      },
    });
    Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
      configurable: true,
      value: async (request: agentHostClient.AgentHostQueuedMessageRequest) => {
        queuedRequests.push(request);
        return { sessionUri: "test-session", chatUri: "test-chat", messageId: "test-message" };
      },
    });
    try {
      sessions.clear();
      const executor = new CopilotExecutor() as unknown as {
        tryExecuteViaAgentHost(
          routing: ReturnType<typeof __testOnly.buildPromptRouting>,
          options: ExecuteOptions,
          config: vscode.WorkspaceConfiguration,
          chatSession: "new" | "continue",
        ): Promise<{ result?: { agentHostRun?: Record<string, unknown> } }>;
      };
      const config = {
        get: (key: string, defaultValue: unknown) =>
          key === "agentHostOpenSession" ? false : defaultValue,
        inspect: (key: string) => ({ key }),
      } as unknown as vscode.WorkspaceConfiguration;
      const routing = __testOnly.buildPromptRouting("synthetic", undefined, undefined);
      for (const mode of ["worktree", "folder"] as const) {
        const result = await executor.tryExecuteViaAgentHost(
          routing,
          { agentHostWorkspaceMode: mode, workingDirectory: __dirname },
          config,
          mode === "worktree" ? "new" : "continue",
        );
        assert.deepStrictEqual(
          result.result?.agentHostRun,
          mode === "worktree"
            ? {
                turnOutcome: "completed",
                responseText: "observed",
                workspaceMode: mode,
                workspaceModeApplication: "new_session_config_confirmed",
              }
            : {
                turnOutcome: "queued",
                messageId: "test-message",
                workspaceMode: mode,
                workspaceModeApplication: "not_applied_resumed",
              },
        );
      }
      assert.strictEqual(requests[0].workspaceMode, "worktree");
      assert.strictEqual(requests[0].resume, undefined);
      assert.deepStrictEqual(queuedRequests[0].resume, {
        sessionUri: "test-session",
        chatUri: "test-chat",
      });
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        configurable: true,
        value: [
          { uri: vscode.Uri.file(__dirname), name: "first", index: 0 },
          { uri: vscode.Uri.joinPath(vscode.Uri.file(__dirname), ".."), name: "second", index: 1 },
        ],
      });
      const ambiguous = await executor.tryExecuteViaAgentHost(
        routing,
        { agentHostWorkspaceMode: "folder" },
        config,
        "continue",
      );
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(queuedRequests.length, 2);
      assert.deepStrictEqual(queuedRequests[1].resume, queuedRequests[0].resume);
      assert.strictEqual(
        ambiguous.result?.agentHostRun?.workspaceModeApplication,
        "not_applied_resumed",
      );
      assert.strictEqual(sessions.size, 1, "workspace mode is not a cache partition");
    } finally {
      Object.defineProperty(vscode.workspace, "workspaceFolders", workspaceFolders);
      Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", userDataDir);
      Object.defineProperty(agentHostClient, "findAgentHostEndpoint", findEndpoint);
      Object.defineProperty(agentHostClient, "runAgentHostTurn", runTurn);
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", queueMessage);
      sessions.clear();
      for (const [key, value] of previousSessions) sessions.set(key, value);
      releaseStorage();
    }
  });

  suite("Agent Host session ordering", () => {
    type InternalExecutor = {
      tryExecuteViaAgentHost(
        routing: ReturnType<typeof __testOnly.buildPromptRouting>,
        options: ExecuteOptions,
        config: vscode.WorkspaceConfiguration,
        chatSession: "new" | "continue",
      ): Promise<{ result?: { agentHostRun?: Record<string, unknown> } }>;
    };
    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      return { promise, resolve, reject };
    }
    const ref = (id: string) => ({
      sessionUri: `ahp-session:/${id}`,
      chatUri: `ahp-chat:/${id}`,
    });
    const result = (id: string): agentHostClient.AgentHostTurnResult => ({
      ...ref(id),
      responseText: "not_observed",
    });
    const config = {
      get: (key: string, defaultValue: unknown) =>
        key === "agentHostOpenSession" ? false : defaultValue,
      inspect: (key: string) => ({ key }),
    } as unknown as vscode.WorkspaceConfiguration;
    const routing = __testOnly.buildPromptRouting("synthetic", undefined, undefined);
    const options: ExecuteOptions = { workingDirectory: __dirname };
    const endpoint = { socketPath: "test", token: "test", protocolVersion: "1.1.0" };
    let executor: InternalExecutor;
    let descriptors: Array<[object, string, PropertyDescriptor]>;
    let maps: Array<[Map<string, unknown>, Map<string, unknown>]>;
    let storageDirectory: string;
    let activeDispatches: Set<string>;
    let savedActiveDispatches: Set<string>;

    setup(() => {
      storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-host-safety-"));
      activeDispatches = Reflect.get(CopilotExecutor, "agentHostActiveDispatches");
      savedActiveDispatches = new Set(activeDispatches);
      activeDispatches.clear();
      const keys = ["agentHostSessions", "agentHostQueues", "agentHostUncertainChats"];
      maps = keys.map((key) => {
        const map: Map<string, unknown> = Reflect.get(CopilotExecutor, key);
        const saved = new Map(map);
        map.clear();
        return [map, saved];
      });
      const properties: Array<[object, string]> = [
        [CopilotExecutor, "agentHostUserDataDir"],
        [CopilotExecutor, "extensionGlobalStorageUri"],
        [CopilotExecutor, "agentHostDispatchOwner"],
        [agentHostClient, "findAgentHostEndpoint"],
        [agentHostClient, "runAgentHostTurn"],
        [agentHostClient, "queueAgentHostMessage"],
        [agentHostClient, "isAgentHostTurnTerminal"],
        [vscode.window, "showWarningMessage"],
        [vscode.workspace, "getConfiguration"],
      ];
      descriptors = properties.map(([owner, key]) => [
        owner,
        key,
        Object.getOwnPropertyDescriptor(owner, key)!,
      ]);
      Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", {
        configurable: true, value: "test",
      });
      Object.defineProperty(CopilotExecutor, "extensionGlobalStorageUri", {
        configurable: true, value: vscode.Uri.file(storageDirectory),
      });
      Object.defineProperty(agentHostClient, "findAgentHostEndpoint", {
        configurable: true, value: () => endpoint,
      });
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true, value: async () => undefined,
      });
      executor = new CopilotExecutor() as unknown as InternalExecutor;
    });

    teardown(() => {
      for (const [owner, key, descriptor] of descriptors) {
        Object.defineProperty(owner, key, descriptor);
      }
      for (const [map, saved] of maps) {
        map.clear();
        for (const [key, value] of saved) map.set(key, value);
      }
      activeDispatches.clear();
      for (const id of savedActiveDispatches) activeDispatches.add(id);
      fs.rmSync(storageDirectory, { recursive: true, force: true });
    });

    test("starts independent sessions in parallel and keeps the latest start after inverted completion", async () => {
      const runs: Array<{
        request: agentHostClient.AgentHostTurnRequest;
        completion: ReturnType<typeof deferred<agentHostClient.AgentHostTurnResult>>;
      }> = [];
      const queued: agentHostClient.AgentHostQueuedMessageRequest[] = [];
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: (request: agentHostClient.AgentHostTurnRequest) => {
          const completion = deferred<agentHostClient.AgentHostTurnResult>();
          runs.push({ request, completion });
          return completion.promise;
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostQueuedMessageRequest) => {
          queued.push(request);
          return { ...ref("newer"), messageId: "queued" };
        },
      });

      const first = executor.tryExecuteViaAgentHost(routing, options, config, "new");
      const second = executor.tryExecuteViaAgentHost(routing, options, config, "new");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(runs.length, 2, "one session must not wait for the other");
      runs[1].request.onSessionStarted?.(ref("newer"), "turn-newer", "2026-01-01T10:00:02.000Z");
      runs[0].request.onSessionStarted?.(ref("older"), "turn-older", "2026-01-01T10:00:01.000Z");
      runs[1].completion.resolve(result("newer"));
      await second;
      runs[0].completion.resolve(result("older"));
      await first;
      const continued = await executor.tryExecuteViaAgentHost(routing, options, config, "continue");
      assert.deepStrictEqual(queued[0].resume, ref("newer"));
      assert.strictEqual(continued.result?.agentHostRun?.turnOutcome, "queued");
    });

    test("fails closed for tied start timestamps until a later start resolves the ordering", async () => {
      let runs = 0;
      const queued: agentHostClient.AgentHostQueuedMessageRequest[] = [];
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          const id = `session-${++runs}`;
          const startedAt = runs < 3 ? "2026-01-01T10:00:01.000Z" : "2026-01-01T10:00:02.000Z";
          request.onSessionStarted?.(ref(id), `turn-${id}`, startedAt);
          return result(id);
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostQueuedMessageRequest) => {
          queued.push(request);
          return { ...ref("session-3"), messageId: "queued" };
        },
      });

      await executor.tryExecuteViaAgentHost(routing, options, config, "new");
      await executor.tryExecuteViaAgentHost(routing, options, config, "new");
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "continue"));
      assert.strictEqual(queued.length, 0);
      await executor.tryExecuteViaAgentHost(routing, options, config, "new");
      await executor.tryExecuteViaAgentHost(routing, options, config, "continue");
      assert.deepStrictEqual(queued[0].resume, ref("session-3"));
    });

    test("serializes the same chat and keeps a continue target selected before waiting", async () => {
      let next = 0;
      const gate = deferred<agentHostClient.AgentHostQueuedMessageResult>();
      const firstQueued = deferred<void>();
      const queued: agentHostClient.AgentHostQueuedMessageRequest[] = [];
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          const id = ++next === 1 ? "first" : "later";
          request.onSessionStarted?.(ref(id), `turn-${id}`, `2026-01-01T10:00:0${next}.000Z`);
          return result(id);
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: (request: agentHostClient.AgentHostQueuedMessageRequest) => {
          queued.push(request);
          if (queued.length === 1) firstQueued.resolve();
          return queued.length === 1
            ? gate.promise
            : Promise.resolve({ ...ref("first"), messageId: "second" });
        },
      });

      await executor.tryExecuteViaAgentHost(routing, options, config, "new");
      const first = executor.tryExecuteViaAgentHost(routing, { ...options, taskId: "first" }, config, "continue");
      await firstQueued.promise;
      const second = executor.tryExecuteViaAgentHost(
        routing,
        { ...options, taskId: "second", queueOccurrenceId: "occurrence" },
        config,
        "continue",
      );
      const third = executor.tryExecuteViaAgentHost(
        routing,
        { ...options, taskId: "third", targetChatId: agentHostClient.toAgentHostChatBindingId(ref("first").chatUri) },
        config,
        "new",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(queued.length, 1, "same-chat queue submissions must not overlap");
      await executor.tryExecuteViaAgentHost(routing, options, config, "new");
      gate.resolve({ ...ref("first"), messageId: "first" });
      assert.strictEqual((await first).result?.agentHostRun?.turnOutcome, "queued");
      assert.strictEqual((await second).result?.agentHostRun?.turnOutcome, "queued");
      assert.strictEqual((await third).result?.agentHostRun?.turnOutcome, "queued");
      assert.deepStrictEqual(queued.map((request) => request.resume), [ref("first"), ref("first"), undefined]);
      assert.deepStrictEqual(queued.map((request) => request.taskId), ["first", "second", "third"]);
      assert.strictEqual(queued[1].occurrenceId, "occurrence");
      assert.strictEqual(queued[0].occurrenceId, undefined);
    });

    test("replaces a confirmed expired continue session but never an explicitly bound chat", async () => {
      let runs = 0;
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          const id = ++runs === 1 ? "expired" : "replacement";
          request.onSessionStarted?.(ref(id), `turn-${id}`, `2026-01-01T10:00:0${runs}.000Z`);
          return result(id);
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async () => {
          throw new agentHostClient.AgentHostError("sessionExpired", "expired");
        },
      });

      await executor.tryExecuteViaAgentHost(routing, options, config, "new");
      const replacement = await executor.tryExecuteViaAgentHost(routing, options, config, "continue");
      assert.strictEqual(replacement.result?.agentHostRun?.turnOutcome, "completed");
      assert.strictEqual(runs, 2);
      await assert.rejects(executor.tryExecuteViaAgentHost(
        routing,
        { ...options, targetChatId: agentHostClient.toAgentHostChatBindingId(ref("bound").chatUri) },
        config,
        "new",
      ));
      assert.strictEqual(runs, 2);
    });

    test("never replaces a continued session when an expired error follows dispatch", async () => {
      const chat = ref("expired-after-send");
      let runs = 0;
      let sends = 0;
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          runs++;
          request.onSessionStarted?.(chat, "turn", "2026-01-01T10:00:01.000Z");
          return result("expired-after-send");
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostQueuedMessageRequest) => {
          await request.beforeDispatch?.(chat, "queued-message");
          await request.dispatchGuard?.(() => {
            sends++;
            request.onMessageDispatched?.(chat);
          });
          throw new agentHostClient.AgentHostError("sessionExpired", "expired");
        },
      });
      await executor.tryExecuteViaAgentHost(routing, options, config, "new");
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "continue"));
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "continue"));
      assert.strictEqual(runs, 1);
      assert.strictEqual(sends, 1);
    });

    test("blocks a whitespace binding while preserving the empty unbound sentinel", async () => {
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true, value: async () => assert.fail("must not create a session"),
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true, value: async () => assert.fail("must not queue without a target"),
      });
      await assert.rejects(executor.tryExecuteViaAgentHost(
        routing, { ...options, targetChatId: "  " }, config, "new",
      ));
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: () => ({ get: (key: string, defaultValue: unknown) =>
          key === "executionRoute" ? "chat" : defaultValue }),
      });
      for (const useCopilotCli of [false, true]) {
        await assert.rejects(
          (executor as unknown as CopilotExecutor).executePrompt("synthetic", {
            targetChatId: "  ", useCopilotCli, model: "selected",
          }),
        );
      }
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true, value: async () => result("unbound"),
      });
      const unbound = await executor.tryExecuteViaAgentHost(
        routing, { ...options, targetChatId: "" }, config, "new",
      );
      assert.strictEqual(unbound.result?.agentHostRun?.turnOutcome, "completed");
      let cliCalls = 0;
      Object.defineProperty(executor, "executePromptViaCopilotCli", {
        configurable: true,
        value: async () => { cliCalls++; return {}; },
      });
      await (executor as unknown as CopilotExecutor).executePrompt("synthetic", {
        targetChatId: "", useCopilotCli: true, model: "selected",
      });
      assert.strictEqual(cliCalls, 1);
    });

    test("blocks an unknown earlier turn until the same Host confirms its exact terminal state", async () => {
      let activeEndpoint = endpoint;
      let terminal = false;
      let reconciliations = 0;
      let dispatches = 0;
      Object.defineProperty(agentHostClient, "findAgentHostEndpoint", {
        configurable: true, value: () => activeEndpoint,
      });
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          request.onSessionStarted?.(ref("unknown"), "turn-unknown", "2026-01-01T10:00:01.000Z");
          throw new agentHostClient.AgentHostError("failed", "unknown", "unknown");
        },
      });
      Object.defineProperty(agentHostClient, "isAgentHostTurnTerminal", {
        configurable: true,
        value: async (_endpoint: agentHostClient.AgentHostEndpoint, seenRef: agentHostClient.AgentHostSessionRef, turnId: string) => {
          reconciliations++;
          assert.deepStrictEqual(seenRef, ref("unknown"));
          assert.strictEqual(turnId, "turn-unknown");
          return terminal;
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async () => {
          dispatches++;
          return { ...ref("unknown"), messageId: "queued" };
        },
      });

      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "new"));
      activeEndpoint = { ...endpoint, token: "different-host" };
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "continue"));
      assert.strictEqual(reconciliations, 0);
      activeEndpoint = endpoint;
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "continue"));
      assert.strictEqual(reconciliations, 1);
      assert.strictEqual(dispatches, 0);
      terminal = true;
      const continued = await executor.tryExecuteViaAgentHost(routing, options, config, "continue");
      assert.strictEqual(continued.result?.agentHostRun?.turnOutcome, "queued");
      assert.strictEqual(dispatches, 1);
    });

    test("does not resend an unknown queued message without an identified turn", async () => {
      let dispatches = 0;
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          request.onSessionStarted?.(ref("unknown-queue"), "turn", "2026-01-01T10:00:01.000Z");
          return result("unknown-queue");
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostQueuedMessageRequest) => {
          dispatches++;
          request.onMessageDispatched?.(ref("unknown-queue"));
          throw new agentHostClient.AgentHostError("failed", "unknown", "unknown");
        },
      });
      Object.defineProperty(agentHostClient, "isAgentHostTurnTerminal", {
        configurable: true,
        value: async () => assert.fail("an unidentified turn cannot be reconciled"),
      });

      await executor.tryExecuteViaAgentHost(routing, options, config, "new");
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "continue"));
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "continue"));
      assert.strictEqual(dispatches, 1);
    });

    test("blocks an explicitly targeted chat when a new message became unknown before start", async () => {
      let dispatches = 0;
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          request.onMessageDispatched?.(ref("not-started"));
          throw new agentHostClient.AgentHostError("failed", "unknown", "unknown");
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async () => {
          dispatches++;
          return { ...ref("not-started"), messageId: "queued" };
        },
      });
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "new"));
      await assert.rejects(executor.tryExecuteViaAgentHost(
        routing,
        { ...options, targetChatId: agentHostClient.toAgentHostChatBindingId(ref("not-started").chatUri) },
        config,
        "new",
      ));
      assert.strictEqual(dispatches, 0);
    });

    test("persists an unknown turn and requires the same Host to confirm it after restart", async () => {
      const chat = ref("durable");
      const chatId = agentHostClient.toAgentHostChatBindingId(chat.chatUri);
      let activeEndpoint = endpoint;
      let terminal = false;
      let checks = 0;
      let sends = 0;
      Object.defineProperty(agentHostClient, "findAgentHostEndpoint", {
        configurable: true, value: () => activeEndpoint,
      });
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          await request.beforeDispatch?.(chat, "message-durable");
          await withAgentHostDispatchJournal(storageDirectory, chatId, async (journal) => {
            assert.strictEqual(journal.records.length, 1, "intent must be saved before dispatch");
            assert.strictEqual(journal.records[0].turnId, undefined);
          });
          request.onMessageDispatched?.(chat);
          request.onSessionStarted?.(chat, "turn-durable", "2026-01-01T10:00:01.000Z");
          throw new agentHostClient.AgentHostError("failed", "unknown", "unknown");
        },
      });
      Object.defineProperty(agentHostClient, "isAgentHostTurnTerminal", {
        configurable: true,
        value: async (_endpoint: agentHostClient.AgentHostEndpoint, seen: agentHostClient.AgentHostSessionRef, turnId: string) => {
          checks++;
          assert.deepStrictEqual(seen, chat);
          assert.strictEqual(turnId, "turn-durable");
          return terminal;
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostQueuedMessageRequest) => {
          await request.beforeDispatch?.(chat, "next-message");
          await request.dispatchGuard?.(() => {
            sends++;
            request.onMessageDispatched?.(chat);
          });
          return { ...chat, messageId: "next-message" };
        },
      });

      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "new"));
      await withAgentHostDispatchJournal(storageDirectory, chatId, async (journal) => {
        assert.strictEqual(journal.records[0]?.turnId, "turn-durable");
      });
      Reflect.get(CopilotExecutor, "agentHostUncertainChats").clear();
      Object.defineProperty(CopilotExecutor, "agentHostDispatchOwner", {
        configurable: true, value: "restarted-window",
      });
      const targeted = { ...options, targetChatId: chatId };
      activeEndpoint = { ...endpoint, token: "other-host" };
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, targeted, config, "new"));
      assert.strictEqual(checks, 0, "a different Host cannot confirm the old turn");
      activeEndpoint = endpoint;
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, targeted, config, "new"));
      assert.strictEqual(checks, 1);
      assert.strictEqual(sends, 0);
      terminal = true;
      await executor.tryExecuteViaAgentHost(routing, targeted, config, "new");
      assert.strictEqual(sends, 1);
      await withAgentHostDispatchJournal(storageDirectory, chatId, async (journal) => {
        assert.deepStrictEqual(journal.records, []);
      });
    });

    test("keeps an unidentified queued dispatch blocked across restart", async () => {
      const chat = ref("unknown-queued");
      const chatId = agentHostClient.toAgentHostChatBindingId(chat.chatUri);
      let sends = 0;
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostQueuedMessageRequest) => {
          await request.beforeDispatch?.(chat, "message-queued");
          await request.dispatchGuard?.(() => {
            sends++;
            request.onMessageDispatched?.(chat);
          });
          throw new agentHostClient.AgentHostError("failed", "unknown", "unknown");
        },
      });
      Object.defineProperty(agentHostClient, "isAgentHostTurnTerminal", {
        configurable: true, value: async () => assert.fail("no turn identity was confirmed"),
      });
      const targeted = { ...options, targetChatId: chatId };
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, targeted, config, "new"));
      Reflect.get(CopilotExecutor, "agentHostUncertainChats").clear();
      Object.defineProperty(CopilotExecutor, "agentHostDispatchOwner", {
        configurable: true, value: "restarted-window",
      });
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, targeted, config, "new"));
      assert.strictEqual(sends, 1);
      await withAgentHostDispatchJournal(storageDirectory, chatId, async (journal) => {
        assert.strictEqual(journal.records.length, 1);
        assert.strictEqual(journal.records[0].turnId, undefined);
      });
    });

    test("allows same-window queueing but blocks another window until the turn ends", async () => {
      const chat = ref("active");
      const chatId = agentHostClient.toAgentHostChatBindingId(chat.chatUri);
      const started = deferred<void>();
      const completion = deferred<agentHostClient.AgentHostTurnResult>();
      let sends = 0;
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          await request.beforeDispatch?.(chat, "message-active");
          request.onMessageDispatched?.(chat);
          request.onSessionStarted?.(chat, "turn-active", "2026-01-01T10:00:01.000Z");
          started.resolve();
          return completion.promise;
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostQueuedMessageRequest) => {
          await request.beforeDispatch?.(chat, `message-${sends}`);
          await request.dispatchGuard?.(() => {
            sends++;
            request.onMessageDispatched?.(chat);
          });
          return { ...chat, messageId: `message-${sends}` };
        },
      });
      Object.defineProperty(agentHostClient, "isAgentHostTurnTerminal", {
        configurable: true, value: async () => false,
      });
      const running = executor.tryExecuteViaAgentHost(routing, options, config, "new");
      await started.promise;
      const targeted = { ...options, targetChatId: chatId };
      await executor.tryExecuteViaAgentHost(routing, targeted, config, "new");
      assert.strictEqual(sends, 1);
      Object.defineProperty(CopilotExecutor, "agentHostDispatchOwner", {
        configurable: true, value: "other-window",
      });
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, targeted, config, "new"));
      assert.strictEqual(sends, 1);
      completion.resolve(result("active"));
      await running;
      await executor.tryExecuteViaAgentHost(routing, targeted, config, "new");
      assert.strictEqual(sends, 2);
    });

    test("rechecks an earlier active dispatch after waiting for the task guard", async () => {
      const chat = ref("guard-race");
      const chatId = agentHostClient.toAgentHostChatBindingId(chat.chatUri);
      const started = deferred<void>();
      const completion = deferred<agentHostClient.AgentHostTurnResult>();
      const guardEntered = deferred<void>();
      const guardReleased = deferred<void>();
      let sends = 0;
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          await request.beforeDispatch?.(chat, "message-running");
          request.onMessageDispatched?.(chat);
          request.onSessionStarted?.(chat, "turn-running", "2026-01-01T10:00:01.000Z");
          started.resolve();
          return completion.promise;
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostQueuedMessageRequest) => {
          await request.beforeDispatch?.(chat, "message-waiting");
          await request.dispatchGuard?.(() => {
            sends++;
            request.onMessageDispatched?.(chat);
          });
          return { ...chat, messageId: "message-waiting" };
        },
      });
      const running = executor.tryExecuteViaAgentHost(routing, options, config, "new");
      const runningRejected = assert.rejects(running);
      await started.promise;
      const queued = executor.tryExecuteViaAgentHost(routing, {
        ...options,
        targetChatId: chatId,
        dispatchGuard: async (dispatch) => {
          guardEntered.resolve();
          await guardReleased.promise;
          try {
            dispatch();
          } catch {
            throw createPromptBlockedError("task changed", "taskClaimChanged");
          }
        },
      }, config, "new");
      const queuedRejected = assert.rejects(queued, (error: unknown) => {
        assert.strictEqual(getPromptBlockedReason(error), "agentHostFailed");
        return true;
      });
      await guardEntered.promise;
      completion.reject(new agentHostClient.AgentHostError("failed", "unknown", "unknown"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      guardReleased.resolve();
      await Promise.all([runningRejected, queuedRejected]);
      assert.strictEqual(sends, 0);
      await withAgentHostDispatchJournal(storageDirectory, chatId, async (journal) => {
        assert.strictEqual(journal.records.length, 1);
        assert.strictEqual(journal.records[0].turnId, "turn-running");
      });
    });

    test("does not treat an earlier run that finishes cleanly during the guard as unknown", async () => {
      const chat = ref("guard-race-ok");
      const chatId = agentHostClient.toAgentHostChatBindingId(chat.chatUri);
      const started = deferred<void>();
      const completion = deferred<agentHostClient.AgentHostTurnResult>();
      const guardEntered = deferred<void>();
      const guardReleased = deferred<void>();
      let sends = 0;
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          await request.beforeDispatch?.(chat, "message-running");
          request.onMessageDispatched?.(chat);
          request.onSessionStarted?.(chat, "turn-running", "2026-01-01T10:00:01.000Z");
          started.resolve();
          return completion.promise;
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostQueuedMessageRequest) => {
          await request.beforeDispatch?.(chat, "message-waiting");
          await request.dispatchGuard?.(() => {
            sends++;
            request.onMessageDispatched?.(chat);
          });
          return { ...chat, messageId: "message-waiting" };
        },
      });
      const running = executor.tryExecuteViaAgentHost(routing, options, config, "new");
      await started.promise;
      const queued = executor.tryExecuteViaAgentHost(routing, {
        ...options,
        targetChatId: chatId,
        dispatchGuard: async (dispatch) => {
          guardEntered.resolve();
          await guardReleased.promise;
          dispatch();
        },
      }, config, "new");
      await guardEntered.promise;
      completion.resolve(result("guard-race-ok"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      guardReleased.resolve();
      await Promise.all([running, queued]);
      assert.strictEqual(sends, 1);
      await withAgentHostDispatchJournal(storageDirectory, chatId, async (journal) => {
        assert.deepStrictEqual(journal.records, []);
      });
    });

    test("forwards the input and queue-blocked handlers to the matching Host call", async () => {
      const chat = ref("handlers");
      const chatId = agentHostClient.toAgentHostChatBindingId(chat.chatUri);
      const onInput = () => undefined;
      const onBlocked = () => undefined;
      let runRequest: agentHostClient.AgentHostTurnRequest | undefined;
      let queueRequest: agentHostClient.AgentHostQueuedMessageRequest | undefined;
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          runRequest = request;
          return result("handlers");
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostQueuedMessageRequest) => {
          queueRequest = request;
          return { ...chat, messageId: "message-handlers" };
        },
      });
      const handlers = { onAgentHostInputNeeded: onInput, onAgentHostQueueBlocked: onBlocked };
      await executor.tryExecuteViaAgentHost(routing, { ...options, ...handlers }, config, "new");
      assert.strictEqual(runRequest?.onInputNeeded, onInput);
      await executor.tryExecuteViaAgentHost(
        routing, { ...options, ...handlers, targetChatId: chatId }, config, "new",
      );
      assert.strictEqual(queueRequest?.onInputNeeded, onInput);
      assert.strictEqual(queueRequest?.onQueueBlocked, onBlocked);
      // A queue-blocked handler alone must still start the observation.
      await executor.tryExecuteViaAgentHost(
        routing, { ...options, onAgentHostQueueBlocked: onBlocked, targetChatId: chatId }, config, "new",
      );
      assert.strictEqual(queueRequest?.onQueueBlocked, onBlocked);
      assert.strictEqual(queueRequest?.onInputNeeded, undefined);

      // The run timeout and the queue observation bound reach each Host call from the settings.
      assert.strictEqual(runRequest?.timeoutMs, undefined);
      await executor.tryExecuteViaAgentHost(
        routing, { ...options, ...handlers, targetChatId: chatId }, config, "new",
      );
      assert.strictEqual(queueRequest?.inputObservationTimeoutMs, 12 * 60 * 60 * 1000);
      const timed = {
        get: (key: string, defaultValue: unknown) =>
          key === "agentHostOpenSession" ? false : key === "agentHostTimeoutEnabled" ? true : defaultValue,
        inspect: (key: string) => (key === "agentHostTimeoutEnabled" ? { key, globalValue: true } : { key }),
      } as unknown as vscode.WorkspaceConfiguration;
      await executor.tryExecuteViaAgentHost(routing, { ...options, ...handlers }, timed, "new");
      assert.strictEqual(runRequest?.timeoutMs, 180 * 60 * 1000);
      await executor.tryExecuteViaAgentHost(
        routing, { ...options, ...handlers, targetChatId: chatId }, timed, "new",
      );
      assert.strictEqual(queueRequest?.inputObservationTimeoutMs, 180 * 60 * 1000);
    });

    test("does not dispatch when the safety journal cannot be written", async () => {
      const blockedStorage = path.join(storageDirectory, "not-a-directory");
      fs.writeFileSync(blockedStorage, "blocked", "utf8");
      Object.defineProperty(CopilotExecutor, "extensionGlobalStorageUri", {
        configurable: true, value: vscode.Uri.file(blockedStorage),
      });
      let sends = 0;
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          await request.beforeDispatch?.(ref("storage-error"), "message");
          sends++;
          return result("storage-error");
        },
      });
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "new"));
      assert.strictEqual(sends, 0);
    });

    test("explains a context-budget failure instead of the raw Host error", async () => {
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async () => {
          throw new agentHostClient.AgentHostError(
            "failed",
            "(query) No response was returned because static system messages and tool definitions exceed this model's context budget.",
            "failed",
          );
        },
      });
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "new"), (error: unknown) => {
        assert.strictEqual(getPromptBlockedReason(error), "agentHostFailed");
        assert.strictEqual((error as Error).message, messages.agentHostContextBudgetExceeded());
        return true;
      });
    });

    test("keeps the raw Host detail for other failed turns", async () => {
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async () => {
          throw new agentHostClient.AgentHostError("failed", "rate limited", "failed");
        },
      });
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "new"), (error: unknown) => {
        assert.strictEqual((error as Error).message, messages.agentHostFailed("rate limited"));
        return true;
      });
    });

    test("treats any unexpected post-dispatch error as an unknown outcome", async () => {
      const chat = ref("unexpected-after-send");
      const chatId = agentHostClient.toAgentHostChatBindingId(chat.chatUri);
      let sends = 0;
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          await request.beforeDispatch?.(chat, "message");
          request.onMessageDispatched?.(chat);
          sends++;
          throw new agentHostClient.AgentHostError("unsupported", "late failure");
        },
      });
      Object.defineProperty(agentHostClient, "queueAgentHostMessage", {
        configurable: true, value: async () => assert.fail("must not send to an uncertain chat"),
      });
      await assert.rejects(executor.tryExecuteViaAgentHost(routing, options, config, "new"), (error: unknown) => {
        assert.strictEqual(getPromptBlockedReason(error), "agentHostFailed");
        return true;
      });
      await assert.rejects(executor.tryExecuteViaAgentHost(
        routing, { ...options, targetChatId: chatId }, config, "new",
      ));
      assert.strictEqual(sends, 1);
    });
  });

  test("the task guard blocks only Host-to-Chat fallback and unresolved identity", async () => {
    const userDataDir = Object.getOwnPropertyDescriptor(CopilotExecutor, "agentHostUserDataDir")!;
    const originalWarning = vscode.window.showWarningMessage;
    Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: async () => undefined,
    });
    try {
      const executor = new CopilotExecutor() as unknown as {
        tryExecuteViaAgentHost(
          routing: ReturnType<typeof __testOnly.buildPromptRouting>,
          options: ExecuteOptions,
          config: vscode.WorkspaceConfiguration,
          chatSession: "new",
        ): Promise<{ fallbackReason?: string }>;
      };
      const routing = __testOnly.buildPromptRouting("synthetic", undefined, undefined);
      const config = (fallback: "chat" | "fail") =>
        ({
          get: (key: string, defaultValue: unknown) =>
            key === "executionFallback" ? fallback : defaultValue,
          inspect: (key: string) => ({ key }),
        }) as unknown as vscode.WorkspaceConfiguration;
      assert.ok(
        (await executor.tryExecuteViaAgentHost(routing, {}, config("chat"), "new"))
          .fallbackReason,
      );
      await assert.rejects(
        executor.tryExecuteViaAgentHost(
          routing,
          { preventAgentHostFallback: true },
          config("chat"),
          "new",
        ),
        /Agent Host|エージェントホスト/,
      );
      await assert.rejects(
        executor.tryExecuteViaAgentHost(routing, {}, config("fail"), "new"),
        /Agent Host|エージェントホスト/,
      );
      await assert.rejects(
        executor.tryExecuteViaAgentHost(
          routing,
          { targetChatId: "bound-chat" },
          config("chat"),
          "new",
        ),
        /Agent Host|エージェントホスト/,
      );
      for (const selection of [
        { model: "model", modelVendor: "vendor" },
        { model: "vendor/a/b" },
        { modelName: "name-only" },
      ]) {
        await assert.rejects(
          executor.tryExecuteViaAgentHost(routing, selection, config("chat"), "new"),
          (error: unknown) =>
            error instanceof Error &&
            error.message === messages.agentHostModelSelectionRequired(),
        );
      }
    } finally {
      Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", userDataDir);
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: originalWarning,
      });
    }
  });

  test("direct Chat and Local routes ignore the Host fallback guard and remain unverified", async () => {
    const originalGetConfiguration = vscode.workspace.getConfiguration;
    let local = false;
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      configurable: true,
      value: ((section?: string) => {
        const config = originalGetConfiguration.call(vscode.workspace, section);
        if (section !== "copilotScheduler") return config;
        return {
          ...config,
          get<T>(key: string, defaultValue?: T): T {
            if (key === "executionRoute") return (local ? "agentHost" : "chat") as T;
            if (key === "sessionHarness") return (local ? "local" : "auto") as T;
            return config.get<T>(key, defaultValue as T);
          },
        } as vscode.WorkspaceConfiguration;
      }) as typeof vscode.workspace.getConfiguration,
    });
    try {
      const executor = new CopilotExecutor();
      const internals = executor as unknown as {
        tryExecuteViaAgentHost(): Promise<never>;
        tryOpenChatWithPrompt(): Promise<{ opened: true }>;
      };
      internals.tryExecuteViaAgentHost = async () => assert.fail("Host must not run");
      internals.tryOpenChatWithPrompt = async () => ({ opened: true });
      for (const route of ["chat", "local"] as const) {
        local = route === "local";
        const result = await executor.executePrompt("synthetic", {
          preventAgentHostFallback: true,
          chatSession: "continue",
        });
        assert.strictEqual(result?.modelExecution?.route, route);
        assert.strictEqual(result?.modelExecution?.verification, "unverified");
      }
    } finally {
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: originalGetConfiguration,
      });
    }
  });

  test("Agent Host uses its default model for an empty configuration", async () => {
    const findEndpoint = Object.getOwnPropertyDescriptor(agentHostClient, "findAgentHostEndpoint")!;
    const runTurn = Object.getOwnPropertyDescriptor(agentHostClient, "runAgentHostTurn")!;
    const storageUri = Object.getOwnPropertyDescriptor(CopilotExecutor, "extensionGlobalStorageUri")!;
    const userDataDir = Object.getOwnPropertyDescriptor(CopilotExecutor, "agentHostUserDataDir")!;
    const sessions: Map<string, unknown> = Reflect.get(CopilotExecutor, "agentHostSessions");
    const previousSessions = new Map(sessions);
    const requests: agentHostClient.AgentHostTurnRequest[] = [];
    Object.defineProperty(agentHostClient, "findAgentHostEndpoint", {
      configurable: true,
      value: () => ({ socketPath: "test", token: "test", protocolVersion: "1.0.0" }),
    });
    Object.defineProperty(agentHostClient, "runAgentHostTurn", {
      configurable: true,
      value: async (request: agentHostClient.AgentHostTurnRequest) => {
        requests.push(request);
        return { sessionUri: "test-session", chatUri: "test-chat", responseText: "observed" };
      },
    });
    CopilotExecutor.configureForExtensionContext(vscode.Uri.file(__dirname));
    try {
      const executor = new CopilotExecutor();
      const config = vscode.workspace.getConfiguration("copilotScheduler");
      const internals = executor as unknown as {
        tryExecuteViaAgentHost(
          routing: ReturnType<typeof __testOnly.buildPromptRouting>,
          options: { modelConfiguration: Record<string, number> },
          config: vscode.WorkspaceConfiguration,
          chatSession: "new",
        ): Promise<{ result?: { agentHostRun?: { turnOutcome?: string } }; fallbackReason?: string }>;
      };
      const routing = __testOnly.buildPromptRouting("synthetic", undefined, undefined);
      const result = await internals.tryExecuteViaAgentHost(
        routing, { modelConfiguration: {} }, config, "new",
      );
      assert.strictEqual(result.result?.agentHostRun?.turnOutcome, "completed");
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0].modelId, undefined);

      await assert.rejects(
        internals.tryExecuteViaAgentHost(
          routing, { modelConfiguration: { temperature: 1 } }, config, "new",
        ),
        (error: unknown) =>
          error instanceof Error &&
          error.message === messages.dynamicConfigurationUnavailable(),
      );
      assert.strictEqual(requests.length, 1);
    } finally {
      Object.defineProperty(agentHostClient, "findAgentHostEndpoint", findEndpoint);
      Object.defineProperty(agentHostClient, "runAgentHostTurn", runTurn);
      Object.defineProperty(CopilotExecutor, "extensionGlobalStorageUri", storageUri);
      Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", userDataDir);
      sessions.clear();
      for (const [key, value] of previousSessions) sessions.set(key, value);
    }
  });

  test("a guarded one-time run never falls back to chat or CLI", async () => {
    const originalWarning = vscode.window.showWarningMessage;
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: async () => undefined,
    });
    try {
      const executor = new CopilotExecutor();
      const internals = executor as unknown as {
        tryExecuteViaAgentHost(): Promise<{ fallbackReason: string }>;
        tryOpenChatWithPrompt(): Promise<never>;
        executePromptViaCopilotCli(): Promise<never>;
      };
      internals.tryExecuteViaAgentHost = async () => ({ fallbackReason: "unavailable" });
      internals.tryOpenChatWithPrompt = async () => assert.fail("chat must not run");
      internals.executePromptViaCopilotCli = async () => assert.fail("CLI must not run");
      const dispatchGuard = async (dispatch: () => void) => { dispatch(); };
      await assert.rejects(
        executor.executePrompt("synthetic", { dispatchGuard, chatSession: "continue" }),
        (error: unknown) =>
          error instanceof Error && error.message === messages.oneTimeDispatchRequiresAgentHost(),
      );
      await assert.rejects(
        executor.executePrompt("synthetic", { dispatchGuard, useCopilotCli: true, model: "test" }),
        (error: unknown) =>
          error instanceof Error && error.message === messages.oneTimeDispatchRequiresAgentHost(),
      );
    } finally {
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: originalWarning,
      });
    }
  });

  test("a recurring Agent Host guard preserves the selected CLI route", async () => {
    const executor = new CopilotExecutor();
    let calls = 0;
    const internals = executor as unknown as {
      executePromptViaCopilotCli(): Promise<undefined>;
    };
    internals.executePromptViaCopilotCli = async () => { calls++; return undefined; };
    await executor.executePrompt("synthetic", {
      dispatchGuard: async (dispatch) => { dispatch(); },
      allowUnguardedFallback: true,
      preventAgentHostFallback: true,
      useCopilotCli: true,
      model: "test",
    });
    assert.strictEqual(calls, 1);
  });

  test("an Agent Host failure propagates without waiting for its warning", async () => {
    const originalWarning = vscode.window.showWarningMessage;
    let dismiss!: () => void;
    const warning = new Promise<undefined>((resolve) => {
      dismiss = () => resolve(undefined);
    });
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: () => warning,
    });
    try {
      const error = createPromptBlockedError("uncertain", "agentHostFailed", "unknown");
      const executor = new CopilotExecutor() as unknown as {
        warnAndThrow(error: Error, prompt: string): Promise<never>;
      };
      const execution = Promise.resolve().then(() => executor.warnAndThrow(error, "synthetic"));
      const outcome = await Promise.race([
        execution.then(() => "resolved", (caught: unknown) => caught),
        new Promise<string>((resolve) => setTimeout(() => resolve("warning blocked"), 100)),
      ]);
      assert.strictEqual(outcome, error);
    } finally {
      dismiss();
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: originalWarning,
      });
    }
  });

  test("a chat fallback failure does not wait for the warning to be dismissed", async () => {
    const originalWarning = vscode.window.showWarningMessage;
    let dismiss!: () => void;
    const warning = new Promise<undefined>((resolve) => {
      dismiss = () => resolve(undefined);
    });
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: () => warning,
    });
    try {
      const error = new Error("chat dispatch failed");
      const executor = new CopilotExecutor();
      const internals = executor as unknown as {
        tryExecuteViaAgentHost(): Promise<{ fallbackReason: string }>;
        tryOpenChatWithPrompt(): Promise<never>;
      };
      internals.tryExecuteViaAgentHost = async () => ({ fallbackReason: "test" });
      internals.tryOpenChatWithPrompt = async () => { throw error; };
      const outcome = await Promise.race([
        executor.executePrompt("synthetic", { chatSession: "continue" })
          .then(() => "resolved", (caught: unknown) => caught),
        new Promise<string>((resolve) => setTimeout(() => resolve("warning blocked"), 200)),
      ]);
      assert.strictEqual(outcome, error);
    } finally {
      dismiss();
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: originalWarning,
      });
    }
  });

  test("a failed copy action cannot replace an Agent Host failure", async () => {
    const originalWarning = vscode.window.showWarningMessage;
    const clipboard = Object.getOwnPropertyDescriptor(vscode.env, "clipboard")!;
    let copyAttempted!: () => void;
    const copied = new Promise<void>((resolve) => { copyAttempted = resolve; });
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: async () => messages.actionCopyPrompt(),
    });
    try {
      Object.defineProperty(vscode.env, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            copyAttempted();
            throw new Error("clipboard unavailable");
          },
        },
      });
      const error = createPromptBlockedError("uncertain", "agentHostFailed", "unknown");
      const executor = new CopilotExecutor() as unknown as {
        warnAndThrow(error: Error, prompt: string): Promise<never>;
      };
      await assert.rejects(
        Promise.resolve().then(() => executor.warnAndThrow(error, "synthetic")),
        (caught: unknown) => caught === error,
      );
      await copied;
      await Promise.resolve();
    } finally {
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: originalWarning,
      });
      Object.defineProperty(vscode.env, "clipboard", clipboard);
    }
  });

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
  test("system-bearing chat routes block advertised overrides without System permission", async () => {
    const originalModels = CopilotExecutor.getAvailableModelsWithSource;
    const originalCommand = vscode.commands.executeCommand;
    const systemPermission = Object.getOwnPropertyDescriptor(
      configuredModels,
      "supportsSystemMessageForwarding",
    )!;
    const calls: string[] = [];
    let vendor = "copilot";
    Object.defineProperty(configuredModels, "supportsSystemMessageForwarding", {
      ...systemPermission,
      value: () => false,
    });
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
      Object.defineProperty(
        configuredModels,
        "supportsSystemMessageForwarding",
        systemPermission,
      );
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

    test("task policy ranks live models by provider first, then family, with exact choices winning", async () => {
      const options = [
        { id: "same-family", vendor: "copilot", family: "claude" },
        { id: "different-family", vendor: "copilot", family: "gpt" },
        { id: "different-provider", vendor: "byok", family: "claude" },
        { id: "both-different", vendor: "byok", family: "gpt" },
        { id: "unknown-family", vendor: "aaa", family: undefined },
      ].map((model) => ({ ...model, name: model.id, description: "" }));
      const primary = { model: "gone", modelVendor: "copilot", modelFamily: "claude", modelReasoningEffort: "high" };
      const taskResolver = CopilotExecutor as unknown as {
        resolveRequestedModelSelection(selection: {
          model: string;
          modelName?: string;
          modelVendor?: string;
          modelFamily?: string;
          modelReasoningEffort?: string;
        }, enabled: boolean, policy: {
          strategy: "diverse" | "similar";
          chatModel?: { id: string; vendor: string };
        }): ReturnType<Resolver["resolveRequestedModelSelection"]>;
      };
      let live = options.filter((model) => model.id !== "same-family");
      let complete = true;
      CopilotExecutor.getAvailableModelsWithSource = async () => ({
        source: "api", models: live, ...(complete ? { liveFallbackModels: live } : {}),
      });
      // A same-provider, same-family model would resolve through the existing
      // tolerant matching before any policy applies, so it is absent here.
      for (const [strategy, expected] of [["diverse", "both-different"], ["similar", "different-family"]] as const) {
        const result = await taskResolver.resolveRequestedModelSelection(primary, true, { strategy });
        assert.strictEqual(result.selection.model, expected);
        assert.strictEqual(Reflect.get(result.selection, "modelReasoningEffort"), undefined);
        assert.strictEqual(result.fallback?.to, expected);
      }
      const explicit = await taskResolver.resolveRequestedModelSelection(primary, true, {
        strategy: "diverse", chatModel: { id: "different-family", vendor: "copilot" },
      });
      assert.strictEqual(explicit.selection.model, "different-family");
      live = live.filter((model) => model.id !== "both-different");
      assert.strictEqual((await taskResolver.resolveRequestedModelSelection(primary, true, {
        strategy: "diverse",
      })).selection.model, "different-provider");
      complete = false;
      const unreadable = await taskResolver.resolveRequestedModelSelection(primary, true, { strategy: "diverse" });
      assert.strictEqual(unreadable.fallback, undefined);
      assert.strictEqual(unreadable.matched, undefined);
      complete = true;
      live = options;
      const renamed = await taskResolver.resolveRequestedModelSelection(
        { model: "old-id", modelName: "same-family", modelVendor: "copilot", modelFamily: "claude" },
        true,
        { strategy: "diverse" },
      );
      assert.strictEqual(renamed.selection.model, "same-family");
      assert.strictEqual(renamed.fallback, undefined);
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

    test("model fallback never overrides the Host route guard or resends an unknown turn", async () => {
      const releaseStorage = useAgentHostTestStorage();
      const getConfig = vscode.workspace.getConfiguration;
      const warning = vscode.window.showWarningMessage;
      const findEndpoint = Object.getOwnPropertyDescriptor(agentHostClient, "findAgentHostEndpoint")!;
      const runTurn = Object.getOwnPropertyDescriptor(agentHostClient, "runAgentHostTurn")!;
      const userDataDir = Object.getOwnPropertyDescriptor(CopilotExecutor, "agentHostUserDataDir")!;
      let hostAvailable = false;
      let acceptHostTurn = false;
      let hostCalls = 0;
      let chatCalls = 0;
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: ((section?: string) => {
          const config = getConfig.call(vscode.workspace, section);
          if (section !== "copilotScheduler") return config;
          return {
            ...config,
            get<T>(key: string, defaultValue?: T): T {
              if (key === "executionRoute") return "agentHost" as T;
              if (key === "sessionHarness") return "auto" as T;
              if (key === "executionFallback") return "chat" as T;
              return config.get<T>(key, defaultValue as T);
            },
          } as vscode.WorkspaceConfiguration;
        }) as typeof vscode.workspace.getConfiguration,
      });
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: async () => undefined,
      });
      Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", {
        configurable: true,
        value: "test",
      });
      Object.defineProperty(agentHostClient, "findAgentHostEndpoint", {
        configurable: true,
        value: () =>
          hostAvailable
            ? { socketPath: "test", token: "test", protocolVersion: "1.0.0" }
            : undefined,
      });
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          hostCalls++;
          assert.strictEqual(request.modelFallback?.agentHostModelId, "byok/group/alternate");
          if (acceptHostTurn) return {
            requestedModel: "byok/group/alternate",
            fallbackFromModel: "ollama/group/gone",
            responseText: "observed",
          };
          throw new agentHostClient.AgentHostError("failed", "uncertain", "unknown");
        },
      });
      try {
        const executor = new CopilotExecutor();
        const internals = executor as unknown as {
          tryOpenChatWithPrompt(): Promise<{ opened: true }>;
        };
        internals.tryOpenChatWithPrompt = async () => {
          chatCalls++;
          return { opened: true };
        };
        const options: ExecuteOptions = {
          model: "gone",
          modelVendor: "ollama",
          agentHostModelId: "ollama/group/gone",
          chatSession: "continue",
        };
        await assert.rejects(
          executor.executePrompt("synthetic", {
            ...options,
            modelFallback: true,
            preventAgentHostFallback: true,
          }),
        );
        await assert.rejects(
          executor.executePrompt("synthetic", { ...options, modelFallback: false }),
        );
        assert.strictEqual(chatCalls, 0);

        const fallback = await executor.executePrompt("synthetic", {
          ...options,
          modelFallback: true,
        });
        assert.strictEqual(fallback.modelFallback?.to, "HydraFusion");
        assert.strictEqual(fallback.modelExecution?.route, "chat");
        assert.strictEqual(chatCalls, 1);

        hostAvailable = true;
        const modelFallbackPolicy = { strategy: "diverse", agentHostModelId: "byok/group/alternate" } as const;
        for (const preventAgentHostFallback of [false, true]) {
          await assert.rejects(
            executor.executePrompt("synthetic", {
              ...options,
              modelFallback: true,
              modelFallbackPolicy,
              preventAgentHostFallback,
            }),
          );
        }
        assert.strictEqual(hostCalls, 2);
        assert.strictEqual(chatCalls, 1);
        acceptHostTurn = true;
        const hostFallback = await executor.executePrompt("synthetic", { ...options, modelFallback: true, modelFallbackPolicy });
        assert.strictEqual(hostFallback.modelFallback?.route, "agentHost");
        assert.strictEqual(hostFallback.modelFallback?.fromId, "ollama/group/gone");
        assert.strictEqual(hostFallback.modelFallback?.toId, "byok/group/alternate");
      } finally {
        Object.defineProperty(vscode.workspace, "getConfiguration", {
          configurable: true,
          value: getConfig,
        });
        Object.defineProperty(vscode.window, "showWarningMessage", {
          configurable: true,
          value: warning,
        });
        Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", userDataDir);
        Object.defineProperty(agentHostClient, "findAgentHostEndpoint", findEndpoint);
        Object.defineProperty(agentHostClient, "runAgentHostTurn", runTurn);
        releaseStorage();
      }
    });

    test("the Agent Host run timeout is off by default and follows the settings", async () => {
      const releaseStorage = useAgentHostTestStorage();
      const getConfig = vscode.workspace.getConfiguration;
      const findEndpoint = Object.getOwnPropertyDescriptor(agentHostClient, "findAgentHostEndpoint")!;
      const runTurn = Object.getOwnPropertyDescriptor(agentHostClient, "runAgentHostTurn")!;
      const userDataDir = Object.getOwnPropertyDescriptor(CopilotExecutor, "agentHostUserDataDir")!;
      let values: Record<string, unknown> = {};
      let honored: string[] = [];
      const requests: agentHostClient.AgentHostTurnRequest[] = [];
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: ((section?: string) => {
          const config = getConfig.call(vscode.workspace, section);
          if (section !== "copilotScheduler") return config;
          return {
            ...config,
            get<T>(key: string, defaultValue?: T): T {
              if (key === "executionRoute") return "agentHost" as T;
              if (key === "sessionHarness") return "auto" as T;
              if (Object.hasOwn(values, key)) return values[key] as T;
              return config.get<T>(key, defaultValue as T);
            },
            inspect: (key: string) =>
              honored.includes(key) ? { key, globalValue: values[key] } : { key },
          } as unknown as vscode.WorkspaceConfiguration;
        }) as typeof vscode.workspace.getConfiguration,
      });
      Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", { configurable: true, value: "test" });
      Object.defineProperty(agentHostClient, "findAgentHostEndpoint", {
        configurable: true,
        value: () => ({ socketPath: "test", token: "test", protocolVersion: "1.0.0" }),
      });
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async (request: agentHostClient.AgentHostTurnRequest) => {
          requests.push(request);
          return { responseText: "observed" };
        },
      });
      try {
        const executor = new CopilotExecutor();
        const timeoutFor = async (
          nextValues: Record<string, unknown>,
          nextHonored: string[],
          timeout?: ExecuteOptions["timeout"],
        ): Promise<number | undefined> => {
          values = nextValues;
          honored = nextHonored;
          requests.length = 0;
          await executor.executePrompt("synthetic", {
            chatSession: "new",
            ...(timeout ? { timeout } : {}),
          });
          assert.strictEqual(requests.length, 1);
          return requests[0].timeoutMs;
        };
        // No settings: the manifest defaults apply and nothing is cancelled.
        assert.strictEqual(await timeoutFor({}, []), undefined);
        // The task's own timeout decides regardless of the settings.
        assert.strictEqual(await timeoutFor({}, [], { mode: "on", minutes: 25 }), 25 * 60 * 1000);
        assert.strictEqual(
          await timeoutFor({ agentHostTimeoutEnabled: true }, ["agentHostTimeoutEnabled"], { mode: "off" }),
          undefined,
        );
        assert.strictEqual(
          await timeoutFor({ agentHostTimeoutEnabled: true }, ["agentHostTimeoutEnabled"]),
          180 * 60 * 1000,
        );
        // Minutes chosen before the on/off option existed keep the timeout on.
        assert.strictEqual(
          await timeoutFor({ agentHostTimeoutMinutes: 90 }, ["agentHostTimeoutMinutes"]),
          90 * 60 * 1000,
        );
        assert.strictEqual(
          await timeoutFor(
            { agentHostTimeoutEnabled: false, agentHostTimeoutMinutes: 90 },
            ["agentHostTimeoutEnabled", "agentHostTimeoutMinutes"],
          ),
          undefined,
        );
      } finally {
        Object.defineProperty(vscode.workspace, "getConfiguration", {
          configurable: true,
          value: getConfig,
        });
        Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", userDataDir);
        Object.defineProperty(agentHostClient, "findAgentHostEndpoint", findEndpoint);
        Object.defineProperty(agentHostClient, "runAgentHostTurn", runTurn);
        releaseStorage();
      }
    });

    test("a timed-out Agent Host run is reported with the setting that ended it", async () => {
      const releaseStorage = useAgentHostTestStorage();
      const getConfig = vscode.workspace.getConfiguration;
      const warning = vscode.window.showWarningMessage;
      const findEndpoint = Object.getOwnPropertyDescriptor(agentHostClient, "findAgentHostEndpoint")!;
      const runTurn = Object.getOwnPropertyDescriptor(agentHostClient, "runAgentHostTurn")!;
      const userDataDir = Object.getOwnPropertyDescriptor(CopilotExecutor, "agentHostUserDataDir")!;
      let enabled = true;
      let stage: "beforeDispatch" | "run" = "run";
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: ((section?: string) => {
          const config = getConfig.call(vscode.workspace, section);
          if (section !== "copilotScheduler") return config;
          return {
            ...config,
            get<T>(key: string, defaultValue?: T): T {
              if (key === "executionRoute") return "agentHost" as T;
              if (key === "sessionHarness") return "auto" as T;
              if (key === "agentHostTimeoutMinutes") return 30 as T;
              if (key === "agentHostTimeoutEnabled") return enabled as T;
              return config.get<T>(key, defaultValue as T);
            },
            inspect: (key: string) =>
              key === "agentHostTimeoutEnabled" ? { key, globalValue: enabled } : { key },
          } as unknown as vscode.WorkspaceConfiguration;
        }) as typeof vscode.workspace.getConfiguration,
      });
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: async () => undefined,
      });
      Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", { configurable: true, value: "test" });
      Object.defineProperty(agentHostClient, "findAgentHostEndpoint", {
        configurable: true,
        value: () => ({ socketPath: "test", token: "test", protocolVersion: "1.0.0" }),
      });
      Object.defineProperty(agentHostClient, "runAgentHostTurn", {
        configurable: true,
        value: async () => {
          throw new agentHostClient.AgentHostError(
            "failed",
            "The Agent Host run timed out.",
            "unknown",
            undefined,
            stage,
          );
        },
      });
      try {
        const executor = new CopilotExecutor();
        const messageFor = async (timeout?: ExecuteOptions["timeout"]): Promise<string> => {
          try {
            await executor.executePrompt("synthetic", {
              chatSession: "new",
              ...(timeout ? { timeout } : {}),
            });
          } catch (error) {
            return (error as Error).message;
          }
          return assert.fail("the run must fail");
        };
        assert.strictEqual(
          await messageFor(),
          messages.agentHostOutcomeUnknown(messages.agentHostTimedOut("run", 30)),
        );
        assert.ok((await messageFor()).includes("agentHostTimeoutMinutes"));
        // A task's own timeout is named as the task's, not as a setting.
        const taskMessage = await messageFor({ mode: "on", minutes: 5 });
        assert.strictEqual(
          taskMessage,
          messages.agentHostOutcomeUnknown(messages.agentHostTimedOut("run", 5, true)),
        );
        assert.ok(!taskMessage.includes("agentHostTimeoutMinutes"));
        // Nothing was sent: the message does not blame a timeout setting that is off.
        enabled = false;
        stage = "beforeDispatch";
        const abandoned = await messageFor();
        assert.strictEqual(
          abandoned,
          messages.agentHostOutcomeUnknown(messages.agentHostTimedOut("beforeDispatch", undefined)),
        );
        assert.ok(!abandoned.includes("agentHostTimeout"));
      } finally {
        Object.defineProperty(vscode.workspace, "getConfiguration", {
          configurable: true,
          value: getConfig,
        });
        Object.defineProperty(vscode.window, "showWarningMessage", {
          configurable: true,
          value: warning,
        });
        Object.defineProperty(CopilotExecutor, "agentHostUserDataDir", userDataDir);
        Object.defineProperty(agentHostClient, "findAgentHostEndpoint", findEndpoint);
        Object.defineProperty(agentHostClient, "runAgentHostTurn", runTurn);
        releaseStorage();
      }
    });

    test("the Copilot CLI timeout is off by default and follows the settings", async () => {
      const getConfig = vscode.workspace.getConfiguration;
      const runProcess = Object.getOwnPropertyDescriptor(copilotCliRunner, "runCopilotCliProcess")!;
      let values: Record<string, unknown> = {};
      let honored: string[] = [];
      let timedOut = false;
      const requests: copilotCliRunner.CopilotCliProcessOptions[] = [];
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: ((section?: string) => {
          const config = getConfig.call(vscode.workspace, section);
          if (section !== "copilotScheduler") return config;
          return {
            ...config,
            get<T>(key: string, defaultValue?: T): T {
              if (key === "cliPath") return process.execPath as T;
              if (Object.hasOwn(values, key)) return values[key] as T;
              return config.get<T>(key, defaultValue as T);
            },
            inspect: (key: string) =>
              honored.includes(key) ? { key, globalValue: values[key] } : { key },
          } as unknown as vscode.WorkspaceConfiguration;
        }) as typeof vscode.workspace.getConfiguration,
      });
      Object.defineProperty(copilotCliRunner, "runCopilotCliProcess", {
        configurable: true,
        value: async (options: copilotCliRunner.CopilotCliProcessOptions) => {
          requests.push(options);
          return {
            exitCode: timedOut ? null : 0,
            timedOut,
            cancelled: false,
            stderrTail: "",
            summary: {},
          };
        },
      });
      try {
        const internals = new CopilotExecutor() as unknown as {
          runCopilotCli(prompt: string, options: ExecuteOptions): Promise<unknown>;
        };
        const timeoutFor = async (
          nextValues: Record<string, unknown>,
          nextHonored: string[],
          timeout?: ExecuteOptions["timeout"],
        ): Promise<number | undefined> => {
          values = nextValues;
          honored = nextHonored;
          requests.length = 0;
          await internals.runCopilotCli("synthetic", {
            useCopilotCli: true,
            model: "test",
            ...(timeout ? { timeout } : {}),
          });
          assert.strictEqual(requests.length, 1);
          return requests[0].timeoutMs;
        };
        // No settings: the CLI is left to finish on its own.
        assert.strictEqual(await timeoutFor({}, []), undefined);
        assert.strictEqual(
          await timeoutFor({ cliTimeoutEnabled: true }, ["cliTimeoutEnabled"]),
          180 * 60 * 1000,
        );
        assert.strictEqual(
          await timeoutFor({ cliTimeoutMinutes: 45 }, ["cliTimeoutMinutes"]),
          45 * 60 * 1000,
        );
        // The Agent Host switch does not turn the CLI timeout on.
        assert.strictEqual(
          await timeoutFor({ agentHostTimeoutEnabled: true }, ["agentHostTimeoutEnabled"]),
          undefined,
        );
        // The task's own timeout decides regardless of the settings.
        assert.strictEqual(await timeoutFor({}, [], { mode: "on", minutes: 7 }), 7 * 60 * 1000);
        assert.strictEqual(
          await timeoutFor({ cliTimeoutEnabled: true }, ["cliTimeoutEnabled"], { mode: "off" }),
          undefined,
        );
        // The stop message names the configured minutes.
        timedOut = true;
        values = { cliTimeoutEnabled: true, cliTimeoutMinutes: 30 };
        honored = ["cliTimeoutEnabled", "cliTimeoutMinutes"];
        await assert.rejects(
          internals.runCopilotCli("synthetic", { useCopilotCli: true, model: "test" }),
          (error: unknown) =>
            error instanceof Error && error.message === messages.copilotCliTimedOut(30),
        );
        await assert.rejects(
          internals.runCopilotCli("synthetic", {
            useCopilotCli: true,
            model: "test",
            timeout: { mode: "on", minutes: 12 },
          }),
          (error: unknown) =>
            error instanceof Error && error.message === messages.copilotCliTimedOut(12, true),
        );
      } finally {
        Object.defineProperty(vscode.workspace, "getConfiguration", {
          configurable: true,
          value: getConfig,
        });
        Object.defineProperty(copilotCliRunner, "runCopilotCliProcess", runProcess);
      }
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
