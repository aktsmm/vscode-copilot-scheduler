import * as vscode from "vscode";
import type {
  ModelInfo,
  ModelConfiguration,
  ModelConfigurationKey,
  ModelConfigurationOption,
  ModelConfigurationValue,
} from "./types";

const KEYS: readonly ModelConfigurationKey[] = [
  "mode",
  "reasoningEffort",
  "speedMode",
  "contextSize",
];
const MAX_BYTES = 1024 * 1024;
const MAX_CHOICES = 64;
const MAX_MODELS = 2000;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid schema object");
  return value as Record<string, unknown>;
}

function resolve(
  root: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  let current = record(value);
  const seen = new Set<object>();
  for (let depth = 0; depth < 24; depth++) {
    if (!Object.hasOwn(current, "$ref")) return current;
    if (seen.has(current) || Object.keys(current).length !== 1)
      throw new Error("Unsupported schema reference");
    seen.add(current);
    if (typeof current.$ref !== "string" || !current.$ref.startsWith("#/"))
      throw new Error("External schema reference");
    let target: unknown = root;
    for (const encoded of current.$ref.slice(2).split("/")) {
      const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
      if (BLOCKED_KEYS.has(key)) throw new Error("Unsafe schema reference");
      const parent = record(target);
      if (!Object.hasOwn(parent, key))
        throw new Error("Missing schema reference");
      target = parent[key];
    }
    current = record(target);
  }
  throw new Error("Schema reference limit");
}

function primitive(value: unknown): value is ModelConfigurationValue {
  return (
    (typeof value === "string" && value.length <= 256) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function option(
  root: Record<string, unknown>,
  key: ModelConfigurationKey,
  raw: unknown,
): ModelConfigurationOption {
  const schema = resolve(root, raw);
  if (schema.secret === true || schema.format === "password") {
    throw new Error("Secret model option is not exposed");
  }
  if (
    !Array.isArray(schema.enum) ||
    !schema.enum.length ||
    schema.enum.length > MAX_CHOICES ||
    !schema.enum.every(primitive)
  )
    throw new Error("Invalid option enum");
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!schema.enum.every((value) => types.includes(typeof value)))
    throw new Error("Option type mismatch");
  if (
    new Set(schema.enum.map((value) => JSON.stringify(value))).size !==
    schema.enum.length
  )
    throw new Error("Duplicate option values");
  const labels = schema.enumItemLabels;
  if (
    labels !== undefined &&
    (!Array.isArray(labels) ||
      labels.length !== schema.enum.length ||
      !labels.every(
        (label) =>
          typeof label === "string" && label.length > 0 && label.length <= 256,
      ))
  )
    throw new Error("Invalid option labels");
  if (
    schema.default !== undefined &&
    !schema.enum.some((value) => value === schema.default)
  )
    throw new Error("Invalid option default");
  return {
    key,
    label:
      typeof schema.title === "string" && schema.title.length <= 256
        ? schema.title
        : key,
    choices: schema.enum.map((value, index) => ({
      value,
      label: Array.isArray(labels) ? labels[index] : String(value),
    })),
    ...(schema.default !== undefined
      ? { defaultValue: schema.default as ModelConfigurationValue }
      : {}),
  };
}

export function enrichModelConfigurationCatalog(
  models: readonly ModelInfo[],
  raw: string,
): ModelInfo[] {
  try {
    if (Buffer.byteLength(raw, "utf8") > MAX_BYTES)
      throw new Error("Schema size limit");
    const root = record(JSON.parse(raw));
    const items = resolve(root, root.items);
    if (!Array.isArray(items.allOf) || items.allOf.length > MAX_MODELS)
      throw new Error("Unsupported model schema");
    const options = new Map<string, ModelConfigurationOption[]>();
    const invalid = new Set<string>();
    for (const rawBlock of items.allOf) {
      const block = resolve(root, rawBlock);
      if (!block.then) continue;
      const condition = resolve(root, block.if);
      if (Object.keys(condition).some((key) => key !== "properties"))
        throw new Error("Unsupported vendor condition");
      const properties = record(condition.properties);
      if (
        Object.keys(properties).length !== 1 ||
        !Object.hasOwn(properties, "vendor")
      )
        throw new Error("Ambiguous vendor condition");
      const vendorSchema = resolve(root, properties.vendor);
      if (
        Object.keys(vendorSchema).length !== 1 ||
        typeof vendorSchema.const !== "string"
      )
        throw new Error("Unsupported vendor binding");
      const vendor = vendorSchema.const;
      const thenProperties = record(resolve(root, block.then).properties);
      if (!thenProperties.settings) continue;
      const settingsProperties = record(
        resolve(root, thenProperties.settings).properties,
      );
      if (Object.keys(settingsProperties).length > MAX_MODELS)
        throw new Error("Model count limit");
      for (const [id, modelSchema] of Object.entries(settingsProperties)) {
        const identity = JSON.stringify([vendor, id]);
        if (!models.some((model) => model.vendor === vendor && model.id === id))
          continue;
        try {
          const modelProperties = record(resolve(root, modelSchema).properties);
          const found = KEYS.filter((key) =>
            Object.hasOwn(modelProperties, key),
          ).map((key) => option(root, key, modelProperties[key]));
          const current = options.get(identity) || [];
          for (const entry of found) {
            const existing = current.find(
              (candidate) => candidate.key === entry.key,
            );
            if (existing && JSON.stringify(existing) !== JSON.stringify(entry))
              throw new Error("Conflicting model options");
            if (!existing) current.push(entry);
          }
          options.set(identity, current);
        } catch {
          invalid.add(identity);
        }
      }
    }
    return models.map((model) => {
      const identity = JSON.stringify([model.vendor, model.id]);
      const found = options.get(identity);
      return {
        ...model,
        configurationOptions: invalid.has(identity) ? [] : found || [],
        configurationStatus: invalid.has(identity)
          ? "invalid"
          : found?.length
            ? "available"
            : "unsupported",
      };
    });
  } catch {
    return models.map((model) => ({
      ...model,
      configurationOptions: [],
      configurationStatus: "invalid",
    }));
  }
}

export async function loadModelConfigurationCatalog(
  models: readonly ModelInfo[],
): Promise<ModelInfo[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      (async () => {
        await vscode.extensions
          .getExtension("vscode.json-language-features")
          ?.activate();
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.parse("vscode://schemas/language-models"),
        );
        if (bytes.byteLength > MAX_BYTES) throw new Error("Schema size limit");
        return Buffer.from(bytes).toString("utf8");
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Schema read timeout")),
          3000,
        );
      }),
    ]);
    return enrichModelConfigurationCatalog(models, raw);
  } catch {
    return models.map((model) => ({
      ...model,
      configurationOptions: [],
      configurationStatus: "unavailable",
    }));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function normalizeModelConfiguration(
  value: unknown,
): ModelConfiguration {
  const source = record(value);
  const result: ModelConfiguration = {};
  for (const key of Reflect.ownKeys(source)) {
    if (
      typeof key !== "string" ||
      !KEYS.includes(key as ModelConfigurationKey) ||
      !primitive(source[key])
    )
      throw new Error("Invalid model configuration");
  }
  for (const key of KEYS) {
    if (Object.hasOwn(source, key))
      result[key] = source[key] as ModelConfigurationValue;
  }
  return result;
}

export function validateModelConfiguration(
  model: ModelInfo,
  value: ModelConfiguration,
): void {
  const normalized = normalizeModelConfiguration(value);
  if (Object.keys(normalized).length === 0) return;
  if (model.configurationStatus !== "available")
    throw new Error("Model configuration schema is unavailable");
  for (const [key, selected] of Object.entries(normalized)) {
    const descriptor = model.configurationOptions?.find(
      (entry) => entry.key === key,
    );
    if (!descriptor?.choices.some((choice) => choice.value === selected))
      throw new Error("Saved model configuration is not supported");
  }
  if (
    normalized.mode !== undefined &&
    (normalized.reasoningEffort !== undefined ||
      normalized.speedMode !== undefined)
  )
    throw new Error("Conflicting reasoning and speed configuration");
}
