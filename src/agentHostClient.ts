/**
 * Minimal Agent Host Protocol (AHP) client used to run a task through the Agent
 * Host that VS Code already runs for the Copilot harness. Only the few messages
 * needed to start a turn and read its outcome are implemented, so the wire shapes
 * below are local rather than a dependency on the full protocol package.
 */

import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import { PipeWebSocket } from "./minimalWebSocket";
import {
  observeAgentHostInput,
  type AgentHostInputChange,
  type AgentHostQueueBlockedChange,
} from "./agentHostInputObserver";
import type {
  AgentHostResponseTextObservation,
  AgentHostTurnOutcome,
  AgentHostWorkspaceMode,
  AgentHostWorkspaceApplication,
} from "./types";

export type AgentHostFailureKind =
  /** No usable Agent Host; running elsewhere is safe. */
  | "unavailable"
  /** The host cannot honour part of the task; running elsewhere is safe. */
  | "unsupported"
  /** The selected model cannot be identified safely; do not choose another route. */
  | "modelIdentity"
  | "workspaceMode"
  /** The selected session was confirmed missing before dispatch. */
  | "sessionExpired"
  /** The run started (or may have) and failed; do not run it a second time. */
  | "failed";

export class AgentHostError extends Error {
  constructor(
    readonly kind: AgentHostFailureKind,
    message: string,
    readonly turnOutcome?: Exclude<
      AgentHostTurnOutcome,
      "completed" | "queued"
    >,
    readonly rpcCode?: number,
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
/** Bounds the time before a turn is dispatched when no run timeout is set. */
const PRE_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;
/** Shown in the run history when an explicit session location has no single local folder to apply to. */
export const WORKSPACE_FOLDER_REQUIRED_DETAIL =
  "an explicit session location needs exactly one local folder: use a workspace task, or open a single local folder";

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

interface AgentHostActionEnvelope {
  rejected: boolean;
  origin: unknown;
  serverSeq?: number;
}

interface AgentHostActionOrigin {
  clientId: string;
  clientSeq: number;
}

/** One JSON-RPC connection to the host (a named pipe carrying a WebSocket). */
export class AgentHostConnection {
  readonly clientId = `copilot-scheduler-${randomUUID()}`;
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
    (
      channel: string,
      action: AgentHostAction,
      envelope: AgentHostActionEnvelope,
    ) => void
  >();
  private readonly closeListeners = new Set<() => void>();

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
    listener: (
      channel: string,
      action: AgentHostAction,
      envelope: AgentHostActionEnvelope,
    ) => void,
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
    return this.dispatchWithOrigin(channel, action, timeoutMs).response;
  }

  dispatchWithOrigin(
    channel: string,
    action: AgentHostAction,
    timeoutMs?: number,
  ): { origin: AgentHostActionOrigin; response: Promise<unknown> } {
    const origin = { clientId: this.clientId, clientSeq: ++this.clientSeq };
    const response = this.request(
      "dispatchAction",
      { channel, clientSeq: origin.clientSeq, action },
      timeoutMs,
    );
    return { origin, response };
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
    const wasClosed = this.closed;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new AgentHostError("failed", message));
      this.pending.delete(id);
    }
    if (!wasClosed) {
      for (const listener of [...this.closeListeners]) {
        listener();
      }
    }
  }

  onClose(listener: () => void): () => void {
    if (this.closed) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
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
            undefined,
            typeof message.error.code === "number" ? message.error.code : undefined,
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
      const rejected = Object.prototype.hasOwnProperty.call(
        message.params,
        "rejectionReason",
      );
      for (const listener of [...this.listeners]) {
        const serverSeq = message.params?.serverSeq;
        listener(channel, action, {
          rejected,
          origin: message.params?.origin,
          ...(typeof serverSeq === "number" && Number.isSafeInteger(serverSeq) && serverSeq >= 0
            ? { serverSeq }
            : {}),
        });
      }
    }
  }
}

export interface AgentHostModelOption {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

export interface AgentHostModelInfo {
  id: string;
  name?: string;
  _meta?: { byokModelIdentifier?: string };
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
    if (value === undefined) {
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
    if (option.type === "number" || option.type === "integer") {
      if (typeof value === "string" && !value.trim()) {
        throw new AgentHostError(
          "unsupported",
          `The "${key}" value is not a number.`,
        );
      }
      resolved = typeof value === "number" ? value : Number(value);
      if (
        !Number.isFinite(resolved) ||
        (option.type === "integer" && !Number.isInteger(resolved)) ||
        (option.minimum !== undefined && resolved < option.minimum) ||
        (option.maximum !== undefined && resolved > option.maximum)
      ) {
        throw new AgentHostError(
          "unsupported",
          `The "${key}" value is outside the model's accepted range.`,
        );
      }
    } else if (
      (option.type === "string" && typeof value !== "string") ||
      (option.type !== undefined && option.type !== "string")
    ) {
      throw new AgentHostError(
        "unsupported",
        `The "${key}" value has an unsupported type.`,
      );
    } else if (typeof value === "number" && !Number.isFinite(value)) {
      throw new AgentHostError(
        "unsupported",
        `The "${key}" value is not a finite number.`,
      );
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
  workspaceMode?: AgentHostWorkspaceMode;
  /** An ambiguous workspace can resume a known session, but cannot create one. */
  allowNewSession?: boolean;
  modelId?: string;
  /** The model ID was explicitly chosen from the Agent Host catalog. */
  hostModelIdExplicit?: boolean;
  modelFallback?: { agentHostModelId?: string };
  modelOptions?: Record<string, string | number | undefined>;
  agentUri?: string;
  attachments?: AgentHostAttachment[];
  autoApprove: boolean;
  /**
   * Cancel a turn that runs longer than this. Omit to wait without cancelling;
   * only the time before the message is dispatched stays bounded.
   */
  timeoutMs?: number;
  /** Bounds a stuck step before dispatch when there is no run timeout (default 10 minutes). */
  preDispatchTimeoutMs?: number;
  /** Reuse this session (a "continue" run) when the host still has it. */
  resume?: AgentHostSessionRef;
  /** Called once the host has accepted the turn, so the session can be shown. */
  onSessionStarted?: (ref: AgentHostSessionRef, turnId: string, startedAt: string) => void;
  beforeDispatch?: (ref: AgentHostSessionRef, messageId: string) => Promise<void>;
  onMessageDispatched?: (ref: AgentHostSessionRef) => void;
  onInputNeeded?: (ref: AgentHostSessionRef, change: AgentHostInputChange) => void;
  onInputObservationError?: () => void;
  dispatchGuard?: (dispatch: () => void) => Promise<void>;
}

export interface AgentHostTurnResult extends AgentHostSessionRef {
  requestedModel?: string;
  fallbackFromModel?: string;
  appliedModel?: string;
  responseText: AgentHostResponseTextObservation;
  workspaceMode?: AgentHostWorkspaceMode;
  workspaceModeApplication?: AgentHostWorkspaceApplication;
}

interface PreparedAgentHostSession extends AgentHostSessionRef {
  workspaceMode?: AgentHostWorkspaceMode;
  workspaceModeApplication?: AgentHostWorkspaceApplication;
}

export interface AgentHostChatInfo {
  bindingId: string;
  title: string;
  sessionUri: string;
  chatUri: string;
  provider: string;
  workingDirectories: string[];
}

export interface AgentHostQueuedMessageRequest {
  endpoint: AgentHostEndpoint;
  targetChatId: string;
  /** A previously confirmed session; never resolve this to a different chat. */
  resume?: AgentHostSessionRef;
  text: string;
  taskId?: string;
  occurrenceId?: string;
  expectedWorkspacePath?: string;
  modelId?: string;
  /** The model ID was explicitly chosen from the Agent Host catalog. */
  hostModelIdExplicit?: boolean;
  modelFallback?: { agentHostModelId?: string };
  modelOptions?: Record<string, string | number | undefined>;
  agentUri?: string;
  attachments?: AgentHostAttachment[];
  dispatchGuard?: (dispatch: () => void) => Promise<void>;
  beforeDispatch?: (ref: AgentHostSessionRef, messageId: string) => Promise<void>;
  onMessageDispatched?: (ref: AgentHostSessionRef) => void;
  onQueuedTurnStarted?: (ref: AgentHostSessionRef, turnId: string) => void;
  onInputNeeded?: (ref: AgentHostSessionRef, change: AgentHostInputChange) => void;
  onQueueBlocked?: (ref: AgentHostSessionRef, change: AgentHostQueueBlockedChange) => void;
  onInputObservationError?: () => void;
  inputObservationTimeoutMs?: number;
}

export interface AgentHostQueuedMessageResult extends AgentHostSessionRef {
  messageId: string;
  requestedModel?: string;
  fallbackFromModel?: string;
}

interface SnapshotResult {
  snapshot?: { state?: Record<string, unknown> };
  state?: Record<string, unknown>;
}

function snapshotState(result: SnapshotResult): Record<string, unknown> {
  return result.snapshot?.state ?? result.state ?? (result as Record<string, unknown>);
}

export function toAgentHostChatBindingId(chatUri: string): string {
  return createHash("sha256").update(chatUri).digest("hex");
}

function normalizeDirectory(directory: string): string {
  const resolved = path.resolve(directory).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function toLocalDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const directories = new Set<string>();
  for (const uri of value) {
    if (typeof uri !== "string") continue;
    try {
      const parsed = new URL(uri);
      if (parsed.protocol === "file:") {
        directories.add(path.resolve(fileURLToPath(parsed)));
      }
    } catch {
      // Ignore unsupported or malformed workspace URIs.
    }
  }
  return [...directories];
}

function isArchived(status: unknown): boolean {
  return typeof status === "number" && (status & (1 << 6)) !== 0;
}

async function initializeAgentHost(
  connection: AgentHostConnection,
): Promise<Array<Record<string, unknown>>> {
  const init = await connection.request<{
    snapshots?: Array<{ state?: { agents?: Array<Record<string, unknown>> } }>;
  }>("initialize", {
    channel: "ahp-root://",
    clientId: connection.clientId,
    protocolVersions: PROTOCOL_VERSIONS,
    initialSubscriptions: ["ahp-root://"],
    clientInfo: { name: "copilot-scheduler", version: "1" },
  });
  return init.snapshots?.[0]?.state?.agents ?? [];
}

function requireAgentHostAgent(
  agents: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const agent = agents.find((candidate) => candidate.provider === PROVIDER);
  if (!agent) {
    throw new AgentHostError("unsupported", "The Agent Host has no Copilot agent.");
  }
  return agent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type AgentHostCatalogModel = Record<string, unknown> & { id: string };

function getAgentHostModels(
  agents: readonly Record<string, unknown>[],
): AgentHostCatalogModel[] {
  const agent = requireAgentHostAgent(agents);
  if (!Array.isArray(agent.models)) {
    throw new AgentHostError("unavailable", "The Agent Host model catalog is unavailable.");
  }
  return agent.models.map((value: unknown) => {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
      throw new AgentHostError("unavailable", "The Agent Host model catalog is invalid.");
    }
    return { ...value, id: value.id };
  });
}

function selectAgentHostModel(
  agents: readonly Record<string, unknown>[],
  modelId: string,
  explicit: boolean,
  fallback?: { agentHostModelId?: string },
): AgentHostModelInfo {
  const catalog = getAgentHostModels(agents);
  if (catalog.length === 0) {
    throw new AgentHostError(
      "unavailable",
      "The Agent Host model catalog is empty or not ready.",
    );
  }
  const matches = catalog.filter((model) => model.id === modelId);
  if (matches.length > 1) {
    throw new AgentHostError("modelIdentity", "The Agent Host model ID is ambiguous.");
  }
  // Nothing has been sent yet, so a missing or unusable replacement is reported
  // like any other unavailable model and the existing route fallback applies.
  const replacement = !matches.length && explicit && fallback?.agentHostModelId
    ? catalog.filter(
        (model) =>
          model.id === fallback.agentHostModelId &&
          model.policyState !== "disabled",
      )
    : [];
  const rawModel = matches[0] ?? (replacement.length === 1 ? replacement[0] : undefined);
  if (!rawModel) {
    throw new AgentHostError(
      "unsupported",
      "The Agent Host does not offer the requested model.",
    );
  }
  if (rawModel._meta !== undefined && !isRecord(rawModel._meta)) {
    throw new AgentHostError("modelIdentity", "The Agent Host model metadata is invalid.");
  }
  const byokId = isRecord(rawModel._meta)
    ? rawModel._meta.byokModelIdentifier
    : undefined;
  if (byokId !== undefined && typeof byokId !== "string") {
    throw new AgentHostError("modelIdentity", "The Agent Host model metadata is invalid.");
  }
  if (!explicit && rawModel.id === modelId && (byokId !== undefined || modelId.includes("/"))) {
    throw new AgentHostError(
      "modelIdentity",
      "The Agent Host model must be selected explicitly.",
    );
  }
  const model: AgentHostModelInfo = { id: rawModel.id };
  const schema = rawModel.configSchema;
  const properties = isRecord(schema) ? schema.properties : undefined;
  if (isRecord(properties)) {
    const options: Record<string, AgentHostModelOption> = {};
    for (const [key, option] of Object.entries(properties)) {
      if (
        isRecord(option) &&
        (option.type === undefined || typeof option.type === "string") &&
        (option.enum === undefined || Array.isArray(option.enum)) &&
        (option.minimum === undefined ||
          (typeof option.minimum === "number" && Number.isFinite(option.minimum))) &&
        (option.maximum === undefined ||
          (typeof option.maximum === "number" && Number.isFinite(option.maximum)))
      ) {
        options[key] = {
          ...(typeof option.type === "string" ? { type: option.type } : {}),
          ...(Array.isArray(option.enum) ? { enum: option.enum } : {}),
          ...(typeof option.minimum === "number"
            ? { minimum: option.minimum }
            : {}),
          ...(typeof option.maximum === "number"
            ? { maximum: option.maximum }
            : {}),
        };
      }
    }
    model.configSchema = { properties: options };
  }
  return model;
}

/** Lists model IDs actually advertised by the current Agent Host. */
export async function listAgentHostModels(
  endpoint: AgentHostEndpoint,
): Promise<AgentHostModelInfo[]> {
  const connection = await AgentHostConnection.open(endpoint);
  try {
    return getAgentHostModels(await initializeAgentHost(connection)).map((model) => ({
      id: model.id,
      ...(typeof model.name === "string" ? { name: model.name } : {}),
    }));
  } finally {
    connection.close();
  }
}

async function listSessionSummaries(
  connection: AgentHostConnection,
): Promise<Array<Record<string, unknown>>> {
  const sessions: Array<Record<string, unknown>> = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const result = await connection.request<{
      items?: Array<Record<string, unknown>>;
      nextCursor?: unknown;
    }>("listSessions", {
      channel: "ahp-root://",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result.items)) {
      throw new AgentHostError(
        "unsupported",
        "The Agent Host returned an invalid session catalog.",
      );
    }
    sessions.push(...result.items);
    if (typeof result.nextCursor !== "string" || !result.nextCursor) {
      return sessions;
    }
    if (cursors.has(result.nextCursor)) {
      throw new AgentHostError(
        "unsupported",
        "The Agent Host returned a repeated session cursor.",
      );
    }
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new AgentHostError(
    "unsupported",
    "The Agent Host session catalog exceeded the supported page limit.",
  );
}

function readChatCatalog(
  sessions: readonly Record<string, unknown>[],
): AgentHostChatInfo[] {
  const chats = new Map<string, AgentHostChatInfo>();
  for (const session of sessions) {
    if (
      typeof session.resource !== "string" ||
      typeof session.provider !== "string" ||
      session.provider !== PROVIDER ||
      !Array.isArray(session.chats)
    ) {
      continue;
    }
    const sessionUri = session.resource;
    const sessionDirectories = session.workingDirectories;
    for (const item of session.chats) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const chat = item as Record<string, unknown>;
      if (
        typeof chat.resource !== "string" ||
        chat.interactivity === "read-only" ||
        chat.interactivity === "hidden" ||
        isArchived(chat.status)
      ) {
        continue;
      }
      const provider =
        typeof chat.provider === "string" ? chat.provider : session.provider;
      if (provider !== PROVIDER) continue;
      const workingDirectories = toLocalDirectories(
        chat.workingDirectories ?? sessionDirectories,
      );
      if (workingDirectories.length === 0) continue;
      const chatUri = chat.resource;
      chats.set(chatUri, {
        bindingId: toAgentHostChatBindingId(chatUri),
        title:
          typeof chat.title === "string" && chat.title.trim()
            ? chat.title.trim().slice(0, 500)
            : "Untitled chat",
        sessionUri,
        chatUri,
        provider,
        workingDirectories,
      });
    }
  }
  return [...chats.values()];
}

/** Lists selectable Copilot chats without reading their conversation content. */
export async function listAgentHostChats(
  endpoint: AgentHostEndpoint,
): Promise<AgentHostChatInfo[]> {
  const connection = await AgentHostConnection.open(endpoint);
  try {
    await initializeAgentHost(connection);
    return readChatCatalog(await listSessionSummaries(connection));
  } finally {
    connection.close();
  }
}

export async function resolveAgentHostChatBinding(
  endpoint: AgentHostEndpoint,
  targetChatId: string,
  expectedWorkspacePath?: string,
): Promise<AgentHostChatInfo> {
  const connection = await AgentHostConnection.open(endpoint);
  try {
    await initializeAgentHost(connection);
    return await resolveAgentHostChat(
      connection,
      targetChatId,
      expectedWorkspacePath,
    );
  } finally {
    connection.close();
  }
}

function validateTargetWorkspace(
  chat: AgentHostChatInfo,
  expectedWorkspacePath: string | undefined,
): void {
  if (!expectedWorkspacePath) return;
  const expected = normalizeDirectory(expectedWorkspacePath);
  if (
    chat.workingDirectories.length !== 1 ||
    normalizeDirectory(chat.workingDirectories[0]) !== expected
  ) {
    throw new AgentHostError(
      "unsupported",
      "The selected chat does not belong exclusively to the task workspace.",
    );
  }
}

async function resolveAgentHostChat(
  connection: AgentHostConnection,
  targetChatId: string,
  expectedWorkspacePath: string | undefined,
): Promise<AgentHostChatInfo> {
  const chats = readChatCatalog(await listSessionSummaries(connection));
  const normalizedId = targetChatId.trim().toLowerCase();
  const matches = chats.filter((chat) => chat.bindingId === normalizedId);
  if (matches.length !== 1) {
    throw new AgentHostError(
      "unsupported",
      "The selected Copilot chat is no longer available.",
    );
  }
  const selected = matches[0];
  validateTargetWorkspace(selected, expectedWorkspacePath);

  const sessionState = snapshotState(
    await connection.request<SnapshotResult>("subscribe", {
      channel: selected.sessionUri,
    }),
  );
  const sessionChats = Array.isArray(sessionState.chats)
    ? (sessionState.chats as Array<Record<string, unknown>>)
    : [];
  const currentSummary = sessionChats.find(
    (chat) => chat?.resource === selected.chatUri,
  );
  if (
    sessionState.lifecycle !== "ready" ||
    sessionState.provider !== PROVIDER ||
    !currentSummary ||
    currentSummary.interactivity === "read-only" ||
    currentSummary.interactivity === "hidden" ||
    isArchived(currentSummary.status)
  ) {
    throw new AgentHostError(
      "unsupported",
      "The selected Copilot chat is no longer available.",
    );
  }

  const chatState = snapshotState(
    await connection.request<SnapshotResult>("subscribe", {
      channel: selected.chatUri,
    }),
  );
  const provider =
    typeof chatState.provider === "string"
      ? chatState.provider
      : selected.provider;
  const workingDirectories = toLocalDirectories(
    chatState.workingDirectories ?? sessionState.workingDirectories,
  );
  const current: AgentHostChatInfo = {
    ...selected,
    title:
      typeof chatState.title === "string" && chatState.title.trim()
        ? chatState.title.trim().slice(0, 500)
        : selected.title,
    provider,
    workingDirectories,
  };
  if (
    chatState.resource !== selected.chatUri ||
    provider !== PROVIDER ||
    chatState.interactivity === "read-only" ||
    chatState.interactivity === "hidden" ||
    isArchived(chatState.status)
  ) {
    throw new AgentHostError(
      "unsupported",
      "The selected Copilot chat is no longer available.",
    );
  }
  validateTargetWorkspace(current, expectedWorkspacePath);
  return current;
}

async function verifyResumedChat(
  connection: AgentHostConnection,
  ref: AgentHostSessionRef,
): Promise<Record<string, unknown>> {
  let sessionSnapshot: unknown;
  try {
    sessionSnapshot = await connection.request("subscribe", { channel: ref.sessionUri });
  } catch (error) {
    if (error instanceof AgentHostError && error.rpcCode === -32001) {
      throw new AgentHostError("sessionExpired", "The Agent Host session no longer exists.");
    }
    throw new AgentHostError("failed", "The continued Agent Host session could not be verified.", "unknown");
  }
  if (!isRecord(sessionSnapshot)) {
    throw new AgentHostError("failed", "The continued Agent Host session could not be verified.", "unknown");
  }
  const sessionState = snapshotState(sessionSnapshot);
  const summaries = Array.isArray(sessionState.chats) ? sessionState.chats : [];
  const summary = summaries.find((item) => isRecord(item) && item.resource === ref.chatUri);
  if (
    sessionState.resource !== ref.sessionUri ||
    sessionState.lifecycle !== "ready" ||
    sessionState.provider !== PROVIDER ||
    !isRecord(summary) ||
    summary.interactivity === "read-only" ||
    summary.interactivity === "hidden" ||
    isArchived(summary.status)
  ) {
    throw new AgentHostError("failed", "The continued Agent Host session could not be verified.", "unknown");
  }

  let chatSnapshot: unknown;
  try {
    chatSnapshot = await connection.request("subscribe", { channel: ref.chatUri });
  } catch {
    throw new AgentHostError("failed", "The continued Agent Host chat could not be verified.", "unknown");
  }
  if (!isRecord(chatSnapshot)) {
    throw new AgentHostError("failed", "The continued Agent Host chat could not be verified.", "unknown");
  }
  const chatState = snapshotState(chatSnapshot);
  if (
    chatState.resource !== ref.chatUri ||
    (chatState.provider !== undefined && chatState.provider !== PROVIDER) ||
    chatState.interactivity === "read-only" ||
    chatState.interactivity === "hidden" ||
    isArchived(chatState.status)
  ) {
    throw new AgentHostError("failed", "The continued Agent Host chat could not be verified.", "unknown");
  }
  return chatState;
}

/** Reconciles an uncertain, identified turn without submitting another message. */
export async function isAgentHostTurnTerminal(
  endpoint: AgentHostEndpoint,
  ref: AgentHostSessionRef,
  turnId: string,
): Promise<boolean> {
  const connection = await AgentHostConnection.open(endpoint);
  try {
    requireAgentHostAgent(await initializeAgentHost(connection));
    const state = await verifyResumedChat(connection, ref);
    if (isRecord(state.activeTurn) && state.activeTurn.id === turnId) return false;
    return Array.isArray(state.turns) && state.turns.some((turn) =>
      isRecord(turn) &&
      turn.id === turnId &&
      (turn.state === "complete" || turn.state === "cancelled" || turn.state === "error"),
    );
  } finally {
    connection.close();
  }
}

function queuedMessageId(taskId?: string, occurrenceId?: string): string {
  if (occurrenceId !== undefined) {
    if (
      typeof taskId !== "string" ||
      !taskId.trim() ||
      typeof occurrenceId !== "string" ||
      !occurrenceId.trim()
    ) {
      throw new AgentHostError("unsupported", "An occurrence needs a task identifier and occurrence identifier.");
    }
    return `copilot-scheduler-occurrence-${createHash("sha256")
      .update(JSON.stringify([taskId, occurrenceId]))
      .digest("hex")}`;
  }
  return `copilot-scheduler-${createHash("sha256")
    .update(taskId || randomUUID())
    .digest("hex")}`;
}

const queuedInputObservers = new Set<() => void>();

export function disposeAgentHostInputObservers(): void {
  for (const stop of [...queuedInputObservers]) stop();
}

function agentHostMessage(
  request: {
    text: string;
    agentUri?: string;
    attachments?: AgentHostAttachment[];
  },
  model: { id: string; config?: Record<string, string | number> } | undefined,
): Record<string, unknown> {
  return {
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
  };
}

async function dispatchQueuedMessage(
  connection: AgentHostConnection,
  chatUri: string,
  messageId: string,
  message: Record<string, unknown>,
  dispatchGuard?: (dispatch: () => void) => Promise<void>,
  onDispatch?: () => void,
  mayDispatch?: () => boolean,
  onQueuedTurnStarted?: (turnId: string) => void,
  onQueueEcho?: (serverSeq: number | undefined) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let dispatchStarted = false;
    let dispatchOrigin: AgentHostActionOrigin | undefined;
    let guardPending = !!dispatchGuard;
    let echoConfirmed = false;
    let stateConfirmed = false;
    let pendingOutcome: (() => void) | undefined;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopListening();
      stopWatchingClose();
      outcome();
    };
    const finishAfterGuard = (outcome: () => void) => {
      if (settled) return;
      if (guardPending) pendingOutcome ??= outcome;
      else finish(outcome);
    };
    const confirm = () => {
      if (echoConfirmed && stateConfirmed) finishAfterGuard(resolve);
    };
    const unconfirmed = () => new AgentHostError(
      "failed",
      "The Agent Host did not confirm the queued message.",
      dispatchStarted ? "unknown" : undefined,
    );
    const timer = setTimeout(() => finish(() => reject(unconfirmed())), REQUEST_TIMEOUT_MS);
    const stopListening = connection.onAction((channel, action, envelope) => {
      if (channel !== chatUri || envelope.rejected) {
        if (
          channel === chatUri &&
          envelope.rejected &&
          dispatchStarted &&
          dispatchOrigin &&
          action.type === "chat/pendingMessageSet" &&
          action.id === messageId &&
          isRecord(envelope.origin) &&
          envelope.origin.clientId === dispatchOrigin?.clientId &&
          envelope.origin.clientSeq === dispatchOrigin?.clientSeq
        ) {
          finishAfterGuard(() => reject(unconfirmed()));
        }
        return;
      }
      if (
        dispatchStarted &&
        echoConfirmed &&
        action.type === "chat/turnStarted" &&
        action.queuedMessageId === messageId &&
        typeof action.turnId === "string" &&
        action.turnId
      ) {
        if (action.type === "chat/turnStarted" && typeof action.turnId === "string") {
          try {
            onQueuedTurnStarted?.(action.turnId);
          } catch {
            // Observation must not change the dispatch outcome.
          }
        }
        stateConfirmed = true;
        confirm();
        return;
      }
      const origin = envelope.origin;
      if (
        !dispatchStarted ||
        !dispatchOrigin ||
        !isRecord(origin) ||
        origin.clientId !== dispatchOrigin.clientId ||
        origin.clientSeq !== dispatchOrigin.clientSeq ||
        action.type !== "chat/pendingMessageSet" ||
        action.id !== messageId ||
        action.kind !== "queued"
      ) return;
      echoConfirmed = true;
      onQueueEcho?.(envelope.serverSeq);
      confirm();
      if (stateConfirmed || settled) return;
      void connection.request<SnapshotResult>("subscribe", { channel: chatUri }).then(
        (snapshot) => {
          if (settled || stateConfirmed) return;
          if (isRecord(snapshot)) {
            const state = snapshotState(snapshot);
            stateConfirmed = state.resource === chatUri && Array.isArray(state.queuedMessages) &&
              state.queuedMessages.some((entry) =>
                isRecord(entry) && entry.id === messageId &&
                (entry.kind === undefined || entry.kind === "queued"),
              );
          }
          if (stateConfirmed) confirm();
          else finishAfterGuard(() => reject(unconfirmed()));
        },
        () => finishAfterGuard(() => reject(unconfirmed())),
      );
    });
    const stopWatchingClose = connection.onClose(() =>
      finishAfterGuard(() => reject(unconfirmed())),
    );
    const dispatch = () => {
      if (settled || dispatchStarted || (mayDispatch && !mayDispatch())) return;
      dispatchStarted = true;
      onDispatch?.();
      const dispatched = connection.dispatchWithOrigin(chatUri, {
        type: "chat/pendingMessageSet",
        kind: "queued",
        id: messageId,
        message,
      });
      dispatchOrigin = dispatched.origin;
      void dispatched.response.catch(() => finishAfterGuard(() => reject(unconfirmed())));
    };
    if (dispatchGuard) {
      void dispatchGuard(dispatch).then(
        () => {
          guardPending = false;
          if (pendingOutcome) finish(pendingOutcome);
          else if (!dispatchStarted) {
            finish(() => reject(new AgentHostError(
              "failed",
              "The task reservation did not allow a queued message.",
            )));
          }
        },
        (error: unknown) => finish(() => reject(
          dispatchStarted
            ? new AgentHostError("failed", "The queued message outcome is unknown.", "unknown")
            : error,
        )),
      );
    } else {
      dispatch();
    }
  });
}

/** Repeated task runs coalesce unless a distinct occurrence is supplied. */
export async function queueAgentHostMessage(
  request: AgentHostQueuedMessageRequest,
): Promise<AgentHostQueuedMessageResult> {
  const messageId = queuedMessageId(request.taskId, request.occurrenceId);
  const connection = await AgentHostConnection.open(request.endpoint);
  let stopInputObservation: (() => void) | undefined;
  let observerStopped = false;
  let keepConnection = false;
  let acceptQueuedMessage!: () => void;
  const queuedAcceptance = new Promise<void>((resolve) => { acceptQueuedMessage = resolve; });
  try {
    const agents = await initializeAgentHost(connection);
    requireAgentHostAgent(agents);
    let model: { id: string; config?: Record<string, string | number> } | undefined;
    if (request.modelId) {
      const info = selectAgentHostModel(
        agents,
        request.modelId,
        request.hostModelIdExplicit === true,
        request.modelFallback,
      );
      const config = mapModelConfiguration(info, info.id === request.modelId ? request.modelOptions ?? {} : {});
      model = {
        id: info.id,
        ...(Object.keys(config).length > 0 ? { config } : {}),
      };
    } else if (
      Object.values(request.modelOptions ?? {}).some(
        (value) => value !== undefined,
      )
    ) {
      throw new AgentHostError(
        "unsupported",
        "Model options need a model to apply to.",
      );
    }
    let chat: AgentHostSessionRef;
    if (request.resume) {
      if (request.targetChatId.trim().toLowerCase() !== toAgentHostChatBindingId(request.resume.chatUri)) {
        throw new AgentHostError("failed", "The continued Agent Host chat could not be verified.", "unknown");
      }
      await verifyResumedChat(connection, request.resume);
      chat = request.resume;
    } else {
      chat = await resolveAgentHostChat(connection, request.targetChatId, request.expectedWorkspacePath);
    }
    await request.beforeDispatch?.(chat, messageId);
    let queueEchoSeq: number | undefined;
    await dispatchQueuedMessage(
      connection,
      chat.chatUri,
      messageId,
      agentHostMessage(request, model),
      request.dispatchGuard,
      () => {
        if (request.onInputNeeded || request.onQueueBlocked) {
          stopInputObservation = observeAgentHostInput(
            connection,
            chat,
            (change) => request.onInputNeeded?.(chat, change),
            {
              queuedMessageId: messageId,
              isQueuedStart: (serverSeq) =>
                queueEchoSeq !== undefined &&
                serverSeq !== undefined &&
                serverSeq > queueEchoSeq,
              queuedAcceptance,
              onQueueBlocked: (change) => request.onQueueBlocked?.(chat, change),
              timeoutMs: request.inputObservationTimeoutMs ?? 60 * 60 * 1000,
              onObservationError: request.onInputObservationError,
              onStopped: () => {
                observerStopped = true;
                if (stopInputObservation) queuedInputObservers.delete(stopInputObservation);
                if (keepConnection) connection.close();
              },
            },
          );
        }
        request.onMessageDispatched?.(chat);
      },
      undefined,
      (turnId) => request.onQueuedTurnStarted?.(chat, turnId),
      (serverSeq) => { queueEchoSeq = serverSeq; },
    );

    acceptQueuedMessage();
    if (stopInputObservation && !observerStopped) {
      keepConnection = true;
      queuedInputObservers.add(stopInputObservation);
    }
    return {
      sessionUri: chat.sessionUri,
      chatUri: chat.chatUri,
      messageId,
      ...(model ? { requestedModel: model.id } : {}),
      ...(model && request.modelId && model.id !== request.modelId ? { fallbackFromModel: request.modelId } : {}),
    };
  } finally {
    if (!keepConnection) {
      stopInputObservation?.();
      connection.close();
    }
  }
}

/** Starts one turn and waits for the host to finish it. */
export async function runAgentHostTurn(
  request: AgentHostTurnRequest,
): Promise<AgentHostTurnResult> {
  const connection = await AgentHostConnection.open(request.endpoint);
  try {
    let prepared: {
      ref: PreparedAgentHostSession;
      model?: { id: string; config?: Record<string, string | number> };
    };
    try {
      prepared = await prepareTurn(connection, request);
    } catch (error) {
      // Nothing has been sent yet, so another route can still run the task.
      throw error instanceof AgentHostError &&
        (error.kind === "unsupported" ||
          error.kind === "modelIdentity" ||
          error.kind === "workspaceMode" ||
          (error.kind === "failed" && error.turnOutcome === "unknown"))
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
  ref: PreparedAgentHostSession;
  model?: { id: string; config?: Record<string, string | number> };
}> {
  const agents = await initializeAgentHost(connection);
  requireAgentHostAgent(agents);
  if (
    request.workspaceMode !== undefined &&
    request.workspaceMode !== "folder" &&
    request.workspaceMode !== "worktree"
  ) {
    throw new AgentHostError("workspaceMode", "The workspace mode is invalid.");
  }

  let model: { id: string; config?: Record<string, string | number> } | undefined;
  if (request.modelId) {
    const info = selectAgentHostModel(
      agents,
      request.modelId,
      request.hostModelIdExplicit === true,
      request.modelFallback,
    );
    const config = mapModelConfiguration(info, info.id === request.modelId ? request.modelOptions ?? {} : {});
    model = {
      id: info.id,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
  } else if (
    Object.values(request.modelOptions ?? {}).some((v) => v !== undefined)
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
): Promise<PreparedAgentHostSession> {
  if (request.resume) {
    try {
      await verifyResumedChat(connection, request.resume);
      return {
        ...request.resume,
        ...(request.workspaceMode
          ? {
              workspaceMode: request.workspaceMode,
              workspaceModeApplication: "not_applied_resumed" as const,
            }
          : {}),
      };
    } catch (error) {
      if (!(error instanceof AgentHostError) || error.kind !== "sessionExpired") {
        throw error;
      }
    }
  }

  if (request.allowNewSession === false) {
    throw new AgentHostError("workspaceMode", WORKSPACE_FOLDER_REQUIRED_DETAIL);
  }

  if (request.workspaceMode) {
    if (!request.cwdUri) {
      throw new AgentHostError("workspaceMode", "No local execution folder was specified.");
    }
    let resolved: unknown;
    try {
      fileURLToPath(request.cwdUri);
      resolved = await connection.request("resolveSessionConfig", {
        channel: "ahp-root://",
        provider: PROVIDER,
        workingDirectory: request.cwdUri,
        config: {
          isolation: request.workspaceMode,
          ...(request.autoApprove ? { autoApprove: "autoApprove" } : {}),
        },
      });
    } catch {
      throw new AgentHostError(
        "workspaceMode",
        "The Agent Host could not confirm the requested workspace mode.",
      );
    }
    const schema = isRecord(resolved) ? resolved.schema : undefined;
    const properties = isRecord(schema) ? schema.properties : undefined;
    const isolation = isRecord(properties) && Object.hasOwn(properties, "isolation")
      ? properties.isolation
      : undefined;
    const values = isRecord(resolved) ? resolved.values : undefined;
    if (
      !isRecord(isolation) ||
      isolation.type !== "string" ||
      !Array.isArray(isolation.enum) ||
      !isolation.enum.includes(request.workspaceMode) ||
      !isRecord(values) ||
      !Object.hasOwn(values, "isolation") ||
      values.isolation !== request.workspaceMode
    ) {
      throw new AgentHostError(
        "workspaceMode",
        "The Agent Host does not support the requested workspace mode for this folder.",
      );
    }
  }

  const sessionUri = `ahp-session:/${randomUUID()}`;
  const config: Record<string, string> = {
    ...(request.autoApprove ? { autoApprove: "autoApprove" } : {}),
    ...(request.workspaceMode ? { isolation: request.workspaceMode } : {}),
  };
  await connection.request("createSession", {
    channel: sessionUri,
    provider: PROVIDER,
    ...(request.cwdUri ? { workingDirectories: [request.cwdUri] } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  });
  const state = snapshotState(
    await connection.request<SnapshotResult>("subscribe", { channel: sessionUri }),
  );
  const chatUri = state.defaultChat;
  if (typeof chatUri !== "string" || !chatUri) {
    throw new AgentHostError("failed", "The Agent Host session has no chat.");
  }
  const chatSnapshot = await connection.request<SnapshotResult>("subscribe", {
    channel: chatUri,
  });
  if (request.workspaceMode) {
    const appliedConfig = isRecord(state.config) ? state.config.values : undefined;
    if (
      !isRecord(appliedConfig) ||
      !Object.hasOwn(appliedConfig, "isolation") ||
      appliedConfig.isolation !== request.workspaceMode
    ) {
      throw new AgentHostError("workspaceMode", "The created session did not confirm the requested workspace mode.");
    }
    if (request.workspaceMode === "folder") {
      if (!isRecord(chatSnapshot)) {
        throw new AgentHostError("workspaceMode", "The Agent Host did not confirm the chat execution folder.");
      }
      const chatState = snapshotState(chatSnapshot);
      if (!isRecord(chatState)) {
        throw new AgentHostError("workspaceMode", "The Agent Host returned an invalid chat state.");
      }
      const directories = Object.hasOwn(chatState, "workingDirectories")
        ? chatState.workingDirectories
        : state.workingDirectories;
      const localDirectories = toLocalDirectories(directories);
      if (
        !request.cwdUri ||
        !Array.isArray(directories) ||
        directories.length !== 1 ||
        localDirectories.length !== 1 ||
        normalizeDirectory(localDirectories[0]) !==
          normalizeDirectory(fileURLToPath(request.cwdUri))
      ) {
        throw new AgentHostError("workspaceMode", "The created session uses a different execution folder.");
      }
    }
  }
  return {
    sessionUri,
    chatUri,
    ...(request.workspaceMode
      ? {
          workspaceMode: request.workspaceMode,
          workspaceModeApplication: "new_session_config_confirmed" as const,
        }
      : {}),
  };
}

async function runTurn(
  connection: AgentHostConnection,
  ref: PreparedAgentHostSession,
  request: AgentHostTurnRequest,
  model: { id: string; config?: Record<string, string | number> } | undefined,
): Promise<AgentHostTurnResult> {
  const messageId = `copilot-scheduler-turn-${randomUUID()}`;
  await request.beforeDispatch?.(ref, messageId);
  return new Promise<AgentHostTurnResult>((resolve, reject) => {
    let turnId: string | undefined;
    let appliedModel: string | undefined;
    let responseTextObserved = false;
    let responseTextUncertain = false;
    const markdownParts = new Set<string>();
    let settled = false;
    let dispatchStarted = false;
    let queueConfirmed = false;
    let pendingOutcome: (() => void) | undefined;
    let timedOut = false;
    let cancelSent = false;
    let removalOrigin: AgentHostActionOrigin | undefined;
    let cancelTimer: NodeJS.Timeout | undefined;
    let stopInputObservation: () => void = () => undefined;
    const finish = (outcome: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (cancelTimer) {
        clearTimeout(cancelTimer);
      }
      stopInputObservation();
      stopListening();
      stopWatchingClose();
      outcome();
    };
    const finishAfterQueue = (outcome: () => void) => {
      if (!queueConfirmed) {
        pendingOutcome ??= outcome;
      } else {
        finish(outcome);
      }
    };

    const cancelTurn = () => {
      if (!turnId || cancelSent) return;
      cancelSent = true;
      void connection.dispatch(ref.chatUri, {
        type: "chat/turnCancelled",
        turnId,
        duration: request.timeoutMs,
      }, CANCEL_TIMEOUT_MS).catch(() => undefined);
    };
    // Without a run timeout only the time before dispatch stays bounded; once the
    // message is sent the turn is waited for and never cancelled.
    const timer = setTimeout(() => {
      timedOut = true;
      if (!dispatchStarted) {
        finish(() =>
          reject(new AgentHostError("failed", "The Agent Host run timed out before dispatch.", "unknown")),
        );
        return;
      }
      // The RPC response alone does not confirm that cancellation took effect.
      cancelTimer = setTimeout(
        () =>
          finish(() =>
            reject(
              new AgentHostError(
                "failed",
                "The Agent Host run timed out.",
                "unknown",
              ),
            ),
          ),
        CANCEL_TIMEOUT_MS,
      );
      if (turnId) {
        cancelTurn();
      } else {
        const removed = connection.dispatchWithOrigin(ref.chatUri, {
          type: "chat/pendingMessageRemoved",
          id: messageId,
          kind: "queued",
        }, CANCEL_TIMEOUT_MS);
        removalOrigin = removed.origin;
        void removed.response.catch(() => undefined);
      }
    }, request.timeoutMs ?? request.preDispatchTimeoutMs ?? PRE_DISPATCH_TIMEOUT_MS);

    const stopListening = connection.onAction((channel, action, envelope) => {
      if (channel !== ref.chatUri) {
        return;
      }
      if (
        action.type === "chat/pendingMessageRemoved" &&
        action.id === messageId &&
        !envelope.rejected &&
        !turnId &&
        removalOrigin &&
        isRecord(envelope.origin) &&
        envelope.origin.clientId === removalOrigin.clientId &&
        envelope.origin.clientSeq === removalOrigin.clientSeq
      ) {
        // The reducer may echo a removal even when the message was already gone.
        finishAfterQueue(() => reject(new AgentHostError(
          "failed",
          "The Agent Host queue cancellation could not be confirmed.",
          "unknown",
        )));
        return;
      }
      if (action.type === "chat/turnStarted" && action.queuedMessageId === messageId) {
        if (envelope.rejected || typeof action.turnId !== "string" || !action.turnId) {
          finish(() =>
            reject(
              new AgentHostError(
                "failed",
                "The Agent Host rejected the turn.",
                "unknown",
              ),
            ),
          );
        } else if (!turnId) {
          turnId = action.turnId;
          try {
            request.onSessionStarted?.(
              ref,
              turnId,
              typeof action.startedAt === "string" ? action.startedAt : "",
            );
          } catch {
            // Revealing the session is best effort and must not fail the run.
          }
          if (timedOut) cancelTurn();
        }
        return;
      }
      // Other chats and other turns, including user input requests, are not this turn.
      if (!turnId || action.turnId !== turnId || envelope.rejected) {
        return;
      }
      if (action.type === "chat/responsePart") {
        const part = action.part;
        if (!part || typeof part !== "object" || Array.isArray(part)) {
          responseTextUncertain = true;
          return;
        }
        const record = part as Record<string, unknown>;
        if (record.kind === "markdown") {
          if (typeof record.id !== "string" || typeof record.content !== "string") {
            responseTextUncertain = true;
            return;
          }
          markdownParts.add(record.id);
          responseTextObserved ||= /\S/.test(record.content);
        } else if (
          record.kind !== "reasoning" &&
          record.kind !== "toolCall" &&
          record.kind !== "contentRef" &&
          record.kind !== "inputRequest" &&
          record.kind !== "systemNotification"
        ) {
          responseTextUncertain = true;
        }
      } else if (action.type === "chat/delta") {
        if (
          typeof action.partId !== "string" ||
          !markdownParts.has(action.partId) ||
          typeof action.content !== "string"
        ) {
          responseTextUncertain = true;
        } else {
          responseTextObserved ||= /\S/.test(action.content);
        }
      } else if (action.type === "chat/usage") {
        const usage = action.usage as { model?: unknown } | undefined;
        if (typeof usage?.model === "string") {
          appliedModel = usage.model;
        }
      } else if (action.type === "chat/turnComplete") {
        finishAfterQueue(() =>
          resolve({
            ...ref,
            ...(model ? { requestedModel: model.id } : {}),
            ...(model && request.modelId && model.id !== request.modelId ? { fallbackFromModel: request.modelId } : {}),
            ...(appliedModel ? { appliedModel } : {}),
            responseText: responseTextObserved
              ? "observed"
              : responseTextUncertain
                ? "unknown"
                : "not_observed",
          }),
        );
      } else if (action.type === "chat/error") {
        const part = action.part as { error?: { message?: unknown } } | undefined;
        const detail =
          typeof part?.error?.message === "string" ? part.error.message : "";
        finishAfterQueue(() =>
          reject(
            new AgentHostError(
              "failed",
              detail || "The Agent Host run failed.",
              "failed",
            ),
          ),
        );
      } else if (action.type === "chat/turnCancelled") {
        finishAfterQueue(() =>
          reject(
            new AgentHostError(
              "failed",
              "The Agent Host run was cancelled.",
              "cancelled",
            ),
          ),
        );
      }
    });

    const stopWatchingClose = connection.onClose(() =>
      finish(() =>
        reject(
          new AgentHostError(
            "failed",
            "The Agent Host connection closed during the run.",
            "unknown",
          ),
        ),
      ),
    );

    void dispatchQueuedMessage(
      connection,
      ref.chatUri,
      messageId,
      agentHostMessage(request, model),
      request.dispatchGuard,
      () => {
        dispatchStarted = true;
        if (request.timeoutMs === undefined) clearTimeout(timer);
        if (request.onInputNeeded) {
          stopInputObservation = observeAgentHostInput(
            connection,
            ref,
            (change) => request.onInputNeeded?.(ref, change),
            { onObservationError: request.onInputObservationError },
          );
        }
        try {
          request.onMessageDispatched?.(ref);
        } catch {
          // Observation must not change the dispatch outcome.
        }
      },
      () => !settled && !timedOut,
    ).then(
      () => {
        queueConfirmed = true;
        if (pendingOutcome) finish(pendingOutcome);
      },
      (error: unknown) => finish(() => reject(
        error instanceof AgentHostError &&
        error.message === "The task reservation did not allow a queued message."
          ? new AgentHostError("failed", "The task reservation did not allow a turn.")
          : error,
      )),
    );
  });
}



