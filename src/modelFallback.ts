import type { ModelFallbackPolicy, ModelInfo, ModelSelectionFields } from "./types";
import { filterPickerModelCatalog } from "./modelSelection";

export const DEFAULT_MODEL_FALLBACK_POLICY: ModelFallbackPolicy = { strategy: "diverse" };

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value);
}

export function normalizeModelFallbackPolicy(value: unknown): ModelFallbackPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { strategy, chatModel, agentHostModelId } = value as Record<string, unknown>;
  if (strategy !== "diverse" && strategy !== "similar") return undefined;
  if (agentHostModelId !== undefined && !isIdentity(agentHostModelId)) return undefined;
  let chat: ModelFallbackPolicy["chatModel"];
  if (chatModel !== undefined) {
    if (!chatModel || typeof chatModel !== "object" || Array.isArray(chatModel)) return undefined;
    const { id, vendor } = chatModel as Record<string, unknown>;
    if (!isIdentity(id) || !isIdentity(vendor)) return undefined;
    chat = { id, vendor };
  }
  return {
    strategy,
    ...(chat ? { chatModel: chat } : {}),
    ...(agentHostModelId ? { agentHostModelId } : {}),
  };
}

export function chooseChatFallbackModel(
  policy: ModelFallbackPolicy,
  primary: ModelSelectionFields,
  models: readonly ModelInfo[],
): ModelInfo | undefined {
  const eligible = filterPickerModelCatalog(models).filter((model) =>
    isIdentity(model.id) && isIdentity(model.vendor),
  );
  // The same ID can occur under distinct providers but not twice under one provider.
  const keys = new Map<string, number>();
  const key = (model: { vendor?: string; id: string }) => JSON.stringify([model.vendor, model.id]);
  for (const model of eligible) keys.set(key(model), (keys.get(key(model)) ?? 0) + 1);
  const unique = eligible.filter((model) => keys.get(key(model)) === 1);
  const explicitKey = policy.chatModel ? key(policy.chatModel) : undefined;
  const explicit = unique.find((model) => key(model) === explicitKey);
  if (explicit) return explicit;
  if (!isIdentity(primary.modelVendor) || !isIdentity(primary.modelFamily)) return undefined;
  const rank = (model: ModelInfo) =>
    (model.vendor !== primary.modelVendor ? 2 : 0) + (model.family !== primary.modelFamily ? 1 : 0);
  return unique
    .filter((model) => isIdentity(model.family) && !/^(auto|hydrafusion|copilot[- ]?fusion)$/iu.test(model.id))
    .sort((a, b) => (policy.strategy === "diverse" ? rank(b) - rank(a) : rank(a) - rank(b)) ||
      (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))[0];
}
