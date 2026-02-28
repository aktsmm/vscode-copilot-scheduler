export type TaskStoreKind = "file" | "globalState";

export type TaskStoreSnapshot<T> = {
  kind: TaskStoreKind;
  /** Whether we consider this store to exist (may be true even if tasks is empty). */
  exists: boolean;
  /** Whether the tasks payload is trustworthy (e.g., JSON parsed successfully). */
  ok: boolean;
  tasks: T[];
  revision: number;
};

export type TaskStoreSelection<T> = {
  chosenKind: TaskStoreKind | "none";
  chosenRevision: number;
  chosenTasks: T[];
  /** Best-effort healing plan without bumping revision. */
  shouldHealFile: boolean;
  shouldHealGlobalState: boolean;
};

function toRevision(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Choose which task store to load and whether to heal the other store.
 *
 * Notes:
 * - We allow an empty task array as a valid newest state (deletes).
 * - If the file store is invalid (ok=false), we treat its effective revision as -1
 *   so it will never win over a valid globalState store.
 * - Healing is always from the chosen store. We never heal globalState from an
 *   invalid file store.
 */
export function selectTaskStore<T>(
  globalState: TaskStoreSnapshot<T>,
  file: TaskStoreSnapshot<T>,
): TaskStoreSelection<T> {
  const globalRevision = toRevision(globalState.revision);
  const fileRevision = toRevision(file.revision);
  const effectiveGlobalRevision = globalState.ok ? globalRevision : -1;
  const effectiveFileRevision = file.ok ? fileRevision : -1;

  let chosenKind: TaskStoreKind | "none" = "none";
  let chosenRevision = 0;
  let chosenTasks: T[] = [];

  if (globalState.exists && file.exists) {
    if (effectiveGlobalRevision > effectiveFileRevision) {
      chosenKind = "globalState";
      chosenRevision = globalRevision;
      chosenTasks = globalState.tasks;
    } else if (effectiveFileRevision > effectiveGlobalRevision) {
      chosenKind = "file";
      chosenRevision = fileRevision;
      chosenTasks = file.tasks;
    } else {
      // Same effective revision (or both invalid): prefer file, then globalState when valid.
      if (file.ok) {
        chosenKind = "file";
        chosenRevision = fileRevision;
        chosenTasks = file.tasks;
      } else if (globalState.ok) {
        chosenKind = "globalState";
        chosenRevision = globalRevision;
        chosenTasks = globalState.tasks;
      } else {
        chosenKind = "none";
        chosenRevision = 0;
        chosenTasks = [];
      }
    }
  } else if (file.exists) {
    chosenKind = "file";
    chosenRevision = fileRevision;
    chosenTasks = file.tasks;
  } else if (globalState.exists) {
    chosenKind = "globalState";
    chosenRevision = globalRevision;
    chosenTasks = globalState.tasks;
  }

  const shouldHealFile =
    chosenKind === "globalState" &&
    globalState.ok &&
    globalState.exists &&
    // Heal if file is missing, older, or invalid.
    (file.exists === false ||
      file.ok === false ||
      globalRevision !== fileRevision);

  const shouldHealGlobalState =
    chosenKind === "file" &&
    file.ok &&
    // Heal if globalState is missing or older.
    (globalState.exists === false ||
      globalState.ok === false ||
      globalRevision !== fileRevision);

  return {
    chosenKind,
    chosenRevision,
    chosenTasks,
    shouldHealFile,
    shouldHealGlobalState,
  };
}
