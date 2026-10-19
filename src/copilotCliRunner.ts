import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";

/** Reasoning effort values the Copilot CLI accepts for --reasoning-effort. */
const CLI_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const MAX_JSON_LINE_CHARS = 2 * 1024 * 1024;
const STDERR_TAIL_CHARS = 600;
const KILL_GRACE_MS = 3000;

/**
 * The CLI only knows Copilot's own model ids. Ids of other providers (for example
 * `default::gpt-6-luna` from the Codex bridge) would fail inside the CLI with a
 * less helpful message, so they are refused up front.
 */
export function isCopilotCliModelSupported(
  vendor: string | undefined,
  modelId: string,
): boolean {
  const id = modelId.trim();
  if (!id || id.includes("::") || /[\s"']/.test(id)) return false;
  const provider = (vendor ?? "").trim().toLowerCase();
  return provider === "" || provider === "copilot";
}

export interface CopilotCliArgsInput {
  model: string;
  reasoningEffort?: string;
  allowAllTools: boolean;
  trustFolder: boolean;
}

/**
 * Locates the `copilot` executable. A configured value must be an absolute path to
 * an existing file. Without one, PATH is searched; on Windows only `copilot.exe` is
 * accepted because a `.cmd` shim cannot be started without a shell.
 */
export function resolveCopilotCliPath(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const isFile = (candidate: string): boolean => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  const value = (configured ?? "").trim();
  if (value) {
    return path.isAbsolute(value) && isFile(value) ? value : undefined;
  }

  const fileName = platform === "win32" ? "copilot.exe" : "copilot";
  const separator = platform === "win32" ? ";" : ":";
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const entry of pathValue.split(separator)) {
    const dir = entry.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    const candidate = path.join(dir, fileName);
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Arguments for a non-interactive run. The prompt itself goes through stdin, so it
 * is never subject to the command line length limit and never parsed by a shell.
 */
export function buildCopilotCliArgs(input: CopilotCliArgsInput): string[] {
  const args = [
    "-s",
    "--output-format",
    "json",
    "--no-ask-user",
    "--no-auto-update",
    "--no-color",
    "--model",
    input.model,
  ];
  const effort = (input.reasoningEffort ?? "").trim().toLowerCase();
  if (CLI_REASONING_EFFORTS.has(effort)) {
    args.push("--reasoning-effort", effort);
  }
  if (input.allowAllTools) {
    args.push("--allow-all-tools");
  }
  if (input.trustFolder) {
    args.push("--trust-folder");
  }
  return args;
}

/**
 * The CLI does not run `/skill` in prompt mode, so the skill's instructions are put
 * in front of the arguments. The folder is named so relative paths in the skill resolve.
 */
export function buildSkillPromptForCli(
  name: string,
  dir: string,
  body: string,
  args: string,
): string {
  const trimmedArgs = args.trim();
  return [
    `Run the Agent Skill "${name}" now. Follow its instructions exactly; the arguments below are the user's request for it.`,
    `The skill folder is ${dir}; resolve relative paths in the instructions against it.`,
    "",
    `<skill-instructions name="${name}">`,
    body,
    "</skill-instructions>",
    "",
    "Arguments:",
    trimmedArgs || "(none)",
  ].join("\n");
}

export interface CopilotCliRunSummary {
  appliedModel?: string;
  premiumRequests?: number;
  exitCodeFromResult?: number;
}

/** Reads only what history needs from the CLI's JSON lines; never stores answers. */
export class CopilotCliOutputParser {
  private buffer = "";
  private skipping = false;
  readonly summary: CopilotCliRunSummary = {};

  push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (this.skipping) {
        this.skipping = false;
      } else {
        this.readLine(line);
      }
      index = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_JSON_LINE_CHARS) {
      this.buffer = "";
      this.skipping = true;
    }
  }

  finish(): CopilotCliRunSummary {
    if (!this.skipping && this.buffer.trim()) {
      this.readLine(this.buffer);
    }
    this.buffer = "";
    return this.summary;
  }

  private readLine(line: string): void {
    const text = line.trim();
    if (!text.startsWith("{")) return;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    const record = event as Record<string, unknown>;
    if (record.type === "assistant.message") {
      const data = record.data as Record<string, unknown> | undefined;
      if (typeof data?.model === "string" && data.model) {
        this.summary.appliedModel = data.model;
      }
    } else if (record.type === "result") {
      if (typeof record.exitCode === "number") {
        this.summary.exitCodeFromResult = record.exitCode;
      }
      const usage = record.usage as Record<string, unknown> | undefined;
      if (typeof usage?.premiumRequests === "number") {
        this.summary.premiumRequests = usage.premiumRequests;
      }
    }
  }
}

export interface CopilotCliProcessOptions {
  executable: string;
  args: string[];
  cwd?: string;
  prompt: string;
  timeoutMs: number;
}

export interface CopilotCliProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  /** True when the run was stopped by terminateActiveCopilotCliProcesses (for example on shutdown). */
  cancelled: boolean;
  stderrTail: string;
  summary: CopilotCliRunSummary;
  spawnError?: string;
}

const activeChildren = new Set<childProcess.ChildProcess>();
const cancelledChildren = new WeakSet<childProcess.ChildProcess>();

/** Stops every CLI run that is still going, so closing VS Code leaves no orphan `copilot` process. */
export function terminateActiveCopilotCliProcesses(): number {
  const children = [...activeChildren];
  for (const child of children) {
    cancelledChildren.add(child);
    killProcessTree(child);
  }
  return children.length;
}

function killProcessTree(child: childProcess.ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      childProcess.execFile(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true },
        () => undefined,
      );
      return;
    } catch {
      // Fall through to a plain kill.
    }
  }
  try {
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS).unref();
  } catch {
    // Already gone.
  }
}

/** Runs the CLI without a shell and resolves when it exits, fails to start or times out. */
export function runCopilotCliProcess(
  options: CopilotCliProcessOptions,
): Promise<CopilotCliProcessResult> {
  return new Promise((resolve) => {
    const parser = new CopilotCliOutputParser();
    let stderrTail = "";
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({
        exitCode,
        timedOut,
        cancelled: cancelledChildren.has(child),
        stderrTail: stderrTail.trim(),
        summary: parser.finish(),
        ...(spawnError ? { spawnError } : {}),
      });
    };

    let child: childProcess.ChildProcess;
    try {
      child = childProcess.spawn(options.executable, options.args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        exitCode: null,
        timedOut: false,
        cancelled: false,
        stderrTail: "",
        summary: {},
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    activeChildren.add(child);

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => parser.push(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));

    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.prompt);
  });
}
