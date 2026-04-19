import type { ModelInfo, ModelSelectionFields } from "./types";
import {
  getExperimentalModelQualityVariants,
  type ExperimentalReasoningEffort,
  getSupportedExperimentalReasoningEfforts,
  normalizeExperimentalReasoningEffort,
} from "./modelQualityExperiment";

const NAMED_VARIANT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^extra[-\s]+high$/iu, label: "Extra High" },
  { pattern: /^high$/iu, label: "High" },
  { pattern: /^medium$/iu, label: "Medium" },
  { pattern: /^low$/iu, label: "Low" },
];

const NON_DEFAULT_PICKER_PATTERNS: RegExp[] = [
  /claude(?:[\s-]*)code/iu,
  /internal(?:[\s-]*)only/iu,
];
const COPILOT_VENDOR_KEYS = new Set([
  "copilot",
  "github-copilot",
  "githubcopilot",
]);

export type ModelPickerVariant = {
  key: string;
  label: string;
  model: ModelInfo;
  reasoningEffort?: ExperimentalReasoningEffort;
};

export type ModelPickerGroup = {
  key: string;
  label: string;
  variants: ModelPickerVariant[];
};

export type NormalizedModelSelection = {
  model?: string;
  modelName?: string;
  modelVendor?: string;
  modelFamily?: string;
  modelVersion?: string;
  modelReasoningEffort?: string;
};

export type BuildModelPickerGroupsOptions = {
  includeExperimentalModelQualityVariants?: boolean;
};

function trimOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function trimRequiredText(value: unknown): string {
  return trimOptionalText(value) || "";
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeKey(value: string | undefined): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/[_.\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeSelectionReasoningEffort(selection: {
  model?: string;
  modelName?: string;
  modelVendor?: string;
  modelFamily?: string;
  modelReasoningEffort?: string;
}): ExperimentalReasoningEffort | undefined {
  const reasoningEffort = normalizeExperimentalReasoningEffort(
    selection.modelReasoningEffort,
  );
  if (!reasoningEffort) {
    return undefined;
  }

  const family = trimOptionalText(selection.modelFamily);
  const vendor = trimOptionalText(selection.modelVendor);
  if (!family || !vendor) {
    return reasoningEffort;
  }

  const supportedEfforts = getSupportedExperimentalReasoningEfforts({
    id: trimOptionalText(selection.model),
    name: trimOptionalText(selection.modelName),
    vendor,
    family,
  });
  if (supportedEfforts.length === 0) {
    return undefined;
  }

  return supportedEfforts.includes(reasoningEffort)
    ? reasoningEffort
    : undefined;
}

export function isCopilotCliModel(model: ModelInfo): boolean {
  const values = [model.id, model.name, model.label, model.family];
  return values.some(
    (value) =>
      typeof value === "string" && /copilot(?:[\s-]*)cli/iu.test(value),
  );
}

export function isNonDefaultPickerModel(model: ModelInfo): boolean {
  const values = [
    model.id,
    model.name,
    model.label,
    model.vendor,
    model.family,
  ];
  return values.some(
    (value) =>
      typeof value === "string" &&
      NON_DEFAULT_PICKER_PATTERNS.some((pattern) => pattern.test(value)),
  );
}

function isCopilotVendorModel(model: ModelInfo): boolean {
  return COPILOT_VENDOR_KEYS.has(normalizeKey(model.vendor));
}

function maybeStripDateSuffix(value: string): string | undefined {
  const stripped = value.replace(/-\d{4}(?:-\d{2}){2}$/u, "");
  return stripped && stripped !== value ? stripped : undefined;
}

function maybeStripTrailingNumericVariant(value: string): string | undefined {
  const stripped = value.replace(/-\d{1,2}$/u, "");
  return stripped && stripped !== value ? stripped : undefined;
}

function stripTrailingParenthesizedGroups(value: string): string {
  return value.replace(/(?:\s*\([^()]*\))+\s*$/u, "").trim();
}

function extractTrailingParenthesizedDetail(
  value: string | undefined,
): string | undefined {
  const trimmed = trimOptionalText(value);
  if (!trimmed) {
    return undefined;
  }

  const match = trimmed.match(/((?:\s*\([^()]*\))+)[\s]*$/u);
  if (!match) {
    return undefined;
  }

  const detail = match[1]
    .replace(/\)\s*\(/g, ", ")
    .replace(/[()]/g, "")
    .trim();
  return detail || undefined;
}

function extractTrailingParenthesizedDetails(
  value: string | undefined,
): string[] {
  const trimmed = trimOptionalText(value);
  if (!trimmed) {
    return [];
  }

  const match = trimmed.match(/((?:\s*\([^()]*\))+)[\s]*$/u);
  if (!match) {
    return [];
  }

  return (
    match[1]
      .match(/\([^()]*\)/gu)
      ?.map((entry) => entry.replace(/[()]/g, "").trim())
      .filter(Boolean) || []
  );
}

function maybeStripNamedVariant(value: string): string | undefined {
  const stripped = value
    .replace(/(?:[-\s]+)(extra[-\s]+high|high|medium|low)$/iu, "")
    .trim();
  return stripped && stripped !== value ? stripped : undefined;
}

function normalizeNamedVariantLabel(
  value: string | undefined,
): string | undefined {
  const trimmed = trimOptionalText(value);
  if (!trimmed) {
    return undefined;
  }

  for (const entry of NAMED_VARIANT_PATTERNS) {
    if (entry.pattern.test(trimmed)) {
      return entry.label;
    }
  }

  return undefined;
}

function normalizeStrictVariantKey(
  value: string | undefined,
): string | undefined {
  const namedVariant = normalizeNamedVariantLabel(value);
  if (namedVariant) {
    return normalizeKey(namedVariant);
  }

  const trimmed = trimOptionalText(value);
  if (!trimmed) {
    return undefined;
  }

  return /^\d{4}(?:-\d{2}){2}$/u.test(trimmed)
    ? normalizeKey(trimmed)
    : undefined;
}

function extractNamedVariant(value: string | undefined): string | undefined {
  const trimmed = trimOptionalText(value);
  if (!trimmed) {
    return undefined;
  }

  const withoutParens = stripTrailingParenthesizedGroups(trimmed);
  const match = withoutParens.match(
    /(?:^|[-\s])(extra[-\s]+high|high|medium|low)$/iu,
  );
  return match ? normalizeNamedVariantLabel(match[1]) : undefined;
}

function canonicalizeModelDisplayName(
  value: string | undefined,
): string | undefined {
  const trimmed = trimOptionalText(value);
  if (!trimmed) {
    return undefined;
  }

  const withoutParens = stripTrailingParenthesizedGroups(trimmed);
  return maybeStripNamedVariant(withoutParens) || withoutParens;
}

function isIgnoredModelGroupDetail(detail: string, model: ModelInfo): boolean {
  const normalizedDetail = normalizeKey(detail);
  if (!normalizedDetail) {
    return true;
  }

  if (COPILOT_VENDOR_KEYS.has(normalizedDetail)) {
    return true;
  }

  const vendorKey = normalizeKey(model.vendor);
  return !!vendorKey && normalizedDetail === vendorKey;
}

function buildModelGroupLabel(model: ModelInfo): string {
  const baseName =
    canonicalizeModelDisplayName(model.name) ||
    canonicalizeModelDisplayName(model.family) ||
    model.name ||
    model.id;
  if (!baseName) {
    return "";
  }

  const significantDetails = extractTrailingParenthesizedDetails(model.name)
    .map((detail) => trimRequiredText(detail))
    .filter((detail) => !isIgnoredModelGroupDetail(detail, model));

  if (significantDetails.length === 0) {
    return baseName;
  }

  return `${baseName} (${significantDetails.join(", ")})`;
}

function normalizeModelInfo(model: ModelInfo): ModelInfo {
  return {
    id: trimRequiredText(model.id),
    name: trimRequiredText(model.name),
    label: trimOptionalText(model.label),
    description: trimRequiredText(model.description),
    vendor: trimRequiredText(model.vendor),
    family: trimOptionalText(model.family),
    version: trimOptionalText(model.version),
    maxInputTokens: normalizeOptionalNumber(model.maxInputTokens),
  };
}

function buildModelCatalogKey(model: ModelInfo): string {
  return JSON.stringify([
    normalizeKey(model.id),
    normalizeKey(model.name),
    normalizeKey(model.vendor),
    normalizeKey(model.family),
    normalizeKey(model.version),
    normalizeOptionalNumber(model.maxInputTokens) ?? "",
  ]);
}

function formatCompactTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const compact = Math.round((value / 1_000_000) * 10) / 10;
    return `${compact % 1 === 0 ? compact.toFixed(0) : compact.toFixed(1)}m`;
  }

  if (value >= 1_000) {
    const compact = Math.round((value / 1_000) * 10) / 10;
    return `${compact % 1 === 0 ? compact.toFixed(0) : compact.toFixed(1)}k`;
  }

  return String(value);
}

function formatModelTokenDetail(value: number | undefined): string | undefined {
  const normalized = normalizeOptionalNumber(value);
  if (normalized === undefined || normalized <= 0) {
    return undefined;
  }

  return formatCompactTokenCount(normalized);
}

function getRuntimeVariantGroupKey(model: ModelInfo): string | undefined {
  if (!isRuntimeVariantModel(model)) {
    return undefined;
  }

  const familyKey = normalizeKey(
    canonicalizeModelDisplayName(model.family) ||
      trimOptionalText(model.family),
  );
  if (familyKey) {
    return familyKey;
  }

  return (
    normalizeKey(
      canonicalizeModelDisplayName(model.name) || trimOptionalText(model.name),
    ) || undefined
  );
}

function getModelGroupKey(model: ModelInfo): string {
  const runtimeVariantGroupKey = getRuntimeVariantGroupKey(model);
  if (runtimeVariantGroupKey) {
    return runtimeVariantGroupKey;
  }

  return normalizeKey(buildModelGroupLabel(model) || model.id);
}

function getGroupRepresentativeModel(
  groupedModels: readonly ModelInfo[],
): ModelInfo | undefined {
  return (
    groupedModels.find((model) => !isRuntimeVariantModel(model)) ||
    groupedModels[0]
  );
}

function getGroupRepresentativeLabel(
  groupedModels: readonly ModelInfo[],
): string {
  const representative = getGroupRepresentativeModel(groupedModels);
  if (!representative) {
    return "";
  }

  return (
    buildModelGroupLabel(representative) ||
    representative.name ||
    representative.id
  );
}

function getModelDetailCandidates(
  model: ModelInfo,
  groupedModels: readonly ModelInfo[],
): string[] {
  const hasDistinctVersions =
    new Set(groupedModels.map((entry) => normalizeKey(entry.version))).size > 1;
  const hasDistinctVendors =
    new Set(groupedModels.map((entry) => normalizeKey(entry.vendor))).size > 1;
  const distinctMaxInputTokens = new Set(
    groupedModels
      .map((entry) => normalizeOptionalNumber(entry.maxInputTokens))
      .filter((value): value is number => value !== undefined),
  );
  const hasDistinctMaxInputTokens = distinctMaxInputTokens.size > 1;

  const detailCandidates = [
    extractNamedVariant(model.name),
    extractVariantTail(model.id, [model.family, model.name]),
    extractVariantTail(model.family, [model.name]),
    extractTrailingParenthesizedDetail(model.name),
    hasDistinctVersions ? model.version : undefined,
    hasDistinctMaxInputTokens
      ? formatModelTokenDetail(model.maxInputTokens)
      : undefined,
    hasDistinctVendors ? model.vendor : undefined,
    groupedModels.length > 1 ? model.id : undefined,
  ];

  const details: string[] = [];
  const seen = new Set<string>();
  const baseName =
    getGroupRepresentativeLabel(groupedModels) ||
    buildModelGroupLabel(model) ||
    model.name ||
    model.id;

  for (const candidate of detailCandidates) {
    const detail = formatModelDetail(candidate);
    if (!detail) {
      continue;
    }

    const key = normalizeKey(detail);
    if (!key || seen.has(key) || detailAppearsInName(detail, baseName)) {
      continue;
    }

    seen.add(key);
    details.push(detail);
  }

  return details;
}

function extractVariantTail(
  value: string | undefined,
  baseCandidates: Array<string | undefined>,
): string | undefined {
  const trimmedValue = trimOptionalText(value);
  if (!trimmedValue) {
    return undefined;
  }

  const normalizedValue = normalizeKey(trimmedValue);
  const normalizedSegments = trimmedValue
    .split(/[\\/]+/u)
    .map((segment) => normalizeKey(segment))
    .filter(Boolean);
  const sourceCandidates = [normalizedValue, ...normalizedSegments];

  for (const candidate of baseCandidates) {
    const normalizedBase = normalizeKey(candidate);
    if (!normalizedBase) {
      continue;
    }

    for (const source of sourceCandidates) {
      if (source.startsWith(normalizedBase + "-")) {
        return source.slice(normalizedBase.length + 1);
      }

      const embeddedIndex = source.lastIndexOf(`-${normalizedBase}-`);
      if (embeddedIndex >= 0) {
        return source.slice(embeddedIndex + normalizedBase.length + 2);
      }
    }

    for (let index = 0; index < normalizedSegments.length; index += 1) {
      if (normalizedSegments[index] !== normalizedBase) {
        continue;
      }

      const next = normalizedSegments[index + 1];
      if (!next) {
        continue;
      }

      if (next === "versions") {
        const versionSegment = normalizedSegments[index + 2];
        if (versionSegment) {
          return versionSegment;
        }
        continue;
      }

      return next;
    }
  }

  return undefined;
}

function formatModelDetail(detail: string | undefined): string | undefined {
  const trimmed = trimOptionalText(detail);
  if (!trimmed) {
    return undefined;
  }

  const namedVariant = normalizeNamedVariantLabel(trimmed);
  if (namedVariant) {
    return namedVariant;
  }

  if (/^\d{4}(?:-\d{2}){2}$/u.test(trimmed)) {
    return trimmed;
  }

  const normalized = normalizeKey(trimmed);
  if (!normalized) {
    return undefined;
  }

  if (normalized.indexOf("-") === -1 && /^[a-z]+$/iu.test(normalized)) {
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  return trimmed;
}

function detailAppearsInName(detail: string, modelName: string): boolean {
  const normalizedDetail = normalizeKey(detail);
  const normalizedName = normalizeKey(modelName);
  return !!normalizedDetail && normalizedName.includes(normalizedDetail);
}

function buildModelDisplayLabel(
  model: ModelInfo,
  groupedModels: readonly ModelInfo[],
): string {
  const baseLabel =
    getGroupRepresentativeLabel(groupedModels) ||
    buildModelGroupLabel(model) ||
    model.name ||
    model.id;
  if (!baseLabel) {
    return "";
  }

  if (groupedModels.length <= 1) {
    return baseLabel;
  }

  const detailLabel = buildModelDetailLabel(model, groupedModels);
  if (!detailLabel) {
    return baseLabel;
  }

  return `${baseLabel} (${detailLabel})`;
}

function buildModelDetailLabel(
  model: ModelInfo,
  groupedModels: readonly ModelInfo[],
): string | undefined {
  const detailCandidates = getModelDetailCandidates(model, groupedModels);
  if (detailCandidates.length === 0) {
    return undefined;
  }

  const detailCounts = detailCandidates.map((_detail, index) => {
    const counts = new Map<string, number>();
    for (const entry of groupedModels) {
      const entryKey = getModelDetailCandidates(entry, groupedModels)
        .slice(0, index + 1)
        .map((value) => normalizeKey(value))
        .join("|");
      if (!entryKey) {
        continue;
      }
      counts.set(entryKey, (counts.get(entryKey) || 0) + 1);
    }
    return counts;
  });

  for (let index = 0; index < detailCandidates.length; index += 1) {
    const currentKey = detailCandidates
      .slice(0, index + 1)
      .map((value) => normalizeKey(value))
      .join("|");
    if (!currentKey) {
      continue;
    }
    if (detailCounts[index]?.get(currentKey) === 1) {
      return detailCandidates.slice(0, index + 1).join(", ");
    }
  }

  return detailCandidates.join(", ");
}

function uniquifyModelDisplayLabels(models: readonly ModelInfo[]): ModelInfo[] {
  const labelCounts = new Map<string, number>();

  for (const model of models) {
    const key = normalizeKey(model.label || model.name || model.id);
    labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
  }

  return models.map((model) => {
    const label = model.label || model.name || model.id;
    const key = normalizeKey(label);
    if (!key || (labelCounts.get(key) || 0) <= 1) {
      return model;
    }

    return {
      ...model,
      label: `${label} [${model.id}]`,
    };
  });
}

function buildMatchKeys(value: string | undefined): Set<string> {
  const keys = new Set<string>();
  const normalized = normalizeKey(value);
  if (!normalized) {
    return keys;
  }

  keys.add(normalized);

  const withoutCopilotPrefix = normalized.replace(/^copilot-/u, "");
  if (withoutCopilotPrefix && withoutCopilotPrefix !== normalized) {
    keys.add(withoutCopilotPrefix);
  }

  const withoutDate = maybeStripDateSuffix(normalized);
  if (withoutDate) {
    keys.add(withoutDate);
  }

  const withoutVariant = maybeStripTrailingNumericVariant(normalized);
  if (withoutVariant) {
    keys.add(withoutVariant);
  }

  const withoutNamedVariant = maybeStripNamedVariant(normalized);
  if (withoutNamedVariant) {
    keys.add(normalizeKey(withoutNamedVariant));
  }

  const withoutParens = normalizeKey(
    stripTrailingParenthesizedGroups(String(value || "")),
  );
  if (withoutParens && withoutParens !== normalized) {
    keys.add(withoutParens);
    const withoutParensVariant = maybeStripNamedVariant(withoutParens);
    if (withoutParensVariant) {
      keys.add(normalizeKey(withoutParensVariant));
    }
  }

  if (withoutDate) {
    const withoutDateVariant = maybeStripTrailingNumericVariant(withoutDate);
    if (withoutDateVariant) {
      keys.add(withoutDateVariant);
    }
  }

  return keys;
}

function hasIntersection(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function countIntersection(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }
  return count;
}

function buildCandidateKeys(model: ModelInfo): {
  id: ReadonlySet<string>;
  name: ReadonlySet<string>;
  family: ReadonlySet<string>;
  vendor: ReadonlySet<string>;
} {
  return {
    id: buildMatchKeys(model.id),
    name: buildMatchKeys(model.name),
    family: buildMatchKeys(model.family),
    vendor: buildMatchKeys(model.vendor),
  };
}

function buildRequestedKeys(selection: NormalizedModelSelection): {
  model: ReadonlySet<string>;
  name: ReadonlySet<string>;
  family: ReadonlySet<string>;
  vendor: ReadonlySet<string>;
  version: string;
} {
  return {
    model: buildMatchKeys(selection.model),
    name: buildMatchKeys(selection.modelName),
    family: buildMatchKeys(selection.modelFamily),
    vendor: buildMatchKeys(selection.modelVendor),
    version: normalizeKey(selection.modelVersion),
  };
}

function getSelectionVariantKey(
  selection: NormalizedModelSelection,
): string | undefined {
  const explicitVersion = normalizeStrictVariantKey(selection.modelVersion);
  if (explicitVersion) {
    return explicitVersion;
  }

  const variantFromId = normalizeStrictVariantKey(
    formatModelDetail(
      extractVariantTail(selection.model, [
        selection.modelFamily,
        selection.modelName,
      ]),
    ),
  );
  if (variantFromId) {
    return variantFromId;
  }

  const variantFromName = normalizeStrictVariantKey(
    extractNamedVariant(selection.modelName),
  );
  if (variantFromName) {
    return variantFromName;
  }

  return normalizeStrictVariantKey(
    formatModelDetail(
      extractVariantTail(selection.modelFamily, [selection.modelName]),
    ),
  );
}

function getModelVariantKey(model: ModelInfo): string | undefined {
  const explicitVersion = normalizeStrictVariantKey(model.version);
  if (explicitVersion) {
    return explicitVersion;
  }

  const variantFromId = normalizeStrictVariantKey(
    formatModelDetail(extractVariantTail(model.id, [model.family, model.name])),
  );
  if (variantFromId) {
    return variantFromId;
  }

  const variantFromName = normalizeStrictVariantKey(
    extractNamedVariant(model.name),
  );
  if (variantFromName) {
    return variantFromName;
  }

  return normalizeStrictVariantKey(
    formatModelDetail(extractVariantTail(model.family, [model.name])),
  );
}

function isRuntimeVariantModel(model: ModelInfo): boolean {
  return !!getModelVariantKey(model);
}

function compareOptionalTextDescending(
  left: string | undefined,
  right: string | undefined,
): number {
  const normalizedLeft = normalizeKey(left);
  const normalizedRight = normalizeKey(right);
  return normalizedRight.localeCompare(normalizedLeft);
}

function scoreModelMatch(
  selection: NormalizedModelSelection,
  candidate: ModelInfo,
): number {
  const requested = buildRequestedKeys(selection);
  const current = buildCandidateKeys(candidate);
  let score = 0;

  if (
    requested.model.size > 0 &&
    hasIntersection(requested.model, current.id)
  ) {
    score += 1000;
  }
  if (
    requested.model.size > 0 &&
    hasIntersection(requested.model, current.name)
  ) {
    score += 900;
  }
  if (
    requested.name.size > 0 &&
    hasIntersection(requested.name, current.name)
  ) {
    score += 850;
  }
  if (requested.name.size > 0 && hasIntersection(requested.name, current.id)) {
    score += 800;
  }
  if (
    requested.family.size > 0 &&
    hasIntersection(requested.family, current.family)
  ) {
    score += 700;
  }
  if (
    requested.model.size > 0 &&
    hasIntersection(requested.model, current.family)
  ) {
    score += 550;
  }
  if (
    requested.name.size > 0 &&
    hasIntersection(requested.name, current.family)
  ) {
    score += 520;
  }

  if (
    requested.vendor.size > 0 &&
    hasIntersection(requested.vendor, current.vendor)
  ) {
    score += 200;
  }

  if (
    requested.version &&
    requested.version === normalizeKey(candidate.version)
  ) {
    score += 120;
  }

  score += countIntersection(requested.family, current.family) * 10;
  score += countIntersection(requested.model, current.id) * 10;
  score += countIntersection(requested.name, current.name) * 10;

  return score;
}

export function normalizeModelSelection(
  selection: ModelSelectionFields | undefined,
): NormalizedModelSelection {
  const normalized: NormalizedModelSelection = {
    model: trimOptionalText(selection?.model),
    modelName: trimOptionalText(selection?.modelName),
    modelVendor: trimOptionalText(selection?.modelVendor),
    modelFamily: trimOptionalText(selection?.modelFamily),
    modelVersion: trimOptionalText(selection?.modelVersion),
    modelReasoningEffort: trimOptionalText(selection?.modelReasoningEffort),
  };

  normalized.modelReasoningEffort =
    normalizeSelectionReasoningEffort(normalized);

  return normalized;
}

export function hasStrictModelVariantSelection(
  selection: ModelSelectionFields | undefined,
): boolean {
  return !!getSelectionVariantKey(normalizeModelSelection(selection));
}

export function normalizeModelCatalog(
  models: readonly ModelInfo[],
): ModelInfo[] {
  const normalizedModels: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const model of models) {
    const normalizedModel = normalizeModelInfo(model);
    const key = buildModelCatalogKey(normalizedModel);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedModels.push(normalizedModel);
  }

  const groupedModels = new Map<string, ModelInfo[]>();
  for (const model of normalizedModels) {
    const key = getModelGroupKey(model);
    const group = groupedModels.get(key);
    if (group) {
      group.push(model);
    } else {
      groupedModels.set(key, [model]);
    }
  }

  const labeledModels = normalizedModels.map((model) => ({
    ...model,
    label: buildModelDisplayLabel(
      model,
      groupedModels.get(getModelGroupKey(model)) || [model],
    ),
  }));

  return uniquifyModelDisplayLabels(labeledModels);
}

export function filterPickerModelCatalog(
  models: readonly ModelInfo[],
): ModelInfo[] {
  const expandedCatalog = filterExpandedPickerModelCatalog(models);
  const allowedGroupKeys = new Set(
    expandedCatalog
      .filter((model) => {
        if (!model || typeof model.id !== "string") {
          return false;
        }

        if (model.id.trim().length === 0) {
          return false;
        }

        return isCopilotVendorModel(model) && !isNonDefaultPickerModel(model);
      })
      .map((model) => getModelGroupKey(model)),
  );

  return expandedCatalog.filter((model) => {
    if (!model || typeof model.id !== "string") {
      return false;
    }

    if (model.id.trim().length === 0) {
      return true;
    }

    if (isNonDefaultPickerModel(model)) {
      return false;
    }

    if (isCopilotVendorModel(model)) {
      return true;
    }

    return (
      allowedGroupKeys.has(getModelGroupKey(model)) &&
      isRuntimeVariantModel(model)
    );
  });
}

export function filterExpandedPickerModelCatalog(
  models: readonly ModelInfo[],
): ModelInfo[] {
  return models.filter((model) => {
    if (!model || typeof model.id !== "string") {
      return false;
    }

    if (model.id.trim().length === 0) {
      return true;
    }

    return !isCopilotCliModel(model);
  });
}

export function buildModelPickerGroups(
  models: readonly ModelInfo[],
  options: BuildModelPickerGroupsOptions = {},
): ModelPickerGroup[] {
  const groupedModels = new Map<string, ModelInfo[]>();

  for (const model of models) {
    const groupKey = getModelGroupKey(model);
    const existing = groupedModels.get(groupKey);
    if (existing) {
      existing.push(model);
    } else {
      groupedModels.set(groupKey, [model]);
    }
  }

  const result: ModelPickerGroup[] = [];
  for (const [groupKey, groupModels] of groupedModels.entries()) {
    if (groupModels.length === 0) {
      continue;
    }

    const orderedGroupModels = [...groupModels].sort((left, right) => {
      const leftIsVariant = isRuntimeVariantModel(left);
      const rightIsVariant = isRuntimeVariantModel(right);
      if (leftIsVariant === rightIsVariant) {
        return 0;
      }
      return leftIsVariant ? 1 : -1;
    });

    const firstModel = orderedGroupModels[0];
    const label =
      getGroupRepresentativeLabel(orderedGroupModels) || firstModel?.id || "";
    if (!label) {
      continue;
    }

    let variants = orderedGroupModels.map((model, index) => ({
      key: buildModelCatalogKey(model),
      label:
        orderedGroupModels.length > 1
          ? !isRuntimeVariantModel(model)
            ? index === 0
              ? "Default"
              : model.label || model.name || model.id
            : buildModelDetailLabel(model, orderedGroupModels) ||
              model.label ||
              model.name ||
              model.id
          : label,
      model,
    }));

    if (
      options.includeExperimentalModelQualityVariants === true &&
      orderedGroupModels.length === 1
    ) {
      const experimentalVariants = getExperimentalModelQualityVariants(
        orderedGroupModels[0],
      );
      if (experimentalVariants.length > 1) {
        variants = experimentalVariants.map((variant) => ({
          key: `${buildModelCatalogKey(orderedGroupModels[0])}::reasoning-effort:${variant.reasoningEffort || "default"}`,
          label: variant.label,
          model: orderedGroupModels[0],
          reasoningEffort: variant.reasoningEffort,
        }));
      }
    }

    result.push({
      key: groupKey,
      label,
      variants,
    });
  }

  return result;
}

export function hasModelSelection(
  selection: ModelSelectionFields | undefined,
): boolean {
  const normalized = normalizeModelSelection(selection);
  return !!(
    normalized.model ||
    normalized.modelName ||
    normalized.modelVendor ||
    normalized.modelFamily ||
    normalized.modelVersion ||
    normalized.modelReasoningEffort
  );
}

export function modelInfoToSelection(
  model: ModelInfo,
): NormalizedModelSelection {
  return normalizeModelSelection({
    model: model.id,
    modelName: model.name,
    modelVendor: model.vendor,
    modelFamily: model.family,
    modelVersion: model.version,
  });
}

export function areModelSelectionsEqual(
  left: ModelSelectionFields | undefined,
  right: ModelSelectionFields | undefined,
): boolean {
  const normalizedLeft = normalizeModelSelection(left);
  const normalizedRight = normalizeModelSelection(right);
  return (
    normalizedLeft.model === normalizedRight.model &&
    normalizedLeft.modelName === normalizedRight.modelName &&
    normalizedLeft.modelVendor === normalizedRight.modelVendor &&
    normalizedLeft.modelFamily === normalizedRight.modelFamily &&
    normalizedLeft.modelVersion === normalizedRight.modelVersion &&
    normalizedLeft.modelReasoningEffort === normalizedRight.modelReasoningEffort
  );
}

export function findBestMatchingModel(
  selection: ModelSelectionFields | undefined,
  availableModels: readonly ModelInfo[],
): ModelInfo | undefined {
  const normalizedSelection = normalizeModelSelection(selection);
  if (!hasModelSelection(normalizedSelection)) {
    return undefined;
  }

  const selectableModels = availableModels.filter(
    (model) =>
      !!model && typeof model.id === "string" && model.id.trim().length > 0,
  );
  if (selectableModels.length === 0) {
    return undefined;
  }

  const requestedVariantKey = getSelectionVariantKey(normalizedSelection);
  const candidateModels = requestedVariantKey
    ? selectableModels.filter(
        (model) => getModelVariantKey(model) === requestedVariantKey,
      )
    : selectableModels;

  if (candidateModels.length === 0) {
    return undefined;
  }

  const ranked = candidateModels
    .map((model) => ({
      model,
      score: scoreModelMatch(normalizedSelection, model),
    }))
    .filter((entry) => entry.score >= 500)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      const versionCompare = compareOptionalTextDescending(
        left.model.version,
        right.model.version,
      );
      if (versionCompare !== 0) {
        return versionCompare;
      }

      return left.model.name.localeCompare(right.model.name);
    });

  return ranked[0]?.model;
}
