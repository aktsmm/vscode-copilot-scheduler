import * as vscode from "vscode";
import { createHash } from "crypto";
import type { ModelConfiguration, ModelInfo } from "./types";
import {
  loadModelConfigurationCatalog,
  normalizeModelConfiguration,
  validateModelConfiguration,
} from "./model-configuration";

export const CONFIGURED_MODEL_VENDOR = "copilot-scheduler-configured";

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
  readonly onDidChangeLanguageModelChatInformation = this.change.event;
  constructor(
    private readonly selectModels = vscode.lm.selectChatModels,
    private readonly loadOptions = loadModelConfigurationCatalog,
  ) {}

  bind(
    model: ModelInfo,
    configuration: ModelConfiguration,
  ): ConfiguredModelInfo {
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
      isUserSelectable: false,
    }));
  }

  private async source(
    model: ConfiguredModelInfo,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChat> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const sources = await this.selectModels({
      vendor: model.sourceVendor,
      id: model.sourceId,
      ...(model.sourceVersion ? { version: model.sourceVersion } : {}),
    });
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (sources.length !== 1)
      throw new Error("Selected source model is unavailable or ambiguous");
    const source = sources[0];
    assertModelIdentity(
      source,
      model.sourceVendor,
      model.sourceId,
      model.sourceVersion,
    );
    const catalog = await this.loadOptions([
      {
        id: source.id,
        vendor: source.vendor,
        name: source.name,
        family: source.family,
        version: source.version,
        maxInputTokens: source.maxInputTokens,
        description: "",
      },
    ]);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
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
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const source = await this.source(binding, token);
    const converted = messages.map(
      (message) =>
        new vscode.LanguageModelChatMessage(
          message.role,
          [...message.content] as vscode.LanguageModelInputPart[],
          message.name,
        ),
    );
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const response = await source.sendRequest(
      converted,
      buildConfiguredRequestOptions(options, binding.configuration),
      token,
    );
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    for await (const part of response.stream) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      progress.report(part as vscode.LanguageModelResponsePart);
    }
    if (token.isCancellationRequested) throw new vscode.CancellationError();
  }

  async provideTokenCount(
    model: ConfiguredModelInfo,
    value: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    const binding = this.bindings.get(model.id);
    if (!binding) throw new Error("Configured task model no longer exists");
    const source = await this.source(binding, token);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const count = await source.countTokens(
      typeof value === "string"
        ? value
        : new vscode.LanguageModelChatMessage(
            value.role,
            [...value.content] as vscode.LanguageModelInputPart[],
            value.name,
          ),
      token,
    );
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    return count;
  }

  dispose(): void {
    this.bindings.clear();
    this.change.dispose();
  }
}

let activeProvider: ConfiguredModelProvider | undefined;

export function registerConfiguredModelProvider(
  context: vscode.ExtensionContext,
): void {
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
  if (!activeProvider || !supportsConfiguredModelExecution())
    throw new Error("Dynamic execution requires VS Code 1.141 or later");
  const sources = await vscode.lm.selectChatModels({
    vendor: model.vendor,
    id: model.id,
    ...(model.version ? { version: model.version } : {}),
  });
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
  const binding = activeProvider.bind(
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
