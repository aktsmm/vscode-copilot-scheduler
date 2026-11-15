import * as assert from "assert";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AgentHostError,
  findAgentHostEndpoint,
  listAgentHostChats,
  mapModelConfiguration,
  queueAgentHostMessage,
  resolveUserDataDir,
  runAgentHostTurn,
  toAgentHostChatBindingId,
  type AgentHostEndpoint,
  type AgentHostTurnRequest,
} from "../../agentHostClient";
import { __testOnly } from "../../copilotExecutor";
import { encodeClientFrame, FrameParser } from "../../minimalWebSocket";

const MODELS = [
  {
    id: "claude-sonnet-5.5",
    configSchema: {
      properties: {
        thinkingLevel: { type: "string", enum: ["low", "medium", "high"] },
        contextSize: { type: "number" },
      },
    },
  },
  { id: "gpt-5.6-luna" },
];

type Recorded = { method: string; params: Record<string, unknown> };

interface FakeHost {
  endpoint: AgentHostEndpoint;
  calls: Recorded[];
  sockets: () => Iterable<WebSocket>;
  close: () => Promise<void>;
}

/** A host speaking just enough AHP over a named pipe (or unix socket). */
async function startFakeHost(
  tmp: string,
  behaviour: {
    finish?: (
      send: (action: Record<string, unknown>, rejectionReason?: string) => void,
    ) => void;
    cancel?: (send: (action: Record<string, unknown>) => void) => void;
    acceptStart?: boolean;
    missingSessions?: boolean;
    sessionPages?: Array<{
      items: Array<Record<string, unknown>>;
      nextCursor?: string;
    }>;
    queueAck?: boolean;
    queueRejected?: boolean;
  } = {},
): Promise<FakeHost> {
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\copilot-scheduler-test-${process.pid}-${Date.now()}`
      : path.join(tmp, "host.sock");
  const calls: Recorded[] = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket: WebSocket, request) => {
    assert.ok(request.url?.includes("tkn=secret"));
    const notify = (
      channel: string,
      action: Record<string, unknown>,
      rejectionReason?: string,
    ) =>
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "action",
          params: {
            channel,
            action,
            ...(rejectionReason === undefined ? {} : { rejectionReason }),
          },
        }),
      );

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      calls.push({ method: message.method, params: message.params });
      const reply = (result: unknown) =>
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));

      switch (message.method) {
        case "initialize":
          reply({
            protocolVersion: "1.1.0",
            snapshots: [
              {
                state: {
                  agents: [{ provider: "copilotcli", models: MODELS }],
                },
              },
            ],
          });
          break;
        case "createSession":
          reply(null);
          break;
        case "listSessions": {
          const cursor = message.params.cursor;
          const pageIndex = cursor === "page-2" ? 1 : 0;
          const page = behaviour.sessionPages?.[pageIndex] ?? { items: [] };
          reply(page);
          break;
        }
        case "subscribe":
          if (
            behaviour.missingSessions &&
            String(message.params.channel).includes("gone")
          ) {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32002, message: "Unknown session" },
              }),
            );
          } else {
            const sessions =
              behaviour.sessionPages?.flatMap((page) => page.items) ?? [];
            const channel = String(message.params.channel);
            const session = sessions.find((item) => item.resource === channel);
            const chat = sessions
              .flatMap((item) =>
                Array.isArray(item.chats)
                  ? (item.chats as Array<Record<string, unknown>>)
                  : [],
              )
              .find((item) => item.resource === channel);
            if (session) {
              reply({
                snapshot: {
                  state: {
                    lifecycle: "ready",
                    provider: session.provider,
                    chats: session.chats,
                    workingDirectories: session.workingDirectories,
                  },
                },
              });
            } else if (chat) {
              const parent = sessions.find((item) =>
                Array.isArray(item.chats) &&
                (item.chats as Array<Record<string, unknown>>).some(
                  (entry) => entry.resource === channel,
                ),
              );
              reply({
                snapshot: {
                  state: {
                    resource: chat.resource,
                    provider: chat.provider,
                    title: chat.title,
                    workingDirectories:
                      chat.workingDirectories ?? parent?.workingDirectories,
                  },
                },
              });
            } else {
              reply({ snapshot: { state: { defaultChat: "ahp-chat:/chat-1" } } });
            }
          }
          break;
        case "dispatchAction": {
          reply(null);
          const channel = message.params.channel as string;
          const action = message.params.action as {
            type: string;
            turnId?: string;
            id?: string;
          };
          if (action.type === "chat/turnStarted") {
            const send = (next: Record<string, unknown>, rejectionReason?: string) =>
              notify(channel, { turnId: action.turnId, ...next }, rejectionReason);
            if (behaviour.acceptStart !== false) {
              send({ type: "chat/turnStarted" });
            }
            if (behaviour.finish) {
              behaviour.finish(send);
            } else {
              send({
                type: "chat/usage",
                usage: { model: "claude-sonnet-5.5" },
              });
              send({ type: "chat/turnComplete" });
            }
          } else if (action.type === "chat/turnCancelled" && behaviour.cancel) {
            behaviour.cancel((next) =>
              notify(channel, { turnId: action.turnId, ...next }),
            );
          } else if (action.type === "chat/pendingMessageSet") {
            if (behaviour.queueAck !== false) {
              notify(
                channel,
                {
                  type: "chat/pendingMessageSet",
                  id: action.id,
                  kind: "queued",
                },
                behaviour.queueRejected ? "queue rejected" : undefined,
              );
            }
          }
          break;
        }
        default:
          reply(null);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    endpoint: { socketPath, token: "secret", protocolVersion: "1.1.0" },
    calls,
    sockets: () => wss.clients,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => server.close(() => resolve()));
        for (const client of wss.clients) {
          client.terminate();
        }
      }),
  };
}

function baseRequest(endpoint: AgentHostEndpoint): AgentHostTurnRequest {
  return {
    endpoint,
    text: "hello",
    autoApprove: true,
    timeoutMs: 5000,
  };
}

suite("Agent Host client", () => {
  let tmp: string;

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-ahp-"));
  });

  teardown(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("lists Copilot chats across pages without exposing chat content", async () => {
    const chatUri = "ahp-copilotcli:/chat-1";
    const session = {
      resource: "ahp-copilotcli:/session-1",
      provider: "copilotcli",
      workingDirectories: [pathToFileURL(tmp).href],
      chats: [
        {
          resource: chatUri,
          title: "Daily review",
          interactivity: "interactive",
        },
      ],
    };
    const host = await startFakeHost(tmp, {
      sessionPages: [
        { items: [session], nextCursor: "page-2" },
        {
          items: [
            {
              resource: "ahp-other:/session",
              provider: "other",
              chats: [],
            },
            {
              resource: "ahp-copilotcli:/archived-session",
              provider: "copilotcli",
              workingDirectories: [tmp],
              chats: [
                {
                  resource: "ahp-copilotcli:/archived-chat",
                  title: "Archived",
                  status: 1 << 6,
                },
              ],
            },
          ],
        },
      ],
    });
    try {
      const chats = await listAgentHostChats(host.endpoint);
      assert.deepStrictEqual(chats, [
        {
          bindingId: toAgentHostChatBindingId(chatUri),
          title: "Daily review",
          sessionUri: session.resource,
          chatUri,
          provider: "copilotcli",
          workingDirectories: [tmp],
        },
      ]);
      assert.strictEqual(host.calls.filter((call) => call.method === "listSessions").length, 2);
      assert.strictEqual(
        JSON.stringify(chats).includes("conversation"),
        false,
      );
    } finally {
      await host.close();
    }
  });

  test("queues a stable per-task message and refuses a workspace mismatch", async () => {
    const chatUri = "ahp-copilotcli:/chat-1";
    const session = {
      resource: "ahp-copilotcli:/session-1",
      provider: "copilotcli",
      workingDirectories: [pathToFileURL(tmp).href],
      chats: [
        {
          resource: chatUri,
          title: "Daily review",
          interactivity: "interactive",
        },
      ],
    };
    const host = await startFakeHost(tmp, {
      sessionPages: [{ items: [session] }],
    });
    try {
      const request = {
        endpoint: host.endpoint,
        targetChatId: toAgentHostChatBindingId(chatUri).toUpperCase(),
        expectedWorkspacePath: tmp,
        taskId: "stable-task-id",
        text: "Review today's changes",
      };
      const first = await queueAgentHostMessage(request);
      const second = await queueAgentHostMessage(request);
      assert.strictEqual(first.messageId, second.messageId);
      assert.match(first.messageId, /^copilot-scheduler-[a-f0-9]{64}$/);
      const queued = host.calls.filter((call) => {
        if (call.method !== "dispatchAction") return false;
        const action = call.params.action as Record<string, unknown> | undefined;
        return action?.type === "chat/pendingMessageSet";
      });
      assert.strictEqual(queued.length, 2);
      const firstAction = queued[0].params.action as Record<string, unknown>;
      assert.strictEqual(firstAction.kind, "queued");
      assert.strictEqual(firstAction.id, first.messageId);

      await assert.rejects(
        queueAgentHostMessage({
          ...request,
          expectedWorkspacePath: path.join(tmp, "another-workspace"),
        }),
        (error: unknown) =>
          error instanceof AgentHostError && error.kind === "unsupported",
      );
      assert.strictEqual(
        host.calls.filter((call) => {
          if (call.method !== "dispatchAction") return false;
          const action = call.params.action as Record<string, unknown> | undefined;
          return action?.type === "chat/pendingMessageSet";
        }).length,
        2,
      );
    } finally {
      await host.close();
    }
  });

  test("reports an unconfirmed queued dispatch as unknown", async () => {
    const chatUri = "ahp-copilotcli:/chat-1";
    const session = {
      resource: "ahp-copilotcli:/session-1",
      provider: "copilotcli",
      workingDirectories: [pathToFileURL(tmp).href],
      chats: [
        {
          resource: chatUri,
          title: "Daily review",
          interactivity: "interactive",
        },
      ],
    };
    const host = await startFakeHost(tmp, {
      sessionPages: [{ items: [session] }],
      queueRejected: true,
    });
    try {
      await assert.rejects(
        queueAgentHostMessage({
          endpoint: host.endpoint,
          targetChatId: toAgentHostChatBindingId(chatUri),
          taskId: "stable-task-id",
          text: "Review today's changes",
        }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.kind === "failed" &&
          error.turnOutcome === "unknown",
      );
    } finally {
      await host.close();
    }
  });

  test("a dispatch guard can allow or block the Agent Host turn", async () => {
    const host = await startFakeHost(tmp);
    try {
      let guards = 0;
      const result = await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        dispatchGuard: async (dispatch) => { guards++; dispatch(); },
      });
      assert.strictEqual(result.responseText, "not_observed");
      assert.strictEqual(guards, 1);
      const starts = () => host.calls.filter(
        (call) =>
          call.method === "dispatchAction" &&
          (call.params.action as { type: string }).type === "chat/turnStarted",
      ).length;
      assert.strictEqual(starts(), 1);
      const blocked = new Error("reservation changed");
      await assert.rejects(
        runAgentHostTurn({
          ...baseRequest(host.endpoint),
          dispatchGuard: async () => { throw blocked; },
        }),
        (error: unknown) => error === blocked,
      );
      assert.strictEqual(starts(), 1);
    } finally {
      await host.close();
    }
  });

  test("a guard failure after dispatch is reported as an unknown outcome", async () => {
    const host = await startFakeHost(tmp);
    try {
      await assert.rejects(
        runAgentHostTurn({
          ...baseRequest(host.endpoint),
          dispatchGuard: async (dispatch) => {
            dispatch();
            throw new Error("lock release failed");
          },
        }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.kind === "failed" &&
          error.turnOutcome === "unknown",
      );
    } finally {
      await host.close();
    }
  });

  test("a completed turn waits for the dispatch guard and reports release failure", async () => {
    let responseSent!: () => void;
    const sent = new Promise<void>((resolve) => { responseSent = resolve; });
    const host = await startFakeHost(tmp, {
      finish: (send) => {
        send({ type: "chat/turnComplete" });
        responseSent();
      },
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    try {
      let settled = false;
      const run = runAgentHostTurn({
        ...baseRequest(host.endpoint),
        dispatchGuard: async (dispatch) => {
          dispatch();
          await hold;
          throw new Error("lock release failed");
        },
      });
      void run.then(() => { settled = true; }, () => { settled = true; });
      await sent;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const settledBeforeRelease = settled;
      release();
      await assert.rejects(
        run,
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.kind === "failed" &&
          error.turnOutcome === "unknown",
      );
      assert.strictEqual(settledBeforeRelease, false);
    } finally {
      release();
      await host.close();
    }
  });

  test("a timed-out dispatch guard cannot send when it later resumes", async () => {
    const host = await startFakeHost(tmp);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    try {
      await assert.rejects(
        runAgentHostTurn({
          ...baseRequest(host.endpoint),
          timeoutMs: 100,
          dispatchGuard: async (dispatch) => { await hold; dispatch(); },
        }),
        (error: unknown) =>
          error instanceof AgentHostError && error.turnOutcome === "unknown",
      );
      release();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assert.ok(!host.calls.some(
        (call) =>
          call.method === "dispatchAction" &&
          (call.params.action as { type: string }).type === "chat/turnStarted",
      ));
    } finally {
      release();
      await host.close();
    }
  });

  suite("endpoint registry", () => {
    const writeEntry = (name: string, entry: Record<string, unknown>) => {
      const dir = path.join(tmp, "agent-host", "local-endpoint", "entries");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(entry));
    };
    const editor = (overrides: Record<string, unknown> = {}) => ({
      schemaVersion: 2,
      type: "editor",
      pid: 1,
      endpoint: { type: "socket", path: "\\\\.\\pipe\\host" },
      connectionToken: "token",
      protocolVersion: "1.1.0",
      ...overrides,
    });

    test("derives the user data dir from the extension's global storage", () => {
      assert.strictEqual(
        resolveUserDataDir(
          path.join(tmp, "Code", "User", "globalStorage", "publisher.ext"),
        ),
        path.join(tmp, "Code"),
      );
    });

    test("returns the live editor host and skips entries it cannot use", () => {
      writeEntry("stale", editor({ pid: 2 }));
      writeEntry("old-protocol", editor({ pid: 1, protocolVersion: "0.9.0" }));
      writeEntry("standalone", editor({ type: "standalone" }));
      writeEntry("old-schema", editor({ schemaVersion: 1 }));
      writeEntry("no-token", editor({ connectionToken: "" }));
      writeEntry("live", editor());
      fs.writeFileSync(
        path.join(tmp, "agent-host", "local-endpoint", "entries", "bad.json"),
        "{not json",
      );

      assert.deepStrictEqual(findAgentHostEndpoint(tmp, (pid) => pid === 1), {
        socketPath: "\\\\.\\pipe\\host",
        token: "token",
        protocolVersion: "1.1.0",
      });
    });

    test("returns nothing when there is no registry or no live host", () => {
      assert.strictEqual(findAgentHostEndpoint(tmp), undefined);
      writeEntry("stale", editor({ pid: 2 }));
      assert.strictEqual(findAgentHostEndpoint(tmp, () => false), undefined);
    });
  });

  suite("model options", () => {
    const model = MODELS[0];

    test("maps scheduler option names to the host's and checks their values", () => {
      assert.deepStrictEqual(
        mapModelConfiguration(model, {
          reasoningEffort: "high",
          contextSize: "200000",
        }),
        { thinkingLevel: "high", contextSize: 200000 },
      );
    });

    test("refuses an option the model does not offer or a value it does not accept", () => {
      assert.throws(
        () => mapModelConfiguration(model, { speedMode: "fast" }),
        (error: unknown) =>
          error instanceof AgentHostError && error.kind === "unsupported",
      );
      assert.throws(
        () => mapModelConfiguration(model, { reasoningEffort: "extreme" }),
        (error: unknown) =>
          error instanceof AgentHostError && error.kind === "unsupported",
      );
      assert.throws(
        () => mapModelConfiguration(MODELS[1], { reasoningEffort: "low" }),
        (error: unknown) =>
          error instanceof AgentHostError && error.kind === "unsupported",
      );
    });

    test("ignores options that are not set", () => {
      assert.deepStrictEqual(
        mapModelConfiguration(model, { reasoningEffort: undefined }),
        {},
      );
    });
  });

  suite("running a turn", () => {
    let host: FakeHost | undefined;

    teardown(async () => {
      await host?.close();
      host = undefined;
    });

    test("sends the model, options, agent and attachments, and reports the model that ran", async () => {
      host = await startFakeHost(tmp);
      const result = await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        cwdUri: "file:///work",
        modelId: "claude-sonnet-5.5",
        modelOptions: { reasoningEffort: "low" },
        agentUri: "file:///work/.github/agents/a.agent.md",
        attachments: [{ label: "notes.md", uri: "file:///work/notes.md" }],
      });

      assert.deepStrictEqual(result, {
        sessionUri: result.sessionUri,
        chatUri: "ahp-chat:/chat-1",
        requestedModel: "claude-sonnet-5.5",
        appliedModel: "claude-sonnet-5.5",
        responseText: "not_observed",
      });
      const create = host.calls.find((c) => c.method === "createSession");
      assert.deepStrictEqual(create?.params.workingDirectories, [
        "file:///work",
      ]);
      assert.deepStrictEqual(create?.params.config, {
        autoApprove: "autoApprove",
      });
      const turn = host.calls.find(
        (c) =>
          c.method === "dispatchAction" &&
          (c.params.action as { type: string }).type === "chat/turnStarted",
      );
      const message = (turn?.params.action as { message: unknown }).message;
      assert.deepStrictEqual(message, {
        text: "hello",
        origin: { kind: "user" },
        model: { id: "claude-sonnet-5.5", config: { thinkingLevel: "low" } },
        agent: { uri: "file:///work/.github/agents/a.agent.md" },
        attachments: [
          { type: "resource", label: "notes.md", uri: "file:///work/notes.md" },
        ],
      });
    });

    test("does not turn on auto approval unless asked", async () => {
      host = await startFakeHost(tmp);
      await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        autoApprove: false,
      });
      const create = host.calls.find((c) => c.method === "createSession");
      assert.strictEqual(create?.params.config, undefined);
    });

    test("refuses a model the host does not offer before sending anything", async () => {
      host = await startFakeHost(tmp);
      await assert.rejects(
        runAgentHostTurn({
          ...baseRequest(host.endpoint),
          modelId: "not-a-model",
        }),
        (error: unknown) =>
          error instanceof AgentHostError && error.kind === "unsupported",
      );
      assert.ok(!host.calls.some((c) => c.method === "dispatchAction"));
    });

    test("reports a host that is not there as unavailable", async () => {
      await assert.rejects(
        runAgentHostTurn(
          baseRequest({
            socketPath:
              process.platform === "win32"
                ? "\\\\.\\pipe\\copilot-scheduler-missing"
                : path.join(tmp, "missing.sock"),
            token: "secret",
            protocolVersion: "1.1.0",
          }),
        ),
        (error: unknown) =>
          error instanceof AgentHostError && error.kind === "unavailable",
      );
    });

    test("reports a failed turn as failed, never as a reason to run it elsewhere", async () => {
      host = await startFakeHost(tmp, {
        finish: (send) =>
          send({
            type: "chat/error",
            part: { error: { message: "context budget exceeded" } },
          }),
      });
      await assert.rejects(
        runAgentHostTurn(baseRequest(host.endpoint)),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.kind === "failed" &&
          error.turnOutcome === "failed" &&
          error.message === "context budget exceeded",
      );
    });

    test("distinguishes response text from reasoning and tool-only turns", async () => {
      host = await startFakeHost(tmp, {
        finish: (send) => {
          send({ type: "chat/responsePart", part: { id: "p1", kind: "markdown", content: "" } });
          send({ type: "chat/delta", partId: "p1", content: "answer" });
          send({ type: "chat/turnComplete" });
        },
      });
      assert.strictEqual(
        (await runAgentHostTurn(baseRequest(host.endpoint))).responseText,
        "observed",
      );
      await host.close();
      host = await startFakeHost(tmp, {
        finish: (send) => {
          send({ type: "chat/responsePart", part: { id: "r1", kind: "reasoning", content: "thinking" } });
          send({ type: "chat/responsePart", part: { id: "t1", kind: "toolCall" } });
          send({ type: "chat/responsePart", part: { id: "p1", kind: "markdown", content: " \n" } });
          send({ type: "chat/turnComplete" });
        },
      });
      assert.strictEqual(
        (await runAgentHostTurn(baseRequest(host.endpoint))).responseText,
        "not_observed",
      );
    });

    test("reports text as unknown when response parts or deltas cannot be interpreted", async () => {
      host = await startFakeHost(tmp, {
        finish: (send) => {
          send({ type: "chat/delta", partId: "missing", content: "answer" });
          send({ type: "chat/turnComplete" });
        },
      });
      assert.strictEqual(
        (await runAgentHostTurn(baseRequest(host.endpoint))).responseText,
        "unknown",
      );
    });

    test("does not count another turn's text as the scheduled response", async () => {
      host = await startFakeHost(tmp, {
        finish: (send) => {
          send({
            type: "chat/responsePart",
            turnId: "other-turn",
            part: { id: "p1", kind: "markdown", content: "unrelated" },
          });
          send({ type: "chat/turnComplete" });
        },
      });
      assert.strictEqual(
        (await runAgentHostTurn(baseRequest(host.endpoint))).responseText,
        "not_observed",
      );
    });

    test("records a cancelled turn without treating a rejected cancellation as accepted", async () => {
      host = await startFakeHost(tmp, {
        finish: (send) => {
          send({ type: "chat/turnCancelled" }, "no active turn");
          send({ type: "chat/turnCancelled" });
        },
      });
      await assert.rejects(
        runAgentHostTurn(baseRequest(host.endpoint)),
        (error: unknown) =>
          error instanceof AgentHostError && error.turnOutcome === "cancelled",
      );
    });

    test("reports a rejected start without retrying another route", async () => {
      host = await startFakeHost(tmp, {
        acceptStart: false,
        finish: (send) =>
          send({ type: "chat/turnStarted" }, ""),
      });
      let revealed = false;
      await assert.rejects(
        runAgentHostTurn({
          ...baseRequest(host.endpoint),
          onSessionStarted: () => { revealed = true; },
        }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.kind === "failed" &&
          error.turnOutcome === "unknown",
      );
      assert.strictEqual(revealed, false);
    });

    test("cancels and fails a turn that outlives the timeout", async () => {
      host = await startFakeHost(tmp, { finish: () => undefined });
      await assert.rejects(
        runAgentHostTurn({ ...baseRequest(host.endpoint), timeoutMs: 150 }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.kind === "failed" &&
          error.turnOutcome === "unknown",
      );
      const cancelled = host.calls.some(
        (c) =>
          c.method === "dispatchAction" &&
          (c.params.action as { type: string }).type === "chat/turnCancelled",
      );
      assert.ok(cancelled);
    });

    test("waits for a cancellation action rather than treating the RPC reply as confirmation", async () => {
      host = await startFakeHost(tmp, {
        finish: () => undefined,
        cancel: (send) =>
          setTimeout(() => send({ type: "chat/turnCancelled" }), 30),
      });
      await assert.rejects(
        runAgentHostTurn({ ...baseRequest(host.endpoint), timeoutMs: 100 }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.turnOutcome === "cancelled",
      );
    });

    test("tells the caller once the host has accepted the turn", async () => {
      host = await startFakeHost(tmp);
      const started: string[] = [];
      await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        onSessionStarted: (ref) => started.push(ref.chatUri),
      });
      assert.deepStrictEqual(started, ["ahp-chat:/chat-1"]);

      await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        onSessionStarted: () => {
          throw new Error("opening the session failed");
        },
      });
    });

    test("ignores events of other turns and fails when the connection drops mid-run", async () => {
      host = await startFakeHost(tmp, {
        finish: (send) => {
          send({ type: "chat/turnComplete", turnId: "some-other-turn" });
          send({ type: "chat/turnComplete", turnId: undefined });
          send({ type: "chat/error", turnId: "some-other-turn", part: {} });
        },
      });
      await assert.rejects(
        runAgentHostTurn({ ...baseRequest(host.endpoint), timeoutMs: 400 }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.message === "The Agent Host run timed out." &&
          error.turnOutcome === "unknown",
      );

      await host.close();
      host = await startFakeHost(tmp, {
        finish: () => {
          for (const client of host?.sockets() ?? []) {
            client.terminate();
          }
        },
      });
      await assert.rejects(
        runAgentHostTurn({ ...baseRequest(host.endpoint), timeoutMs: 20000 }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.kind === "failed" &&
          error.turnOutcome === "unknown" &&
          /closed/.test(error.message),
      );
    });

    test("continues an existing session instead of creating one", async () => {
      host = await startFakeHost(tmp);
      const result = await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        resume: { sessionUri: "ahp-session:/old", chatUri: "ahp-chat:/old" },
      });
      assert.strictEqual(result.chatUri, "ahp-chat:/old");
      assert.ok(!host.calls.some((c) => c.method === "createSession"));
    });

    test("starts a new session when the host no longer has the one to continue", async () => {
      host = await startFakeHost(tmp, { missingSessions: true });
      const result = await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        resume: { sessionUri: "ahp-session:/gone", chatUri: "ahp-chat:/gone" },
      });
      assert.strictEqual(result.chatUri, "ahp-chat:/chat-1");
      assert.ok(host.calls.some((c) => c.method === "createSession"));
    });
  });

  suite("WebSocket frames", () => {
    const serverFrame = (opcode: number, payload: Buffer, fin = true) => {
      const head =
        payload.length < 126
          ? Buffer.from([(fin ? 0x80 : 0) | opcode, payload.length])
          : payload.length < 65536
            ? Buffer.from([
                (fin ? 0x80 : 0) | opcode,
                126,
                payload.length >> 8,
                payload.length & 0xff,
              ])
            : Buffer.concat([
                Buffer.from([(fin ? 0x80 : 0) | opcode, 127]),
                (() => {
                  const length = Buffer.alloc(8);
                  length.writeBigUInt64BE(BigInt(payload.length));
                  return length;
                })(),
              ]);
      return Buffer.concat([head, payload]);
    };

    test("reads short, medium and long frames split across chunks", () => {
      const parser = new FrameParser();
      const payloads = ["hi", "x".repeat(300), "y".repeat(70000)].map((text) =>
        Buffer.from(text),
      );
      const wire = Buffer.concat(payloads.map((p) => serverFrame(1, p)));
      const seen: string[] = [];
      for (let i = 0; i < wire.length; i += 1000) {
        for (const frame of parser.push(wire.subarray(i, i + 1000))) {
          seen.push(frame.payload.toString());
        }
      }
      assert.deepStrictEqual(
        seen,
        payloads.map((p) => p.toString()),
      );
    });

    test("masks client frames so the server can read them back", () => {
      const key = Buffer.from([1, 2, 3, 4]);
      const frame = encodeClientFrame(1, Buffer.from("hello"), key);
      assert.strictEqual(frame[1] & 0x80, 0x80);
      const decoded = new FrameParser().push(frame);
      assert.strictEqual(decoded[0].payload.toString(), "hello");
    });
  });

  suite("execution route", () => {
    const configWith = (values: Record<string, string>) =>
      ({
        get: (key: string, fallback?: unknown) => values[key] ?? fallback,
      }) as never;

    test("uses the Agent Host by default", () => {
      assert.strictEqual(__testOnly.resolveExecutionRoute(configWith({})), "agentHost");
    });

    test("honours the chat route and the Local harness setting", () => {
      assert.strictEqual(
        __testOnly.resolveExecutionRoute(configWith({ executionRoute: "chat" })),
        "chat",
      );
      assert.strictEqual(
        __testOnly.resolveExecutionRoute(configWith({ sessionHarness: "local" })),
        "chat",
      );
    });
  });
});
