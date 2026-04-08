import type { ModelInfo, ModelSelectionFields } from "./types";

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

  const ranked = selectableModels
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
