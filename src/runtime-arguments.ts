import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeFileAtomically } from "./atomic-file-write";

export const EXTENSION_ID = "yamapan.copilot-scheduler";
const KEY = "enable-proposed-api";
const MAX_WRITE_ATTEMPTS = 3;

export type EnableProposedApiPlan =
  | { status: "unchanged" }
  | { status: "updated"; content: string }
  | { status: "invalid" };

type Token = {
  kind: "{" | "}" | "[" | "]" | "," | ":" | "string" | "other";
  start: number;
  end: number;
};

const isLineBreak = (ch: string | undefined) => ch === "\n" || ch === "\r";

// Tokenizes JSONC; returns undefined on an unterminated string or block comment.
function scan(text: string): Token[] | undefined {
  const tokens: Token[] = [];
  const structural = "{}[],:";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && !isLineBreak(text[i])) i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) return undefined;
      i = close + 2;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (isLineBreak(text[j])) return undefined;
        j += text[j] === "\\" ? 2 : 1;
      }
      if (j >= text.length) return undefined;
      tokens.push({ kind: "string", start: i, end: j + 1 });
      i = j + 1;
    } else if (structural.includes(ch)) {
      tokens.push({ kind: ch as Token["kind"], start: i, end: i + 1 });
      i++;
    } else {
      let j = i;
      while (
        j < text.length &&
        !/\s/.test(text[j]) &&
        !structural.includes(text[j]) &&
        text[j] !== '"' &&
        !(text[j] === "/" && (text[j + 1] === "/" || text[j + 1] === "*"))
      )
        j++;
      tokens.push({ kind: "other", start: i, end: j });
      i = j;
    }
  }
  return tokens;
}

// Strict parse after dropping comments and trailing commas; undefined if not valid JSONC.
function parseJsonc(text: string): unknown {
  const tokens = scan(text);
  if (!tokens) return undefined;
  const kept: string[] = [];
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    if (token.kind === "," && (next?.kind === "}" || next?.kind === "]"))
      return;
    kept.push(text.slice(token.start, token.end));
  });
  try {
    return JSON.parse(kept.join(" "));
  } catch {
    return undefined;
  }
}

function stringValue(text: string, token: Token): string | undefined {
  try {
    const value: unknown = JSON.parse(text.slice(token.start, token.end));
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function matchingClose(tokens: Token[], openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    const kind = tokens[i].kind;
    if (kind === "{" || kind === "[") depth++;
    if (kind === "}" || kind === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

type Edit = { at: number; order: number; text: string };

function applyEdits(text: string, edits: Edit[]): string {
  // Later positions first so earlier offsets stay valid; at the same offset the lower order lands last.
  const sorted = [...edits].sort((a, b) => b.at - a.at || a.order - b.order);
  let result = text;
  for (const edit of sorted)
    result = result.slice(0, edit.at) + edit.text + result.slice(edit.at);
  return result;
}

function planOnce(
  original: string | undefined,
  extensionId: string,
): EnableProposedApiPlan {
  const eol = original?.includes("\r\n") ? "\r\n" : "\n";
  const entry = `"${KEY}": [${JSON.stringify(extensionId)}]`;
  if (original === undefined || original.trim() === "") {
    return {
      status: "updated",
      content: `{${eol}  ${entry}${eol}}${eol}`,
    };
  }

  const tokens = scan(original);
  if (!tokens) return { status: "invalid" };
  if (tokens.length === 0) {
    return {
      status: "updated",
      content: `${original.replace(/\s+$/, "")}${eol}{${eol}  ${entry}${eol}}${eol}`,
    };
  }
  if (tokens[0].kind !== "{") return { status: "invalid" };
  const closeIndex = matchingClose(tokens, 0);
  if (closeIndex < 0) return { status: "invalid" };

  const keyIndexes: number[] = [];
  let depth = 0;
  for (let i = 1; i < closeIndex; i++) {
    const token = tokens[i];
    if (token.kind === "{" || token.kind === "[") depth++;
    else if (token.kind === "}" || token.kind === "]") depth--;
    else if (
      depth === 0 &&
      token.kind === "string" &&
      tokens[i + 1]?.kind === ":" &&
      stringValue(original, token) === KEY
    )
      keyIndexes.push(i);
  }
  // A duplicated key makes the effective value ambiguous; leave the file alone.
  if (keyIndexes.length > 1) return { status: "invalid" };

  if (keyIndexes.length === 1) {
    const open = keyIndexes[0] + 2;
    if (tokens[open]?.kind !== "[") return { status: "invalid" };
    const close = matchingClose(tokens, open);
    if (close < 0 || close >= closeIndex) return { status: "invalid" };

    const elements = tokens
      .slice(open + 1, close)
      .filter((item) => item.kind !== ",");
    if (
      elements.some(
        (item) =>
          item.kind === "string" && stringValue(original, item) === extensionId,
      )
    )
      return { status: "unchanged" };
    if (elements.some((item) => item.kind !== "string"))
      return { status: "invalid" };

    const last = elements[elements.length - 1];
    const insertAt = last ? last.end : tokens[open].end;
    const insertion = last
      ? `, ${JSON.stringify(extensionId)}`
      : JSON.stringify(extensionId);
    return {
      status: "updated",
      content: applyEdits(original, [
        { at: insertAt, order: 0, text: insertion },
      ]),
    };
  }

  const closeToken = tokens[closeIndex];
  const previous = tokens[closeIndex - 1];
  const hasProperties = closeIndex > 1;
  const needsComma = hasProperties && previous.kind !== ",";
  const lineStart = original.lastIndexOf("\n", closeToken.start - 1) + 1;
  const ownLine = /^[ \t]*$/.test(original.slice(lineStart, closeToken.start));

  const edits: Edit[] = [];
  if (needsComma) edits.push({ at: previous.end, order: 1, text: "," });
  edits.push(
    ownLine
      ? { at: lineStart, order: 0, text: `  ${entry}${eol}` }
      : {
          at: closeToken.start,
          order: 0,
          text: `${hasProperties ? "" : " "}${entry} `,
        },
  );
  return { status: "updated", content: applyEdits(original, edits) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function planEnableProposedApi(
  original: string | undefined,
  extensionId: string = EXTENSION_ID,
): EnableProposedApiPlan {
  const blank = original === undefined || original.trim() === "";
  const commentsOnly = !blank && scan(original)?.length === 0;
  const before = blank || commentsOnly ? {} : parseJsonc(original);
  // Only edit files that already parse as a JSONC object.
  if (!isPlainObject(before)) return { status: "invalid" };

  const plan = planOnce(original, extensionId);
  if (plan.status !== "updated") return plan;

  const current = before[KEY];
  const expected = {
    ...before,
    [KEY]: [...(Array.isArray(current) ? current : []), extensionId],
  };
  // The edit must add exactly our entry and change nothing else.
  return JSON.stringify(parseJsonc(plan.content)) === JSON.stringify(expected)
    ? plan
    : { status: "invalid" };
}

export function resolveRuntimeArgumentsPath(
  appName: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  remoteName?: string,
): string | undefined {
  // argv.json belongs to the local desktop client, not a remote or web extension host.
  if (remoteName) return undefined;
  const folder =
    appName === "Visual Studio Code"
      ? ".vscode"
      : appName === "Visual Studio Code - Insiders"
        ? ".vscode-insiders"
        : undefined;
  if (!folder) return undefined;
  if (env.VSCODE_PORTABLE) return path.join(env.VSCODE_PORTABLE, "argv.json");
  return path.join(homeDir, folder, "argv.json");
}

export async function readRuntimeArguments(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Re-reads right before replacing the file and re-plans if it changed. This narrows, but does not
// close, the window for a concurrent edit; the atomic replace only guarantees a non-corrupt file.
export async function applyEnableProposedApi(
  filePath: string,
  extensionId: string = EXTENSION_ID,
): Promise<EnableProposedApiPlan["status"]> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const original = await readRuntimeArguments(filePath);
    const plan = planEnableProposedApi(original, extensionId);
    if (plan.status !== "updated") return plan.status;
    if ((await readRuntimeArguments(filePath)) !== original) continue;
    await writeFileAtomically(filePath, plan.content);
    return "updated";
  }
  return "invalid";
}
