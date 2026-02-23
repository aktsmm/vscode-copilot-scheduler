import * as path from "path";
import * as fs from "fs";

function normalizeForCompare(p: string): string {
  const n = path.normalize(path.resolve(p)).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n.toLowerCase() : n;
}

function isInsideDir(baseDir: string, targetPath: string): boolean {
  const base = normalizeForCompare(baseDir);
  const tgt = normalizeForCompare(targetPath);
  return tgt === base || tgt.startsWith(base + path.sep);
}

function isMarkdownFile(p: string): boolean {
  return p.toLowerCase().endsWith(".md");
}

/**
 * Resolve a path against a base directory and ensure it stays inside it.
 *
 * Accepts absolute or relative `promptPath`.
 */
export function resolveAllowedPathInBaseDir(
  baseDir: string,
  promptPath: string,
): string | undefined {
  if (!baseDir || !promptPath) return undefined;
  const resolvedTarget = path.resolve(baseDir, promptPath);
  if (!isInsideDir(baseDir, resolvedTarget)) {
    return undefined;
  }
  if (!isMarkdownFile(resolvedTarget)) {
    return undefined;
  }
  return resolvedTarget;
}

export function resolveGlobalPromptPath(
  globalRoot: string | undefined,
  promptPath: string,
): string | undefined {
  if (!globalRoot) return undefined;
  return resolveAllowedPathInBaseDir(globalRoot, promptPath);
}

/**
 * Resolve local prompt template path for execution.
 *
 * Security/consistency:
 * - Only allows markdown files under `.github/prompts/` in any open workspace folder.
 * - Supports multi-root workspaces.
 * - Supports absolute paths and relative paths (relative to workspace root or prompts dir).
 */
export function resolveLocalPromptPath(
  workspaceFolderPaths: string[],
  promptPath: string,
): string | undefined {
  if (!promptPath || typeof promptPath !== "string") return undefined;
  if (workspaceFolderPaths.length === 0) return undefined;

  for (const workspaceRoot of workspaceFolderPaths) {
    if (!workspaceRoot) continue;
    const promptsDir = path.join(workspaceRoot, ".github", "prompts");

    // Absolute path case: just validate containment.
    if (path.isAbsolute(promptPath)) {
      const resolvedAbs = path.resolve(promptPath);
      if (isInsideDir(promptsDir, resolvedAbs) && isMarkdownFile(resolvedAbs)) {
        return resolvedAbs;
      }
      continue;
    }

    // Relative paths:
    // - relative to workspace root (e.g., ".github/prompts/foo.md")
    // - relative to prompts dir (e.g., "foo.md" or "sub/foo.md")
    const candidateFromWorkspace = path.resolve(workspaceRoot, promptPath);
    if (
      isInsideDir(promptsDir, candidateFromWorkspace) &&
      isMarkdownFile(candidateFromWorkspace)
    ) {
      return candidateFromWorkspace;
    }

    const candidateFromPrompts = path.resolve(promptsDir, promptPath);
    if (
      isInsideDir(promptsDir, candidateFromPrompts) &&
      isMarkdownFile(candidateFromPrompts)
    ) {
      return candidateFromPrompts;
    }
  }

  return undefined;
}

/**
 * Resolve the global prompts root directory.
 * Falls back to the default VS Code User/prompts folder.
 */
export function resolveGlobalPromptsRoot(
  customPath?: string,
): string | undefined {
  const defaultRoot = process.env.APPDATA
    ? path.join(process.env.APPDATA, "Code", "User", "prompts")
    : "";
  const globalRoot = customPath || defaultRoot;
  if (!globalRoot) return undefined;
  return fs.existsSync(globalRoot) ? globalRoot : undefined;
}
