/**
 * Copilot Scheduler - Attachment path handling
 *
 * Attachments are sent to an LLM unattended, so paths are validated twice:
 * once when a task is saved (shape only, workspace-independent) and again at
 * execution time against the real roots.
 *
 * `resolveAllowedPathInBaseDir` from promptResolver is deliberately NOT reused:
 * it only accepts prompt-template markdown and rejects `*.instructions.md` and
 * `*.agent.md`, which are exactly the files users want to attach.
 */

import * as fs from "fs";
import * as path from "path";
import { isPathInsideBaseDir, normalizeForCompare } from "./promptResolver";
import type { AttachmentSource, TaskAttachment, TaskScope } from "./types";

export const MAX_TASK_ATTACHMENTS = 10;

/** Files that must never be uploaded by an unattended run. */
const DENIED_BASENAME_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /^id_rsa(\..+)?$/i,
  /^id_ed25519(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
];

const DENIED_PATH_SEGMENTS = new Set(["secrets", ".ssh"]);

export type AttachmentRejectionReason =
  | "invalidPath"
  | "absolutePath"
  | "traversal"
  | "denied"
  | "localOnGlobalScope"
  | "tooMany";

export interface AttachmentRejection {
  reason: AttachmentRejectionReason;
  path: string;
}

export interface NormalizedAttachments {
  attachments: TaskAttachment[];
  rejected: AttachmentRejection[];
  /** True when the input differed from the normalized result. */
  changed: boolean;
}

function isAttachmentSource(value: unknown): value is AttachmentSource {
  return value === "local" || value === "global";
}

function toPosixSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Normalize a stored attachment path.
 * Returns undefined for anything that is not a safe workspace-relative path.
 */
export function normalizeAttachmentPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = toPosixSeparators(value.trim());
  if (!trimmed) {
    return undefined;
  }
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:\//.test(trimmed)) {
    return undefined;
  }

  const segments = trimmed.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0 || segments.some((s) => s === "..")) {
    return undefined;
  }

  return segments.join("/");
}

/** Whether the path targets a file class that must not be uploaded. */
export function isDeniedAttachmentPath(value: string): boolean {
  const normalized = toPosixSeparators(value);
  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    return true;
  }

  if (segments.slice(0, -1).some((s) => DENIED_PATH_SEGMENTS.has(s.toLowerCase()))) {
    return true;
  }

  const basename = segments[segments.length - 1];
  return DENIED_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

function attachmentKey(attachment: TaskAttachment): string {
  return `${attachment.source}:${attachment.path.toLowerCase()}`;
}

/**
 * Validate and de-duplicate attachments for persistence.
 * Workspace-independent: only shape, safety, scope and limits are checked here.
 */
export function normalizeAttachments(
  value: unknown,
  scope: TaskScope,
): NormalizedAttachments {
  const rejected: AttachmentRejection[] = [];
  const attachments: TaskAttachment[] = [];
  const seen = new Set<string>();

  if (value === undefined || value === null) {
    return { attachments: [], rejected, changed: false };
  }

  if (!Array.isArray(value)) {
    return {
      attachments: [],
      rejected: [{ reason: "invalidPath", path: "" }],
      changed: true,
    };
  }

  let changed = false;

  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      rejected.push({ reason: "invalidPath", path: "" });
      changed = true;
      continue;
    }

    const candidate = raw as Partial<TaskAttachment>;
    const rawPath = typeof candidate.path === "string" ? candidate.path : "";

    if (!isAttachmentSource(candidate.source)) {
      rejected.push({ reason: "invalidPath", path: rawPath });
      changed = true;
      continue;
    }

    if (scope === "global" && candidate.source === "local") {
      rejected.push({ reason: "localOnGlobalScope", path: rawPath });
      changed = true;
      continue;
    }

    const trimmed = toPosixSeparators(rawPath.trim());
    const normalizedPath = normalizeAttachmentPath(rawPath);
    if (!normalizedPath) {
      const reason: AttachmentRejectionReason =
        trimmed && (path.isAbsolute(trimmed) || /^[a-zA-Z]:\//.test(trimmed))
          ? "absolutePath"
          : trimmed.split("/").includes("..")
            ? "traversal"
            : "invalidPath";
      rejected.push({ reason, path: rawPath });
      changed = true;
      continue;
    }

    if (isDeniedAttachmentPath(normalizedPath)) {
      rejected.push({ reason: "denied", path: normalizedPath });
      changed = true;
      continue;
    }

    const entry: TaskAttachment = {
      source: candidate.source,
      path: normalizedPath,
    };
    const key = attachmentKey(entry);
    if (seen.has(key)) {
      changed = true;
      continue;
    }

    if (attachments.length >= MAX_TASK_ATTACHMENTS) {
      rejected.push({ reason: "tooMany", path: normalizedPath });
      changed = true;
      continue;
    }

    if (normalizedPath !== rawPath) {
      changed = true;
    }
    seen.add(key);
    attachments.push(entry);
  }

  if (attachments.length !== value.length) {
    changed = true;
  }

  return { attachments, rejected, changed };
}

export interface AttachmentRoots {
  /** Roots a "local" attachment may resolve against. */
  localRoots: string[];
  /** Root a "global" attachment resolves against. */
  globalRoot?: string;
}

export interface ResolvedAttachment {
  attachment: TaskAttachment;
  fsPath: string;
}

export interface AttachmentResolution {
  resolved: ResolvedAttachment[];
  missing: TaskAttachment[];
}

function resolveInRoot(root: string, relativePath: string): string | undefined {
  if (!root) {
    return undefined;
  }

  const target = path.resolve(root, relativePath);
  // isPathInsideBaseDir resolves both sides through realpath, so a symlink
  // pointing outside the root is rejected here.
  if (!isPathInsideBaseDir(root, target)) {
    return undefined;
  }

  try {
    if (!fs.statSync(target).isFile()) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return target;
}

/**
 * Resolve attachments against the real roots at execution time.
 * Re-checks the denylist and the root boundary to close the save-to-run window.
 */
export function resolveAttachments(
  attachments: TaskAttachment[] | undefined,
  roots: AttachmentRoots,
): AttachmentResolution {
  const resolved: ResolvedAttachment[] = [];
  const missing: TaskAttachment[] = [];
  const seen = new Set<string>();

  for (const attachment of attachments ?? []) {
    const normalizedPath = normalizeAttachmentPath(attachment?.path);
    if (
      !normalizedPath ||
      !isAttachmentSource(attachment?.source) ||
      isDeniedAttachmentPath(normalizedPath)
    ) {
      missing.push(attachment);
      continue;
    }

    const candidateRoots =
      attachment.source === "global"
        ? roots.globalRoot
          ? [roots.globalRoot]
          : []
        : roots.localRoots;

    let match: string | undefined;
    for (const root of candidateRoots) {
      match = resolveInRoot(root, normalizedPath);
      if (match) {
        break;
      }
    }

    if (!match) {
      missing.push(attachment);
      continue;
    }

    const key = normalizeForCompare(match);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    resolved.push({ attachment, fsPath: match });
  }

  return { resolved, missing };
}

/** Display label for an attachment, used in the UI and in history entries. */
export function getAttachmentDisplayName(attachment: TaskAttachment): string {
  const normalized = normalizeAttachmentPath(attachment?.path);
  if (!normalized) {
    return "";
  }
  return normalized.split("/").pop() ?? normalized;
}
