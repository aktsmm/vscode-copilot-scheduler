import type { ModelInfo, ModelSelectionFields } from "./types";

const NAMED_VARIANT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^extra[-\s]+high$/iu, label: "Extra High" },
  { pattern: /^high$/iu, label: "High" },
  { pattern: /^medium$/iu, label: "Medium" },
  { pattern: /^low$/iu, label: "Low" },
];

export type NormalizedModelSelection = {
  model?: string;
  modelName?: string;
  modelVendor?: string;
  modelFamily?: string;
  modelVersion?: string;
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

function normalizeKey(value: string | undefined): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/[_.\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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

function maybeStripNamedVariant(value: string): string | undefined {
  const stripped = value
    .replace(/(?:[-\s]+)(extra[-\s]+high|high|medium|low)$/iu, "")
    .trim();
  return stripped && stripped !== value ? stripped : undefined;
}

function normalizeNamedVariantLabel(value: string | undefined): string | undefined {
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

function normalizeModelInfo(model: ModelInfo): ModelInfo {
  return {
    id: trimRequiredText(model.id),
    name: trimRequiredText(model.name),
    label: trimOptionalText(model.label),
    description: trimRequiredText(model.description),
    vendor: trimRequiredText(model.vendor),
    family: trimOptionalText(model.family),
    version: trimOptionalText(model.version),
  };
}

function buildModelCatalogKey(model: ModelInfo): string {
  return JSON.stringify([
    normalizeKey(model.id),
    normalizeKey(model.name),
    normalizeKey(model.vendor),
    normalizeKey(model.family),
    normalizeKey(model.version),
  ]);
}

function getModelGroupKey(model: ModelInfo): string {
  return normalizeKey(
    canonicalizeModelDisplayName(model.name) ||
      canonicalizeModelDisplayName(model.family) ||
      model.id,
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

  const detailCandidates = [
    extractNamedVariant(model.name),
    extractVariantTail(model.id, [model.family, model.name]),
    extractVariantTail(model.family, [model.name]),
    extractTrailingParenthesizedDetail(model.name),
    hasDistinctVersions ? model.version : undefined,
    hasDistinctVendors ? model.vendor : undefined,
    groupedModels.length > 1 ? model.id : undefined,
  ];

  const details: string[] = [];
  const seen = new Set<string>();
  const baseName =
    canonicalizeModelDisplayName(model.name) ||
    canonicalizeModelDisplayName(model.family) ||
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
  const baseName =
    canonicalizeModelDisplayName(model.name) ||
    canonicalizeModelDisplayName(model.family) ||
    model.name ||
    model.id;
  if (!baseName) {
    return "";
  }

  if (groupedModels.length <= 1) {
    return baseName;
  }

  const detailCandidates = getModelDetailCandidates(model, groupedModels);
  if (detailCandidates.length === 0) {
    return baseName;
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
      return `${baseName} (${detailCandidates.slice(0, index + 1).join(", ")})`;
    }
  }

  return `${baseName} (${detailCandidates.join(", ")})`;
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
  const explicitVersion = normalizeKey(
    formatModelDetail(selection.modelVersion) || "",
  );
  if (explicitVersion) {
    return explicitVersion;
  }

  const variantFromId = normalizeKey(
    formatModelDetail(
      extractVariantTail(selection.model, [
        selection.modelFamily,
        selection.modelName,
      ]),
    ) || "",
  );
  if (variantFromId) {
    return variantFromId;
  }

  const variantFromName = normalizeKey(
    extractNamedVariant(selection.modelName) || "",
  );
  if (variantFromName) {
    return variantFromName;
  }

  return normalizeKey(
    formatModelDetail(
      extractVariantTail(selection.modelFamily, [selection.modelName]),
    ) || "",
  );
}

function getModelVariantKey(model: ModelInfo): string | undefined {
  const explicitVersion = normalizeKey(formatModelDetail(model.version) || "");
  if (explicitVersion) {
    return explicitVersion;
  }

  const variantFromId = normalizeKey(
    formatModelDetail(
      extractVariantTail(model.id, [model.family, model.name]),
    ) || "",
  );
  if (variantFromId) {
    return variantFromId;
  }

  const variantFromName = normalizeKey(extractNamedVariant(model.name) || "");
  if (variantFromName) {
    return variantFromName;
  }

  return normalizeKey(
    formatModelDetail(extractVariantTail(model.family, [model.name])) || "",
  );
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
  return {
    model: trimOptionalText(selection?.model),
    modelName: trimOptionalText(selection?.modelName),
    modelVendor: trimOptionalText(selection?.modelVendor),
    modelFamily: trimOptionalText(selection?.modelFamily),
    modelVersion: trimOptionalText(selection?.modelVersion),
  };
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

export function hasModelSelection(
  selection: ModelSelectionFields | undefined,
): boolean {
  const normalized = normalizeModelSelection(selection);
  return !!(
    normalized.model ||
    normalized.modelName ||
    normalized.modelVendor ||
    normalized.modelFamily ||
    normalized.modelVersion
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
    normalizedLeft.modelVersion === normalizedRight.modelVersion
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
