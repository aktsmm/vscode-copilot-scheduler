import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkSkillRef,
  discoverSkills,
  findSkillByRef,
  getCurrentSkillRoots,
  getSkillRoots,
  isValidSkillName,
  normalizeSkillRef,
  parseSkillFrontmatter,
  promptInvokesSkill,
} from "../../skillResolver";

function writeSkill(
  root: string,
  folder: string,
  frontmatter: string[] | null,
): void {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const body =
    frontmatter === null
      ? "# no frontmatter\n"
      : ["---", ...frontmatter, "---", "", "# body", ""].join("\n");
  fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
}

suite("Skill resolver", () => {
  let tmp: string;
  let home: string;
  let ws: string;

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-skills-"));
    home = path.join(tmp, "home");
    ws = path.join(tmp, "ws");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(ws, { recursive: true });
  });

  teardown(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  test("frontmatter parsing reads the flat keys and tolerates BOM, CRLF and quoting", () => {
    const parsed = parseSkillFrontmatter(
      [
        "\uFEFF---",
        "name: my-skill",
        'description: "Does a thing"',
        "argument-hint: '[file] [options]'",
        "disable-model-invocation: \"true\"",
        "user-invocable: FALSE",
        "---",
        "body",
      ].join("\r\n"),
    );
    assert.deepStrictEqual(parsed, {
      name: "my-skill",
      description: "Does a thing",
      argumentHint: "[file] [options]",
      userInvocable: false,
      disableModelInvocation: true,
    });
  });

  test("frontmatter parsing folds block scalars, keeps the first duplicate and clips long text", () => {
    const parsed = parseSkillFrontmatter(
      [
        "---",
        "name: a",
        "description: >-",
        "  first line",
        "  second line",
        "name: ignored",
        `argument-hint: ${"x".repeat(500)}`,
        "---",
      ].join("\n"),
    );
    assert.strictEqual(parsed?.name, "a");
    assert.strictEqual(parsed?.description, "first line second line");
    assert.strictEqual(parsed?.argumentHint?.length, 120);
  });

  test("frontmatter parsing rejects text without a closed leading block", () => {
    assert.strictEqual(parseSkillFrontmatter("# title\n---\nname: a\n---"), undefined);
    assert.strictEqual(parseSkillFrontmatter("---\nname: a\n"), undefined);
    assert.strictEqual(parseSkillFrontmatter(""), undefined);
  });

  test("only lower-case hyphenated names up to 64 characters are valid", () => {
    for (const name of ["a", "my-skill", "skill2", "a-b-c"]) {
      assert.strictEqual(isValidSkillName(name), true, name);
    }
    for (const name of [
      "",
      "My-Skill",
      "my_skill",
      "-a",
      "a-",
      "a--b",
      "a b",
      "../x",
      "a/b",
      "日本語",
      "a".repeat(65),
      undefined,
      42,
    ]) {
      assert.strictEqual(isValidSkillName(name), false, String(name));
    }
  });

  test("skill references are cleaned and malformed ones are dropped", () => {
    assert.deepStrictEqual(
      normalizeSkillRef({
        name: "a",
        scope: "workspace",
        root: ".github/skills",
        junk: true,
      }),
      { name: "a", scope: "workspace", root: ".github/skills" },
    );
    for (const value of [
      null,
      "x",
      {},
      { name: "A", scope: "user", root: ".copilot/skills" },
      { name: "a", scope: "other", root: ".copilot/skills" },
      { name: "a", scope: "user", root: "" },
      { name: "a", scope: "user", root: "C:\\x" },
      { name: "a", scope: "user", root: "../../etc" + "x".repeat(60) },
    ]) {
      assert.strictEqual(normalizeSkillRef(value), undefined, JSON.stringify(value));
    }
  });

  test("a prompt invokes a skill only when the command comes first and is a whole word", () => {
    assert.strictEqual(promptInvokesSkill("/s do it", "s"), true);
    assert.strictEqual(promptInvokesSkill("/s", "s"), true);
    assert.strictEqual(promptInvokesSkill("\uFEFF  /s\nx", "s"), true);
    assert.strictEqual(promptInvokesSkill("/s2", "s"), false);
    assert.strictEqual(promptInvokesSkill("x /s", "s"), false);
    assert.strictEqual(promptInvokesSkill("[auto] hint\n\n/s", "s"), false);
  });

  test("roots cover every workspace folder, the user folders and COPILOT_HOME", () => {
    const roots = getSkillRoots(["/w1", "/w2"], "/home/u", "/custom/copilot");
    assert.deepStrictEqual(
      roots.map((root) => `${root.scope}:${root.label}`),
      [
        "workspace:.github/skills",
        "workspace:.agents/skills",
        "workspace:.claude/skills",
        "workspace:.github/skills",
        "workspace:.agents/skills",
        "workspace:.claude/skills",
        "user:.copilot/skills",
        "user:.agents/skills",
        "user:.claude/skills",
      ],
    );
    assert.strictEqual(
      roots.find((root) => root.label === ".copilot/skills")?.dir,
      path.join("/custom/copilot", "skills"),
    );
    assert.strictEqual(getSkillRoots([], "", undefined).length, 0);
  });

  test("the roots the watchers observe are the roots discovery reads", () => {
    const current = getCurrentSkillRoots();
    assert.ok(current.some((root) => root.scope === "user"));
    assert.ok(
      current.every((root) => path.isAbsolute(root.dir)),
      "watch patterns need absolute folders",
    );
    const root = path.resolve(__dirname, "../../..");
    const source = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
    for (const token of [
      "getCurrentSkillRoots()",
      '"*/SKILL.md"',
      "watcher.onDidCreate(scheduleSkillRefresh)",
      "watcher.onDidChange(scheduleSkillRefresh)",
      "watcher.onDidDelete(scheduleSkillRefresh)",
      'e.affectsConfiguration("copilotScheduler.skillTemplates")',
      "onDidGrantWorkspaceTrust",
    ]) {
      assert.ok(source.includes(token), `extension.ts must contain: ${token}`);
    }
    const resolver = fs.readFileSync(
      path.join(root, "src", "skillResolver.ts"),
      "utf8",
    );
    assert.ok(
      resolver.includes("discoverSkills(getCurrentSkillRoots()"),
      "discovery and watchers must share one root list",
    );
  });

  test("discovery lists valid skills, explicit ones first, and applies the naming rules", async () => {
    const userRoot = path.join(home, ".copilot", "skills");
    writeSkill(userRoot, "zeta", [
      "name: zeta",
      "description: manual one",
      "disable-model-invocation: true",
    ]);
    writeSkill(userRoot, "alpha", ["name: alpha", "description: auto one"]);
    writeSkill(userRoot, "hidden", ["name: hidden", "user-invocable: false"]);
    writeSkill(userRoot, "mismatch", ["name: other-name"]);
    writeSkill(userRoot, "Bad_Name", ["name: Bad_Name"]);
    writeSkill(userRoot, "no-frontmatter", null);
    fs.mkdirSync(path.join(userRoot, "empty-dir"), { recursive: true });
    fs.writeFileSync(path.join(userRoot, "file.txt"), "x");

    const result = await discoverSkills(getSkillRoots([], home), {
      workspaceTrusted: true,
    });
    assert.deepStrictEqual(
      result.skills.map((skill) => [skill.name, skill.explicit, skill.scope]),
      [
        ["zeta", true, "user"],
        ["alpha", false, "user"],
      ],
    );
    assert.strictEqual(result.skills[0].description, "manual one");
    assert.deepStrictEqual(result.ambiguous, []);
  });

  test("a workspace skill hides a user skill of the same name", async () => {
    writeSkill(path.join(home, ".copilot", "skills"), "shared", [
      "name: shared",
      "description: user copy",
    ]);
    writeSkill(path.join(ws, ".github", "skills"), "shared", [
      "name: shared",
      "description: workspace copy",
    ]);

    const result = await discoverSkills(getSkillRoots([ws], home), {
      workspaceTrusted: true,
    });
    assert.deepStrictEqual(
      result.skills.map((skill) => [skill.name, skill.scope, skill.description]),
      [["shared", "workspace", "workspace copy"]],
    );
  });

  test("a name found twice at the same level is left out as ambiguous", async () => {
    writeSkill(path.join(ws, ".github", "skills"), "twice", ["name: twice"]);
    writeSkill(path.join(ws, ".agents", "skills"), "twice", ["name: twice"]);
    writeSkill(path.join(home, ".copilot", "skills"), "twice-user", ["name: twice-user"]);
    writeSkill(path.join(home, ".agents", "skills"), "twice-user", ["name: twice-user"]);
    writeSkill(path.join(home, ".copilot", "skills"), "unique", ["name: unique"]);

    const result = await discoverSkills(getSkillRoots([ws], home), {
      workspaceTrusted: true,
    });
    assert.deepStrictEqual(
      result.skills.map((skill) => skill.name),
      ["unique"],
    );
    assert.deepStrictEqual(result.ambiguous, ["twice", "twice-user"]);
  });

  test("workspace skills are not read while the workspace is untrusted", async () => {
    writeSkill(path.join(ws, ".github", "skills"), "repo-skill", ["name: repo-skill"]);
    writeSkill(path.join(home, ".copilot", "skills"), "my-skill", ["name: my-skill"]);

    const result = await discoverSkills(getSkillRoots([ws], home), {
      workspaceTrusted: false,
    });
    assert.deepStrictEqual(
      result.skills.map((skill) => skill.name),
      ["my-skill"],
    );
    assert.strictEqual(result.workspaceSkipped, true);
  });

  test("a workspace skill folder that links outside the workspace is ignored", async function () {
    const outside = path.join(tmp, "outside");
    writeSkill(outside, "escaped", ["name: escaped"]);
    const skillsRoot = path.join(ws, ".github", "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    try {
      fs.symlinkSync(
        path.join(outside, "escaped"),
        path.join(skillsRoot, "escaped"),
        "junction",
      );
    } catch {
      this.skip();
    }

    const result = await discoverSkills(getSkillRoots([ws], home), {
      workspaceTrusted: true,
    });
    assert.deepStrictEqual(result.skills, []);
  });

  test("lookup by reference needs the same name, scope and root", async () => {
    writeSkill(path.join(home, ".copilot", "skills"), "my-skill", ["name: my-skill"]);
    const result = await discoverSkills(getSkillRoots([], home), {
      workspaceTrusted: true,
    });
    assert.ok(
      findSkillByRef(result, {
        name: "my-skill",
        scope: "user",
        root: ".copilot/skills",
      }),
    );
    for (const ref of [
      { name: "my-skill", scope: "workspace" as const, root: ".copilot/skills" },
      { name: "my-skill", scope: "user" as const, root: ".agents/skills" },
      { name: "other", scope: "user" as const, root: ".copilot/skills" },
    ]) {
      assert.strictEqual(findSkillByRef(result, ref), undefined);
    }
  });

  test("a missing skill fails the run-time check", async () => {
    const check = await checkSkillRef({
      name: "zz-scheduler-test-missing-skill",
      scope: "user",
      root: ".copilot/skills",
    });
    assert.deepStrictEqual(check, { ok: false, reason: "missing" });
  });
});
