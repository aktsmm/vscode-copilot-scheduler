export type AgentHostInputKind =
  | "chatInput"
  | "toolConfirmation"
  | "toolAuthentication";

export interface AgentHostInputChange {
  id: string;
  kind: AgentHostInputKind;
  waiting: boolean;
}

export interface AgentHostQueueBlockedChange {
  id: string;
  waiting: boolean;
}

interface AgentHostInputRef {
  sessionUri: string;
  chatUri: string;
}

interface InputAction {
  type: string;
  [key: string]: unknown;
}

interface InputConnection {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
  onAction(
    listener: (
      channel: string,
      action: InputAction,
      envelope: { rejected: boolean; serverSeq?: number },
    ) => void,
  ): () => void;
  onClose(listener: () => void): () => void;
}

interface InputRequest {
  id: string;
  kind: AgentHostInputKind;
  chat: string;
  turnId?: string;
  requestId?: string;
}

type InputEvent =
  | { type: "set"; request: InputRequest }
  | { type: "remove"; id: string }
  | { type: "start"; turnId: string; queuedMessageId?: string }
  | { type: "input"; requestId: string }
  | { type: "answered"; requestId: string }
  | { type: "finish"; turnId: string; outcome: "completed" | "failed" | "cancelled" }
  | { type: "unqueued"; messageId: string };

interface BufferedInputEvent {
  channel: string;
  event: InputEvent;
  serverSeq?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 2048
    ? value
    : undefined;
}

function readInputRequest(value: unknown, chatUri: string): InputRequest | undefined {
  if (!isRecord(value) || value.chat !== chatUri) return undefined;
  const id = identifier(value.id);
  if (!id) return undefined;
  if (value.kind === "chatInput") {
    const requestId = isRecord(value.request)
      ? identifier(value.request.id)
      : undefined;
    return requestId
      ? { id, kind: value.kind, chat: chatUri, requestId }
      : undefined;
  }
  if (value.kind === "toolConfirmation" || value.kind === "toolAuthentication") {
    const turnId = identifier(value.turnId);
    return turnId ? { id, kind: value.kind, chat: chatUri, turnId } : undefined;
  }
  return undefined;
}

function readEvent(
  ref: AgentHostInputRef,
  channel: string,
  action: InputAction,
): InputEvent | undefined {
  if (channel === ref.sessionUri) {
    if (action.type === "session/inputNeededSet") {
      const request = readInputRequest(action.request, ref.chatUri);
      if (request) return { type: "set", request };
      const id = isRecord(action.request) ? identifier(action.request.id) : undefined;
      return id ? { type: "remove", id } : undefined;
    }
    if (action.type === "session/inputNeededRemoved") {
      const id = identifier(action.id);
      return id ? { type: "remove", id } : undefined;
    }
    return undefined;
  }
  if (channel !== ref.chatUri) return undefined;
  if (action.type === "chat/turnStarted") {
    const turnId = identifier(action.turnId);
    const queuedMessageId = identifier(action.queuedMessageId);
    return turnId
      ? { type: "start", turnId, ...(queuedMessageId ? { queuedMessageId } : {}) }
      : undefined;
  }
  if (action.type === "chat/inputRequested") {
    const requestId = isRecord(action.request)
      ? identifier(action.request.id)
      : undefined;
    return requestId ? { type: "input", requestId } : undefined;
  }
  if (action.type === "chat/inputCompleted") {
    const requestId = identifier(action.requestId);
    return requestId ? { type: "answered", requestId } : undefined;
  }
  if (action.type === "chat/pendingMessageRemoved" && action.kind === "queued") {
    const messageId = identifier(action.id);
    return messageId ? { type: "unqueued", messageId } : undefined;
  }
  if (
    action.type === "chat/turnComplete" ||
    action.type === "chat/turnCancelled" ||
    action.type === "chat/error"
  ) {
    const turnId = identifier(action.turnId);
    return turnId
      ? {
          type: "finish",
          turnId,
          outcome: action.type === "chat/error"
            ? "failed"
            : action.type === "chat/turnCancelled"
              ? "cancelled"
              : "completed",
        }
      : undefined;
  }
  return undefined;
}

function snapshotState(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result)) return undefined;
  if (isRecord(result.snapshot) && isRecord(result.snapshot.state)) {
    return result.snapshot.state;
  }
  return isRecord(result.state) ? result.state : result;
}

function snapshotSequence(result: unknown): number | undefined {
  if (!isRecord(result) || !isRecord(result.snapshot)) return undefined;
  const sequence = result.snapshot.fromSeq;
  return typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
    ? sequence
    : undefined;
}

export function observeAgentHostInput(
  connection: InputConnection,
  ref: AgentHostInputRef,
  onChange: (change: AgentHostInputChange) => void,
  options: {
    queuedMessageId?: string;
    isQueuedStart?: (serverSeq: number | undefined) => boolean;
    queuedAcceptance?: Promise<void>;
    onQueueBlocked?: (change: AgentHostQueueBlockedChange) => void;
    timeoutMs?: number;
    onStopped?: () => void;
    onObservationError?: () => void;
  } = {},
): () => void {
  const requests = new Map<string, InputRequest>();
  const visible = new Map<string, AgentHostInputKind>();
  let activeTurnId: string | undefined;
  let activeInputIds = new Set<string>();
  let observedTurnId: string | undefined;
  let stopped = false;
  let buffering = true;
  const buffered: BufferedInputEvent[] = [];
  let queueBlocked = false;
  let queueCheckGeneration = 0;

  const report = (change: AgentHostInputChange) => {
    try {
      onChange(change);
    } catch {
      options.onObservationError?.();
    }
  };
  const reconcile = () => {
    const next = new Map<string, AgentHostInputKind>();
    for (const request of requests.values()) {
      if (
        activeTurnId &&
        (request.kind === "chatInput"
          ? !!request.requestId && activeInputIds.has(request.requestId)
          : request.turnId === activeTurnId)
      ) {
        next.set(request.id, request.kind);
      }
    }
    for (const [id, kind] of visible) {
      if (next.get(id) !== kind) report({ id, kind, waiting: false });
    }
    for (const [id, kind] of next) {
      if (visible.get(id) !== kind) report({ id, kind, waiting: true });
    }
    visible.clear();
    for (const [id, kind] of next) visible.set(id, kind);
  };
  const recordQueuedStart = (event: InputEvent, serverSeq?: number) => {
    if (
      event.type === "start" &&
      options.queuedMessageId &&
      event.queuedMessageId === options.queuedMessageId &&
      (options.isQueuedStart?.(serverSeq) ?? true)
    ) {
      observedTurnId = event.turnId;
    }
  };
  const reportQueueBlocked = (waiting: boolean) => {
    if (!options.queuedMessageId || queueBlocked === waiting) return;
    queueBlocked = waiting;
    try {
      options.onQueueBlocked?.({ id: options.queuedMessageId, waiting });
    } catch {
      options.onObservationError?.();
    }
  };
  const checkBlockedQueue = () => {
    if (!options.queuedMessageId || !options.onQueueBlocked) return;
    const generation = ++queueCheckGeneration;
    void Promise.resolve(options.queuedAcceptance).then(async () => {
      if (stopped || generation !== queueCheckGeneration || observedTurnId) return;
      try {
        const result = await connection.request<unknown>("subscribe", { channel: ref.chatUri });
        if (stopped || generation !== queueCheckGeneration || observedTurnId) return;
        const chat = snapshotState(result);
        if (chat?.resource !== ref.chatUri || !Array.isArray(chat.queuedMessages)) {
          options.onObservationError?.();
          return;
        }
        const waiting = !chat.activeTurn && chat.queuedMessages.some((entry) =>
          isRecord(entry) &&
          entry.id === options.queuedMessageId &&
          (entry.kind === undefined || entry.kind === "queued"),
        );
        reportQueueBlocked(waiting);
      } catch {
        if (!stopped && generation === queueCheckGeneration) options.onObservationError?.();
      }
    });
  };
  const observeQueueEvent = (event: InputEvent) => {
    if (
      (event.type === "start" && event.turnId === observedTurnId) ||
      (event.type === "unqueued" && event.messageId === options.queuedMessageId)
    ) {
      queueCheckGeneration++;
      reportQueueBlocked(false);
    } else if (
      event.type === "finish" &&
      event.outcome !== "completed" &&
      event.turnId !== observedTurnId
    ) {
      checkBlockedQueue();
    }
  };
  const apply = (event: InputEvent, serverSeq?: number) => {
    switch (event.type) {
      case "set":
        requests.set(event.request.id, event.request);
        break;
      case "remove":
        requests.delete(event.id);
        break;
      case "start":
        activeTurnId = event.turnId;
        activeInputIds = new Set();
        recordQueuedStart(event, serverSeq);
        break;
      case "input":
        if (activeTurnId) activeInputIds.add(event.requestId);
        break;
      case "answered":
        activeInputIds.delete(event.requestId);
        break;
      case "finish":
        if (event.turnId === activeTurnId) {
          activeTurnId = undefined;
          activeInputIds.clear();
        }
        break;
      case "unqueued":
        break;
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    stopListening();
    stopWatchingClose();
    for (const [id, kind] of visible) report({ id, kind, waiting: false });
    visible.clear();
    reportQueueBlocked(false);
    options.onStopped?.();
  };
  const handle = (event: InputEvent, serverSeq?: number) => {
    apply(event, serverSeq);
    observeQueueEvent(event);
    reconcile();
    if (event.type === "finish" && event.turnId === observedTurnId) stop();
  };
  const stopListening = connection.onAction((channel, action, envelope) => {
    if (stopped || envelope.rejected) return;
    const event = readEvent(ref, channel, action);
    if (!event) return;
    if (buffering) {
      if (buffered.length >= 1024) {
        // Without the opening snapshot the state would be blind, so stop observing.
        options.onObservationError?.();
        stop();
        return;
      }
      buffered.push({ channel, event, serverSeq: envelope.serverSeq });
    } else {
      handle(event, envelope.serverSeq);
    }
  });
  const stopWatchingClose = connection.onClose(stop);
  const timer = options.timeoutMs
    ? setTimeout(stop, options.timeoutMs)
    : undefined;

  void Promise.all([
    connection.request<unknown>("subscribe", { channel: ref.sessionUri }),
    connection.request<unknown>("subscribe", { channel: ref.chatUri }),
  ]).then(
    ([sessionResult, chatResult]) => {
      if (stopped || !buffering) return;
      const session = snapshotState(sessionResult);
      const chat = snapshotState(chatResult);
      const sessionSeq = snapshotSequence(sessionResult);
      const chatSeq = snapshotSequence(chatResult);
      if (session?.resource !== ref.sessionUri || chat?.resource !== ref.chatUri) {
        options.onObservationError?.();
      }
      if (buffered.some(({ channel, serverSeq }) =>
        serverSeq === undefined ||
        (channel === ref.sessionUri ? sessionSeq : chatSeq) === undefined,
      )) {
        options.onObservationError?.();
        stop();
        return;
      }
      if (session?.resource === ref.sessionUri && Array.isArray(session.inputNeeded)) {
        for (const value of session.inputNeeded) {
          const request = readInputRequest(value, ref.chatUri);
          if (request) requests.set(request.id, request);
        }
      }
      if (chat?.resource === ref.chatUri && isRecord(chat.activeTurn)) {
        activeTurnId = identifier(chat.activeTurn.id);
        if (Array.isArray(chat.activeTurn.responseParts)) {
          for (const part of chat.activeTurn.responseParts) {
            if (
              isRecord(part) &&
              part.kind === "inputRequest" &&
              part.response === undefined &&
              isRecord(part.request)
            ) {
              const requestId = identifier(part.request.id);
              if (requestId) activeInputIds.add(requestId);
            }
          }
        }
      }
      buffering = false;
      const replay = buffered.filter(({ channel, serverSeq }) =>
        serverSeq! > (channel === ref.sessionUri ? sessionSeq! : chatSeq!),
      );
      for (const { event, serverSeq } of buffered) recordQueuedStart(event, serverSeq);
      for (const { event, serverSeq } of replay) apply(event, serverSeq);
      reconcile();
      for (const { event } of buffered) observeQueueEvent(event);
      if (buffered.some(({ event }) => event.type === "finish" && event.turnId === observedTurnId)) {
        stop();
      }
      buffered.length = 0;
    },
    () => {
      if (stopped || !buffering) return;
      options.onObservationError?.();
      buffering = false;
      buffered.length = 0;
    },
  );
  return stop;
}
