import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { isPathInsideBaseDir } from "./promptResolver";
import type { SkillScope, SkillTemplate, TaskSkillRef } from "./types";

/** Skill names are lower-case words joined by single hyphens (Agent Skills format). */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_FRONTMATTER_BYTES = 16 * 1024;
const MAX_SKILLS_PER_ROOT = 200;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_ARGUMENT_HINT_LENGTH = 120;
const MAX_ROOT_LABEL_LENGTH = 40;

const WORKSPACE_SKILL_ROOTS = [
  ".github/skills",
  ".agents/skills",
  ".claude/skills",
];

export type SkillFrontmatter = {
  name?: string;
  description?: string;
  argumentHint?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
};

export type SkillRoot = {
  scope: SkillScope;
  /** Absolute folder that directly contains the skill folders. */
  dir: string;
  /** Label stored in a task reference. */
  label: string;
  /** Workspace folder a workspace skill must stay inside. */
  boundary?: string;
};

export type DiscoveredSkills = {
  skills: SkillTemplate[];
  /** Names left out because the same name exists in several places. */
  ambiguous: string[];
  /** True when workspace skills were skipped because the workspace is not trusted. */
  workspaceSkipped: boolean;
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

/**
 * Reads the flat keys Scheduler needs from a SKILL.md header. Only a leading
 * `---` block is read; anything else yields undefined.
 */
export function parseSkillFrontmatter(
  text: string,
): SkillFrontmatter | undefined {
  const source = text.replace(/^\uFEFF/, "");
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }

  const values = new Map<string, string>();
  let closed = false;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === "---" || line.trim() === "...") {
      closed = true;
      break;
    }
    const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    let value = match[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded: string[] = [];
      while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1])) {
        folded.push(lines[index + 1].trim());
        index++;
      }
      value = folded.join(" ");
    }
    if (!values.has(key)) {
      values.set(key, unquote(value));
    }
  }
  if (!closed) {
    return undefined;
  }

  const clip = (value: string | undefined, max: number) => {
    const text = (value ?? "").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, max) : undefined;
  };
  return {
    name: clip(values.get("name"), MAX_SKILL_NAME_LENGTH + 1),
    description: clip(values.get("description"), MAX_DESCRIPTION_LENGTH),
    argumentHint: clip(values.get("argument-hint"), MAX_ARGUMENT_HINT_LENGTH),
    userInvocable: parseBoolean(values.get("user-invocable")),
    disableModelInvocation: parseBoolean(values.get("disable-model-invocation")),
  };
}

export function isValidSkillName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_SKILL_NAME_LENGTH &&
    SKILL_NAME_PATTERN.test(name)
  );
}

/** Returns a clean reference or undefined; never throws on persisted data. */
export function normalizeSkillRef(value: unknown): TaskSkillRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const { name, scope, root } = record;
  if (!isValidSkillName(name)) return undefined;
  if (scope !== "workspace" && scope !== "user") return undefined;
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    root.length > MAX_ROOT_LABEL_LENGTH ||
    !/^[.\w/-]+$/.test(root)
  ) {
    return undefined;
  }
  return { name, scope, root };
}

export function isSameSkillRef(
  left: TaskSkillRef | undefined,
  right: TaskSkillRef | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.name === right.name &&
    left.scope === right.scope &&
    left.root === right.root
  );
}

/** True when the prompt starts with `/<name>` as a whole command word. */
export function promptInvokesSkill(prompt: string, name: string): boolean {
  const text = prompt.replace(/^\uFEFF/, "").trimStart();
  if (!text.startsWith(`/${name}`)) return false;
  const next = text.charAt(name.length + 1);
  return next === "" || /\s/.test(next);
}

export function getSkillRoots(
  workspaceFolders: readonly string[],
  homeDir: string,
  copilotHome?: string,
): SkillRoot[] {
  const roots: SkillRoot[] = [];
  for (const folder of workspaceFolders) {
    for (const label of WORKSPACE_SKILL_ROOTS) {
      roots.push({
        scope: "workspace",
        dir: path.join(folder, ...label.split("/")),
        label,
        boundary: folder,
      });
    }
  }
  if (homeDir) {
    roots.push(
      {
        scope: "user",
        dir: copilotHome
          ? path.join(copilotHome, "skills")
          : path.join(homeDir, ".copilot", "skills"),
        label: ".copilot/skills",
      },
      {
        scope: "user",
        dir: path.join(homeDir, ".agents", "skills"),
        label: ".agents/skills",
      },
      {
        scope: "user",
        dir: path.join(homeDir, ".claude", "skills"),
        label: ".claude/skills",
      },
    );
  }
  return roots;
}

async function readFrontmatterText(file: string): Promise<string | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return undefined;
    handle = await fs.promises.open(file, "r");
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_FRONTMATTER_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Lists skills under the given roots. Only top-level skill folders whose name is
 * valid and equals the `name` in SKILL.md are kept, so the `/<name>` that is sent
 * is the name the host knows. A workspace skill must resolve inside its workspace
 * folder; user skill folders may be links.
 *
 * Duplicates: a workspace skill wins over a user skill of the same name (observed
 * host behavior). A name found more than once at the same level is left out,
 * because the host's choice between them is not known.
 */
export async function discoverSkills(
  roots: readonly SkillRoot[],
  options: { workspaceTrusted: boolean },
): Promise<DiscoveredSkills> {
  const found: Array<{ skill: SkillTemplate; scope: SkillScope }> = [];
  let workspaceSkipped = false;

  for (const root of roots) {
    if (root.scope === "workspace" && !options.workspaceTrusted) {
      workspaceSkipped = true;
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const names = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter(isValidSkillName)
      .sort()
      .slice(0, MAX_SKILLS_PER_ROOT);

    for (const name of names) {
      const file = path.join(root.dir, name, "SKILL.md");
      if (root.boundary && !isPathInsideBaseDir(root.boundary, file)) {
        continue;
      }
      const text = await readFrontmatterText(file);
      if (text === undefined) continue;
      const frontmatter = parseSkillFrontmatter(text);
      if (!frontmatter || frontmatter.name !== name) continue;
      if (frontmatter.userInvocable === false) continue;

      found.push({
        scope: root.scope,
        skill: {
          name,
          scope: root.scope,
          root: root.label,
          description: frontmatter.description ?? "",
          ...(frontmatter.argumentHint
            ? { argumentHint: frontmatter.argumentHint }
            : {}),
          explicit: frontmatter.disableModelInvocation === true,
        },
      });
    }
  }

  const byName = new Map<string, typeof found>();
  for (const item of found) {
    const list = byName.get(item.skill.name) ?? [];
    list.push(item);
    byName.set(item.skill.name, list);
  }

  const skills: SkillTemplate[] = [];
  const ambiguous: string[] = [];
  for (const [name, items] of byName) {
    const workspace = items.filter((item) => item.scope === "workspace");
    const user = items.filter((item) => item.scope === "user");
    const level = workspace.length > 0 ? workspace : user;
    if (level.length === 1) {
      skills.push(level[0].skill);
    } else {
      ambiguous.push(name);
    }
  }

  skills.sort((a, b) =>
    a.explicit === b.explicit
      ? a.name.localeCompare(b.name)
      : a.explicit
        ? -1
        : 1,
  );
  ambiguous.sort();
  return { skills, ambiguous, workspaceSkipped };
}

export function findSkillByRef(
  discovered: DiscoveredSkills,
  ref: TaskSkillRef,
): SkillTemplate | undefined {
  return discovered.skills.find((skill) => isSameSkillRef(skill, ref));
}

function getLocalWorkspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath)
    .filter(Boolean);
}

export type SkillTemplateMode = "explicit" | "all" | "off";

export function getSkillTemplateMode(): SkillTemplateMode {
  const raw = vscode.workspace
    .getConfiguration("copilotScheduler")
    .get<string>("skillTemplates", "explicit");
  return raw === "all" || raw === "off" ? raw : "explicit";
}

/** Discovers skills for the current VS Code window. */
export async function discoverWorkspaceSkills(): Promise<DiscoveredSkills> {
  if (getSkillTemplateMode() === "off") {
    return { skills: [], ambiguous: [], workspaceSkipped: false };
  }
  return discoverSkills(
    getSkillRoots(
      getLocalWorkspaceFolderPaths(),
      os.homedir(),
      process.env.COPILOT_HOME?.trim() || undefined,
    ),
    { workspaceTrusted: vscode.workspace.isTrusted },
  );
}

export type SkillRefCheck =
  | { ok: true }
  | { ok: false; reason: "notTrusted" | "missing" | "ambiguous" };

/**
 * Re-checks a task's skill right before it runs. A skill that is gone, ambiguous
 * or in an untrusted workspace stops the run: sending `/<name>` anyway would
 * either do nothing or run something other than what the task was saved with.
 */
export async function checkSkillRef(ref: TaskSkillRef): Promise<SkillRefCheck> {
  if (ref.scope === "workspace" && !vscode.workspace.isTrusted) {
    return { ok: false, reason: "notTrusted" };
  }
  const discovered = await discoverSkills(
    getSkillRoots(
      getLocalWorkspaceFolderPaths(),
      os.homedir(),
      process.env.COPILOT_HOME?.trim() || undefined,
    ),
    { workspaceTrusted: vscode.workspace.isTrusted },
  );
  if (findSkillByRef(discovered, ref)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: discovered.ambiguous.includes(ref.name) ? "ambiguous" : "missing",
  };
}
