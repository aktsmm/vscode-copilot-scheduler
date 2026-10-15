import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  applyEnableProposedApi,
  planEnableProposedApi,
  resolveRuntimeArgumentsPath,
} from "../../runtime-arguments";

const ID = "yamapan.copilot-scheduler";

function updated(original: string | undefined): string {
  const plan = planEnableProposedApi(original, ID);
  assert.strictEqual(plan.status, "updated");
  return (plan as { content: string }).content;
}

suite("Runtime Arguments (argv.json)", () => {
  test("creates the file content when it is missing or blank", () => {
    for (const original of [undefined, "", " \n"])
      assert.deepStrictEqual(JSON.parse(updated(original)), {
        "enable-proposed-api": [ID],
      });
  });

  test("keeps comments and other entries when adding the key (CRLF)", () => {
    const original = [
      "// header comment",
      "{",
      "  // inline note",
      '  "locale": "ja" // trailing',
      "}",
      "",
    ].join("\r\n");
    const content = updated(original);
    assert.ok(content.includes("// header comment"));
    assert.ok(content.includes("// inline note"));
    assert.ok(content.includes("// trailing"));
    assert.ok(content.includes(`"enable-proposed-api": ["${ID}"]`));
    assert.ok(!/(^|[^\r])\n/.test(content), "keeps CRLF line endings");
    assert.strictEqual(planEnableProposedApi(content, ID).status, "unchanged");
  });

  test("handles trailing commas, empty and inline objects", () => {
    for (const original of ['{\n  "a": 1,\n}\n', "{}", "{ }", '{ "a": 1 }']) {
      const content = updated(original);
      assert.strictEqual(
        planEnableProposedApi(content, ID).status,
        "unchanged",
        original,
      );
      assert.ok(content.includes(`"enable-proposed-api": ["${ID}"]`));
    }
  });

  test("appends to an existing array without touching other items", () => {
    const empty = updated('{\n  "enable-proposed-api": []\n}');
    assert.ok(empty.includes(`["${ID}"]`));
    const withOthers = updated(
      '{\n  "enable-proposed-api": [\n    "a.b", // keep\n    "c.d"\n  ]\n}',
    );
    assert.ok(withOthers.includes('"a.b", // keep'));
    assert.ok(withOthers.includes(`"c.d", "${ID}"`));
  });

  test("is unchanged when already listed, ignoring comments and nested keys", () => {
    assert.deepStrictEqual(
      planEnableProposedApi(`{ "enable-proposed-api": ["x.y", "${ID}"] }`, ID),
      { status: "unchanged" },
    );
    const content = updated(
      `{\n  // "enable-proposed-api": ["${ID}"]\n  "nested": { "enable-proposed-api": ["${ID}"] }\n}`,
    );
    assert.ok(content.endsWith("}") || content.endsWith("}\n"));
    assert.ok(/\n {2}"enable-proposed-api": \[/.test(content));
  });

  test("refuses content it cannot edit safely", () => {
    for (const original of [
      "[]",
      '{ "enable-proposed-api": "x" }',
      '{ "enable-proposed-api": [1] }',
      '{ "a": ',
      '{ "a": "unterminated }',
      "{ /* open",
      '{"enable-proposed-api":["a.b"],"enable-proposed-api":["c.d"]}',
      "// header\r{} {}",
      '{ "a": 1 } trailing',
    ])
      assert.deepStrictEqual(
        planEnableProposedApi(original, ID),
        { status: "invalid" },
        original,
      );
  });

  test("produces valid output for compact objects and unusual line breaks", () => {
    const compact = updated('{"locale":"ja"}');
    assert.deepStrictEqual(JSON.parse(compact), {
      locale: "ja",
      "enable-proposed-api": [ID],
    });
    assert.deepStrictEqual(
      JSON.parse(updated('{"a":1,"b":[1,2],}'.replace(",}", "}"))),
      { a: 1, b: [1, 2], "enable-proposed-api": [ID] },
    );
    const crComment = updated("// header\r{}");
    assert.ok(crComment.startsWith("// header\r{"));
    assert.strictEqual(
      planEnableProposedApi(crComment, ID).status,
      "unchanged",
    );
    assert.strictEqual(
      (crComment.match(/\{/g) ?? []).length,
      1,
      "keeps a single root object",
    );
  });

  test("keeps a BOM and comment markers inside strings intact", () => {
    const content = updated(
      '\uFEFF// c\n{\n  "url": "http://x/*y*/",\n  "a": 1\n}\n',
    );
    assert.ok(content.startsWith("\uFEFF// c"));
    assert.ok(content.includes('"url": "http://x/*y*/"'));
    assert.strictEqual(planEnableProposedApi(content, ID).status, "unchanged");
  });

  test("resolves the runtime arguments path only for supported local hosts", () => {
    const home = path.join("home", "user");
    assert.strictEqual(
      resolveRuntimeArgumentsPath("Visual Studio Code", {}, home),
      path.join(home, ".vscode", "argv.json"),
    );
    assert.strictEqual(
      resolveRuntimeArgumentsPath("Visual Studio Code - Insiders", {}, home),
      path.join(home, ".vscode-insiders", "argv.json"),
    );
    assert.strictEqual(
      resolveRuntimeArgumentsPath(
        "Visual Studio Code",
        { VSCODE_PORTABLE: "p" },
        home,
      ),
      path.join("p", "argv.json"),
    );
    assert.strictEqual(
      resolveRuntimeArgumentsPath("VSCodium", {}, home),
      undefined,
    );
    assert.strictEqual(
      resolveRuntimeArgumentsPath("VSCodium", { VSCODE_PORTABLE: "p" }, home),
      undefined,
    );
    assert.strictEqual(
      resolveRuntimeArgumentsPath("Visual Studio Code", {}, home, "wsl"),
      undefined,
    );
  });

  test("re-plans instead of overwriting when the file changes before the write", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-argv-"));
    const target = path.join(root, "argv.json");
    fs.writeFileSync(target, '{\n  "locale": "ja"\n}\n', "utf8");
    const readFile = Object.getOwnPropertyDescriptor(fs.promises, "readFile")!;
    let reads = 0;
    try {
      Object.defineProperty(fs.promises, "readFile", {
        ...readFile,
        value: async (...args: unknown[]) => {
          reads++;
          // Simulates another window saving between our read and our write.
          if (reads === 2)
            fs.writeFileSync(
              target,
              '{\n  "locale": "en",\n  "disable-hardware-acceleration": true\n}\n',
              "utf8",
            );
          return (readFile.value as (...a: unknown[]) => Promise<string>)(
            ...args,
          );
        },
      });
      assert.strictEqual(await applyEnableProposedApi(target, ID), "updated");
    } finally {
      Object.defineProperty(fs.promises, "readFile", readFile);
    }
    try {
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, "utf8")), {
        locale: "en",
        "disable-hardware-acceleration": true,
        "enable-proposed-api": [ID],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes atomically, creates the file, and skips rewriting when unchanged", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-argv-"));
    const target = path.join(root, "nested", "argv.json");
    try {
      assert.strictEqual(await applyEnableProposedApi(target, ID), "updated");
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, "utf8")), {
        "enable-proposed-api": [ID],
      });
      const before = fs.statSync(target).mtimeMs;
      assert.strictEqual(await applyEnableProposedApi(target, ID), "unchanged");
      assert.strictEqual(fs.statSync(target).mtimeMs, before);

      fs.writeFileSync(target, "[]", "utf8");
      assert.strictEqual(await applyEnableProposedApi(target, ID), "invalid");
      assert.strictEqual(fs.readFileSync(target, "utf8"), "[]");
      assert.deepStrictEqual(
        fs
          .readdirSync(path.dirname(target))
          .filter((name) => name.endsWith(".tmp")),
        [],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
