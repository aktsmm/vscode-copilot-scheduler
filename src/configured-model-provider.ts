import * as vscode from "vscode";
import { createHash } from "crypto";
import type { ModelConfiguration, ModelInfo } from "./types";
import { messages } from "./i18n";
import {
  loadModelConfigurationCatalog,
  normalizeModelConfiguration,
  validateModelConfiguration,
} from "./model-configuration";

export const CONFIGURED_MODEL_VENDOR = "copilot-scheduler-configured";
let configuredProviderOwner = "yamapan.copilot-scheduler";

export function hasSystemMessageDeclaration(): boolean {
  const manifest = vscode.extensions.getExtension(
    configuredProviderOwner,
  )?.packageJSON;
  const proposals =
    manifest?.originalEnabledApiProposals ?? manifest?.enabledApiProposals;
  return Array.isArray(proposals) && proposals.includes("languageModelSystem");
}

export function supportsSystemMessageForwarding(): boolean {
  const proposals = vscode.extensions.getExtension(configuredProviderOwner)
    ?.packageJSON.enabledApiProposals;
  return Array.isArray(proposals) && proposals.includes("languageModelSystem");
}

function assertForwardableRole(
  role: vscode.LanguageModelChatMessageRole,
): void {
  if (Number(role) === 3 && supportsSystemMessageForwarding()) return;
  if (
    role !== vscode.LanguageModelChatMessageRole.User &&
    role !== vscode.LanguageModelChatMessageRole.Assistant
  ) {
    throw vscode.LanguageModelError.Blocked(
      messages.dynamicConfigurationSystemMessagesUnsupported(),
    );
  }
}

function assertModelIdentity(
  model: vscode.LanguageModelChat,
  vendor: string,
  id: string,
  version?: string,
): void {
  if (
    model.vendor !== vendor ||
    model.id !== id ||
    (version !== undefined && model.version !== version)
  ) {
    throw new Error(
      "Selected model identity changed; execution stopped without fallback",
    );
  }
}

interface ConfiguredModelInfo extends vscode.LanguageModelChatInformation {
  sourceVendor: string;
  sourceId: string;
  sourceVersion?: string;
  configuration: ModelConfiguration;
}

export function supportsConfiguredModelExecution(): boolean {
  const version = /^1\.(\d+)\./u.exec(vscode.version);
  return (
    !!version &&
    Number(version[1]) >= 141 &&
    typeof vscode.lm.registerLanguageModelChatProvider === "function"
  );
}

export function buildConfiguredRequestOptions(
  options: vscode.ProvideLanguageModelChatResponseOptions,
  configuration: ModelConfiguration,
): vscode.LanguageModelChatRequestOptions & {
  configuration: Record<string, unknown>;
} {
  const fixed: Record<string, unknown> = {
    ...normalizeModelConfiguration(configuration),
  };
  if (
    fixed.mode === undefined &&
    (fixed.reasoningEffort !== undefined || fixed.speedMode !== undefined)
  )
    fixed.mode = null;
  const forwarded = {
    ...options,
    tools: options.tools ? [...options.tools] : undefined,
    configuration: fixed,
  };
  delete (forwarded as Record<string, unknown>).modelConfiguration;
  return forwarded;
}

export class ConfiguredModelProvider
  implements
    vscode.LanguageModelChatProvider<ConfiguredModelInfo>,
    vscode.Disposable
{
  private readonly change = new vscode.EventEmitter<void>();
  private readonly bindings = new Map<string, ConfiguredModelInfo>();
  private readonly tokenSources = new Map<string, vscode.LanguageModelChat>();
  private readonly pendingTokenSources = new Map<
    string,
    Promise<vscode.LanguageModelChat>
  >();
  private readonly tokenSourceCancellation =
    new vscode.CancellationTokenSource();
  private tokenSourceRevision = 0;
  private disposed = false;
  private readonly tokenSourceInvalidation?: vscode.Disposable;
  readonly onDidChangeLanguageModelChatInformation = this.change.event;
  constructor(
    private readonly selectModels = vscode.lm.selectChatModels,
    private readonly loadOptions = loadModelConfigurationCatalog,
    onModelsChanged = vscode.lm.onDidChangeChatModels,
  ) {
    this.tokenSourceInvalidation = onModelsChanged?.(() => {
      this.tokenSourceRevision++;
      this.tokenSources.clear();
      this.pendingTokenSources.clear();
    });
  }

  bind(
    model: ModelInfo,
    configuration: ModelConfiguration,
  ): ConfiguredModelInfo {
    if (this.disposed) throw new vscode.CancellationError();
    if (model.vendor === CONFIGURED_MODEL_VENDOR)
      throw new Error("Configured model recursion is not allowed");
    validateModelConfiguration(model, configuration);
    const normalized = normalizeModelConfiguration(configuration);
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          model.vendor,
          model.id,
          model.version,
          model.maxInputTokens,
          model.supportsToolCalling,
          model.supportsImageInput,
          normalized,
        ]),
      )
      .digest("hex");
    const existing = this.bindings.get(id);
    if (existing) return existing;
    if (this.bindings.size >= 256)
      throw new Error(
        "Configured model capacity reached; reload the extension",
      );
    const binding: ConfiguredModelInfo = {
      id,
      name: `${model.name} (${Object.values(normalized).join(", ")})`,
      family: model.family || model.id,
      version: model.version || "",
      maxInputTokens:
        typeof normalized.contextSize === "number" && normalized.contextSize > 0
          ? Math.min(
              normalized.contextSize,
              model.maxInputTokens || normalized.contextSize,
            )
          : model.maxInputTokens || 4096,
      maxOutputTokens: 8192,
      capabilities: {
        toolCalling: model.supportsToolCalling === true,
        imageInput: model.supportsImageInput === true,
      },
      sourceVendor: model.vendor,
      sourceId: model.id,
      sourceVersion: model.version || undefined,
      configuration: Object.freeze({ ...normalized }),
    };
    this.bindings.set(id, binding);
    this.change.fire();
    return binding;
  }

  provideLanguageModelChatInformation(): ConfiguredModelInfo[] {
    return [...this.bindings.values()].map((model) => ({
      ...model,
    }));
  }

  private sourceToken(
    token: vscode.CancellationToken,
  ): vscode.CancellationToken {
    const lifetime = this.tokenSourceCancellation.token;
    return {
      get isCancellationRequested() {
        return (
          token.isCancellationRequested || lifetime.isCancellationRequested
        );
      },
      onCancellationRequested: (listener, thisArgs, disposables) => {
        let fired = false;
        const emit = () => {
          if (!fired) {
            fired = true;
            listener.call(thisArgs, undefined);
          }
        };
        const caller = token.onCancellationRequested(emit);
        const owner = lifetime.onCancellationRequested(emit);
        const subscription = new vscode.Disposable(() => {
          caller.dispose();
          owner.dispose();
        });
        disposables?.push(subscription);
        return subscription;
      },
    };
  }

  private throwIfStopped(token: vscode.CancellationToken): void {
    if (this.disposed || token.isCancellationRequested)
      throw new vscode.CancellationError();
  }

  private async waitFor<T>(
    action: () => PromiseLike<T>,
    token: vscode.CancellationToken,
  ): Promise<T> {
    this.throwIfStopped(token);
    let cancelCaller: vscode.Disposable | undefined;
    let cancelProvider: vscode.Disposable | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(new vscode.CancellationError());
      cancelCaller = token.onCancellationRequested(cancel);
      cancelProvider =
        this.tokenSourceCancellation.token.onCancellationRequested(cancel);
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.throwIfStopped(token);
          return action();
        }),
        stopped,
      ]);
      this.throwIfStopped(token);
      return result;
    } finally {
      cancelCaller?.dispose();
      cancelProvider?.dispose();
    }
  }

  private async source(
    model: ConfiguredModelInfo,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChat> {
    this.throwIfStopped(token);
    const sources = await this.waitFor(
      () =>
        this.selectModels({
          vendor: model.sourceVendor,
          id: model.sourceId,
          ...(model.sourceVersion ? { version: model.sourceVersion } : {}),
        }),
      token,
    );
    if (sources.length !== 1)
      throw new Error("Selected source model is unavailable or ambiguous");
    const source = sources[0];
    assertModelIdentity(
      source,
      model.sourceVendor,
      model.sourceId,
      model.sourceVersion,
    );
    const catalog = await this.waitFor(
      () =>
        this.loadOptions([
          {
            id: source.id,
            vendor: source.vendor,
            name: source.name,
            family: source.family,
            version: source.version,
            maxInputTokens: source.maxInputTokens,
            description: "",
          },
        ]),
      token,
    );
    validateModelConfiguration(catalog[0], model.configuration);
    return source;
  }

  async provideLanguageModelChatResponse(
    model: ConfiguredModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const binding = this.bindings.get(model.id);
    if (!binding) throw new Error("Configured task model no longer exists");
    this.throwIfStopped(token);
    for (const message of messages) assertForwardableRole(message.role);
    const source = await this.source(binding, token);
    const converted = messages.map(
      (message) =>
        new vscode.LanguageModelChatMessage(
          message.role,
          [...message.content] as vscode.LanguageModelInputPart[],
          message.name,
        ),
    );
    this.throwIfStopped(token);
    const response = await this.waitFor(
      () =>
        source.sendRequest(
          converted,
          buildConfiguredRequestOptions(options, binding.configuration),
          this.sourceToken(token),
        ),
      token,
    );
    const iterator = response.stream[Symbol.asyncIterator]();
    let completed = false;
    try {
      while (true) {
        const result = await this.waitFor(() => iterator.next(), token);
        if (result.done) {
          completed = true;
          break;
        }
        progress.report(result.value as vscode.LanguageModelResponsePart);
      }
    } finally {
      if (!completed && iterator.return) {
        try {
          void Promise.resolve(iterator.return()).catch(() => undefined);
        } catch {}
      }
    }
    this.throwIfStopped(token);
  }

  private async tokenSource(
    model: ConfiguredModelInfo,
  ): Promise<vscode.LanguageModelChat> {
    const cached = this.tokenSources.get(model.id);
    if (cached) return cached;
    const pending = this.pendingTokenSources.get(model.id);
    if (pending) return pending;
    const revision = this.tokenSourceRevision;
    const operation: Promise<vscode.LanguageModelChat> = this.source(
      model,
      this.tokenSourceCancellation.token,
    )
      .then((source) => {
        if (this.disposed || revision !== this.tokenSourceRevision)
          throw new vscode.CancellationError();
        this.tokenSources.set(model.id, source);
        return source;
      })
      .finally(() => {
        if (this.pendingTokenSources.get(model.id) === operation)
          this.pendingTokenSources.delete(model.id);
      });
    this.pendingTokenSources.set(model.id, operation);
    return operation;
  }

  async provideTokenCount(
    model: ConfiguredModelInfo,
    value: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    const binding = this.bindings.get(model.id);
    if (!binding) throw new Error("Configured task model no longer exists");
    this.throwIfStopped(token);
    if (typeof value !== "string") assertForwardableRole(value.role);
    const source = await this.waitFor(() => this.tokenSource(binding), token);
    assertModelIdentity(
      source,
      binding.sourceVendor,
      binding.sourceId,
      binding.sourceVersion,
    );
    const count = await this.waitFor(
      () =>
        source.countTokens(
          typeof value === "string"
            ? value
            : new vscode.LanguageModelChatMessage(
                value.role,
                [...value.content] as vscode.LanguageModelInputPart[],
                value.name,
              ),
          this.sourceToken(token),
        ),
      token,
    );
    return count;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tokenSourceCancellation.cancel();
    this.tokenSourceCancellation.dispose();
    this.tokenSourceInvalidation?.dispose();
    this.tokenSources.clear();
    this.pendingTokenSources.clear();
    this.bindings.clear();
    this.change.dispose();
  }
}

let activeProvider: ConfiguredModelProvider | undefined;

export function registerConfiguredModelProvider(
  context: vscode.ExtensionContext,
): void {
  configuredProviderOwner = context.extension.id;
  if (!supportsConfiguredModelExecution()) return;
  const provider = new ConfiguredModelProvider();
  activeProvider = provider;
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(
      CONFIGURED_MODEL_VENDOR,
      provider,
    ),
    {
      dispose() {
        provider.dispose();
        if (activeProvider === provider) activeProvider = undefined;
      },
    },
  );
}

export async function resolveConfiguredTaskModel(
  model: ModelInfo,
  configuration: ModelConfiguration,
): Promise<ModelInfo> {
  const provider = activeProvider;
  if (!provider || !supportsConfiguredModelExecution())
    throw new Error("Dynamic execution requires VS Code 1.141 or later");
  const sources = await vscode.lm.selectChatModels({
    vendor: model.vendor,
    id: model.id,
    ...(model.version ? { version: model.version } : {}),
  });
  if (activeProvider !== provider) throw new vscode.CancellationError();
  if (sources.length !== 1)
    throw new Error("Source model is unavailable or ambiguous");
  assertModelIdentity(
    sources[0],
    model.vendor,
    model.id,
    model.version || undefined,
  );
  const capabilities = (
    sources[0] as unknown as {
      capabilities?: {
        supportsToolCalling?: boolean;
        supportsImageToText?: boolean;
      };
    }
  ).capabilities;
  const binding = provider.bind(
    {
      ...model,
      supportsToolCalling: capabilities?.supportsToolCalling,
      supportsImageInput: capabilities?.supportsImageToText,
    },
    configuration,
  );
  const registered = await vscode.lm.selectChatModels({
    vendor: CONFIGURED_MODEL_VENDOR,
    id: binding.id,
  });
  if (activeProvider !== provider) throw new vscode.CancellationError();
  if (registered.length !== 1)
    throw new Error("Configured task model was not registered");
  assertModelIdentity(
    registered[0],
    CONFIGURED_MODEL_VENDOR,
    binding.id,
    binding.version,
  );
  return {
    id: registered[0].id,
    name: binding.name,
    vendor: CONFIGURED_MODEL_VENDOR,
    family: binding.family,
    version: binding.version,
    maxInputTokens: binding.maxInputTokens,
    description: "",
  };
}
