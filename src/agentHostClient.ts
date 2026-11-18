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
import type {
  AgentHostResponseTextObservation,
  AgentHostTurnOutcome,
} from "./types";

export type AgentHostFailureKind =
  /** No usable Agent Host; running elsewhere is safe. */
  | "unavailable"
  /** The host cannot honour part of the task; running elsewhere is safe. */
  | "unsupported"
  /** The selected model cannot be identified safely; do not choose another route. */
  | "modelIdentity"
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

interface AgentHostActionEnvelope {
  rejected: boolean;
  origin: unknown;
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
        listener(channel, action, { rejected, origin: message.params?.origin });
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
  modelId?: string;
  /** The model ID was explicitly chosen from the Agent Host catalog. */
  hostModelIdExplicit?: boolean;
  modelOptions?: Record<string, string | number | undefined>;
  agentUri?: string;
  attachments?: AgentHostAttachment[];
  autoApprove: boolean;
  timeoutMs: number;
  /** Reuse this session (a "continue" run) when the host still has it. */
  resume?: AgentHostSessionRef;
  /** Called once the host has accepted the turn, so the session can be shown. */
  onSessionStarted?: (ref: AgentHostSessionRef) => void;
  dispatchGuard?: (dispatch: () => void) => Promise<void>;
}

export interface AgentHostTurnResult extends AgentHostSessionRef {
  requestedModel?: string;
  appliedModel?: string;
  responseText: AgentHostResponseTextObservation;
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
  text: string;
  taskId?: string;
  expectedWorkspacePath?: string;
  modelId?: string;
  /** The model ID was explicitly chosen from the Agent Host catalog. */
  hostModelIdExplicit?: boolean;
  modelOptions?: Record<string, string | number | undefined>;
  agentUri?: string;
  attachments?: AgentHostAttachment[];
  dispatchGuard?: (dispatch: () => void) => Promise<void>;
}

export interface AgentHostQueuedMessageResult extends AgentHostSessionRef {
  messageId: string;
  requestedModel?: string;
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
  const rawModel = matches[0];
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
  if (!explicit && (byokId !== undefined || modelId.includes("/"))) {
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

/** Queues one task-specific message in an existing chat; repeated task runs upsert the same pending ID. */
export async function queueAgentHostMessage(
  request: AgentHostQueuedMessageRequest,
): Promise<AgentHostQueuedMessageResult> {
  const connection = await AgentHostConnection.open(request.endpoint);
  try {
    const agents = await initializeAgentHost(connection);
    requireAgentHostAgent(agents);
    let model: { id: string; config?: Record<string, string | number> } | undefined;
    if (request.modelId) {
      const info = selectAgentHostModel(
        agents,
        request.modelId,
        request.hostModelIdExplicit === true,
      );
      const config = mapModelConfiguration(info, request.modelOptions ?? {});
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
    const chat = await resolveAgentHostChat(
      connection,
      request.targetChatId,
      request.expectedWorkspacePath,
    );
    const messageId = `copilot-scheduler-${createHash("sha256")
      .update(request.taskId || randomUUID())
      .digest("hex")}`;
    const message = {
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

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let dispatchStarted = false;
      let dispatchOrigin: AgentHostActionOrigin | undefined;
      let timedOut = false;
      let guardPending = !!request.dispatchGuard;
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
        if (guardPending) {
          pendingOutcome ??= outcome;
        } else {
          finish(outcome);
        }
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          finish(() =>
            reject(
              new AgentHostError(
                "failed",
                "The Agent Host did not confirm the queued message.",
                dispatchStarted ? "unknown" : undefined,
              ),
            ),
          );
        },
        REQUEST_TIMEOUT_MS,
      );
      const stopListening = connection.onAction((channel, action, envelope) => {
        // Message IDs are reused; only this dispatch's origin can confirm it.
        const origin = envelope.origin;
        if (
          !dispatchStarted ||
          !dispatchOrigin ||
          !origin ||
          typeof origin !== "object" ||
          !("clientId" in origin) ||
          !("clientSeq" in origin) ||
          origin.clientId !== dispatchOrigin.clientId ||
          origin.clientSeq !== dispatchOrigin.clientSeq ||
          channel !== chat.chatUri ||
          action.type !== "chat/pendingMessageSet" ||
          action.id !== messageId
        ) {
          return;
        }
        if (envelope.rejected) {
          finishAfterGuard(() =>
            reject(
              new AgentHostError(
                "failed",
                "The Agent Host rejected the queued message.",
                "unknown",
              ),
            ),
          );
        } else if (action.kind === "queued") {
          finishAfterGuard(resolve);
        }
      });
      const stopWatchingClose = connection.onClose(() =>
        finishAfterGuard(() =>
          reject(
            new AgentHostError(
              "failed",
              "The Agent Host connection closed before confirming the queued message.",
              dispatchStarted ? "unknown" : undefined,
            ),
          ),
        ),
      );
      const dispatch = () => {
        if (settled || timedOut || dispatchStarted) return;
        dispatchStarted = true;
        const dispatched = connection.dispatchWithOrigin(chat.chatUri, {
          type: "chat/pendingMessageSet",
          kind: "queued",
          id: messageId,
          message,
        });
        dispatchOrigin = dispatched.origin;
        void dispatched.response.catch(() =>
          finishAfterGuard(() =>
            reject(
              new AgentHostError(
                "failed",
                "The Agent Host did not confirm the queued message.",
                "unknown",
              ),
            ),
          ),
        );
      };
      if (request.dispatchGuard) {
        void request.dispatchGuard(dispatch).then(
          () => {
            guardPending = false;
            if (pendingOutcome) finish(pendingOutcome);
            else if (!dispatchStarted) {
              finish(() =>
                reject(
                  new AgentHostError(
                    "failed",
                    "The task reservation did not allow a queued message.",
                  ),
                ),
              );
            }
          },
          (error: unknown) =>
            finish(() =>
              reject(
                dispatchStarted
                  ? new AgentHostError(
                      "failed",
                      "The queued message outcome is unknown.",
                      "unknown",
                    )
                  : error,
              ),
            ),
        );
      } else {
        dispatch();
      }
    });

    return {
      sessionUri: chat.sessionUri,
      chatUri: chat.chatUri,
      messageId,
      ...(model ? { requestedModel: model.id } : {}),
    };
  } finally {
    connection.close();
  }
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
      throw error instanceof AgentHostError &&
        (error.kind === "unsupported" || error.kind === "modelIdentity")
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
  const agents = await initializeAgentHost(connection);
  requireAgentHostAgent(agents);

  let model: { id: string; config?: Record<string, string | number> } | undefined;
  if (request.modelId) {
    const info = selectAgentHostModel(
      agents,
      request.modelId,
      request.hostModelIdExplicit === true,
    );
    const config = mapModelConfiguration(info, request.modelOptions ?? {});
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
    let responseTextObserved = false;
    let responseTextUncertain = false;
    const markdownParts = new Set<string>();
    let settled = false;
    let dispatchStarted = false;
    let guardPending = !!request.dispatchGuard;
    let pendingOutcome: (() => void) | undefined;
    let sessionStarted = false;
    let cancelTimer: NodeJS.Timeout | undefined;
    const revealSession = () => {
      if (sessionStarted) return;
      sessionStarted = true;
      try {
        request.onSessionStarted?.(ref);
      } catch {
        // Revealing the session is best effort and must not fail the run.
      }
    };
    const finish = (outcome: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (cancelTimer) {
        clearTimeout(cancelTimer);
      }
      stopListening();
      stopWatchingClose();
      outcome();
    };
    const finishAfterGuard = (outcome: () => void) => {
      if (guardPending) {
        pendingOutcome ??= outcome;
      } else {
        finish(outcome);
      }
    };

    const timer = setTimeout(() => {
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
        .catch(() => undefined);
    }, request.timeoutMs);

    const stopListening = connection.onAction((channel, action, envelope) => {
      if (channel !== ref.chatUri) {
        return;
      }
      // A continued chat can carry events of other turns; only this turn counts.
      if (action.turnId !== turnId) {
        return;
      }
      if (envelope.rejected) {
        if (action.type === "chat/turnStarted") {
          finish(() =>
            reject(
              new AgentHostError(
                "failed",
                "The Agent Host rejected the turn.",
                "unknown",
              ),
            ),
          );
        }
        return;
      }
      if (
        action.type === "chat/turnStarted" ||
        action.type === "chat/responsePart" ||
        action.type === "chat/delta" ||
        action.type === "chat/usage" ||
        action.type === "chat/turnComplete" ||
        action.type === "chat/error"
      ) {
        revealSession();
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
        finishAfterGuard(() =>
          resolve({
            ...ref,
            ...(model ? { requestedModel: model.id } : {}),
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
        finishAfterGuard(() =>
          reject(
            new AgentHostError(
              "failed",
              detail || "The Agent Host run failed.",
              "failed",
            ),
          ),
        );
      } else if (action.type === "chat/turnCancelled") {
        finishAfterGuard(() =>
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

    const dispatch = () => {
      if (settled || dispatchStarted) return;
      dispatchStarted = true;
      void connection
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
        .catch((error: unknown) =>
          finish(() =>
            reject(
              new AgentHostError(
                "failed",
                error instanceof AgentHostError
                  ? error.message
                  : "The Agent Host rejected the run.",
                "unknown",
              ),
            ),
          ),
        );
    };
    if (request.dispatchGuard) {
      void request.dispatchGuard(dispatch).then(
        () => {
          guardPending = false;
          if (pendingOutcome) finish(pendingOutcome);
          else if (!dispatchStarted) {
            finish(() =>
              reject(
                new AgentHostError(
                  "failed",
                  "The task reservation did not allow a turn.",
                ),
              ),
            );
          }
        },
        (error: unknown) =>
          finish(() =>
            reject(
              dispatchStarted
                ? new AgentHostError("failed", "The dispatch outcome could not be confirmed.", "unknown")
                : error,
            ),
          ),
      );
    } else {
      dispatch();
    }
  });
}



