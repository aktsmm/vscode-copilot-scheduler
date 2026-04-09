import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getPromptTemplateDisplayName,
  isPromptTemplateMarkdownFile,
  resolveAllowedPathInBaseDir,
  resolveLocalPromptPath,
  resolveGlobalPromptPath,
  resolveGlobalPromptsRoot,
  resolveGlobalAgentRoots,
} from "../../promptResolver";

function norm(p: string | undefined): string {
  if (!p) return "";
  const n = path.normalize(path.resolve(p)).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n.toLowerCase() : n;
}

function withEnv(
  overrides: Partial<NodeJS.ProcessEnv>,
  callback: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const nextValue = overrides[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }

  try {
    callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: platform,
  });

  try {
    return callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

function createDirectoryEscapeLink(targetDir: string, linkPath: string): void {
  const linkTypes: Array<"junction" | "dir"> =
    process.platform === "win32" ? ["junction", "dir"] : ["dir"];
  let lastError: unknown;

  for (const linkType of linkTypes) {
    try {
      fs.symlinkSync(targetDir, linkPath, linkType);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to create directory link for test");
}

suite("Prompt Resolver Tests", () => {
  test("resolveAllowedPathInBaseDir rejects traversal", () => {
    const base = path.join("/tmp", "ws");
    const resolved = resolveAllowedPathInBaseDir(base, "../secret.md");
    assert.strictEqual(resolved, undefined);
  });

  test("resolveAllowedPathInBaseDir requires .md", () => {
    const base = path.join("/tmp", "ws");
    const resolved = resolveAllowedPathInBaseDir(base, "a.txt");
    assert.strictEqual(resolved, undefined);
  });

  test("resolveAllowedPathInBaseDir rejects .agent.md", () => {
    const base = path.join("/tmp", "ws");
    const resolved = resolveAllowedPathInBaseDir(base, "a.agent.md");
    assert.strictEqual(resolved, undefined);
  });

  test("resolveAllowedPathInBaseDir rejects .instructions.md", () => {
    const base = path.join("/tmp", "ws");
    const resolved = resolveAllowedPathInBaseDir(base, "a.instructions.md");
    assert.strictEqual(resolved, undefined);
  });

  test("resolveGlobalPromptPath resolves under global root", () => {
    const globalRoot = path.join("/tmp", "prompts");
    const p = resolveGlobalPromptPath(globalRoot, "daily.md");
    assert.strictEqual(norm(p), norm(path.join(globalRoot, "daily.md")));
  });

  test("resolveGlobalPromptPath rejects .agent.md", () => {
    const globalRoot = path.join("/tmp", "prompts");
    const p = resolveGlobalPromptPath(globalRoot, "x.agent.md");
    assert.strictEqual(p, undefined);
  });

  test("resolveGlobalPromptPath rejects .instructions.md", () => {
    const globalRoot = path.join("/tmp", "prompts");
    const p = resolveGlobalPromptPath(globalRoot, "x.instructions.md");
    assert.strictEqual(p, undefined);
  });

  test("resolveGlobalPromptsRoot keeps VS Code user prompts default", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-global-prompts-"),
    );

    try {
      const appData = path.join(tempRoot, "appdata");
      const homeDir = path.join(tempRoot, "home");
      const promptsRoot = path.join(appData, "Code", "User", "prompts");
      fs.mkdirSync(promptsRoot, { recursive: true });
      fs.mkdirSync(homeDir, { recursive: true });

      withEnv(
        {
          APPDATA: appData,
          HOME: homeDir,
          USERPROFILE: homeDir,
          XDG_CONFIG_HOME: undefined,
        },
        () => {
          const resolved = resolveGlobalPromptsRoot();
          assert.strictEqual(norm(resolved), norm(promptsRoot));
        },
      );
    } finally {
      fs.rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  });

  test("resolveGlobalPromptsRoot ignores APPDATA fallback on macOS", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-global-prompts-macos-"),
    );

    try {
      const appData = path.join(tempRoot, "appdata");
      const homeDir = path.join(tempRoot, "home");
      const macPromptsRoot = path.join(
        homeDir,
        "Library",
        "Application Support",
        "Code",
        "User",
        "prompts",
      );
      fs.mkdirSync(path.join(appData, "Code", "User", "prompts"), {
        recursive: true,
      });
      fs.mkdirSync(macPromptsRoot, { recursive: true });

      withPlatform("darwin", () => {
        withEnv(
          {
            APPDATA: appData,
            HOME: homeDir,
            USERPROFILE: homeDir,
            XDG_CONFIG_HOME: undefined,
          },
          () => {
            const resolved = resolveGlobalPromptsRoot();
            assert.strictEqual(norm(resolved), norm(macPromptsRoot));
          },
        );
      });
    } finally {
      fs.rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  });

  test("resolveGlobalPromptsRoot ignores APPDATA fallback on Linux", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-global-prompts-linux-"),
    );

    try {
      const appData = path.join(tempRoot, "appdata");
      const homeDir = path.join(tempRoot, "home");
      const xdgConfigHome = path.join(tempRoot, "xdg");
      const linuxPromptsRoot = path.join(
        xdgConfigHome,
        "Code",
        "User",
        "prompts",
      );
      fs.mkdirSync(path.join(appData, "Code", "User", "prompts"), {
        recursive: true,
      });
      fs.mkdirSync(linuxPromptsRoot, { recursive: true });

      withPlatform("linux", () => {
        withEnv(
          {
            APPDATA: appData,
            HOME: homeDir,
            USERPROFILE: homeDir,
            XDG_CONFIG_HOME: xdgConfigHome,
          },
          () => {
            const resolved = resolveGlobalPromptsRoot();
            assert.strictEqual(norm(resolved), norm(linuxPromptsRoot));
          },
        );
      });
    } finally {
      fs.rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  });

  test("resolveGlobalAgentRoots includes VS Code user prompts and copilot agents", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-global-agents-"),
    );

    try {
      const appData = path.join(tempRoot, "appdata");
      const homeDir = path.join(tempRoot, "home");
      const promptsRoot = path.join(appData, "Code", "User", "prompts");
      const copilotAgentsRoot = path.join(homeDir, ".copilot", "agents");
      fs.mkdirSync(promptsRoot, { recursive: true });
      fs.mkdirSync(copilotAgentsRoot, { recursive: true });

      withEnv(
        {
          APPDATA: appData,
          HOME: homeDir,
          USERPROFILE: homeDir,
          XDG_CONFIG_HOME: undefined,
        },
        () => {
          const resolved = resolveGlobalAgentRoots();
          assert.deepStrictEqual(resolved.map(norm), [
            norm(promptsRoot),
            norm(copilotAgentsRoot),
          ]);
        },
      );
    } finally {
      fs.rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  });

  test("resolveGlobalAgentRoots custom path overrides defaults", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-global-agents-custom-"),
    );

    try {
      const appData = path.join(tempRoot, "appdata");
      const homeDir = path.join(tempRoot, "home");
      const promptsRoot = path.join(appData, "Code", "User", "prompts");
      const copilotAgentsRoot = path.join(homeDir, ".copilot", "agents");
      const customRoot = path.join(tempRoot, "custom-agents");
      fs.mkdirSync(promptsRoot, { recursive: true });
      fs.mkdirSync(copilotAgentsRoot, { recursive: true });
      fs.mkdirSync(customRoot, { recursive: true });

      withEnv(
        {
          APPDATA: appData,
          HOME: homeDir,
          USERPROFILE: homeDir,
          XDG_CONFIG_HOME: undefined,
        },
        () => {
          const resolved = resolveGlobalAgentRoots(customRoot);
          assert.deepStrictEqual(resolved.map(norm), [norm(customRoot)]);
        },
      );
    } finally {
      fs.rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  });

  test("resolveLocalPromptPath supports multi-root absolute paths", () => {
    const ws1 = path.join("/tmp", "ws1");
    const ws2 = path.join("/tmp", "ws2");
    const allowed = path.join(ws2, ".github", "prompts", "a.md");
    const p = resolveLocalPromptPath([ws1, ws2], allowed);
    assert.strictEqual(norm(p), norm(allowed));
  });

  test("resolveLocalPromptPath rejects workspace files outside .github/prompts", () => {
    const ws1 = path.join("/tmp", "ws1");
    const outside = path.join(ws1, "notes.md");
    const p = resolveLocalPromptPath([ws1], outside);
    assert.strictEqual(p, undefined);
  });

  test("resolveLocalPromptPath accepts relative path from workspace root", () => {
    const ws1 = path.join("/tmp", "ws1");
    const rel = path.join(".github", "prompts", "x.md");
    const p = resolveLocalPromptPath([ws1], rel);
    assert.strictEqual(
      norm(p),
      norm(path.join(ws1, ".github", "prompts", "x.md")),
    );
  });

  test("resolveLocalPromptPath rejects .agent.md", () => {
    const ws1 = path.join("/tmp", "ws1");
    const rel = path.join(".github", "prompts", "x.agent.md");
    const p = resolveLocalPromptPath([ws1], rel);
    assert.strictEqual(p, undefined);
  });

  test("resolveLocalPromptPath rejects .instructions.md", () => {
    const ws1 = path.join("/tmp", "ws1");
    const rel = path.join(".github", "prompts", "x.instructions.md");
    const p = resolveLocalPromptPath([ws1], rel);
    assert.strictEqual(p, undefined);
  });

  test("isPromptTemplateMarkdownFile allows plain markdown and .prompt.md", () => {
    assert.strictEqual(isPromptTemplateMarkdownFile("task.md"), true);
    assert.strictEqual(isPromptTemplateMarkdownFile("daily.prompt.md"), true);
  });

  test("isPromptTemplateMarkdownFile rejects agent and instruction files", () => {
    assert.strictEqual(isPromptTemplateMarkdownFile("agent.agent.md"), false);
    assert.strictEqual(
      isPromptTemplateMarkdownFile("team.instructions.md"),
      false,
    );
  });

  test("getPromptTemplateDisplayName strips .prompt.md suffix", () => {
    assert.strictEqual(
      getPromptTemplateDisplayName("daily.prompt.md"),
      "daily",
    );
    assert.strictEqual(getPromptTemplateDisplayName("notes.md"), "notes");
  });

  test("resolveAllowedPathInBaseDir rejects symlink escape", function () {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-resolver-"),
    );

    try {
      const base = path.join(tempRoot, "allowed");
      const outsideDir = path.join(tempRoot, "outside");
      fs.mkdirSync(base, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const outsideFile = path.join(outsideDir, "secret.md");
      fs.writeFileSync(outsideFile, "secret", "utf8");

      const linkPath = path.join(base, "escaped");
      createDirectoryEscapeLink(outsideDir, linkPath);

      const resolved = resolveAllowedPathInBaseDir(
        base,
        path.join("escaped", "secret.md"),
      );
      assert.strictEqual(resolved, undefined);
    } finally {
      fs.rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  });
});
