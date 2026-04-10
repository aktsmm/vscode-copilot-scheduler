import * as path from "path";
import * as vscode from "vscode";
import type { ModelInfo, ModelSelectionFields } from "./types";

export const EXPERIMENTAL_REASONING_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ExperimentalReasoningEffort =
  (typeof EXPERIMENTAL_REASONING_EFFORT_LEVELS)[number];

export type ExperimentalModelQualityVariant = {
  label: string;
  reasoningEffort?: ExperimentalReasoningEffort;
};

type LanguageModelsProviderGroup = {
  name: string;
  vendor: string;
  settings?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

type UpdateLanguageModelsConfigParams = {
  vendor: string;
  modelId: string;
  reasoningEffort?: ExperimentalReasoningEffort;
};

type ExperimentalModelQualityRule = {
  familyPattern: RegExp;
  efforts: readonly ExperimentalReasoningEffort[];
};

const EXPERIMENTAL_MODEL_QUALITY_RULES: readonly ExperimentalModelQualityRule[] =
  [
    {
      familyPattern: /^gpt-5(?:$|-)/u,
      efforts: ["low", "medium", "high", "xhigh"],
    },
    {
      familyPattern: /^claude-opus(?:$|-)/u,
      efforts: ["low", "medium", "high"],
    },
    {
      familyPattern: /^claude-sonnet(?:$|-)/u,
      efforts: ["low", "medium", "high"],
    },
  ];

function trimOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeKey(value: string | undefined): string {
  return (value || "").trim().toLowerCase();
}

function normalizeModelFamilyKey(value: string | undefined): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/[_.\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getReasoningEffortLabel(
  reasoningEffort: ExperimentalReasoningEffort,
): string {
  switch (reasoningEffort) {
    case "xhigh":
      return "Xhigh";
    default:
      return reasoningEffort.charAt(0).toUpperCase() + reasoningEffort.slice(1);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function isExperimentalModelQualityEnabled(
  _config = vscode.workspace.getConfiguration("copilotScheduler"),
): boolean {
  return true;
}

export function normalizeExperimentalReasoningEffort(
  value: unknown,
): ExperimentalReasoningEffort | undefined {
  const normalized = trimOptionalText(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return EXPERIMENTAL_REASONING_EFFORT_LEVELS.includes(
    normalized as ExperimentalReasoningEffort,
  )
    ? (normalized as ExperimentalReasoningEffort)
    : undefined;
}

export function supportsExperimentalModelQuality(model: {
  vendor?: string;
  family?: string;
}): boolean {
  const vendor = normalizeKey(model.vendor);
  if (vendor !== "copilot" && vendor !== "github-copilot") {
    return false;
  }

  const familyKey = normalizeModelFamilyKey(model.family);
  return EXPERIMENTAL_MODEL_QUALITY_RULES.some((rule) =>
    rule.familyPattern.test(familyKey),
  );
}

export function getSupportedExperimentalReasoningEfforts(model: {
  vendor?: string;
  family?: string;
}): readonly ExperimentalReasoningEffort[] {
  if (!supportsExperimentalModelQuality(model)) {
    return [];
  }

  const familyKey = normalizeModelFamilyKey(model.family);
  const matchedRule = EXPERIMENTAL_MODEL_QUALITY_RULES.find((rule) =>
    rule.familyPattern.test(familyKey),
  );

  return matchedRule?.efforts || [];
}

export function getExperimentalModelQualityVariants(
  model: ModelInfo,
): ExperimentalModelQualityVariant[] {
  const supportedEfforts = getSupportedExperimentalReasoningEfforts(model);
  if (supportedEfforts.length === 0) {
    return [];
  }

  return [
    { label: "Default" },
    ...supportedEfforts.map((reasoningEffort) => ({
      label: getReasoningEffortLabel(reasoningEffort),
      reasoningEffort,
    })),
  ];
}

export function getLanguageModelsConfigUriFromGlobalStorageUri(
  globalStorageUri: vscode.Uri,
): vscode.Uri {
  const profileDir = path.dirname(path.dirname(globalStorageUri.fsPath));
  return vscode.Uri.file(path.join(profileDir, "chatLanguageModels.json"));
}

function parseLanguageModelsProviderGroups(
  rawText: string | undefined,
): LanguageModelsProviderGroup[] {
  const normalizedText = trimOptionalText(rawText);
  if (!normalizedText) {
    return [];
  }

  const parsed = JSON.parse(normalizedText);
  if (!Array.isArray(parsed)) {
    throw new Error("chatLanguageModels.json must contain a JSON array.");
  }

  return parsed.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error(
        "chatLanguageModels.json contains an invalid provider group entry.",
      );
    }
    return { ...entry } as LanguageModelsProviderGroup;
  });
}

export function updateLanguageModelsConfigText(
  rawText: string | undefined,
  params: UpdateLanguageModelsConfigParams,
): string {
  const vendor = trimOptionalText(params.vendor) || "copilot";
  const modelId = trimOptionalText(params.modelId);
  if (!modelId) {
    throw new Error("Model id is required to update chatLanguageModels.json.");
  }

  const reasoningEffort = normalizeExperimentalReasoningEffort(
    params.reasoningEffort,
  );
  const groups = parseLanguageModelsProviderGroups(rawText);
  const originalJson = trimOptionalText(rawText);

  let targetIndex = groups.findIndex(
    (group) =>
      normalizeKey(group.vendor) === normalizeKey(vendor) &&
      isRecord(group.settings) &&
      isRecord(group.settings[modelId]),
  );
  if (targetIndex < 0) {
    targetIndex = groups.findIndex(
      (group) => normalizeKey(group.vendor) === normalizeKey(vendor),
    );
  }

  if (targetIndex < 0) {
    if (!reasoningEffort) {
      return originalJson || "[]";
    }
    groups.push({
      name: vendor,
      vendor,
      settings: {
        [modelId]: {
          reasoningEffort,
        },
      },
    });
    return JSON.stringify(groups, undefined, "\t");
  }

  const targetGroup = { ...groups[targetIndex] };
  const settings = isRecord(targetGroup.settings)
    ? ({ ...targetGroup.settings } as Record<string, Record<string, unknown>>)
    : {};
  const modelSettings = isRecord(settings[modelId])
    ? { ...settings[modelId] }
    : {};
  const previousReasoningEffort = normalizeExperimentalReasoningEffort(
    modelSettings.reasoningEffort,
  );

  let changed = false;
  if (reasoningEffort) {
    if (previousReasoningEffort !== reasoningEffort) {
      changed = true;
    }
    modelSettings.reasoningEffort = reasoningEffort;
    settings[modelId] = modelSettings;
  } else {
    if (hasOwn(modelSettings, "reasoningEffort")) {
      delete modelSettings.reasoningEffort;
      changed = true;
    }
    if (Object.keys(modelSettings).length > 0) {
      settings[modelId] = modelSettings;
    } else if (hasOwn(settings, modelId)) {
      delete settings[modelId];
      changed = true;
    }
  }

  if (Object.keys(settings).length > 0) {
    targetGroup.settings = settings;
  } else if (hasOwn(targetGroup, "settings")) {
    delete targetGroup.settings;
    changed = true;
  }

  if (!changed) {
    return originalJson || JSON.stringify(groups, undefined, "\t");
  }

  groups[targetIndex] = targetGroup;
  return JSON.stringify(groups, undefined, "\t");
}

export async function applyExperimentalModelQualitySelection(args: {
  globalStorageUri: vscode.Uri;
  selection: ModelSelectionFields;
  matchedModel?: ModelInfo;
}): Promise<boolean> {
  const savedReasoningEffort = normalizeExperimentalReasoningEffort(
    args.selection.modelReasoningEffort,
  );

  const matchedModel = args.matchedModel;
  const modelId =
    trimOptionalText(matchedModel?.id) ||
    trimOptionalText(args.selection.model);
  const vendor =
    trimOptionalText(matchedModel?.vendor) ||
    trimOptionalText(args.selection.modelVendor) ||
    "copilot";
  const family =
    trimOptionalText(matchedModel?.family) ||
    trimOptionalText(args.selection.modelFamily);

  if (!modelId || !supportsExperimentalModelQuality({ vendor, family })) {
    return false;
  }

  const configUri = getLanguageModelsConfigUriFromGlobalStorageUri(
    args.globalStorageUri,
  );

  let rawText: string | undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(configUri);
    rawText = Buffer.from(bytes).toString("utf8");
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code !== "FileNotFound") {
      throw error;
    }
  }

  const nextText = updateLanguageModelsConfigText(rawText, {
    vendor,
    modelId,
    reasoningEffort: savedReasoningEffort,
  });

  if (rawText === undefined && nextText === "[]") {
    return true;
  }
  if (rawText !== undefined && nextText === rawText) {
    return true;
  }

  await vscode.workspace.fs.writeFile(configUri, Buffer.from(nextText, "utf8"));
  return true;
}
