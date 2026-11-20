import * as assert from "assert";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { pathToFileURL } from "url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AgentHostError,
  disposeAgentHostInputObservers,
  findAgentHostEndpoint,
  isAgentHostTurnTerminal,
  listAgentHostChats,
  listAgentHostModels,
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
  broadcast: (channel: string, action: Record<string, unknown>) => void;
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
    missingSessionCode?: number;
    sessionPages?: Array<{
      items: Array<Record<string, unknown>>;
      nextCursor?: string;
    }>;
    queueAck?: boolean;
    queueRejected?: boolean;
    queueStateMissing?: boolean;
    keepNewTurnQueued?: boolean;
    removalAck?: boolean;
    distinctChats?: boolean;
    queueInterference?: "otherClient" | "otherSequence" | "missingOrigin";
    queueInterferenceRejected?: boolean;
    models?: unknown;
    resolvedSessionConfig?: unknown;
    sessionState?: Record<string, unknown>;
    chatState?: Record<string, unknown>;
    nullChatSnapshot?: boolean;
  } = {},
): Promise<FakeHost> {
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\copilot-scheduler-test-${process.pid}-${Date.now()}`
      : path.join(tmp, "host.sock");
  const calls: Recorded[] = [];
  const sessionChats = new Map<string, string>();
  const pending = new Map<string, Array<{ id: string; kind: string }>>();
  const active = new Map<string, string>();
  const turns = new Map<string, Array<{ id: string; state: string }>>();
  let nextChat = 0;
  let nextTurn = 0;
  let serverSeq = 0;
  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket: WebSocket, request) => {
    assert.ok(request.url?.includes("tkn=secret"));
    let clientId = "";
    const notify = (
      channel: string,
      action: Record<string, unknown>,
      rejectionReason?: string,
      origin?: { clientId: string; clientSeq: number },
    ) =>
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "action",
          params: {
            channel,
            action,
            serverSeq: ++serverSeq,
            ...(rejectionReason === undefined ? {} : { rejectionReason }),
            ...(origin === undefined ? {} : { origin }),
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
          assert.ok(typeof message.params.clientId === "string");
          clientId = message.params.clientId;
          reply({
            protocolVersion: "1.1.0",
            snapshots: [
              {
                state: {
                  agents: [{
                    provider: "copilotcli",
                    models: Object.hasOwn(behaviour, "models")
                      ? behaviour.models
                      : MODELS,
                  }],
                },
              },
            ],
          });
          break;
        case "createSession":
          sessionChats.set(
            String(message.params.channel),
            `ahp-chat:/chat-${behaviour.distinctChats ? ++nextChat : 1}`,
          );
          reply(null);
          break;
        case "resolveSessionConfig":
          reply(behaviour.resolvedSessionConfig);
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
                error: { code: behaviour.missingSessionCode ?? -32001, message: "Unknown session" },
              }),
            );
          } else {
            const sessions =
              behaviour.sessionPages?.flatMap((page) => page.items) ?? [];
            const channel = String(message.params.channel);
            if (behaviour.nullChatSnapshot && channel.startsWith("ahp-chat:")) {
              reply(null);
              break;
            }
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
                  fromSeq: serverSeq,
                  state: {
                    resource: session.resource,
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
                  fromSeq: serverSeq,
                  state: {
                    resource: chat.resource,
                    provider: chat.provider,
                    title: chat.title,
                    workingDirectories:
                      chat.workingDirectories ?? parent?.workingDirectories,
                    queuedMessages: behaviour.queueStateMissing ? [] : pending.get(channel) ?? [],
                    activeTurn: active.has(channel) ? { id: active.get(channel) } : undefined,
                    turns: turns.get(channel) ?? [],
                  },
                },
              });
            } else {
              const isSession = channel.startsWith("ahp-session:");
              const defaultChat = sessionChats.get(channel) ??
                channel.replace("ahp-session:", "ahp-chat:");
              reply({
                snapshot: {
                  fromSeq: serverSeq,
                  state: {
                    resource: channel,
                    ...(isSession
                      ? {
                          defaultChat,
                          lifecycle: "ready",
                          provider: "copilotcli",
                          chats: [{ resource: defaultChat }],
                        }
                      : {
                          provider: "copilotcli",
                          queuedMessages: behaviour.queueStateMissing ? [] : pending.get(channel) ?? [],
                          activeTurn: active.has(channel) ? { id: active.get(channel) } : undefined,
                          turns: turns.get(channel) ?? [],
                        }),
                    ...(isSession
                      ? behaviour.sessionState
                      : behaviour.chatState),
                  },
                },
              });
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
          if (action.type === "chat/turnCancelled" && behaviour.cancel) {
            behaviour.cancel((next) =>
              notify(channel, { turnId: action.turnId, ...next }),
            );
          } else if (action.type === "chat/pendingMessageRemoved" && behaviour.removalAck) {
            notify(channel, action, undefined, { clientId, clientSeq: Number(message.params.clientSeq) });
          } else if (action.type === "chat/pendingMessageSet") {
            if (!behaviour.queueRejected && typeof action.id === "string") {
              const items = (pending.get(channel) ?? []).filter((item) => item.id !== action.id);
              items.push({ id: action.id, kind: "queued" });
              pending.set(channel, items);
            }
            if (behaviour.queueAck !== false) {
              const clientSeq = message.params.clientSeq;
              assert.ok(typeof clientSeq === "number");
              const origin = { clientId, clientSeq };
              if (behaviour.queueInterference) {
                const otherOrigin =
                  behaviour.queueInterference === "otherClient"
                    ? { clientId: "other-client", clientSeq }
                    : behaviour.queueInterference === "otherSequence"
                      ? { clientId, clientSeq: clientSeq + 1 }
                      : undefined;
                notify(
                  channel,
                  { type: "chat/pendingMessageSet", id: action.id, kind: "queued" },
                  behaviour.queueInterferenceRejected ? "previous rejection" : undefined,
                  otherOrigin,
                );
              }
              notify(
                channel,
                {
                  type: "chat/pendingMessageSet",
                  id: action.id,
                  kind: "queued",
                },
                behaviour.queueRejected ? "queue rejected" : undefined,
                origin,
              );
            }
            if (
              typeof action.id === "string" &&
              action.id.startsWith("copilot-scheduler-turn-") &&
              !behaviour.queueRejected &&
              !behaviour.keepNewTurnQueued
            ) {
              const messageId = action.id;
              const turnId = `turn-${++nextTurn}`;
              const startedAt = new Date(Date.now() + nextTurn).toISOString();
              const send = (next: Record<string, unknown>, rejectionReason?: string) => {
                const sent = {
                  turnId,
                  ...(next.type === "chat/turnStarted"
                    ? { queuedMessageId: messageId, startedAt }
                    : {}),
                  ...next,
                };
                if (rejectionReason === undefined && sent.turnId === turnId) {
                  if (next.type === "chat/turnStarted") {
                    active.set(channel, turnId);
                    pending.set(channel, (pending.get(channel) ?? []).filter((item) => item.id !== messageId));
                  } else if (
                    next.type === "chat/turnComplete" ||
                    next.type === "chat/error" ||
                    next.type === "chat/turnCancelled"
                  ) {
                    active.delete(channel);
                    const state = next.type === "chat/turnComplete"
                      ? "complete"
                      : next.type === "chat/error" ? "error" : "cancelled";
                    turns.set(channel, [...(turns.get(channel) ?? []), { id: turnId, state }]);
                  }
                }
                notify(channel, sent, rejectionReason);
              };
              if (behaviour.acceptStart !== false) send({ type: "chat/turnStarted" });
              if (behaviour.finish) {
                behaviour.finish(send);
              } else {
                send({ type: "chat/usage", usage: { model: "claude-sonnet-5.5" } });
                send({ type: "chat/turnComplete" });
              }
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
    broadcast: (channel, action) => {
      const message = JSON.stringify({
        jsonrpc: "2.0",
        method: "action",
        params: { channel, action, serverSeq: ++serverSeq },
      });
      for (const client of wss.clients) client.send(message);
    },
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
    const hostModelId = "vendor/group/model::variant";
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
      models: [{
        id: hostModelId,
        configSchema: {
          properties: { thinkingLevel: { type: "string", enum: ["high"] } },
        },
      }],
    });
    try {
      const request = {
        endpoint: host.endpoint,
        targetChatId: toAgentHostChatBindingId(chatUri).toUpperCase(),
        expectedWorkspacePath: tmp,
        taskId: "stable-task-id",
        text: "Review today's changes",
        modelId: hostModelId,
        hostModelIdExplicit: true,
        modelOptions: { reasoningEffort: "high" },
      };
      const first = await queueAgentHostMessage(request);
      const second = await queueAgentHostMessage(request);
      assert.strictEqual(first.messageId, second.messageId);
      const fallback = await queueAgentHostMessage({
        ...request,
        taskId: "with-fallback",
        modelId: "missing",
        modelFallback: { agentHostModelId: hostModelId },
      });
      assert.strictEqual(fallback.requestedModel, hostModelId);
      assert.strictEqual(fallback.fallbackFromModel, "missing");
      const fallbackDispatch = host.calls.find((call) => call.method === "dispatchAction" &&
        (call.params.action as { id?: string }).id === fallback.messageId);
      assert.deepStrictEqual((fallbackDispatch?.params.action as { message: { model: unknown } }).message.model,
        { id: hostModelId });
      assert.match(first.messageId, /^copilot-scheduler-[a-f0-9]{64}$/);
      const occurrence = await queueAgentHostMessage({ ...request, occurrenceId: "2026-01-01T10:00:00.000Z" });
      const retry = await queueAgentHostMessage({ ...request, occurrenceId: "2026-01-01T10:00:00.000Z" });
      const next = await queueAgentHostMessage({ ...request, occurrenceId: "2026-01-01T11:00:00.000Z" });
      const otherTask = await queueAgentHostMessage({
        ...request, taskId: "another-task", occurrenceId: "2026-01-01T10:00:00.000Z",
      });
      assert.match(occurrence.messageId, /^copilot-scheduler-occurrence-[a-f0-9]{64}$/);
      assert.strictEqual(occurrence.messageId, retry.messageId);
      assert.notStrictEqual(occurrence.messageId, next.messageId);
      assert.notStrictEqual(occurrence.messageId, first.messageId);
      assert.notStrictEqual(occurrence.messageId, otherTask.messageId);
      await assert.rejects(
        queueAgentHostMessage({ ...request, taskId: undefined, occurrenceId: "occurrence" }),
        (error: unknown) => error instanceof AgentHostError && error.kind === "unsupported",
      );
      const queued = host.calls.filter((call) => {
        if (call.method !== "dispatchAction") return false;
        const action = call.params.action as Record<string, unknown> | undefined;
        return action?.type === "chat/pendingMessageSet";
      });
      assert.strictEqual(queued.length, 7);
      const firstAction = queued[0].params.action as Record<string, unknown>;
      assert.strictEqual(firstAction.kind, "queued");
      assert.strictEqual(firstAction.id, first.messageId);
      assert.deepStrictEqual(
        (firstAction.message as { model: unknown }).model,
        { id: hostModelId, config: { thinkingLevel: "high" } },
      );

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
        7,
      );
    } finally {
      await host.close();
    }
  });

  test("requires queue state as well as a matching dispatch echo", async () => {
    const chatUri = "ahp-copilotcli:/chat-1";
    const host = await startFakeHost(tmp, {
      sessionPages: [{
        items: [{
          resource: "ahp-copilotcli:/session-1",
          provider: "copilotcli",
          workingDirectories: [pathToFileURL(tmp).href],
          chats: [{ resource: chatUri, interactivity: "interactive" }],
        }],
      }],
      queueStateMissing: true,
    });
    try {
      await assert.rejects(
        queueAgentHostMessage({
          endpoint: host.endpoint,
          targetChatId: toAgentHostChatBindingId(chatUri),
          taskId: "stable-task-id",
          text: "synthetic",
        }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.kind === "failed" &&
          error.turnOutcome === "unknown",
      );
      assert.strictEqual(
        host.calls.filter((call) =>
          call.method === "dispatchAction" &&
          (call.params.action as { type?: string }).type === "chat/pendingMessageSet",
        ).length,
        1,
      );
    } finally {
      await host.close();
    }
  });

  test("queues behind an input-waiting turn without starting or completing it", async () => {
    let sendTurnEvent: ((action: Record<string, unknown>) => void) | undefined;
    let acceptStart!: (value: { ref: { sessionUri: string; chatUri: string }; turnId: string }) => void;
    const started = new Promise<{ ref: { sessionUri: string; chatUri: string }; turnId: string }>((resolve) => {
      acceptStart = resolve;
    });
    const host = await startFakeHost(tmp, {
      finish: (send) => {
        sendTurnEvent = send;
        send({ type: "chat/inputRequested", turnId: undefined, requestId: "input-1" });
      },
    });
    let runSettled = false;
    const running = runAgentHostTurn({
      ...baseRequest(host.endpoint),
      onSessionStarted: (ref, turnId) => acceptStart({ ref, turnId }),
    });
    void running.then(() => { runSettled = true; }, () => { runSettled = true; });
    try {
      const { ref, turnId } = await Promise.race([
        started,
        running.then(() => assert.fail("the input-waiting turn must not complete yet")),
      ]);
      assert.strictEqual(await isAgentHostTurnTerminal(host.endpoint, ref, turnId), false);
      const queued = await queueAgentHostMessage({
        endpoint: host.endpoint,
        targetChatId: toAgentHostChatBindingId(ref.chatUri),
        resume: ref,
        taskId: "another-task",
        text: "synthetic queued message",
      });
      assert.strictEqual(queued.chatUri, ref.chatUri);
      assert.strictEqual(runSettled, false, "queue acceptance is not turn completion");
      const actions = host.calls
        .filter((call) => call.method === "dispatchAction")
        .map((call) => call.params.action as { type: string; kind?: string });
      assert.strictEqual(actions.filter((action) => action.type === "chat/pendingMessageSet").length, 2);
      assert.ok(actions.every((action) => action.type !== "chat/turnStarted"));
      assert.ok(actions.every((action) => action.kind !== "steering"));
      assert.ok(sendTurnEvent);
      sendTurnEvent({ type: "chat/inputCompleted", turnId: undefined, requestId: "input-1" });
      sendTurnEvent({ type: "chat/turnComplete" });
      await running;
      assert.strictEqual(await isAgentHostTurnTerminal(host.endpoint, ref, turnId), true);
      assert.strictEqual(await isAgentHostTurnTerminal(host.endpoint, ref, "unrelated-turn"), false);
    } finally {
      await host.close();
    }
  });

  test("observes input on a running turn without answering it", async () => {
    let sendTurnEvent!: (action: Record<string, unknown>) => void;
    let acceptStart!: (ref: { sessionUri: string; chatUri: string }) => void;
    let acceptInput!: () => void;
    const started = new Promise<{ sessionUri: string; chatUri: string }>((resolve) => {
      acceptStart = resolve;
    });
    const inputSeen = new Promise<void>((resolve) => { acceptInput = resolve; });
    const host = await startFakeHost(tmp, { finish: (send) => { sendTurnEvent = send; } });
    const changes: Array<{ id: string; kind: string; waiting: boolean }> = [];
    const running = runAgentHostTurn({
      ...baseRequest(host.endpoint),
      onSessionStarted: (ref) => acceptStart(ref),
      onInputNeeded: (_ref, change) => {
        changes.push(change);
        if (change.waiting) acceptInput();
      },
    });
    try {
      const ref = await started;
      host.broadcast(ref.sessionUri, {
        type: "session/inputNeededSet",
        request: { id: "input", kind: "chatInput", chat: ref.chatUri, request: { id: "question" } },
      });
      host.broadcast(ref.chatUri, { type: "chat/inputRequested", request: { id: "question" } });
      await inputSeen;
      host.broadcast(ref.chatUri, { type: "chat/inputCompleted", requestId: "question" });
      sendTurnEvent({ type: "chat/turnComplete" });
      await running;
      assert.deepStrictEqual(changes, [
        { id: "input", kind: "chatInput", waiting: true },
        { id: "input", kind: "chatInput", waiting: false },
      ]);
      assert.ok(host.calls.every((call) =>
        call.method !== "dispatchAction" ||
        (call.params.action as { type?: string }).type !== "chat/inputCompleted",
      ));
    } finally {
      await host.close();
    }
  });

  test("keeps observing a queued chat until its own turn finishes", async () => {
    const sessionUri = "ahp-session:/existing";
    const chatUri = "ahp-chat:/existing";
    const host = await startFakeHost(tmp, {
      sessionPages: [{
        items: [{
          resource: sessionUri,
          provider: "copilotcli",
          workingDirectories: [pathToFileURL(tmp).href],
          chats: [{ resource: chatUri, interactivity: "interactive" }],
        }],
      }],
    });
    const changes: Array<{ id: string; kind: string; waiting: boolean }> = [];
    let acceptInput!: () => void;
    const inputSeen = new Promise<void>((resolve) => { acceptInput = resolve; });
    try {
      const queued = await queueAgentHostMessage({
        endpoint: host.endpoint,
        targetChatId: toAgentHostChatBindingId(chatUri),
        taskId: "task",
        text: "synthetic",
        inputObservationTimeoutMs: 5000,
        onInputNeeded: (_ref, change) => {
          changes.push(change);
          if (change.waiting) acceptInput();
        },
      });
      const socket = [...host.sockets()][0];
      assert.ok(socket, "queue acceptance must retain the observation connection");
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      host.broadcast(chatUri, { type: "chat/turnStarted", turnId: "previous", queuedMessageId: "previous" });
      host.broadcast(sessionUri, {
        type: "session/inputNeededSet",
        request: { id: "approval", kind: "toolConfirmation", chat: chatUri, turnId: "previous" },
      });
      await inputSeen;
      host.broadcast(sessionUri, { type: "session/inputNeededRemoved", id: "approval" });
      host.broadcast(chatUri, { type: "chat/turnComplete", turnId: "previous" });
      host.broadcast(chatUri, { type: "chat/turnStarted", turnId: "own", queuedMessageId: queued.messageId });
      host.broadcast(chatUri, { type: "chat/turnComplete", turnId: "own" });
      await closed;
      assert.deepStrictEqual(changes, [
        { id: "approval", kind: "toolConfirmation", waiting: true },
        { id: "approval", kind: "toolConfirmation", waiting: false },
      ]);
    } finally {
      disposeAgentHostInputObservers();
      await host.close();
    }
  });

  test("reports a queue left pending after an earlier turn is cancelled", async () => {
    const sessionUri = "ahp-session:/existing";
    const chatUri = "ahp-chat:/existing";
    const host = await startFakeHost(tmp, {
      sessionPages: [{
        items: [{
          resource: sessionUri,
          provider: "copilotcli",
          workingDirectories: [pathToFileURL(tmp).href],
          chats: [{ resource: chatUri, interactivity: "interactive" }],
        }],
      }],
    });
    const changes: Array<{ id: string; waiting: boolean }> = [];
    let acceptBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { acceptBlocked = resolve; });
    try {
      const queued = await queueAgentHostMessage({
        endpoint: host.endpoint,
        targetChatId: toAgentHostChatBindingId(chatUri),
        taskId: "task",
        text: "synthetic",
        inputObservationTimeoutMs: 5000,
        onQueueBlocked: (_ref, change) => {
          changes.push(change);
          if (change.waiting) acceptBlocked();
        },
      });
      const socket = [...host.sockets()][0];
      assert.ok(socket, "queue observation must keep the connection open");
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      host.broadcast(chatUri, { type: "chat/turnCancelled", turnId: "previous" });
      await blocked;
      host.broadcast(chatUri, { type: "chat/turnStarted", turnId: "own", queuedMessageId: queued.messageId });
      host.broadcast(chatUri, { type: "chat/turnComplete", turnId: "own" });
      await closed;
      assert.deepStrictEqual(changes, [
        { id: queued.messageId, waiting: true },
        { id: queued.messageId, waiting: false },
      ]);
      assert.strictEqual(host.calls.filter((call) =>
        call.method === "dispatchAction" &&
        (call.params.action as { type?: string }).type === "chat/pendingMessageSet",
      ).length, 1, "observation must not resend the task");
    } finally {
      disposeAgentHostInputObservers();
      await host.close();
    }
  });

  test("does not send a new or queued message if the pre-dispatch write fails", async () => {
    const sessionUri = "ahp-session:/existing";
    const chatUri = "ahp-chat:/existing";
    const host = await startFakeHost(tmp, {
      sessionPages: [{
        items: [{
          resource: sessionUri,
          provider: "copilotcli",
          workingDirectories: [pathToFileURL(tmp).href],
          chats: [{ resource: chatUri, interactivity: "interactive" }],
        }],
      }],
    });
    const failWrite = async () => { throw new Error("storage unavailable"); };
    try {
      await assert.rejects(runAgentHostTurn({
        ...baseRequest(host.endpoint), beforeDispatch: failWrite,
      }), /storage unavailable/);
      await assert.rejects(queueAgentHostMessage({
        endpoint: host.endpoint,
        targetChatId: toAgentHostChatBindingId(chatUri),
        text: "synthetic",
        beforeDispatch: failWrite,
      }), /storage unavailable/);
      assert.strictEqual(host.calls.filter((call) =>
        call.method === "dispatchAction" &&
        (call.params.action as { type?: string }).type === "chat/pendingMessageSet",
      ).length, 0);
    } finally {
      await host.close();
    }
  });

  test("does not subscribe to input when the dispatch guard rejects", async () => {
    const sessionUri = "ahp-session:/existing";
    const chatUri = "ahp-chat:/existing";
    const host = await startFakeHost(tmp, {
      sessionPages: [{
        items: [{
          resource: sessionUri,
          provider: "copilotcli",
          workingDirectories: [pathToFileURL(tmp).href],
          chats: [{ resource: chatUri, interactivity: "interactive" }],
        }],
      }],
    });
    try {
      await assert.rejects(queueAgentHostMessage({
        endpoint: host.endpoint,
        targetChatId: toAgentHostChatBindingId(chatUri),
        text: "synthetic",
        onInputNeeded: () => assert.fail("input must not be reported before dispatch"),
        dispatchGuard: async () => { throw new Error("blocked"); },
      }), /blocked/);
      assert.strictEqual(host.calls.filter((call) => call.method === "subscribe").length, 2);
      assert.strictEqual(host.calls.filter((call) => call.method === "dispatchAction").length, 0);
    } finally {
      await host.close();
    }
  });

  test("closes a queued input observer on timeout or extension disposal", async () => {
    const sessionUri = "ahp-session:/existing";
    const chatUri = "ahp-chat:/existing";
    const host = await startFakeHost(tmp, {
      sessionPages: [{
        items: [{
          resource: sessionUri,
          provider: "copilotcli",
          workingDirectories: [pathToFileURL(tmp).href],
          chats: [{ resource: chatUri, interactivity: "interactive" }],
        }],
      }],
    });
    try {
      for (const timeout of [true, false]) {
        await queueAgentHostMessage({
          endpoint: host.endpoint,
          targetChatId: toAgentHostChatBindingId(chatUri),
          text: "synthetic",
          inputObservationTimeoutMs: timeout ? 100 : 5000,
          onInputNeeded: () => undefined,
        });
        const socket = [...host.sockets()][0];
        assert.ok(socket);
        const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        if (!timeout) disposeAgentHostInputObservers();
        await closed;
      }
    } finally {
      disposeAgentHostInputObservers();
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

  test("ignores another dispatch's queued notification after dispatch starts", async () => {
    const chatUri = "ahp-copilotcli:/chat-1";
    const session = {
      resource: "ahp-copilotcli:/session-1",
      provider: "copilotcli",
      workingDirectories: [pathToFileURL(tmp).href],
      chats: [{ resource: chatUri, title: "Daily review", interactivity: "interactive" }],
    };
    for (const queueInterference of ["otherClient", "otherSequence", "missingOrigin"] as const) {
      const host = await startFakeHost(tmp, {
        sessionPages: [{ items: [session] }],
        queueInterference,
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
          queueInterference,
        );
      } finally {
        await host.close();
      }
    }
  });

  test("ignores another dispatch's rejection after dispatch starts", async () => {
    const chatUri = "ahp-copilotcli:/chat-1";
    const session = {
      resource: "ahp-copilotcli:/session-1",
      provider: "copilotcli",
      workingDirectories: [pathToFileURL(tmp).href],
      chats: [{ resource: chatUri, title: "Daily review", interactivity: "interactive" }],
    };
    const host = await startFakeHost(tmp, {
      sessionPages: [{ items: [session] }],
      queueInterference: "otherClient",
      queueInterferenceRejected: true,
    });
    try {
      const queued = await queueAgentHostMessage({
        endpoint: host.endpoint,
        targetChatId: toAgentHostChatBindingId(chatUri),
        taskId: "stable-task-id",
        text: "Review today's changes",
      });
      assert.match(queued.messageId, /^copilot-scheduler-[a-f0-9]{64}$/);
    } finally {
      await host.close();
    }
  });

  test("ignores an earlier queued notification before the guard dispatches", async () => {
    const chatUri = "ahp-copilotcli:/chat-1";
    const taskId = "stable-task-id";
    const messageId = `copilot-scheduler-${createHash("sha256").update(taskId).digest("hex")}`;
    const session = {
      resource: "ahp-copilotcli:/session-1",
      provider: "copilotcli",
      workingDirectories: [pathToFileURL(tmp).href],
      chats: [{ resource: chatUri, title: "Daily review", interactivity: "interactive" }],
    };
    const host = await startFakeHost(tmp, { sessionPages: [{ items: [session] }] });
    try {
      await assert.rejects(
        queueAgentHostMessage({
          endpoint: host.endpoint,
          targetChatId: toAgentHostChatBindingId(chatUri),
          taskId,
          text: "Review today's changes",
          dispatchGuard: async () => {
            const socket = [...host.sockets()][0];
            assert.ok(socket);
            const clientId = host.calls.find((call) => call.method === "initialize")?.params.clientId;
            assert.ok(typeof clientId === "string");
            const received = new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("Host ping timed out")), 3000);
              socket.once("pong", () => {
                clearTimeout(timeout);
                resolve();
              });
            });
            socket.send(JSON.stringify({
              jsonrpc: "2.0",
              method: "action",
              params: {
                channel: chatUri,
                action: { type: "chat/pendingMessageSet", id: messageId, kind: "queued" },
                origin: { clientId, clientSeq: 1 },
              },
            }));
            socket.ping();
            await received;
          },
        }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.kind === "failed" &&
          /reservation did not allow/.test(error.message),
      );
      assert.strictEqual(host.calls.filter((call) =>
        call.method === "dispatchAction" &&
        (call.params.action as { type?: string }).type === "chat/pendingMessageSet",
      ).length, 0);

      const queued = await queueAgentHostMessage({
        endpoint: host.endpoint,
        targetChatId: toAgentHostChatBindingId(chatUri),
        taskId,
        text: "Review today's changes",
        dispatchGuard: async (dispatch) => { dispatch(); dispatch(); },
      });
      assert.strictEqual(queued.messageId, messageId);
      assert.strictEqual(host.calls.filter((call) =>
        call.method === "dispatchAction" &&
        (call.params.action as { type?: string }).type === "chat/pendingMessageSet",
      ).length, 1);
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
          (call.params.action as { type: string }).type === "chat/pendingMessageSet",
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

  test("without a run timeout a long turn outlives the pre-dispatch bound and is never cancelled", async () => {
    const host = await startFakeHost(tmp, {
      finish: (send) => {
        setTimeout(() => send({ type: "chat/turnComplete" }), 400);
      },
    });
    try {
      const result = await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        timeoutMs: undefined,
        preDispatchTimeoutMs: 100,
      });
      assert.ok(result.sessionUri);
      assert.ok(!host.calls.some(
        (call) =>
          call.method === "dispatchAction" &&
          (call.params.action as { type: string }).type === "chat/turnCancelled",
      ));
    } finally {
      await host.close();
    }
  });

  test("without a run timeout a step stuck before dispatch is still abandoned", async () => {
    const host = await startFakeHost(tmp);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    try {
      await assert.rejects(
        runAgentHostTurn({
          ...baseRequest(host.endpoint),
          timeoutMs: undefined,
          preDispatchTimeoutMs: 100,
          dispatchGuard: async (dispatch) => { await hold; dispatch(); },
        }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.message === "The Agent Host run timed out before dispatch." &&
          error.timeout === "beforeDispatch" &&
          error.turnOutcome === "unknown",
      );
      release();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assert.ok(!host.calls.some(
        (call) =>
          call.method === "dispatchAction" &&
          (call.params.action as { type: string }).type === "chat/pendingMessageSet",
      ));
    } finally {
      release();
      await host.close();
    }
  });

  test("a guard that skips dispatch fails without sending a turn", async () => {
    const host = await startFakeHost(tmp);
    try {
      await assert.rejects(
        runAgentHostTurn({
          ...baseRequest(host.endpoint),
          timeoutMs: 200,
          dispatchGuard: async () => {},
        }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.kind === "failed" &&
          error.message === "The task reservation did not allow a turn.",
      );
      assert.ok(!host.calls.some(
        (call) =>
          call.method === "dispatchAction" &&
          (call.params.action as { type: string }).type === "chat/pendingMessageSet",
      ));
    } finally {
      await host.close();
    }
  });

  test("a guard cannot dispatch the same turn twice", async () => {
    let responseScheduled = false;
    const host = await startFakeHost(tmp, {
      finish: (send) => {
        if (!responseScheduled) {
          responseScheduled = true;
          setTimeout(() => send({ type: "chat/turnComplete" }), 50);
        }
      },
    });
    try {
      await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        dispatchGuard: async (dispatch) => { dispatch(); dispatch(); },
      });
      assert.strictEqual(host.calls.filter(
        (call) =>
          call.method === "dispatchAction" &&
          (call.params.action as { type: string }).type === "chat/pendingMessageSet",
      ).length, 1);
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
          (call.params.action as { type: string }).type === "chat/pendingMessageSet",
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

    test("rejects explicit invalid types, empty numbers and out-of-range values", () => {
      const boundedModel = {
        id: "bounded",
        configSchema: {
          properties: {
            thinkingLevel: { type: "string", enum: ["low", "high"] },
            contextSize: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      };
      for (const options of [
        { reasoningEffort: 1 },
        { reasoningEffort: "" },
        { contextSize: "" },
        { contextSize: 1.5 },
        { contextSize: 101 },
      ]) {
        assert.throws(
          () => mapModelConfiguration(boundedModel, options),
          (error: unknown) =>
            error instanceof AgentHostError && error.kind === "unsupported",
        );
      }
      assert.deepStrictEqual(mapModelConfiguration(boundedModel, {}), {});
    });
  });

  suite("running a turn", () => {
    let host: FakeHost | undefined;

    teardown(async () => {
      await host?.close();
      host = undefined;
    });

    test("runs new sessions concurrently even for the same folder and approval policy", async () => {
      const senders: Array<(action: Record<string, unknown>) => void> = [];
      const refs: Array<{ sessionUri: string; chatUri: string }> = [];
      let acceptStarts!: () => void;
      const started = new Promise<void>((resolve) => { acceptStarts = resolve; });
      host = await startFakeHost(tmp, {
        distinctChats: true,
        finish: (send) => { senders.push(send); },
      });
      const request = {
        ...baseRequest(host.endpoint),
        cwdUri: pathToFileURL(tmp).href,
        onSessionStarted: (ref: { sessionUri: string; chatUri: string }) => {
          refs.push(ref);
          if (refs.length === 2) acceptStarts();
        },
      };
      const first = runAgentHostTurn(request);
      const second = runAgentHostTurn(request);
      void first.catch(() => undefined);
      void second.catch(() => undefined);
      await Promise.race([
        started,
        Promise.all([first, second]).then(() => assert.fail("both starts must be observed before completion")),
      ]);
      assert.notStrictEqual(refs[0].sessionUri, refs[1].sessionUri);
      assert.notStrictEqual(refs[0].chatUri, refs[1].chatUri);
      assert.strictEqual(senders.length, 2);
      senders[1]({ type: "chat/turnComplete" });
      senders[0]({ type: "chat/turnComplete" });
      await Promise.all([first, second]);
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
      assert.deepStrictEqual(
        host.calls.slice(0, 5).map((call) => call.method),
        ["initialize", "createSession", "subscribe", "subscribe", "dispatchAction"],
        "legacy runs must not negotiate workspace configuration",
      );
      const turn = host.calls.find(
        (c) =>
          c.method === "dispatchAction" &&
          (c.params.action as { type: string }).type === "chat/pendingMessageSet",
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

    test("a legacy turn accepts a null chat subscription without parsing workspace metadata", async () => {
      host = await startFakeHost(tmp, { nullChatSnapshot: true });
      const result = await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        cwdUri: pathToFileURL(tmp).href,
      });
      assert.strictEqual(result.chatUri, "ahp-chat:/chat-1");
      assert.strictEqual(result.responseText, "not_observed");
      assert.strictEqual(result.workspaceMode, undefined);
      assert.strictEqual(result.workspaceModeApplication, undefined);
      assert.ok(!host.calls.some((call) => call.method === "resolveSessionConfig"));
      assert.strictEqual(
        host.calls.filter((call) => call.method === "dispatchAction").length,
        1,
      );
    });

    test("an explicit folder preference rejects a null chat snapshot before dispatch", async () => {
      const cwdUri = pathToFileURL(tmp).href;
      host = await startFakeHost(tmp, {
        nullChatSnapshot: true,
        resolvedSessionConfig: {
          schema: {
            properties: {
              isolation: { type: "string", enum: ["folder", "worktree"] },
            },
          },
          values: { isolation: "folder" },
        },
        sessionState: {
          config: { values: { isolation: "folder" } },
          workingDirectories: [cwdUri],
        },
      });
      await assert.rejects(
        runAgentHostTurn({
          ...baseRequest(host.endpoint),
          cwdUri,
          workspaceMode: "folder",
        }),
        (error: unknown) =>
          error instanceof AgentHostError && error.kind === "workspaceMode",
      );
      assert.ok(!host.calls.some((call) => call.method === "dispatchAction"));
    });

    test("confirms a new folder session from session-only metadata and preserves the approval policy", async () => {
      const cwdUri = pathToFileURL(tmp).href;
      for (const autoApprove of [true, false]) {
        host = await startFakeHost(tmp, {
          resolvedSessionConfig: {
            schema: {
              properties: {
                isolation: { type: "string", enum: ["folder", "worktree"] },
              },
            },
            values: { isolation: "folder" },
          },
          sessionState: {
            config: { values: { isolation: "folder" } },
            workingDirectories: [
              pathToFileURL(
                (process.platform === "win32" ? tmp.toUpperCase() : tmp) + path.sep,
              ).href,
            ],
          },
        });
        const result = await runAgentHostTurn({
          ...baseRequest(host.endpoint),
          cwdUri,
          autoApprove,
          workspaceMode: "folder",
        });
        assert.strictEqual(result.workspaceMode, "folder");
        assert.strictEqual(
          result.workspaceModeApplication,
          "new_session_config_confirmed",
        );
        const config = {
          isolation: "folder",
          ...(autoApprove ? { autoApprove: "autoApprove" } : {}),
        };
        assert.deepStrictEqual(
          host.calls.find((call) => call.method === "resolveSessionConfig")?.params,
          {
            channel: "ahp-root://",
            provider: "copilotcli",
            workingDirectory: cwdUri,
            config,
          },
        );
        const create = host.calls.find((call) => call.method === "createSession");
        assert.deepStrictEqual(create?.params.config, config);
        assert.deepStrictEqual(create?.params.workingDirectories, [cwdUri]);
        assert.strictEqual(
          host.calls.filter((call) => call.method === "dispatchAction").length,
          1,
        );
        await host.close();
        host = undefined;
      }
    });

    test("refuses unconfirmed workspace configurations and folder snapshots before dispatch", async () => {
      const cwdUri = pathToFileURL(tmp).href;
      const schema = {
        properties: {
          isolation: { type: "string", enum: ["folder", "worktree"] },
        },
      };
      const sessionState = {
        config: { values: { isolation: "folder" } },
        workingDirectories: [cwdUri],
      };
      const cases: Array<{
        name: string;
        resolvedSessionConfig?: unknown;
        sessionState?: Record<string, unknown>;
        chatState?: Record<string, unknown>;
        request?: Partial<AgentHostTurnRequest>;
        createsSession?: boolean;
      }> = [
        { name: "missing capability", resolvedSessionConfig: null },
        { name: "malformed schema", resolvedSessionConfig: { schema: [] } },
        {
          name: "non-string isolation",
          resolvedSessionConfig: {
            schema: { properties: { isolation: { type: "boolean", enum: ["folder"] } } },
            values: { isolation: "folder" },
          },
        },
        {
          name: "unsupported isolation",
          resolvedSessionConfig: {
            schema: { properties: { isolation: { type: "string", enum: ["worktree"] } } },
            values: { isolation: "folder" },
          },
        },
        { name: "missing resolved value", resolvedSessionConfig: { schema, values: {} } },
        {
          name: "ignored preference",
          resolvedSessionConfig: { schema, values: { isolation: "worktree" } },
        },
        {
          name: "invalid request enum",
          request: { workspaceMode: "FOLDER" as never },
        },
        { name: "missing execution folder", request: { cwdUri: undefined } },
        {
          name: "snapshot mode mismatch",
          sessionState: { ...sessionState, config: { values: { isolation: "worktree" } } },
          createsSession: true,
        },
        {
          name: "snapshot mode missing",
          sessionState: { ...sessionState, config: { values: {} } },
          createsSession: true,
        },
        {
          name: "wrong folder",
          sessionState: { ...sessionState, workingDirectories: [pathToFileURL(path.join(tmp, "other")).href] },
          createsSession: true,
        },
        {
          name: "missing folder",
          sessionState: { config: sessionState.config },
          createsSession: true,
        },
        {
          name: "multiple folders",
          sessionState: { ...sessionState, workingDirectories: [cwdUri, cwdUri] },
          createsSession: true,
        },
        {
          name: "non-local folder",
          sessionState: { ...sessionState, workingDirectories: ["vscode-remote://ssh-remote/work"] },
          createsSession: true,
        },
        {
          name: "chat folder overrides matching session",
          chatState: { workingDirectories: [] },
          createsSession: true,
        },
      ];
      for (const scenario of cases) {
        host = await startFakeHost(tmp, {
          resolvedSessionConfig: { schema, values: { isolation: "folder" } },
          sessionState,
          ...scenario,
        });
        await assert.rejects(
          runAgentHostTurn({
            ...baseRequest(host.endpoint),
            cwdUri,
            workspaceMode: "folder",
            ...scenario.request,
          }),
          (error: unknown) =>
            error instanceof AgentHostError && error.kind === "workspaceMode",
          scenario.name,
        );
        assert.ok(
          !host.calls.some((call) => call.method === "dispatchAction"),
          scenario.name,
        );
        assert.strictEqual(
          host.calls.some((call) => call.method === "createSession"),
          scenario.createsSession === true,
          scenario.name,
        );
        await host.close();
        host = undefined;
      }
    });

    test("resumes a worktree despite a folder creation preference without reconfiguration", async () => {
      const cwdUri = pathToFileURL(tmp).href;
      host = await startFakeHost(tmp, {
        resolvedSessionConfig: {
          schema: {
            properties: {
              isolation: { type: "string", enum: ["folder", "worktree"] },
            },
          },
          values: { isolation: "worktree" },
        },
        sessionState: {
          config: { values: { isolation: "worktree" } },
          workingDirectories: [pathToFileURL(path.join(tmp, "isolated")).href],
        },
      });
      const created = await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        cwdUri,
        workspaceMode: "worktree",
      });
      assert.strictEqual(created.workspaceModeApplication, "new_session_config_confirmed");
      const callsBeforeResume = host.calls.length;
      const resumed = await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        cwdUri,
        workspaceMode: "folder",
        resume: { sessionUri: created.sessionUri, chatUri: created.chatUri },
      });
      assert.strictEqual(resumed.sessionUri, created.sessionUri);
      assert.strictEqual(resumed.chatUri, created.chatUri);
      assert.strictEqual(resumed.workspaceMode, "folder");
      assert.strictEqual(resumed.workspaceModeApplication, "not_applied_resumed");
      const resumedCalls = host.calls.slice(callsBeforeResume);
      const initializeIndex = resumedCalls.findIndex((call) => call.method === "initialize");
      assert.deepStrictEqual(
        resumedCalls.slice(initializeIndex, initializeIndex + 4).map((call) => call.method),
        ["initialize", "subscribe", "subscribe", "dispatchAction"],
      );
    });

    test("applies the folder creation preference when a resumed session has gone stale", async () => {
      const cwdUri = pathToFileURL(tmp).href;
      host = await startFakeHost(tmp, {
        missingSessions: true,
        resolvedSessionConfig: {
          schema: {
            properties: {
              isolation: { type: "string", enum: ["folder", "worktree"] },
            },
          },
          values: { isolation: "folder" },
        },
        sessionState: {
          config: { values: { isolation: "folder" } },
          workingDirectories: [cwdUri],
        },
      });
      const result = await runAgentHostTurn({
        ...baseRequest(host.endpoint),
        cwdUri,
        workspaceMode: "folder",
        resume: { sessionUri: "ahp-session:/gone", chatUri: "ahp-chat:/gone" },
      });
      assert.notStrictEqual(result.sessionUri, "ahp-session:/gone");
      assert.strictEqual(result.workspaceMode, "folder");
      assert.strictEqual(result.workspaceModeApplication, "new_session_config_confirmed");
      assert.strictEqual(
        (host.calls.find((call) => call.method === "createSession")?.params.config as Record<string, unknown>).isolation,
        "folder",
      );
      assert.ok(host.calls.some((call) => call.method === "resolveSessionConfig"));
    });

    test("an ambiguous workspace can resume but cannot create a session after a missing cached reference", async () => {
      host = await startFakeHost(tmp, { missingSessions: true });
      const request: AgentHostTurnRequest = {
        ...baseRequest(host.endpoint),
        cwdUri: pathToFileURL(tmp).href,
        workspaceMode: "folder",
        allowNewSession: false,
      };
      const resumed = await runAgentHostTurn({
        ...request,
        resume: { sessionUri: "ahp-session:/old", chatUri: "ahp-chat:/old" },
      });
      assert.strictEqual(resumed.sessionUri, "ahp-session:/old");
      assert.strictEqual(resumed.workspaceMode, "folder");
      assert.strictEqual(resumed.workspaceModeApplication, "not_applied_resumed");
      assert.ok(!host.calls.some((call) => call.method === "createSession"));
      for (const resume of [
        undefined,
        { sessionUri: "ahp-session:/gone", chatUri: "ahp-chat:/gone" },
      ]) {
        const before = host.calls.length;
        await assert.rejects(
          runAgentHostTurn({ ...request, resume }),
          (error: unknown) =>
            error instanceof AgentHostError && error.kind === "workspaceMode",
        );
        assert.ok(
          !host.calls.slice(before).some((call) =>
            ["resolveSessionConfig", "createSession", "dispatchAction"].includes(call.method),
          ),
          "a missing cached session must not negotiate, create or dispatch",
        );
      }
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

    test("requires an explicit opaque BYOK ID and sends it for new and continued turns", async () => {
      const id = "openai-codex/Codex Bridge/default::gpt-6.2-sol";
      host = await startFakeHost(tmp, {
        models: [{
          id,
          name: "Synthetic Bridge",
          _meta: { byokModelIdentifier: "opaque-renderer-identifier" },
          configSchema: {
            properties: {
              thinkingLevel: { type: "string", enum: ["high"] },
            },
          },
        }],
      });
      assert.deepStrictEqual(await listAgentHostModels(host.endpoint), [
        { id, name: "Synthetic Bridge" },
      ]);
      await assert.rejects(
        runAgentHostTurn({ ...baseRequest(host.endpoint), modelId: id }),
        (error: unknown) =>
          error instanceof AgentHostError && error.kind === "modelIdentity",
      );
      assert.ok(!host.calls.some((call) => call.method === "dispatchAction"));
      for (const resume of [
        undefined,
        { sessionUri: "ahp-session:/old", chatUri: "ahp-chat:/old" },
      ]) {
        await runAgentHostTurn({
          ...baseRequest(host.endpoint),
          modelId: id,
          hostModelIdExplicit: true,
          modelOptions: { reasoningEffort: "high" },
          ...(resume ? { resume } : {}),
        });
      }
      const turns = host.calls.filter(
        (call) =>
          call.method === "dispatchAction" &&
          (call.params.action as { type: string }).type === "chat/pendingMessageSet",
      );
      assert.strictEqual(turns.length, 2);
      for (const turn of turns) {
        const action = turn.params.action as {
          message: { model: unknown };
        };
        assert.deepStrictEqual(action.message.model, {
          id,
          config: { thinkingLevel: "high" },
        });
      }
    });

    test("dispatches an explicit Host replacement once without copying options", async () => {
      const replacement = "vendor/group/replacement";
      const disabled = "vendor/group/disabled";
      host = await startFakeHost(tmp, { models: [{ id: replacement }, { id: disabled, policyState: "disabled" }] });
      const request = {
        ...baseRequest(host.endpoint),
        modelId: "missing",
        hostModelIdExplicit: true,
        modelOptions: { reasoningEffort: "high" },
      };
      for (const modelFallback of [{}, { agentHostModelId: "vendor/group/absent" }, { agentHostModelId: disabled }]) {
        await assert.rejects(runAgentHostTurn({ ...request, modelFallback }),
          (error: unknown) => error instanceof AgentHostError && error.kind === "unsupported");
      }
      // A Chat-catalog ID that is only absent from the Host catalog is not proof the model is gone.
      await assert.rejects(
        runAgentHostTurn({ ...request, hostModelIdExplicit: false, modelFallback: { agentHostModelId: replacement } }),
        (error: unknown) => error instanceof AgentHostError && error.kind === "unsupported");
      assert.ok(!host.calls.some((call) => call.method === "dispatchAction"));
      const result = await runAgentHostTurn({ ...request, modelFallback: { agentHostModelId: replacement } });
      assert.strictEqual(result.requestedModel, replacement);
      assert.strictEqual(result.fallbackFromModel, "missing");
      const turns = host.calls.filter((call) => call.method === "dispatchAction" &&
        (call.params.action as { type: string }).type === "chat/pendingMessageSet");
      assert.strictEqual(turns.length, 1);
      assert.deepStrictEqual((turns[0].params.action as { message: { model: unknown } }).message.model,
        { id: replacement });
    });

    test("does not dispatch on missing, malformed or duplicate live Host IDs", async () => {
      const id = "vendor/group/model";
      for (const models of [
        [],
        [{ id }, { id }],
        [{ id: null }],
        null,
      ]) {
        host = await startFakeHost(tmp, { models });
        await assert.rejects(
          runAgentHostTurn({
            ...baseRequest(host.endpoint),
            modelId: id,
            hostModelIdExplicit: true,
          }),
          (error: unknown) =>
            error instanceof AgentHostError &&
            ["unavailable", "unsupported", "modelIdentity"].includes(error.kind),
        );
        assert.ok(!host.calls.some((call) => call.method === "dispatchAction"));
        await host.close();
        host = undefined;
      }
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

    test("does not claim queued cancellation from a possibly no-op removal echo", async () => {
      host = await startFakeHost(tmp, { keepNewTurnQueued: true, removalAck: true });
      await assert.rejects(
        runAgentHostTurn({ ...baseRequest(host.endpoint), timeoutMs: 100 }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.kind === "failed" &&
          error.turnOutcome === "unknown",
      );
      const actions = host.calls
        .filter((call) => call.method === "dispatchAction")
        .map((call) => (call.params.action as { type: string }).type);
      assert.deepStrictEqual(actions, ["chat/pendingMessageSet", "chat/pendingMessageRemoved"]);
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
          error.timeout === "run" &&
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

    test("does not replace a continued session when its verification fails ambiguously", async () => {
      host = await startFakeHost(tmp, { missingSessions: true, missingSessionCode: -32002 });
      await assert.rejects(
        runAgentHostTurn({
          ...baseRequest(host.endpoint),
          resume: { sessionUri: "ahp-session:/gone-unknown", chatUri: "ahp-chat:/gone-unknown" },
        }),
        (error: unknown) =>
          error instanceof AgentHostError &&
          error.kind === "failed" &&
          error.turnOutcome === "unknown",
      );
      assert.ok(!host.calls.some((call) => call.method === "createSession"));
      assert.ok(!host.calls.some((call) => call.method === "dispatchAction"));
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
