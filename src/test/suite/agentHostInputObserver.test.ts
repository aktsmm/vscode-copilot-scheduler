import * as assert from "assert";
import {
  AgentHostInputChange,
  AgentHostQueueBlockedChange,
  observeAgentHostInput,
} from "../../agentHostInputObserver";

type Listener = (
  channel: string,
  action: { type: string; [key: string]: unknown },
  envelope: { rejected: boolean; serverSeq?: number },
) => void;

class FakeConnection {
  readonly listeners = new Set<Listener>();
  readonly closeListeners = new Set<() => void>();
  readonly snapshots = new Map<string, Promise<unknown>>();
  private serverSeq = 0;

  request<T>(_method: string, params: Record<string, unknown>): Promise<T> {
    const snapshot = this.snapshots.get(String(params.channel));
    if (!snapshot) return Promise.reject(new Error("Missing snapshot"));
    return snapshot as Promise<T>;
  }

  onAction(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  emit(channel: string, action: { type: string; [key: string]: unknown }, rejected = false): void {
    const serverSeq = ++this.serverSeq;
    for (const listener of this.listeners) listener(channel, action, { rejected, serverSeq });
  }
}

const ref = {
  sessionUri: "ahp-session:/one",
  chatUri: "ahp-chat:/one",
};

function snapshot(state: Record<string, unknown>, fromSeq = 0): Promise<unknown> {
  return Promise.resolve({ snapshot: { state, fromSeq } });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

suite("Agent Host input observation", () => {
  test("correlates snapshot requests with the target chat and active turn", async () => {
    const connection = new FakeConnection();
    connection.snapshots.set(
      ref.sessionUri,
      snapshot({
        resource: ref.sessionUri,
        inputNeeded: [
          { id: "input", kind: "chatInput", chat: ref.chatUri, request: { id: "question" } },
          { id: "unmatched", kind: "chatInput", chat: ref.chatUri, request: { id: "old" } },
          { id: "other-chat", kind: "toolConfirmation", chat: "ahp-chat:/other", turnId: "turn" },
          { id: "other-turn", kind: "toolAuthentication", chat: ref.chatUri, turnId: "old" },
          { id: "client-tool", kind: "toolClientExecution", chat: ref.chatUri, turnId: "turn" },
          { id: "auth", kind: "toolAuthentication", chat: ref.chatUri, turnId: "turn" },
        ],
      }),
    );
    connection.snapshots.set(
      ref.chatUri,
      snapshot({
        resource: ref.chatUri,
        activeTurn: {
          id: "turn",
          responseParts: [{ kind: "inputRequest", request: { id: "question" } }],
        },
      }),
    );
    const changes: AgentHostInputChange[] = [];
    const stop = observeAgentHostInput(connection, ref, (change) => changes.push(change));
    await flush();
    assert.deepStrictEqual(changes, [
      { id: "input", kind: "chatInput", waiting: true },
      { id: "auth", kind: "toolAuthentication", waiting: true },
    ]);
    stop();
    assert.strictEqual(connection.listeners.size, 0);
    assert.strictEqual(connection.closeListeners.size, 0);
  });

  test("only reports live input after chat request and turn correlation", async () => {
    const connection = new FakeConnection();
    connection.snapshots.set(ref.sessionUri, snapshot({ resource: ref.sessionUri }));
    connection.snapshots.set(
      ref.chatUri,
      snapshot({ resource: ref.chatUri, activeTurn: { id: "turn" } }),
    );
    const changes: AgentHostInputChange[] = [];
    const stop = observeAgentHostInput(connection, ref, (change) => changes.push(change));
    await flush();
    connection.emit(ref.sessionUri, {
      type: "session/inputNeededSet",
      request: { id: "input", kind: "chatInput", chat: ref.chatUri, request: { id: "question" } },
    });
    connection.emit(ref.sessionUri, {
      type: "session/inputNeededSet",
      request: { id: "wrong-turn", kind: "toolConfirmation", chat: ref.chatUri, turnId: "other" },
    });
    connection.emit(ref.chatUri, { type: "chat/inputRequested", request: { id: "question" } }, true);
    assert.deepStrictEqual(changes, []);
    connection.emit(ref.chatUri, { type: "chat/inputRequested", request: { id: "question" } });
    connection.emit(ref.sessionUri, {
      type: "session/inputNeededSet",
      request: { id: "confirmation", kind: "toolConfirmation", chat: ref.chatUri, turnId: "turn" },
    });
    connection.emit(ref.chatUri, { type: "chat/inputCompleted", requestId: "question" });
    connection.emit(ref.sessionUri, { type: "session/inputNeededRemoved", id: "confirmation" });
    assert.deepStrictEqual(changes, [
      { id: "input", kind: "chatInput", waiting: true },
      { id: "confirmation", kind: "toolConfirmation", waiting: true },
      { id: "input", kind: "chatInput", waiting: false },
      { id: "confirmation", kind: "toolConfirmation", waiting: false },
    ]);
    stop();
  });

  test("replays events received while subscribing without confusing another turn", async () => {
    const connection = new FakeConnection();
    let resolveSession!: (value: unknown) => void;
    let resolveChat!: (value: unknown) => void;
    connection.snapshots.set(ref.sessionUri, new Promise((resolve) => { resolveSession = resolve; }));
    connection.snapshots.set(ref.chatUri, new Promise((resolve) => { resolveChat = resolve; }));
    const changes: AgentHostInputChange[] = [];
    const stop = observeAgentHostInput(connection, ref, (change) => changes.push(change));
    connection.emit(ref.chatUri, { type: "chat/turnStarted", turnId: "new" });
    connection.emit(ref.sessionUri, {
      type: "session/inputNeededSet",
      request: { id: "new-input", kind: "chatInput", chat: ref.chatUri, request: { id: "q" } },
    });
    connection.emit(ref.chatUri, { type: "chat/inputRequested", request: { id: "q" } });
    resolveSession({ snapshot: { state: { resource: ref.sessionUri }, fromSeq: 0 } });
    resolveChat({ snapshot: { state: { resource: ref.chatUri, activeTurn: { id: "old" } }, fromSeq: 0 } });
    await flush();
    assert.deepStrictEqual(changes, [{ id: "new-input", kind: "chatInput", waiting: true }]);
    stop();
  });

  test("does not report a request answered while snapshots are loading", async () => {
    const connection = new FakeConnection();
    let resolveSession!: (value: unknown) => void;
    let resolveChat!: (value: unknown) => void;
    connection.snapshots.set(ref.sessionUri, new Promise((resolve) => { resolveSession = resolve; }));
    connection.snapshots.set(ref.chatUri, new Promise((resolve) => { resolveChat = resolve; }));
    const changes: AgentHostInputChange[] = [];
    const stop = observeAgentHostInput(connection, ref, (change) => changes.push(change));
    connection.emit(ref.chatUri, { type: "chat/inputCompleted", requestId: "q" });
    connection.emit(ref.sessionUri, { type: "session/inputNeededRemoved", id: "input" });
    resolveSession({
      snapshot: {
        state: {
          resource: ref.sessionUri,
          inputNeeded: [{ id: "input", kind: "chatInput", chat: ref.chatUri, request: { id: "q" } }],
        },
        fromSeq: 0,
      },
    });
    resolveChat({
      snapshot: {
        state: {
          resource: ref.chatUri,
          activeTurn: { id: "turn", responseParts: [{ kind: "inputRequest", request: { id: "q" } }] },
        },
        fromSeq: 0,
      },
    });
    await flush();
    assert.deepStrictEqual(changes, []);
    stop();
  });

  test("does not replay events already incorporated in each channel snapshot", async () => {
    const connection = new FakeConnection();
    let resolveSession!: (value: unknown) => void;
    let resolveChat!: (value: unknown) => void;
    connection.snapshots.set(ref.sessionUri, new Promise((resolve) => { resolveSession = resolve; }));
    connection.snapshots.set(ref.chatUri, new Promise((resolve) => { resolveChat = resolve; }));
    const changes: AgentHostInputChange[] = [];
    const stop = observeAgentHostInput(connection, ref, (change) => changes.push(change));
    connection.emit(ref.chatUri, { type: "chat/turnStarted", turnId: "old" });
    resolveSession({
      snapshot: {
        state: {
          resource: ref.sessionUri,
          inputNeeded: [{ id: "auth", kind: "toolAuthentication", chat: ref.chatUri, turnId: "new" }],
        },
        fromSeq: 1,
      },
    });
    resolveChat({
      snapshot: { state: { resource: ref.chatUri, activeTurn: { id: "new" } }, fromSeq: 1 },
    });
    await flush();
    assert.deepStrictEqual(changes, [{ id: "auth", kind: "toolAuthentication", waiting: true }]);
    stop();
  });

  test("reports an unorderable buffered snapshot instead of showing stale input", async () => {
    const connection = new FakeConnection();
    let resolveSession!: (value: unknown) => void;
    let resolveChat!: (value: unknown) => void;
    connection.snapshots.set(ref.sessionUri, new Promise((resolve) => { resolveSession = resolve; }));
    connection.snapshots.set(ref.chatUri, new Promise((resolve) => { resolveChat = resolve; }));
    const changes: AgentHostInputChange[] = [];
    let errors = 0;
    observeAgentHostInput(connection, ref, (change) => changes.push(change), {
      onObservationError: () => { errors++; },
    });
    connection.emit(ref.chatUri, { type: "chat/turnStarted", turnId: "old" });
    resolveSession({ snapshot: { state: { resource: ref.sessionUri } } });
    resolveChat({ snapshot: { state: { resource: ref.chatUri, activeTurn: { id: "new" } } } });
    await flush();
    assert.strictEqual(errors, 1);
    assert.deepStrictEqual(changes, []);
    assert.strictEqual(connection.listeners.size, 0);
  });

  test("stops observing instead of continuing blind when too many events arrive before the snapshots", async () => {
    const connection = new FakeConnection();
    connection.snapshots.set(ref.sessionUri, new Promise(() => undefined));
    connection.snapshots.set(ref.chatUri, new Promise(() => undefined));
    let errors = 0;
    observeAgentHostInput(connection, ref, () => undefined, {
      onObservationError: () => { errors++; },
    });
    for (let index = 0; index <= 1024; index++) {
      connection.emit(ref.chatUri, { type: "chat/turnStarted", turnId: `turn-${index}` });
    }
    assert.strictEqual(errors, 1);
    assert.strictEqual(connection.listeners.size, 0);
    assert.strictEqual(connection.closeListeners.size, 0);
  });

  test("reports an unavailable snapshot while still observing later live events", async () => {
    const connection = new FakeConnection();
    connection.snapshots.set(ref.sessionUri, Promise.reject(new Error("unavailable")));
    connection.snapshots.set(ref.chatUri, snapshot({ resource: ref.chatUri }));
    const changes: AgentHostInputChange[] = [];
    let errors = 0;
    const stop = observeAgentHostInput(connection, ref, (change) => changes.push(change), {
      onObservationError: () => { errors++; },
    });
    await flush();
    connection.emit(ref.chatUri, { type: "chat/turnStarted", turnId: "turn" });
    connection.emit(ref.sessionUri, {
      type: "session/inputNeededSet",
      request: { id: "auth", kind: "toolAuthentication", chat: ref.chatUri, turnId: "turn" },
    });
    assert.strictEqual(errors, 1);
    assert.deepStrictEqual(changes, [{ id: "auth", kind: "toolAuthentication", waiting: true }]);
    stop();
  });

  test("stops a queued observer only when its own turn finishes", async () => {
    const connection = new FakeConnection();
    connection.snapshots.set(ref.sessionUri, snapshot({ resource: ref.sessionUri }));
    connection.snapshots.set(ref.chatUri, snapshot({ resource: ref.chatUri }));
    let stopped = 0;
    const stop = observeAgentHostInput(connection, ref, () => undefined, {
      queuedMessageId: "queued",
      onStopped: () => { stopped++; },
    });
    await flush();
    connection.emit(ref.chatUri, { type: "chat/turnStarted", turnId: "other", queuedMessageId: "other" });
    connection.emit(ref.chatUri, { type: "chat/turnComplete", turnId: "other" });
    assert.strictEqual(stopped, 0);
    connection.emit(ref.chatUri, { type: "chat/turnStarted", turnId: "own", queuedMessageId: "queued" });
    connection.emit(ref.chatUri, { type: "chat/turnComplete", turnId: "own" });
    assert.strictEqual(stopped, 1);
    stop();
    assert.strictEqual(stopped, 1);
  });

  test("reports a confirmed queue left pending after a failed turn and clears it on start", async () => {
    const connection = new FakeConnection();
    connection.snapshots.set(ref.sessionUri, snapshot({ resource: ref.sessionUri }));
    connection.snapshots.set(ref.chatUri, snapshot({ resource: ref.chatUri, activeTurn: { id: "previous" } }));
    let accept!: () => void;
    const queuedAcceptance = new Promise<void>((resolve) => { accept = resolve; });
    const changes: AgentHostQueueBlockedChange[] = [];
    const stop = observeAgentHostInput(connection, ref, () => undefined, {
      queuedMessageId: "queued",
      queuedAcceptance,
      onQueueBlocked: (change) => changes.push(change),
    });
    await flush();
    connection.snapshots.set(ref.chatUri, snapshot({
      resource: ref.chatUri,
      queuedMessages: [{ id: "queued", kind: "queued" }],
    }));
    connection.emit("ahp-chat:/other", { type: "chat/error", turnId: "previous" });
    connection.emit(ref.chatUri, { type: "chat/error", turnId: "previous" });
    await flush();
    assert.deepStrictEqual(changes, [], "the notification requires queue acceptance");
    accept();
    await flush();
    assert.deepStrictEqual(changes, [{ id: "queued", waiting: true }]);
    connection.emit(ref.chatUri, { type: "chat/turnStarted", turnId: "own", queuedMessageId: "queued" });
    assert.deepStrictEqual(changes, [
      { id: "queued", waiting: true },
      { id: "queued", waiting: false },
    ]);
    stop();
  });

  test("detects a cancelled turn buffered during subscription and clears a removed message", async () => {
    const connection = new FakeConnection();
    let resolveSession!: (value: unknown) => void;
    let resolveChat!: (value: unknown) => void;
    connection.snapshots.set(ref.sessionUri, new Promise((resolve) => { resolveSession = resolve; }));
    connection.snapshots.set(ref.chatUri, new Promise((resolve) => { resolveChat = resolve; }));
    const changes: AgentHostQueueBlockedChange[] = [];
    const stop = observeAgentHostInput(connection, ref, () => undefined, {
      queuedMessageId: "queued",
      onQueueBlocked: (change) => changes.push(change),
    });
    connection.emit(ref.chatUri, { type: "chat/turnCancelled", turnId: "previous" });
    resolveSession({ snapshot: { state: { resource: ref.sessionUri }, fromSeq: 1 } });
    resolveChat({
      snapshot: {
        state: { resource: ref.chatUri, queuedMessages: [{ id: "queued", kind: "queued" }] },
        fromSeq: 1,
      },
    });
    await flush();
    assert.deepStrictEqual(changes, [{ id: "queued", waiting: true }]);
    connection.emit(ref.chatUri, { type: "chat/pendingMessageRemoved", kind: "queued", id: "queued" });
    assert.deepStrictEqual(changes, [
      { id: "queued", waiting: true },
      { id: "queued", waiting: false },
    ]);
    stop();
  });

  test("does not report missing, actively progressing, or already-started queued messages", async () => {
    for (const state of [
      { resource: ref.chatUri, queuedMessages: [{ id: "other", kind: "queued" }] },
      { resource: ref.chatUri, queuedMessages: [{ id: "queued", kind: "queued" }], activeTurn: { id: "other" } },
    ]) {
      const connection = new FakeConnection();
      connection.snapshots.set(ref.sessionUri, snapshot({ resource: ref.sessionUri }));
      connection.snapshots.set(ref.chatUri, snapshot(state));
      const changes: AgentHostQueueBlockedChange[] = [];
      const stop = observeAgentHostInput(connection, ref, () => undefined, {
        queuedMessageId: "queued",
        onQueueBlocked: (change) => changes.push(change),
      });
      await flush();
      connection.emit(ref.chatUri, { type: "chat/error", turnId: "previous" });
      await flush();
      assert.deepStrictEqual(changes, []);
      stop();
    }

    const connection = new FakeConnection();
    connection.snapshots.set(ref.sessionUri, snapshot({ resource: ref.sessionUri }));
    connection.snapshots.set(ref.chatUri, snapshot({ resource: ref.chatUri }));
    const changes: AgentHostQueueBlockedChange[] = [];
    const stop = observeAgentHostInput(connection, ref, () => undefined, {
      queuedMessageId: "queued",
      onQueueBlocked: (change) => changes.push(change),
    });
    await flush();
    let resolveStale!: (value: unknown) => void;
    connection.snapshots.set(ref.chatUri, new Promise((resolve) => { resolveStale = resolve; }));
    connection.emit(ref.chatUri, { type: "chat/error", turnId: "previous" });
    await flush();
    connection.emit(ref.chatUri, { type: "chat/turnStarted", turnId: "own", queuedMessageId: "queued" });
    resolveStale({
      snapshot: { state: { resource: ref.chatUri, queuedMessages: [{ id: "queued", kind: "queued" }] } },
    });
    await flush();
    assert.deepStrictEqual(changes, []);
    stop();
  });
});
