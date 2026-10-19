import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildCopilotCliArgs,
  buildSkillPromptForCli,
  CopilotCliOutputParser,
  isCopilotCliModelSupported,
  resolveCopilotCliPath,
  runCopilotCliProcess,
  terminateActiveCopilotCliProcesses,
} from "../../copilotCliRunner";
import { readSkillInstructions, stripSkillFrontmatter } from "../../skillResolver";
import { getSkillRoots } from "../../skillResolver";

suite("Copilot CLI runner", () => {
  let tmp: string;

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-cli-"));
  });

  teardown(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("builds arguments without a prompt and without allow-all by default", () => {
    const args = buildCopilotCliArgs({
      model: "claude-sonnet-5.5",
      reasoningEffort: "HIGH",
      allowAllTools: false,
      trustFolder: false,
    });
    assert.deepStrictEqual(args, [
      "-s",
      "--output-format",
      "json",
      "--no-ask-user",
      "--no-auto-update",
      "--no-color",
      "--model",
      "claude-sonnet-5.5",
      "--reasoning-effort",
      "high",
    ]);
    assert.ok(!args.includes("-p"), "the prompt goes through stdin");
  });

  test("adds tool approval and folder trust only when asked, and drops unknown effort", () => {
    const args = buildCopilotCliArgs({
      model: "auto",
      reasoningEffort: "extreme",
      allowAllTools: true,
      trustFolder: true,
    });
    assert.ok(args.includes("--allow-all-tools"));
    assert.ok(args.includes("--trust-folder"));
    assert.ok(!args.includes("--reasoning-effort"));
  });

  test("only an absolute existing file is accepted as a configured path", () => {
    const exe = path.join(tmp, process.platform === "win32" ? "copilot.exe" : "copilot");
    fs.writeFileSync(exe, "");
    assert.strictEqual(resolveCopilotCliPath(exe), exe);
    assert.strictEqual(resolveCopilotCliPath(path.join(tmp, "missing")), undefined);
    assert.strictEqual(resolveCopilotCliPath("copilot"), undefined);
    assert.strictEqual(resolveCopilotCliPath(tmp), undefined);
  });

  test("PATH search finds the executable and ignores a Windows cmd shim", () => {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "copilot.cmd"), "");
    assert.strictEqual(
      resolveCopilotCliPath("", { PATH: bin }, "win32"),
      undefined,
      "a .cmd shim cannot be started without a shell",
    );
    fs.writeFileSync(path.join(bin, "copilot.exe"), "");
    assert.strictEqual(
      resolveCopilotCliPath("", { PATH: `${path.join(tmp, "none")};${bin}` }, "win32"),
      path.join(bin, "copilot.exe"),
    );
  });

  test("skill prompt carries the instructions, the folder and the arguments", () => {
    const prompt = buildSkillPromptForCli("daily-ops", "C:\\skills\\daily-ops", "Do the thing.", " 2026-10-19 ");
    assert.ok(prompt.includes('<skill-instructions name="daily-ops">'));
    assert.ok(prompt.includes("Do the thing."));
    assert.ok(prompt.includes("C:\\skills\\daily-ops"));
    assert.ok(prompt.endsWith("Arguments:\n2026-10-19"));
    assert.ok(buildSkillPromptForCli("a", "d", "b", "  ").endsWith("(none)"));
  });

  test("output parser keeps only the model and usage, across split chunks", () => {
    const parser = new CopilotCliOutputParser();
    const lines = [
      JSON.stringify({ type: "session.mcp_server_status_changed", data: {} }),
      JSON.stringify({ type: "assistant.message", data: { model: "claude-haiku-4.5", content: "secret answer" } }),
      "not json",
      JSON.stringify({ type: "result", exitCode: 0, usage: { premiumRequests: 0.33 } }),
    ].join("\n");
    parser.push(lines.slice(0, 60));
    parser.push(lines.slice(60));
    const summary = parser.finish();
    assert.deepStrictEqual(summary, {
      appliedModel: "claude-haiku-4.5",
      exitCodeFromResult: 0,
      premiumRequests: 0.33,
    });
    assert.ok(!JSON.stringify(summary).includes("secret answer"));
  });

  test("a run feeds the prompt through stdin and reports the applied model", async () => {
    const script = path.join(tmp, "fake-cli.js");
    fs.writeFileSync(
      script,
      [
        "let input = '';",
        "process.stdin.on('data', (c) => input += c);",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ type: 'assistant.message', data: { model: 'echo-model', content: input.length } }));",
        "  console.log(JSON.stringify({ type: 'result', exitCode: 0, usage: { premiumRequests: 1 } }));",
        "});",
      ].join("\n"),
    );
    const longPrompt = "x".repeat(200000);
    const result = await runCopilotCliProcess({
      executable: process.execPath,
      args: [script],
      cwd: tmp,
      prompt: longPrompt,
      timeoutMs: 20000,
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.summary.appliedModel, "echo-model");
    assert.strictEqual(result.summary.premiumRequests, 1);
  });

  test("a failing run reports its exit code and a stderr tail", async () => {
    const script = path.join(tmp, "fail-cli.js");
    fs.writeFileSync(script, "console.error('model not available'); process.exit(3);");
    const result = await runCopilotCliProcess({
      executable: process.execPath,
      args: [script],
      cwd: tmp,
      prompt: "hi",
      timeoutMs: 20000,
    });
    assert.strictEqual(result.exitCode, 3);
    assert.ok(result.stderrTail.includes("model not available"));
  });

  test("terminating active runs stops them and marks the result cancelled", async () => {
    const script = path.join(tmp, "hang-cli.js");
    fs.writeFileSync(script, "setInterval(() => {}, 1000);");
    const pending = runCopilotCliProcess({
      executable: process.execPath,
      args: [script],
      cwd: tmp,
      prompt: "hi",
      timeoutMs: 60000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(terminateActiveCopilotCliProcesses(), 1);
    const result = await pending;
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(terminateActiveCopilotCliProcesses(), 0, "nothing left to stop");
  });

  test("a run that exceeds the timeout is stopped", async () => {
    const script = path.join(tmp, "slow-cli.js");
    fs.writeFileSync(script, "setInterval(() => {}, 1000);");
    const result = await runCopilotCliProcess({
      executable: process.execPath,
      args: [script],
      cwd: tmp,
      prompt: "hi",
      timeoutMs: 400,
    });
    assert.strictEqual(result.timedOut, true);
  });

  test("a missing executable is reported instead of thrown", async () => {
    const result = await runCopilotCliProcess({
      executable: path.join(tmp, "does-not-exist"),
      args: [],
      cwd: tmp,
      prompt: "hi",
      timeoutMs: 5000,
    });
    assert.ok(result.spawnError);
    assert.strictEqual(result.exitCode, null);
  });

  test("only Copilot model ids are handed to the CLI", () => {
    assert.strictEqual(isCopilotCliModelSupported("copilot", "claude-haiku-4.5"), true);
    assert.strictEqual(isCopilotCliModelSupported("", "auto"), true);
    assert.strictEqual(isCopilotCliModelSupported(undefined, "gpt-6.1-sol"), true);
    assert.strictEqual(isCopilotCliModelSupported("openai-codex", "default::gpt-6-luna"), false);
    assert.strictEqual(isCopilotCliModelSupported("copilot", "default::gpt-6-luna"), false);
    assert.strictEqual(isCopilotCliModelSupported("copilot", "bad id"), false);
    assert.strictEqual(isCopilotCliModelSupported("copilot", "  "), false);
  });

  test("skill instructions are read without front matter and respect trust and precedence", async () => {
    const ws = path.join(tmp, "ws");
    const home = path.join(tmp, "home");
    const write = (dir: string, text: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), text);
    };
    write(
      path.join(ws, ".github", "skills", "daily-ops"),
      "---\nname: daily-ops\ndescription: x\n---\nWorkspace body\n",
    );
    write(
      path.join(home, ".copilot", "skills", "daily-ops"),
      "---\nname: daily-ops\n---\nUser body\n",
    );
    write(
      path.join(home, ".copilot", "skills", "renamed"),
      "---\nname: other\n---\nBad\n",
    );
    const roots = getSkillRoots([ws], home);

    const trusted = await readSkillInstructions("daily-ops", roots, { workspaceTrusted: true });
    assert.strictEqual(trusted?.body, "Workspace body");
    assert.strictEqual(trusted?.dir, path.join(ws, ".github", "skills", "daily-ops"));

    const untrusted = await readSkillInstructions("daily-ops", roots, { workspaceTrusted: false });
    assert.strictEqual(untrusted?.body, "User body");

    assert.strictEqual(
      await readSkillInstructions("renamed", roots, { workspaceTrusted: true }),
      undefined,
      "a folder name that differs from the skill name is not used",
    );
    assert.strictEqual(
      await readSkillInstructions("../escape", roots, { workspaceTrusted: true }),
      undefined,
    );
    assert.strictEqual(stripSkillFrontmatter("no front matter"), "no front matter");
  });
});
