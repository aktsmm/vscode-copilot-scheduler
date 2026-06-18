import * as path from "path";
import * as vscode from "vscode";
import type { ModelInfo, ModelSelectionFields } from "./types";

export const EXPERIMENTAL_REASONING_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ExperimentalReasoningEffort =
  (typeof EXPERIMENTAL_REASONING_EFFORT_LEVELS)[number];

export type ExperimentalModelQualityVariant = {
  label: string;
  reasoningEffort?: ExperimentalReasoningEffort;
};

type ExperimentalModelQualityTarget = {
  vendor?: string;
  family?: string;
  id?: string;
  name?: string;
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

export type ExperimentalModelQualitySelectionResult = {
  modelId?: string;
  vendor: string;
  family?: string;
  requestedReasoningEffort?: ExperimentalReasoningEffort;
  supportedReasoningEfforts: readonly ExperimentalReasoningEffort[];
  effectiveReasoningEffort?: ExperimentalReasoningEffort;
  previousReasoningEffort?: ExperimentalReasoningEffort;
  configChanged: boolean;
  skippedReason?: "missingModelId";
};

type ExperimentalModelQualityRule = {
  familyPattern: RegExp;
  efforts: readonly ExperimentalReasoningEffort[];
};

// Reasoning-effort options mirror the levels Copilot Chat actually exposes per
// model. The public `vscode.lm` API does not surface reasoning capabilities, so
// this table is verified against Copilot Chat's model catalog (VS Code 1.125,
// 2026-06-18) and must be revisited when Copilot updates its model lineup.
// Order matters: specific families must precede the generic fallbacks because
// the first matching rule wins.
const EXPERIMENTAL_MODEL_QUALITY_RULES: readonly ExperimentalModelQualityRule[] =
  [
    // GPT-5 mini exposes low/medium/high only (no xhigh); keep it before gpt-5.
    {
      familyPattern: /^gpt-5-mini(?:$|-)/u,
      efforts: ["low", "medium", "high"],
    },
    {
      familyPattern: /^gpt-5(?:$|-)/u,
      efforts: ["low", "medium", "high", "xhigh"],
    },
    // Claude Opus — specific versions precede the generic fallback.
    {
      familyPattern: /^claude-opus-4-8(?:$|-)/u,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      familyPattern: /^claude-opus-4-7-1m(?:$|-)/u,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      familyPattern: /^claude-opus-4-7(?:$|-)/u,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      familyPattern: /^claude-opus-4-6(?:$|-)/u,
      efforts: ["low", "medium", "high", "max"],
    },
    {
      familyPattern: /^claude-opus(?:$|-)/u,
      efforts: ["low", "medium", "high"],
    },
    // Claude Sonnet
    {
      familyPattern: /^claude-sonnet-4-6(?:$|-)/u,
      efforts: ["low", "medium", "high", "max"],
    },
    {
      familyPattern: /^claude-sonnet(?:$|-)/u,
      efforts: ["low", "medium", "high"],
    },
    // MAI-Code-1-Flash (family `oswe-vscode-modelD`, id `mai-code-1-flash-internal`).
    {
      familyPattern: /^mai-code-1-flash(?:$|-)/u,
      efforts: ["low", "medium", "high"],
    },
    {
      familyPattern: /^oswe-vscode-modeld(?:$|-)/u,
      efforts: ["low", "medium", "high"],
    },
  ];

const EXPERIMENTAL_MODEL_QUALITY_EXCLUDED_FAMILY_PATTERNS: readonly RegExp[] = [
  // Legacy Internal-only models bake the reasoning level into a distinct model
  // id (e.g. claude-opus-4.7-high / -xhigh). They must stay as single picker
  // entries rather than gaining synthesized reasoning-effort sub-variants.
  /^claude-opus-4-7-high(?:$|-)/u,
  /^claude-opus-4-7-xhigh(?:$|-)/u,
];

const EXPERIMENTAL_MODEL_QUALITY_INCLUDED_FAMILY_PATTERNS: readonly RegExp[] =
  [];

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

function getExperimentalModelQualityKeys(
  model: ExperimentalModelQualityTarget,
): string[] {
  const values = [model.family, model.id, model.name]
    .map((value) => normalizeModelFamilyKey(value))
    .filter(Boolean);
  return Array.from(new Set(values));
}

function isExcludedExperimentalModelQualityTarget(
  model: ExperimentalModelQualityTarget,
): boolean {
  const keys = getExperimentalModelQualityKeys(model);
  if (
    keys.some((key) =>
      EXPERIMENTAL_MODEL_QUALITY_INCLUDED_FAMILY_PATTERNS.some((pattern) =>
        pattern.test(key),
      ),
    )
  ) {
    return false;
  }

  return keys.some((key) =>
    EXPERIMENTAL_MODEL_QUALITY_EXCLUDED_FAMILY_PATTERNS.some((pattern) =>
      pattern.test(key),
    ),
  );
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

export function supportsExperimentalModelQuality(
  model: ExperimentalModelQualityTarget,
): boolean {
  const vendor = normalizeKey(model.vendor);
  if (vendor !== "copilot" && vendor !== "github-copilot") {
    return false;
  }

  const candidateKeys = getExperimentalModelQualityKeys(model);
  if (
    candidateKeys.length === 0 ||
    isExcludedExperimentalModelQualityTarget(model)
  ) {
    return false;
  }

  return candidateKeys.some((key) =>
    EXPERIMENTAL_MODEL_QUALITY_RULES.some((rule) =>
      rule.familyPattern.test(key),
    ),
  );
}

export function getSupportedExperimentalReasoningEfforts(
  model: ExperimentalModelQualityTarget,
): readonly ExperimentalReasoningEffort[] {
  if (!supportsExperimentalModelQuality(model)) {
    return [];
  }

  const matchedRule = getExperimentalModelQualityKeys(model)
    .map((key) =>
      EXPERIMENTAL_MODEL_QUALITY_RULES.find((rule) =>
        rule.familyPattern.test(key),
      ),
    )
    .find((rule) => !!rule);

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
}): Promise<ExperimentalModelQualitySelectionResult> {
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

  if (!modelId) {
    return {
      vendor,
      family,
      requestedReasoningEffort: savedReasoningEffort,
      supportedReasoningEfforts: [],
      configChanged: false,
      skippedReason: "missingModelId",
    };
  }

  const supportedEfforts = getSupportedExperimentalReasoningEfforts({
    vendor,
    family,
    id: modelId,
    name:
      trimOptionalText(matchedModel?.name) ||
      trimOptionalText(args.selection.modelName),
  });
  const effectiveReasoningEffort =
    savedReasoningEffort && supportedEfforts.includes(savedReasoningEffort)
      ? savedReasoningEffort
      : undefined;

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

  const existingModelSettings = parseLanguageModelsProviderGroups(rawText).find(
    (group) => normalizeKey(group.vendor) === normalizeKey(vendor),
  )?.settings?.[modelId];
  const previousReasoningEffort = existingModelSettings
    ? normalizeExperimentalReasoningEffort(
        existingModelSettings.reasoningEffort,
      )
    : undefined;

  const nextText = updateLanguageModelsConfigText(rawText, {
    vendor,
    modelId,
    reasoningEffort: effectiveReasoningEffort,
  });

  const configChanged =
    rawText === undefined ? nextText !== "[]" : nextText !== rawText;

  const result: ExperimentalModelQualitySelectionResult = {
    modelId,
    vendor,
    family,
    requestedReasoningEffort: savedReasoningEffort,
    supportedReasoningEfforts: supportedEfforts,
    effectiveReasoningEffort,
    previousReasoningEffort,
    configChanged,
  };

  if (rawText === undefined && nextText === "[]") {
    return result;
  }
  if (rawText !== undefined && nextText === rawText) {
    return result;
  }

  await vscode.workspace.fs.writeFile(configUri, Buffer.from(nextText, "utf8"));
  return result;
}
