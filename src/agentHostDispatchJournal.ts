import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { writeFileAtomically } from "./atomic-file-write";
import { withTaskStoreLock } from "./task-store-lock";
import type { AgentHostSessionRef } from "./agentHostClient";

// A queued send holds the chat's journal lock across Host round trips, and a
// finishing run must wait for it rather than report its completed turn as unknown.
const JOURNAL_LOCK_TIMEOUT_MS = 180_000;

export interface AgentHostDispatchRecord {
  id: string;
  owner: string;
  hostIdentity: string;
  ref: AgentHostSessionRef;
  messageId: string;
  turnId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048;
}

function isDispatchRecord(value: unknown, chatId: string): value is AgentHostDispatchRecord {
  if (!isRecord(value) || !isRecord(value.ref)) return false;
  const ref = value.ref;
  return isIdentifier(value.id) &&
    isIdentifier(value.owner) &&
    typeof value.hostIdentity === "string" &&
    /^[a-f0-9]{64}$/u.test(value.hostIdentity) &&
    isIdentifier(value.messageId) &&
    isIdentifier(ref.sessionUri) &&
    isIdentifier(ref.chatUri) &&
    createHash("sha256").update(ref.chatUri).digest("hex") === chatId &&
    (value.turnId === undefined || isIdentifier(value.turnId));
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function withAgentHostDispatchJournal<T>(
  storageDirectory: string,
  chatId: string,
  operation: (journal: {
    records: AgentHostDispatchRecord[];
    save: () => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  if (!/^[a-f0-9]{64}$/u.test(chatId)) {
    throw new Error("Invalid Agent Host chat identifier");
  }
  const directory = path.join(storageDirectory, "agent-host-dispatches");
  const filePath = path.join(directory, `${chatId}.json`);
  const markerPath = path.join(directory, `${chatId}.initialized`);
  return withTaskStoreLock(`${filePath}.lock`, async () => {
    const raw = await readOptionalFile(filePath);
    const marker = await readOptionalFile(markerPath);
    if ((marker !== undefined && marker !== "1") || (marker === "1" && raw === undefined)) {
      throw new Error("Cannot safely read Agent Host dispatch state");
    }
    let records: AgentHostDispatchRecord[] = [];
    if (raw !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Cannot safely read Agent Host dispatch state");
      }
      if (!Array.isArray(parsed) || !parsed.every((item) => isDispatchRecord(item, chatId))) {
        throw new Error("Cannot safely read Agent Host dispatch state");
      }
      if (marker === undefined && parsed.length > 0) {
        throw new Error("Cannot safely read Agent Host dispatch state");
      }
      records = parsed;
    }
    let initialized = marker === "1";
    return operation({
      records,
      save: async () => {
        if (!records.every((record) => isDispatchRecord(record, chatId))) {
          throw new Error("Cannot safely write Agent Host dispatch state");
        }
        if (records.length === 0 && initialized) {
          // An empty journal protects nothing, so drop its files instead of
          // leaving a pair behind for every chat. The empty journal is written
          // first so that a failure part-way never leaves records without their marker.
          await writeFileAtomically(filePath, "[]");
          try {
            await fs.promises.rm(markerPath, { force: true });
            initialized = false;
            await fs.promises.rm(filePath, { force: true });
          } catch {
            // Keeping the empty journal is harmless; only the cleanup failed.
          }
          return;
        }
        if (!initialized) {
          await writeFileAtomically(filePath, "[]");
          await writeFileAtomically(markerPath, "1");
          initialized = true;
        }
        await writeFileAtomically(filePath, JSON.stringify(records));
      },
    });
  }, { timeoutMs: JOURNAL_LOCK_TIMEOUT_MS });
}
