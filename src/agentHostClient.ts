/**
 * Minimal Agent Host Protocol (AHP) client used to run a task through the Agent
 * Host that VS Code already runs for the Copilot harness. Only the few messages
 * needed to start a turn and read its outcome are implemented, so the wire shapes
 * below are local rather than a dependency on the full protocol package.
 */

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { PipeWebSocket } from "./minimalWebSocket";

export type AgentHostFailureKind =
  /** No usable Agent Host; running elsewhere is safe. */
  | "unavailable"
  /** The host cannot honour part of the task; running elsewhere is safe. */
  | "unsupported"
  /** The run started (or may have) and failed; do not run it a second time. */
  | "failed";

export class AgentHostError extends Error {
  constructor(
    readonly kind: AgentHostFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "AgentHostError";
  }
}

export interface AgentHostEndpoint {
  socketPath: string;
  token: string;
  protocolVersion: string;
}

const PROVIDER = "copilotcli";
const PROTOCOL_VERSIONS = ["1.1.0", "1.0.0"];
const SUPPORTED_MAJOR = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const CANCEL_TIMEOUT_MS = 3_000;

/** VS Code keeps `<userData>/User/globalStorage/<extension id>` for each extension. */
export function resolveUserDataDir(globalStoragePath: string): string {
  return path.resolve(globalStoragePath, "..", "..", "..");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Finds the Agent Host that the running VS Code publishes in its local endpoint
 * registry. The registry is an internal VS Code format, so anything unexpected
 * counts as "no host" and the caller runs the task another way.
 */
export function findAgentHostEndpoint(
  userDataDir: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): AgentHostEndpoint | undefined {
  const entriesDir = path.join(
    userDataDir,
    "agent-host",
    "local-endpoint",
    "entries",
  );
  let names: string[];
  try {
    names = fs.readdirSync(entriesDir).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }

  const candidates: Array<AgentHostEndpoint & { mtimeMs: number }> = [];
  for (const name of names) {
    try {
      const file = path.join(entriesDir, name);
      const entry = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
        string,
        unknown
      >;
      const endpoint = entry.endpoint as Record<string, unknown> | undefined;
      const version = typeof entry.protocolVersion === "string"
        ? entry.protocolVersion
        : "";
      if (
        entry.type !== "editor" ||
        entry.schemaVersion !== 2 ||
        typeof entry.pid !== "number" ||
        !isAlive(entry.pid) ||
        endpoint?.type !== "socket" ||
        typeof endpoint.path !== "string" ||
        typeof entry.connectionToken !== "string" ||
        !entry.connectionToken ||
        Number.parseInt(version.split(".")[0] ?? "", 10) !== SUPPORTED_MAJOR
      ) {
        continue;
      }
      candidates.push({
        socketPath: endpoint.path,
        token: entry.connectionToken,
        protocolVersion: version,
        mtimeMs: fs.statSync(file).mtimeMs,
      });
    } catch {
      // An unreadable entry belongs to some other process; skip it.
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const best = candidates[0];
  return best
    ? {
        socketPath: best.socketPath,
        token: best.token,
        protocolVersion: best.protocolVersion,
      }
    : undefined;
}

export function toFileUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface AgentHostAction {
  type: string;
  [key: string]: unknown;
}

/** One JSON-RPC connection to the host (a named pipe carrying a WebSocket). */
export class AgentHostConnection {
  private nextId = 0;
  private clientSeq = 0;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly listeners = new Set<
    (channel: string, action: AgentHostAction) => void
  >();

  private constructor(private readonly socket: PipeWebSocket) {
    socket.onMessage((text) => this.handleMessage(text));
    socket.onClose(() => this.failAll("The Agent Host connection closed."));
  }

  static async open(endpoint: AgentHostEndpoint): Promise<AgentHostConnection> {
    try {
      const socket = await PipeWebSocket.connect(
        endpoint.socketPath,
        `/?tkn=${encodeURIComponent(endpoint.token)}`,
        CONNECT_TIMEOUT_MS,
      );
      return new AgentHostConnection(socket);
    } catch {
      throw new AgentHostError(
        "unavailable",
        "Could not connect to the Agent Host.",
      );
    }
  }
  onAction(
    listener: (channel: string, action: AgentHostAction) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new AgentHostError("unavailable", "The Agent Host connection closed."),
      );
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentHostError("failed", `Agent Host ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  dispatch(
    channel: string,
    action: AgentHostAction,
    timeoutMs?: number,
  ): Promise<unknown> {
    return this.request(
      "dispatchAction",
      { channel, clientSeq: ++this.clientSeq, action },
      timeoutMs,
    );
  }

  close(): void {
    this.failAll("The Agent Host connection closed.");
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }

  private failAll(message: string): void {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new AgentHostError("failed", message));
      this.pending.delete(id);
    }
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    if (typeof message.id === "number" && !message.method) {
      const entry = this.pending.get(message.id);
      if (!entry) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(
          new AgentHostError(
            "failed",
            `Agent Host error ${message.error.code ?? ""}: ${message.error.message ?? ""}`.trim(),
          ),
        );
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      // This client offers no server-callable features.
      this.socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        }),
      );
      return;
    }

    const action = message.params?.action as AgentHostAction | undefined;
    const channel = message.params?.channel;
    if (action && typeof action.type === "string" && typeof channel === "string") {
      for (const listener of [...this.listeners]) {
        listener(channel, action);
      }
    }
  }
}

export interface AgentHostModelOption {
  type?: string;
  enum?: unknown[];
}

export interface AgentHostModelInfo {
  id: string;
  configSchema?: { properties?: Record<string, AgentHostModelOption> };
}

/**
 * Maps the task's model options to the host's per-model option names. Anything the
 * model does not offer is refused so a task never runs with a silently dropped option.
 */
export function mapModelConfiguration(
  model: AgentHostModelInfo,
  requested: Record<string, string | number | undefined>,
): Record<string, string | number> {
  const properties = model.configSchema?.properties ?? {};
  const hostKeys: Record<string, string> = {
    reasoningEffort: "thinkingLevel",
  };
  const config: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(requested)) {
    if (value === undefined || value === "") {
      continue;
    }
    const hostKey = hostKeys[key] ?? key;
    const option = properties[hostKey];
    if (!option) {
      throw new AgentHostError(
        "unsupported",
        `The model does not offer the "${key}" option.`,
      );
    }
    let resolved: string | number = value;
    if (option.type === "number" && typeof value !== "number") {
      resolved = Number(value);
      if (!Number.isFinite(resolved)) {
        throw new AgentHostError(
          "unsupported",
          `The "${key}" value is not a number.`,
        );
      }
    }
    if (option.enum && !option.enum.includes(resolved)) {
      throw new AgentHostError(
        "unsupported",
        `The model does not accept the "${key}" value.`,
      );
    }
    config[hostKey] = resolved;
  }
  return config;
}

export interface AgentHostSessionRef {
  sessionUri: string;
  chatUri: string;
}

export interface AgentHostAttachment {
  label: string;
  uri: string;
}

export interface AgentHostTurnRequest {
  endpoint: AgentHostEndpoint;
  text: string;
  cwdUri?: string;
  modelId?: string;
  modelOptions?: Record<string, string | number | undefined>;
  agentUri?: string;
  attachments?: AgentHostAttachment[];
  autoApprove: boolean;
  timeoutMs: number;
  /** Reuse this session (a "continue" run) when the host still has it. */
  resume?: AgentHostSessionRef;
  /** Called once the host has accepted the turn, so the session can be shown. */
  onSessionStarted?: (ref: AgentHostSessionRef) => void;
}

export interface AgentHostTurnResult extends AgentHostSessionRef {
  requestedModel?: string;
  appliedModel?: string;
}

interface SnapshotResult {
  snapshot?: { state?: Record<string, unknown> };
  state?: Record<string, unknown>;
}

function snapshotState(result: SnapshotResult): Record<string, unknown> {
  return result.snapshot?.state ?? result.state ?? (result as Record<string, unknown>);
}

/** Starts one turn and waits for the host to finish it. */
export async function runAgentHostTurn(
  request: AgentHostTurnRequest,
): Promise<AgentHostTurnResult> {
  const connection = await AgentHostConnection.open(request.endpoint);
  try {
    let prepared: {
      ref: AgentHostSessionRef;
      model?: { id: string; config?: Record<string, string | number> };
    };
    try {
      prepared = await prepareTurn(connection, request);
    } catch (error) {
      // Nothing has been sent yet, so another route can still run the task.
      throw error instanceof AgentHostError && error.kind === "unsupported"
        ? error
        : new AgentHostError(
            "unavailable",
            error instanceof Error ? error.message : "The Agent Host is unavailable.",
          );
    }
    return await runTurn(connection, prepared.ref, request, prepared.model);
  } finally {
    connection.close();
  }
}

async function prepareTurn(
  connection: AgentHostConnection,
  request: AgentHostTurnRequest,
): Promise<{
  ref: AgentHostSessionRef;
  model?: { id: string; config?: Record<string, string | number> };
}> {
  const init = await connection.request<{
    snapshots?: Array<{ state?: { agents?: Array<Record<string, unknown>> } }>;
  }>("initialize", {
    channel: "ahp-root://",
    clientId: `copilot-scheduler-${randomUUID()}`,
    protocolVersions: PROTOCOL_VERSIONS,
    initialSubscriptions: ["ahp-root://"],
    clientInfo: { name: "copilot-scheduler", version: "1" },
  });
  const agents = init.snapshots?.[0]?.state?.agents ?? [];
  const agent = agents.find((candidate) => candidate.provider === PROVIDER) as
    | { models?: AgentHostModelInfo[] }
    | undefined;
  if (!agent) {
    throw new AgentHostError("unsupported", "The Agent Host has no Copilot agent.");
  }

  let model: { id: string; config?: Record<string, string | number> } | undefined;
  if (request.modelId) {
    const info = (agent.models ?? []).find((m) => m.id === request.modelId);
    if (!info) {
      throw new AgentHostError(
        "unsupported",
        "The Agent Host does not offer the requested model.",
      );
    }
    const config = mapModelConfiguration(info, request.modelOptions ?? {});
    model = {
      id: info.id,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
  } else if (
    Object.values(request.modelOptions ?? {}).some((v) => v !== undefined && v !== "")
  ) {
    throw new AgentHostError(
      "unsupported",
      "Model options need a model to apply to.",
    );
  }

  return { ref: await openChat(connection, request), model };
}

async function openChat(
  connection: AgentHostConnection,
  request: AgentHostTurnRequest,
): Promise<AgentHostSessionRef> {
  if (request.resume) {
    try {
      await connection.request("subscribe", { channel: request.resume.sessionUri });
      await connection.request("subscribe", { channel: request.resume.chatUri });
      return request.resume;
    } catch {
      // The host no longer has that session; start a new one.
    }
  }

  const sessionUri = `ahp-session:/${randomUUID()}`;
  await connection.request("createSession", {
    channel: sessionUri,
    provider: PROVIDER,
    ...(request.cwdUri ? { workingDirectories: [request.cwdUri] } : {}),
    ...(request.autoApprove ? { config: { autoApprove: "autoApprove" } } : {}),
  });
  const state = snapshotState(
    await connection.request<SnapshotResult>("subscribe", { channel: sessionUri }),
  );
  const chatUri = state.defaultChat;
  if (typeof chatUri !== "string" || !chatUri) {
    throw new AgentHostError("failed", "The Agent Host session has no chat.");
  }
  await connection.request("subscribe", { channel: chatUri });
  return { sessionUri, chatUri };
}

function runTurn(
  connection: AgentHostConnection,
  ref: AgentHostSessionRef,
  request: AgentHostTurnRequest,
  model: { id: string; config?: Record<string, string | number> } | undefined,
): Promise<AgentHostTurnResult> {
  const turnId = randomUUID();
  return new Promise<AgentHostTurnResult>((resolve, reject) => {
    let appliedModel: string | undefined;
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stopListening();
      outcome();
    };

    const timer = setTimeout(() => {
      // The turn keeps running in the host unless it is cancelled, so give the
      // cancel a moment to arrive before the connection is closed.
      void connection
        .dispatch(
          ref.chatUri,
          {
            type: "chat/turnCancelled",
            turnId,
            duration: request.timeoutMs,
          },
          CANCEL_TIMEOUT_MS,
        )
        .catch(() => undefined)
        .then(() =>
          finish(() =>
            reject(new AgentHostError("failed", "The Agent Host run timed out.")),
          ),
        );
    }, request.timeoutMs);

    const stopListening = connection.onAction((channel, action) => {
      if (channel !== ref.chatUri) {
        return;
      }
      if (action.type === "chat/usage") {
        const usage = action.usage as { model?: unknown } | undefined;
        if (typeof usage?.model === "string") {
          appliedModel = usage.model;
        }
      } else if (action.type === "chat/turnComplete") {
        finish(() =>
          resolve({
            ...ref,
            ...(model ? { requestedModel: model.id } : {}),
            ...(appliedModel ? { appliedModel } : {}),
          }),
        );
      } else if (action.type === "chat/error") {
        const part = action.part as { error?: { message?: unknown } } | undefined;
        const detail =
          typeof part?.error?.message === "string" ? part.error.message : "";
        finish(() =>
          reject(new AgentHostError("failed", detail || "The Agent Host run failed.")),
        );
      } else if (action.type === "chat/turnCancelled") {
        finish(() =>
          reject(new AgentHostError("failed", "The Agent Host run was cancelled.")),
        );
      }
    });

    connection
      .dispatch(ref.chatUri, {
        type: "chat/turnStarted",
        turnId,
        startedAt: new Date().toISOString(),
        message: {
          text: request.text,
          origin: { kind: "user" },
          ...(model ? { model } : {}),
          ...(request.agentUri ? { agent: { uri: request.agentUri } } : {}),
          ...(request.attachments && request.attachments.length > 0
            ? {
                attachments: request.attachments.map((item) => ({
                  type: "resource",
                  label: item.label,
                  uri: item.uri,
                })),
              }
            : {}),
        },
      })
      .then(() => {
        try {
          request.onSessionStarted?.(ref);
        } catch {
          // Revealing the session is best effort and must not fail the run.
        }
      })
      .catch((error: unknown) =>
        finish(() =>
          reject(
            error instanceof AgentHostError
              ? error
              : new AgentHostError("failed", "The Agent Host rejected the run."),
          ),
        ),
      );
  });
}



