/**
 * Copilot Scheduler - Extension Tests
 */

import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { parseExpression } from "cron-parser";
import type { ExecutionHistoryEntry } from "../../executionHistoryStore";
import { messages } from "../../i18n";
import { EXPERIMENTAL_REASONING_EFFORT_LEVELS } from "../../modelQualityExperiment";
import type {
  ExecuteOptions,
  ExecutePromptResult,
  ScheduledTask,
} from "../../types";
import { runSharedSanitizerCases } from "./helpers/sanitizerAssertions";

function findMatchingBraceEnd(source: string, braceStart: number): number {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inSingleQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (inTemplate) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "`") {
        inTemplate = false;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (ch === "`") {
      inTemplate = true;
      continue;
    }

    if (ch === "{") {
      depth++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return -1;
}

function extractBlockFromStartToken(
  source: string,
  startToken: string,
): string {
  const start = source.indexOf(startToken);
  assert.ok(start >= 0, `Start token not found: ${startToken}`);

  const braceStart = source.indexOf("{", start);
  assert.ok(braceStart >= 0, `Opening brace not found for: ${startToken}`);

  const end = findMatchingBraceEnd(source, braceStart);
  assert.ok(end > braceStart, `Closing brace not found for: ${startToken}`);

  return source.slice(start, end);
}

suite("Extension Test Suite", () => {
  test("Extension should be present", () => {
    assert.ok(vscode.extensions.getExtension("yamapan.copilot-scheduler"));
  });

  test("Extension should activate", async () => {
    const extension = vscode.extensions.getExtension(
      "yamapan.copilot-scheduler",
    );
    if (extension) {
      await extension.activate();
      assert.strictEqual(extension.isActive, true);
    }
  });

  test("Commands should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);

    const expectedCommands = [
      "copilotScheduler.createTask",
      "copilotScheduler.createTaskGui",
      "copilotScheduler.listTasks",
      "copilotScheduler.deleteTask",
      "copilotScheduler.toggleTask",
      "copilotScheduler.enableTask",
      "copilotScheduler.disableTask",
      "copilotScheduler.runNow",
      "copilotScheduler.copyPrompt",
      "copilotScheduler.editTask",
      "copilotScheduler.duplicateTask",
      "copilotScheduler.moveToCurrentWorkspace",
      "copilotScheduler.openSettings",
      "copilotScheduler.showVersion",
      "copilotScheduler.showExecutionHistory",
      "copilotScheduler.dumpModelCatalog",
    ];

    for (const cmd of expectedCommands) {
      assert.ok(commands.includes(cmd), `Command ${cmd} should be registered`);
    }

    // Verify no unexpected copilotScheduler commands exist (P6)
    const registeredSchedulerCommands = commands.filter((cmd) =>
      cmd.startsWith("copilotScheduler."),
    );
    assert.strictEqual(
      registeredSchedulerCommands.length,
      expectedCommands.length,
      `Expected ${expectedCommands.length} copilotScheduler commands but found ${registeredSchedulerCommands.length}. Update expectedCommands when adding new commands.`,
    );
  });

  test("auto-mode guidance uses native setting links without a trailing hash in the target", () => {
    const root = path.resolve(__dirname, "../../..");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    assert.strictEqual(
      manifest.contributes.configuration.properties[
        "copilotScheduler.autoModeDefault"
      ].markdownDescription,
      "%config.autoModeDefault%",
    );
    for (const filename of ["package.nls.json", "package.nls.ja.json"]) {
      const strings: Record<string, string> = JSON.parse(
        fs.readFileSync(path.join(root, filename), "utf8"),
      );
      const description = strings["config.autoModeDefault"];
      assert.ok(
        description.includes("`#chat.editing.autoAcceptDelay#`"),
        filename,
      );
      for (const value of Object.values(strings)) {
        assert.doesNotMatch(value, /\]\(#[^)\s]+#\)/, filename);
      }
    }
  });

  test("auto-enable setting is on by default and documents restart in both locales", () => {
    const root = path.resolve(__dirname, "../../..");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    const property =
      manifest.contributes.configuration.properties[
        "copilotScheduler.autoEnableProposedApi"
      ];
    assert.strictEqual(property.type, "boolean");
    assert.strictEqual(property.default, true);
    assert.strictEqual(
      property.markdownDescription,
      "%config.autoEnableProposedApi%",
    );
    const expected: Record<string, string[]> = {
      "package.nls.json": ["argv.json", "reloading the window is not enough"],
      "package.nls.ja.json": [
        "argv.json",
        "ウィンドウの再読み込みでは反映されません",
      ],
    };
    for (const [filename, tokens] of Object.entries(expected)) {
      const strings: Record<string, string> = JSON.parse(
        fs.readFileSync(path.join(root, filename), "utf8"),
      );
      for (const token of tokens)
        assert.ok(
          strings["config.autoEnableProposedApi"].includes(token),
          `${filename}: ${token}`,
        );
    }
  });

  test("FULL_SPECIFICATION stays aligned with package manifest basics", () => {
    const root = path.resolve(__dirname, "../../..");
    const specPath = path.join(root, "FULL_SPECIFICATION.md");
    if (!fs.existsSync(specPath)) {
      return;
    }

    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      version: string;
      contributes?: {
        commands?: Array<{ command?: string }>;
        configuration?: { properties?: Record<string, unknown> };
      };
    };
    const spec = fs.readFileSync(specPath, "utf8");

    assert.match(
      spec,
      new RegExp(`\\|\\s*バージョン\\s*\\|\\s*${packageJson.version}\\s*\\|`),
      "FULL_SPECIFICATION.md should document the current package version",
    );

    for (const item of packageJson.contributes?.commands ?? []) {
      assert.ok(
        item.command && spec.includes(item.command),
        `FULL_SPECIFICATION.md should mention contributed command ${item.command}`,
      );
    }

    for (const settingKey of Object.keys(
      packageJson.contributes?.configuration?.properties ?? {},
    )) {
      if (settingKey === "copilotScheduler.reportIssue") {
        continue;
      }
      assert.ok(
        spec.includes(settingKey),
        `FULL_SPECIFICATION.md should mention contributed setting ${settingKey}`,
      );
    }

    for (const staleToken of [
      "0.1.0",
      "sidebar-icon.svg",
      "tsc -watch -p ./",
      "executePromptViaCLI",
      "setDefaultScope",
    ]) {
      assert.ok(
        !spec.includes(staleToken),
        `FULL_SPECIFICATION.md contains stale token: ${staleToken}`,
      );
    }
  });

  test("manual run next-run policy default stays aligned across runtime docs", () => {
    const root = path.resolve(__dirname, "../../..");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      contributes?: {
        configuration?: {
          properties?: Record<
            string,
            {
              default?: unknown;
              enum?: unknown[];
              enumDescriptions?: unknown[];
            }
          >;
        };
      };
    };
    const setting =
      manifest.contributes?.configuration?.properties?.[
        "copilotScheduler.manualRunNextRunPolicy"
      ];
    assert.strictEqual(setting?.default, "fromNow");
    assert.deepStrictEqual(setting?.enum, ["fromNow", "advance"]);
    assert.strictEqual(
      setting?.enumDescriptions?.length,
      setting?.enum?.length,
    );

    for (const [filename, expectedRow, fallbackText] of [
      [
        "README.md",
        /manualRunNextRunPolicy`\s*\|\s*`fromNow`/,
        "otherwise use current time",
      ],
      [
        "README_ja.md",
        /manualRunNextRunPolicy`\s*\|\s*`fromNow`/,
        "なければ現在時刻から再計算",
      ],
    ] as const) {
      const readme = fs.readFileSync(path.join(root, filename), "utf8");
      assert.match(readme, expectedRow, filename);
      assert.ok(readme.includes(fallbackText), filename);
    }

    const nls = JSON.parse(
      fs.readFileSync(path.join(root, "package.nls.json"), "utf8"),
    ) as Record<string, string>;
    const nlsJa = JSON.parse(
      fs.readFileSync(path.join(root, "package.nls.ja.json"), "utf8"),
    ) as Record<string, string>;
    assert.match(
      nls["config.manualRunNextRunPolicy.advance"],
      /otherwise recalculate from the current time/,
    );
    assert.match(
      nlsJa["config.manualRunNextRunPolicy.advance"],
      /未来の予定がなければ現在時刻から再計算/,
    );
  });

  test("the publish workflow runs every release gate", () => {
    const root = path.resolve(__dirname, "../../..");
    const workflowPath = path.join(
      root,
      ".github/workflows/publish-marketplace.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");

    // The tag push is the only release path, so a gate missing here never runs
    // before the artifact reaches the Marketplace.
    for (const gate of [
      "node scripts/verify-package-lock-registry.js",
      "npm audit --omit=dev --registry=https://registry.npmjs.org",
      "npm run verify:nls",
      "npm run lint",
      "npm test",
      "npm run verify:vsix",
    ]) {
      assert.ok(
        workflow.includes(gate),
        `publish workflow should run the release gate: ${gate}`,
      );
    }
    assert.ok(
      workflow.includes("Validate tag matches package version"),
      "publish workflow should refuse a tag that does not match package.json",
    );
    assert.match(workflow, /type: boolean\s+default: false/);
    // Temporary GHSA-fc5q-39xc-vjpf exception: production dependencies block the
    // release; the full audit is only reported. Restore a single blocking audit
    // (and this assertion) once a patched picomatch exists.
    assert.match(
      workflow,
      /- name: Audit production dependencies\s+run: npm audit --omit=dev --registry=https:\/\/registry\.npmjs\.org/,
    );
    assert.match(
      workflow,
      /- name: Audit all dependencies \(report only\)\s+continue-on-error: true\s+run: npm audit --registry=https:\/\/registry\.npmjs\.org/,
    );
    assert.ok(
      workflow.indexOf("- name: Audit production dependencies") <
        workflow.indexOf("- name: Package VSIX"),
    );
    assert.match(
      workflow,
      /group: publish-extension\s+cancel-in-progress: false/,
    );
    assert.match(
      workflow,
      /node-version:\s*22/,
      "publish workflow should use a supported Node.js LTS release",
    );
  });

  test("Preview release metadata never enables Marketplace publishing", function () {
    this.timeout(30000);
    const root = path.resolve(__dirname, "../../..");
    const workflow = fs.readFileSync(
      path.join(root, ".github/workflows/publish-marketplace.yml"),
      "utf8",
    );
    const metadata =
      /- name: Read package version[\s\S]*?run:\s*\|([\s\S]*?)\r?\n {6}- name:/.exec(
        workflow,
      );
    assert.ok(metadata);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    for (const scenario of [
      {
        ref: `refs/tags/v${manifest.version}`,
        preview: false,
        publish: false,
        blocked: false,
      },
      {
        ref: `refs/tags/preview-v${manifest.version}`,
        preview: true,
        publish: false,
        blocked: false,
      },
      {
        ref: `refs/tags/marketplace-preview-v${manifest.version}`,
        preview: true,
        publish: false,
        blocked: false,
      },
      {
        ref: "refs/heads/preview/system-api",
        preview: true,
        publish: false,
        blocked: false,
      },
      {
        ref: "refs/heads/preview/system-api",
        preview: true,
        publish: false,
        packagePreRelease: true,
        blocked: false,
      },
      {
        ref: "refs/heads/preview/system-api",
        preview: true,
        publish: true,
        blocked: true,
      },
      {
        ref: "refs/heads/preview/system-api",
        preview: true,
        publish: true,
        packagePreRelease: true,
        blocked: true,
      },
      {
        ref: "refs/heads/master",
        preview: false,
        publish: false,
        packagePreRelease: true,
        blocked: true,
        errorPattern: /Pre-release package validation requires a preview branch/,
      },
    ]) {
      const script: string = metadata[1]
        .replace(/\$\{\{ inputs.publish \}\}/g, String(scenario.publish))
        .replace(
          /\$\{\{ inputs.package_pre_release \}\}/g,
          String(scenario.packagePreRelease ?? false),
        )
        .replace(/ >> \$env:GITHUB_OUTPUT/g, "");
      const result = spawnSync(
        "pwsh",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          cwd: root,
          env: { ...process.env, GITHUB_REF: scenario.ref },
          encoding: "utf8",
        },
      );
      assert.strictEqual(
        result.status,
        scenario.blocked ? 1 : 0,
        result.stderr,
      );
      if (scenario.blocked) {
        assert.match(
          result.stderr,
          scenario.errorPattern ?? /Preview builds cannot publish/,
        );
      } else {
        assert.ok(
          result.stdout.includes(`preview=${scenario.preview}`),
          result.stdout,
        );
        assert.ok(
          result.stdout.includes(
            `tag=${scenario.ref.startsWith("refs/tags/marketplace-preview-v") ? "marketplace-preview-v" : scenario.preview ? "preview-v" : "v"}${manifest.version}`,
          ),
          result.stdout,
        );
        assert.ok(
          result.stdout.includes(
            `marketplacePreview=${scenario.ref.startsWith("refs/tags/marketplace-preview-v")}`,
          ),
          result.stdout,
        );
        assert.ok(
          result.stdout.includes(
            `packagePreRelease=${scenario.packagePreRelease === true || scenario.ref.startsWith("refs/tags/marketplace-preview-v")}`,
          ),
          result.stdout,
        );
      }
    }
    for (const name of [
      "Verify Marketplace eligibility",
      "Ensure marketplace secret is configured",
      "Publish to VS Code Marketplace",
    ]) {
      assert.ok(
        workflow.includes(
          `- name: ${name}\n        if: steps.meta.outputs.preview != 'true'`,
        ) ||
          workflow.includes(
            `- name: ${name}\r\n        if: steps.meta.outputs.preview != 'true'`,
          ),
      );
    }
    const eligibility = /- name: Verify Marketplace eligibility\r?\n\s+if: ([^\r\n]+)/.exec(
      workflow,
    );
    const publication = /- name: Publish to VS Code Marketplace\r?\n\s+if: ([^\r\n]+)/.exec(
      workflow,
    );
    assert.ok(eligibility);
    assert.ok(publication);
    assert.match(eligibility[1], /steps\.meta\.outputs\.packagePreRelease/);
    assert.match(publication[1], /steps\.meta\.outputs\.marketplacePreview/);
    assert.doesNotMatch(publication[1], /packagePreRelease/);
    assert.ok(
      workflow.includes(
        "prerelease: ${{ steps.meta.outputs.preview == 'true' }}",
      ),
    );
  });

  test("registry gate rejects an empty lockfile rather than reporting a vacuous pass", () => {
    const root = path.resolve(__dirname, "../../..");
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lock-"));
    try {
      const fixture = path.join(fixtureRoot, "package-lock.json");
      fs.writeFileSync(
        fixture,
        JSON.stringify({ lockfileVersion: 3, packages: {} }),
      );
      const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts/verify-package-lock-registry.js"), fixture],
        { encoding: "utf8" },
      );
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /No resolved package URLs found/);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("NLS consistency gate rejects keys missing from either locale", () => {
    const root = path.resolve(__dirname, "../../..");
    const script = path.join(root, "scripts/verify-nls-consistency.js");
    const actual = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    assert.strictEqual(actual.status, 0, actual.stderr);

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-nls-"));
    const defaultPath = path.join(fixtureRoot, "package.nls.json");
    const localizedPath = path.join(fixtureRoot, "package.nls.ja.json");
    try {
      fs.writeFileSync(defaultPath, JSON.stringify({ shared: "x", en: "x" }));
      fs.writeFileSync(localizedPath, JSON.stringify({ shared: " ", ja: "x" }));
      const mismatch = spawnSync(
        process.execPath,
        [script, defaultPath, localizedPath],
        { cwd: root, encoding: "utf8" },
      );
      assert.strictEqual(mismatch.status, 1);
      assert.match(mismatch.stderr, /Missing from package\.nls\.ja\.json: en/);
      assert.match(mismatch.stderr, /Missing from package\.nls\.json: ja/);
      assert.match(
        mismatch.stderr,
        /Invalid values in package\.nls\.ja\.json: shared/,
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("VSIX verifier rejects a central directory outside the archive", () => {
    const root = path.resolve(__dirname, "../../..");
    const script = path.join(root, "scripts/verify-vsix-contents.js");
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-vsix-"));
    const fixturePath = path.join(fixtureRoot, "corrupt.vsix");
    try {
      const buffer = Buffer.alloc(22);
      buffer.writeUInt32LE(0x06054b50, 0);
      buffer.writeUInt16LE(1, 10);
      buffer.writeUInt32LE(46, 12);
      buffer.writeUInt32LE(1000, 16);
      fs.writeFileSync(fixturePath, buffer);

      const result = spawnSync(process.execPath, [script, fixturePath], {
        cwd: root,
        encoding: "utf8",
      });
      assert.strictEqual(result.status, 1);
      assert.match(
        result.stderr,
        /Invalid VSIX: central directory is outside the archive/,
      );
      assert.ok(!result.stderr.includes("RangeError"));
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("VSIX verifier handles empty ZIP structure and rejects ZIP64", () => {
    const root = path.resolve(__dirname, "../../..");
    const script = path.join(root, "scripts/verify-vsix-contents.js");
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-vsix-"));
    try {
      const emptyPath = path.join(fixtureRoot, "empty.vsix");
      const empty = Buffer.alloc(22);
      empty.writeUInt32LE(0x06054b50, 0);
      fs.writeFileSync(emptyPath, empty);
      const emptyResult = spawnSync(process.execPath, [script, emptyPath], {
        cwd: root,
        encoding: "utf8",
      });
      assert.strictEqual(emptyResult.status, 1);
      assert.match(emptyResult.stderr, /Required entries missing/);
      assert.ok(!emptyResult.stderr.includes("Invalid VSIX"));

      const zip64Path = path.join(fixtureRoot, "zip64.vsix");
      const zip64 = Buffer.from(empty);
      zip64.writeUInt16LE(0xffff, 10);
      zip64.writeUInt32LE(0xffffffff, 12);
      zip64.writeUInt32LE(0xffffffff, 16);
      fs.writeFileSync(zip64Path, zip64);
      const zip64Result = spawnSync(process.execPath, [script, zip64Path], {
        cwd: root,
        encoding: "utf8",
      });
      assert.strictEqual(zip64Result.status, 1);
      assert.match(zip64Result.stderr, /ZIP64 archives are not supported/);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("VSIX verifier rejects case-insensitive duplicate entries", () => {
    const root = path.resolve(__dirname, "../../..");
    const script = path.join(root, "scripts/verify-vsix-contents.js");
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-vsix-"));
    const fixturePath = path.join(fixtureRoot, "duplicate.vsix");
    const makeEntry = (name: string): Buffer => {
      const nameBytes = Buffer.from(name, "utf8");
      const entry = Buffer.alloc(46 + nameBytes.length);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(nameBytes.length, 28);
      nameBytes.copy(entry, 46);
      return entry;
    };

    try {
      const entries = Buffer.concat([
        makeEntry("extension/package.json"),
        makeEntry("EXTENSION/PACKAGE.JSON"),
      ]);
      const footer = Buffer.alloc(22);
      footer.writeUInt32LE(0x06054b50, 0);
      footer.writeUInt16LE(2, 10);
      footer.writeUInt32LE(entries.length, 12);
      footer.writeUInt32LE(0, 16);
      fs.writeFileSync(fixturePath, Buffer.concat([entries, footer]));

      const result = spawnSync(process.execPath, [script, fixturePath], {
        cwd: root,
        encoding: "utf8",
      });
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Duplicate entries found/);
      assert.match(result.stderr, /EXTENSION\/PACKAGE\.JSON/);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("VSIX verifier requires localized documentation and both product icons", () => {
    const root = path.resolve(__dirname, "../../..");
    const script = path.join(root, "scripts/verify-vsix-contents.js");
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-vsix-"));
    const fixturePath = path.join(fixtureRoot, "entries.vsix");
    const required = [
      "extension/package.json",
      "extension/package.nls.json",
      "extension/package.nls.ja.json",
      "extension/out/extension.js",
      "extension/media/schedulerWebview.js",
      "extension/README.md",
      "extension/README_ja.md",
      "extension/images/icon.png",
      "extension/images/scheduler-icon.svg",
      "extension/LICENSE.txt",
    ];
    try {
      for (const missing of [
        undefined,
        "extension/README_ja.md",
        "extension/images/icon.png",
        "extension/images/scheduler-icon.svg",
      ]) {
        const names = required.filter((name) => name !== missing);
        const directory = Buffer.concat(
          names.map((name) => {
            const bytes = Buffer.from(name, "utf8");
            const entry = Buffer.alloc(46 + bytes.length);
            entry.writeUInt32LE(0x02014b50, 0);
            entry.writeUInt16LE(bytes.length, 28);
            bytes.copy(entry, 46);
            return entry;
          }),
        );
        const footer = Buffer.alloc(22);
        footer.writeUInt32LE(0x06054b50, 0);
        footer.writeUInt16LE(names.length, 10);
        footer.writeUInt32LE(directory.length, 12);
        fs.writeFileSync(fixturePath, Buffer.concat([directory, footer]));
        const result = spawnSync(process.execPath, [script, fixturePath], {
          cwd: root,
          encoding: "utf8",
        });
        assert.strictEqual(result.status, missing ? 1 : 0, result.stderr);
        if (missing) assert.ok(result.stderr.includes(missing), result.stderr);
      }
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("installed VSIX smoke reads the archive version and rejects missing or invalid manifests", async () => {
    const root = path.resolve(__dirname, "../../..");
    const verifier = require(
      path.join(root, "scripts/verify-vsix-contents.js"),
    ) as {
      readVsixManifest(file: string): Promise<{ version: string }>;
      verifyVsixMarketplace(file: string, allowed?: string[]): Promise<boolean>;
    };
    const { ZipFile } = require("yazl");
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-installed-manifest-"),
    );
    const fixture = path.join(fixtureRoot, "different-version.vsix");
    const write = async (name: string, content: string) => {
      const zip = new ZipFile();
      const output = fs.createWriteStream(fixture);
      const done = new Promise<void>((resolve, reject) => {
        output.once("close", resolve);
        output.once("error", reject);
        zip.outputStream.once("error", reject);
      });
      zip.addBuffer(Buffer.from(content), name);
      zip.end();
      zip.outputStream.pipe(output);
      await done;
    };
    try {
      await write(
        "extension/package.json",
        JSON.stringify({
          publisher: "fixture",
          name: "fixture",
          version: "9.8.7",
        }),
      );
      assert.strictEqual(
        (await verifier.readVsixManifest(fixture)).version,
        "9.8.7",
      );
      assert.strictEqual(await verifier.verifyVsixMarketplace(fixture), true);
      await write(
        "extension/package.json",
        JSON.stringify({ version: "9.8.7", enableProposedApi: true }),
      );
      await assert.rejects(
        verifier.verifyVsixMarketplace(fixture),
        /Marketplace publication blocked/,
      );
      for (const proposals of [
        ["languageModelSystem"],
        "languageModelSystem",
      ]) {
        await write(
          "extension/package.json",
          JSON.stringify({ version: "9.8.7", enabledApiProposals: proposals }),
        );
        await assert.rejects(
          verifier.verifyVsixMarketplace(fixture),
          /Marketplace publication blocked/,
        );
        if (Array.isArray(proposals)) {
          assert.strictEqual(
            await verifier.verifyVsixMarketplace(fixture, [
              "languageModelSystem",
            ]),
            true,
          );
          await assert.rejects(
            verifier.verifyVsixMarketplace(fixture, ["otherApi"]),
            /Unsupported publication exception/,
          );
        }
      }
      await write(
        "extension/package.json",
        JSON.stringify({ version: "9.8.7", enabledApiProposals: [] }),
      );
      assert.strictEqual(await verifier.verifyVsixMarketplace(fixture), true);
      await write("extension/README.md", "no manifest");
      await assert.rejects(
        verifier.readVsixManifest(fixture),
        /manifest was not found/,
      );
      await write("extension/package.json", "{invalid");
      await assert.rejects(verifier.readVsixManifest(fixture), SyntaxError);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("VSIX build verification rejects stale payloads and runtime metadata", async () => {
    const root = path.resolve(__dirname, "../../..");
    const verifier = require(
      path.join(root, "scripts/verify-vsix-contents.js"),
    ) as {
      verifyVsixBuild(filePath: string, buildRoot: string): Promise<boolean>;
    };
    const { ZipFile } = require("yazl");
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-vsix-build-"),
    );
    const fixturePath = path.join(fixtureRoot, "test.vsix");
    const manifest = {
      name: "fixture",
      publisher: "fixture",
      version: "1.0.0",
      engines: { vscode: "^1.95.0" },
      main: "./out/extension.js",
      contributes: { commands: [] },
    };
    const files: Record<string, Buffer> = {
      "package.json": Buffer.from(JSON.stringify(manifest)),
      "package.nls.json": Buffer.from('{"title":"Current title"}'),
      "package.nls.ja.json": Buffer.from('{"title":"Current title"}'),
      "out/extension.js": Buffer.from("current-runtime"),
      "media/schedulerWebview.js": Buffer.from("current-webview"),
      "images/icon.png": Buffer.from("current-icon"),
      "images/scheduler-icon.svg": Buffer.from("current-sidebar-icon"),
      "README.md": Buffer.from("readme"),
      "README_ja.md": Buffer.from("readme"),
      "LICENSE.txt": Buffer.from("license"),
    };
    const writeArchive = async (
      overrides: Record<string, Buffer> = {},
      names: Record<string, string> = {},
    ) => {
      const zip = new ZipFile();
      for (const [name, content] of Object.entries({
        ...files,
        ...overrides,
      })) {
        zip.addBuffer(content, `extension/${names[name] ?? name}`);
      }
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(fixturePath);
        output.on("close", resolve).on("error", reject);
        zip.outputStream.on("error", reject).pipe(output);
        zip.end();
      });
    };
    try {
      for (const [name, content] of Object.entries(files)) {
        const target = path.join(fixtureRoot, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      await writeArchive();
      assert.strictEqual(
        await verifier.verifyVsixBuild(fixturePath, fixtureRoot),
        true,
      );
      for (const name of [
        "out/extension.js",
        "media/schedulerWebview.js",
        "package.nls.json",
        "package.nls.ja.json",
        "images/icon.png",
        "images/scheduler-icon.svg",
      ]) {
        await writeArchive({ [name]: Buffer.alloc(files[name].length, 0x78) });
        await assert.rejects(
          verifier.verifyVsixBuild(fixturePath, fixtureRoot),
          /Build content mismatch/,
        );
      }
      for (const overrides of [
        { version: "0.9.0" },
        { engines: { vscode: "^1.139.0" } },
        { contributes: { commands: [{ command: "unexpected" }] } },
        { type: "module" },
      ]) {
        await writeArchive({
          "package.json": Buffer.from(
            JSON.stringify({ ...manifest, ...overrides }),
          ),
        });
        await assert.rejects(
          verifier.verifyVsixBuild(fixturePath, fixtureRoot),
          /Manifest mismatch/,
        );
      }
      await writeArchive(
        {},
        { "media/schedulerWebview.js": "media/SchedulerWebview.js" },
      );
      await assert.rejects(
        verifier.verifyVsixBuild(fixturePath, fixtureRoot),
        /Build entry missing/,
      );
      await writeArchive({
        "package.json": Buffer.from(JSON.stringify(manifest, null, 4)),
      });
      assert.strictEqual(
        await verifier.verifyVsixBuild(fixturePath, fixtureRoot),
        true,
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("README command tables stay aligned with contributed commands", () => {
    const root = path.resolve(__dirname, "../../..");
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      contributes?: { commands?: Array<{ title?: string }> };
    };
    const nls = JSON.parse(
      fs.readFileSync(path.join(root, "package.nls.json"), "utf8"),
    ) as Record<string, string>;
    const readmes = [
      fs.readFileSync(path.join(root, "README.md"), "utf8"),
      fs.readFileSync(path.join(root, "README_ja.md"), "utf8"),
    ];

    for (const item of packageJson.contributes?.commands ?? []) {
      const titleKey = item.title?.match(/^%(.+)%$/)?.[1];
      const title = titleKey ? nls[titleKey] : item.title;
      assert.ok(title, `Command title should resolve: ${item.title}`);
      for (const readme of readmes) {
        assert.ok(
          readme.includes(`Copilot Scheduler: ${title}`),
          `README command table should mention: ${title}`,
        );
      }
    }
  });

  test("README documents natural-language Copilot Chat examples", () => {
    const root = path.resolve(__dirname, "../../..");
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const readmeJa = fs.readFileSync(path.join(root, "README_ja.md"), "utf8");

    assert.match(readme, /natural-language requests/i);
    assert.match(readme, /Schedule a workspace task/i);
    assert.match(readme, /Change the daily summary task/i);
    assert.match(readme, /Pause the release reminder task/i);
    assert.match(readme, /Show my scheduled Copilot tasks/i);
    assert.match(readme, /multiple tasks could match/i);
    assert.match(readmeJa, /自然文の依頼/);
    assert.match(readmeJa, /スケジュール設定して/);
    assert.match(readmeJa, /変更して/);
    assert.match(readmeJa, /一時停止して/);
    assert.match(readmeJa, /見せて/);
    assert.match(readmeJa, /同じ名前のタスク/);
  });

  test("user-facing text files carry no replacement characters or lone surrogates", () => {
    const root = path.resolve(__dirname, "../../..");
    // These surfaces are read outside the editor (Marketplace page, UI strings),
    // where a broken emoji is invisible to a compiler but visible to every user.
    const files = [
      "README.md",
      "README_ja.md",
      "CHANGELOG.md",
      "package.json",
      "package.nls.json",
      "package.nls.ja.json",
    ];

    for (const file of files) {
      const content = fs.readFileSync(path.join(root, file), "utf8");
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        assert.ok(
          !lines[i].includes("\uFFFD"),
          `${file}:${i + 1} contains a replacement character: ${lines[i].trim()}`,
        );
        assert.ok(
          !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
            lines[i],
          ),
          `${file}:${i + 1} contains a lone surrogate: ${lines[i].trim()}`,
        );
      }
    }
  });

  test("both READMEs document attachments with matching section markers", () => {
    const root = path.resolve(__dirname, "../../..");
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const readmeJa = fs.readFileSync(path.join(root, "README_ja.md"), "utf8");

    assert.ok(
      readme.includes("## \u{1F4CE} Attachments"),
      "README.md should keep the attachments section heading intact",
    );
    assert.ok(
      readmeJa.includes("## \u{1F4CE} 添付ファイル"),
      "README_ja.md should keep the attachments section heading intact",
    );
    for (const [file, content] of [
      ["README.md", readme],
      ["README_ja.md", readmeJa],
    ] as const) {
      assert.ok(
        content.includes(".env*") && content.includes("secrets/"),
        `${file} should document the attachment denylist`,
      );
      assert.ok(
        content.includes("blocked"),
        `${file} should document that an unresolvable attachment blocks the run`,
      );
    }
  });

  test("LM write tool descriptions keep natural-language intent", () => {
    const root = path.resolve(__dirname, "../../..");
    const nls = JSON.parse(
      fs.readFileSync(path.join(root, "package.nls.json"), "utf8"),
    ) as Record<string, string>;
    const nlsJa = JSON.parse(
      fs.readFileSync(path.join(root, "package.nls.ja.json"), "utf8"),
    ) as Record<string, string>;
    const createDescription =
      nls["tool.scheduler_create_task.modelDescription"] ?? "";
    const createDescriptionJa =
      nlsJa["tool.scheduler_create_task.modelDescription"] ?? "";
    const updateDescription =
      nls["tool.scheduler_update_task.modelDescription"] ?? "";
    const updateDescriptionJa =
      nlsJa["tool.scheduler_update_task.modelDescription"] ?? "";
    const deleteDescription =
      nls["tool.scheduler_delete_task.modelDescription"] ?? "";
    const deleteDescriptionJa =
      nlsJa["tool.scheduler_delete_task.modelDescription"] ?? "";
    const setEnabledDescription =
      nls["tool.scheduler_set_task_enabled.modelDescription"] ?? "";
    const setEnabledDescriptionJa =
      nlsJa["tool.scheduler_set_task_enabled.modelDescription"] ?? "";
    const runDescription =
      nls["tool.scheduler_run_task.modelDescription"] ?? "";
    const runDescriptionJa =
      nlsJa["tool.scheduler_run_task.modelDescription"] ?? "";

    assert.match(createDescription, /Use when the user asks/i);
    assert.match(createDescription, /schedule|set up|register|automate/i);
    assert.match(
      createDescriptionJa,
      /スケジュール設定|定期実行|タスク登録|自動化/,
    );
    assert.match(updateDescription, /Use when the user asks/i);
    assert.match(updateDescription, /change|edit|reschedule|revise/i);
    assert.match(updateDescriptionJa, /変更|編集|リスケジュール|見直し/);
    assert.match(deleteDescription, /Use when the user asks/i);
    assert.match(deleteDescription, /delete|remove|cancel/i);
    assert.match(deleteDescriptionJa, /削除|除去|キャンセル/);
    assert.match(setEnabledDescription, /Use when the user asks/i);
    assert.match(
      setEnabledDescription,
      /enable|disable|pause|resume|turn on|turn off/i,
    );
    assert.match(
      setEnabledDescriptionJa,
      /有効化|無効化|一時停止|再開|オン|オフ/,
    );
    assert.match(runDescription, /run|execute|trigger|test/i);
    assert.match(
      runDescription,
      /Recurring tasks keep their enabled state.*one-time tasks are reserved and disabled before execution/i,
    );
    assert.match(
      runDescription,
      /afterRun delete applies only after success and saved history/i,
    );
    assert.match(runDescription, /claimFailed means no prompt was sent/i);
    assert.match(runDescriptionJa, /今すぐ1回実行|起動|テスト/);
    assert.match(
      runDescriptionJa,
      /定期タスクの有効\/無効は維持.*単発タスクは実行前に確保・無効化/,
    );
    assert.match(runDescriptionJa, /afterRun の削除は成功と履歴保存後だけ/);
    assert.match(runDescriptionJa, /claimFailed は今回プロンプトを送信していない/);
    assert.match(runDescription, /not model response completion/);
    assert.match(runDescription, /saveFailed.*do not retry automatically/);
    assert.match(runDescription, /manualRunNextRunPolicy/);
    assert.match(runDescriptionJa, /モデル応答完了は意味しません/);
    assert.match(runDescriptionJa, /saveFailed.*自動再試行しない/);
  });

  test("LM tools manifest keeps prompt references and avoids proposed toolsets", () => {
    const root = path.resolve(__dirname, "../../..");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      contributes?: {
        languageModelTools?: Array<{
          name?: string;
          toolReferenceName?: string;
          canBeReferencedInPrompt?: boolean;
          tags?: string[];
        }>;
        languageModelToolSets?: unknown;
      };
    };
    const tools = manifest.contributes?.languageModelTools ?? [];
    const expectedToolNames = [
      "scheduler_query",
      "scheduler_create_task",
      "scheduler_update_task",
      "scheduler_delete_task",
      "scheduler_set_task_enabled",
      "scheduler_run_task",
    ];

    assert.deepStrictEqual(
      tools.map((tool) => tool.name),
      expectedToolNames,
      "Update the expected LM tool surface only after reviewing picker, prompt-reference, and docs impact.",
    );
    assert.strictEqual(
      manifest.contributes?.languageModelToolSets,
      undefined,
      "Do not add proposed languageModelToolSets as a picker workaround without a dedicated compatibility review.",
    );

    for (const tool of tools) {
      assert.strictEqual(
        tool.canBeReferencedInPrompt,
        true,
        `${tool.name} must remain prompt-referenceable for #scheduler_* usage.`,
      );
      assert.strictEqual(tool.toolReferenceName, tool.name);
      assert.deepStrictEqual(
        tool.tags,
        ["copilot-scheduler"],
        `${tool.name} tags should not be removed as an unverified picker workaround; update this guard only after the A/B picker evidence is reviewed.`,
      );
    }
  });

  test("LM write tool schemas expose model selection and stay closed for updates", () => {
    const root = path.resolve(__dirname, "../../..");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      contributes?: {
        languageModelTools?: Array<{
          name?: string;
          inputSchema?: {
            properties?: Record<string, Record<string, unknown>>;
          };
        }>;
      };
    };
    const tools = manifest.contributes?.languageModelTools ?? [];
    const toolByName = (name: string) =>
      tools.find((tool) => tool.name === name);

    const queryKinds = toolByName("scheduler_query")?.inputSchema?.properties
      ?.kind?.enum as string[] | undefined;
    assert.ok(queryKinds?.includes("list_models"));
    assert.ok(queryKinds?.includes("list_agents"));
    assert.ok(queryKinds?.includes("list_skills"));

    const createProperties =
      toolByName("scheduler_create_task")?.inputSchema?.properties ?? {};
    const runSchema = toolByName("scheduler_run_task")?.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    assert.strictEqual(runSchema.additionalProperties, false);
    assert.deepStrictEqual(runSchema.required, ["id"]);
    assert.deepStrictEqual(Object.keys(runSchema.properties ?? {}), ["id"]);
    const updates = toolByName("scheduler_update_task")?.inputSchema?.properties
      ?.updates as
      | { additionalProperties?: boolean; properties?: Record<string, unknown> }
      | undefined;

    for (const key of [
      "model",
      "modelReasoningEffort",
      "autoMode",
      "modelFallback",
      "jitterSeconds",
      "maxExecutionsPerDay",
      "runAt",
      "afterRun",
      "allowedTimeStart",
      "allowedTimeEnd",
    ]) {
      assert.ok(
        createProperties[key],
        `scheduler_create_task must expose '${key}' so agent mode can set it.`,
      );
      assert.ok(
        updates?.properties?.[key],
        `scheduler_update_task updates must expose '${key}'.`,
      );
    }
    for (const [toolName, schema] of [
      ["scheduler_create_task", createProperties.modelReasoningEffort],
      ["scheduler_update_task", updates?.properties?.modelReasoningEffort],
    ] as const) {
      assert.deepStrictEqual(
        (schema as { enum?: unknown } | undefined)?.enum,
        [...EXPERIMENTAL_REASONING_EFFORT_LEVELS],
        `${toolName} reasoning efforts must match the runtime levels.`,
      );
    }
    assert.ok(updates?.properties?.scope);
    assert.strictEqual(
      updates?.additionalProperties,
      false,
      "Keep 'updates' closed so unknown fields fail fast instead of being ignored.",
    );
    assert.strictEqual(
      createProperties.modelName,
      undefined,
      "Derived model metadata must stay out of the schema; it is filled in by model resolution.",
    );
  });

  test("LM tools receive the same filtered model catalog as the picker", () => {
    const root = path.resolve(__dirname, "../../..");
    const source = fs.readFileSync(
      path.join(root, "src", "extension.ts"),
      "utf8",
    );
    const contract =
      "Contract: list_models and model resolution must share one loader that applies filterPickerModelCatalog, so Chat only offers models the Webview picker also shows. Only the execution-time resolver in copilotExecutor may use the raw catalog.";

    const loaderIndex = source.indexOf("const loadPickerModelCatalog");
    assert.notStrictEqual(
      loaderIndex,
      -1,
      `loadPickerModelCatalog not found. ${contract}`,
    );
    const callIndex = source.indexOf("registerLmTools(", loaderIndex);
    assert.notStrictEqual(
      callIndex,
      -1,
      `registerLmTools call not found after the loader. ${contract}`,
    );

    const loaderBlock = source.slice(loaderIndex, callIndex);
    const call = source.slice(callIndex, source.indexOf("});", callIndex));

    assert.match(
      loaderBlock,
      /filterPickerModelCatalog/,
      `The loader no longer filters the catalog. ${contract}`,
    );
    assert.match(
      call,
      /listModels:\s*loadPickerModelCatalog/,
      `list_models no longer uses the shared loader. ${contract}`,
    );
    assert.match(
      call,
      /createModelSelectionResolver\(loadPickerModelCatalog\)/,
      `Model resolution no longer uses the shared loader. ${contract}`,
    );
    assert.strictEqual(
      /getAvailableModelsWithSource/.test(call),
      false,
      `The raw catalog is being handed to the LM tools. ${contract}`,
    );
  });

  test("VSIX package ignore keeps local research and repro artifacts out", () => {
    const root = path.resolve(__dirname, "../../..");
    const ignoreLines = fs
      .readFileSync(path.join(root, ".vscodeignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    for (const pattern of [
      "*.vsix",
      "research/**",
      "artifacts/**",
      "output_sessions/**",
      "session/**",
      ".github/**",
      "scripts/**",
    ]) {
      assert.ok(
        ignoreLines.includes(pattern),
        `.vscodeignore must exclude ${pattern} from published VSIX packages.`,
      );
    }
  });
});

suite("Execution History Queue Tests", () => {
  test("missed-run policy remains configured without a global concurrency cap", () => {
    const root = path.resolve(__dirname, "../../..");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    const settings = manifest.contributes.configuration.properties;
    assert.strictEqual(
      settings["copilotScheduler.missedRunPolicy"].default,
      "runOnce",
    );
    assert.deepStrictEqual(settings["copilotScheduler.missedRunPolicy"].enum, [
      "runOnce",
      "skip",
    ]);
    assert.ok(
      !Object.hasOwn(settings, "copilotScheduler.maxConcurrentAutomaticRuns"),
    );
    for (const filename of ["package.nls.json", "package.nls.ja.json"]) {
      const strings = JSON.parse(
        fs.readFileSync(path.join(root, filename), "utf8"),
      );
      assert.ok(
        !Object.hasOwn(strings, "config.maxConcurrentAutomaticRuns"),
        filename,
      );
    }
  });

  test("execution summaries describe success as prompt dispatch", async () => {
    const { __testOnly } = await import("../../extension");
    const buildSummary = __testOnly.buildExecutionSummary;
    const nextRun = new Date("2026-09-05T09:00:00.000Z");

    const dispatched = buildSummary("Audit task", "success", nextRun);
    assert.ok(dispatched.includes(messages.executionResultDispatched()));

    const queued = buildSummary("Audit task", "success", nextRun, "queued");
    assert.ok(queued.includes(messages.executionResultQueued()));

    const completed = buildSummary("Audit task", "success", nextRun, "completed");
    assert.ok(completed.includes(messages.executionResultTurnCompleted()));

    const failed = buildSummary("Audit task", "failed", nextRun);
    assert.ok(failed.includes(messages.executionResultFailed()));
  });

  test("history quick picks expose execution context and prompt audit metadata", async () => {
    const { __testOnly } = await import("../../extension");
    const buildItems = __testOnly.buildExecutionHistoryQuickPickItems as (
      entries: ExecutionHistoryEntry[],
    ) => Array<{ description: string; detail: string }>;

    const [item] = buildItems([
      {
        taskId: "task-audit",
        taskName: "Audit task",
        trigger: "auto",
        status: "success",
        executedAt: "2026-07-30T09:00:00.000Z",
        dueAt: "2026-07-30T08:30:00.000Z",
        attachmentCount: 2,
        promptSource: "snapshotFallback",
        promptPathDisplay: "daily.prompt.md",
        promptHash: "ABC123DEF456",
        promptResolvedAt: "2026-07-30T08:59:59.000Z",
        promptFallbackReason: "readFailed",
      },
    ]);

    assert.ok(item.detail.includes(messages.executionPromptSourceSnapshot()));
    assert.ok(item.description.includes(messages.executionResultDispatched()));
    assert.ok(item.detail.includes(messages.executionHistoryDueAt()));
    assert.ok(item.detail.includes(messages.executionHistoryDelay(30 * 60)));
    assert.ok(item.detail.includes(messages.executionHistoryAttachments(2)));
    assert.ok(item.detail.includes("daily.prompt.md"));
    assert.ok(item.detail.includes("abc123def456"));
    assert.ok(item.detail.includes(messages.promptBlockedReasonReadFailed()));
    assert.ok(
      item.detail.includes(messages.executionHistoryPromptResolvedAt()),
    );
  });

  test("history quick picks preserve legacy detail and tolerate malformed dates", async () => {
    const { __testOnly } = await import("../../extension");
    const buildItems = __testOnly.buildExecutionHistoryQuickPickItems as (
      entries: ExecutionHistoryEntry[],
    ) => Array<{ description: string; detail: string }>;

    const [legacy, malformed] = buildItems([
      {
        taskId: "legacy",
        taskName: "Legacy",
        trigger: "auto",
        status: "failed",
        executedAt: "2026-07-30T09:00:00.000Z",
        detail: "existing detail",
      },
      {
        taskId: "malformed",
        taskName: "Malformed",
        trigger: "auto",
        status: "success",
        executedAt: "not-a-date",
        nextRunAt: "also-not-a-date",
        promptSource: "not-valid",
        promptHash: "x",
        promptResolvedAt: "still-not-a-date",
        promptFallbackReason: "unknown-reason",
      } as unknown as ExecutionHistoryEntry,
    ]);

    assert.strictEqual(legacy.detail, "existing detail");
    assert.ok(malformed.description.includes(messages.webviewUnknown()));
    assert.ok(malformed.detail.includes(messages.webviewUnknown()));
    assert.ok(!malformed.detail.includes("not-valid"));
    assert.ok(!malformed.detail.includes("unknown-reason"));
    assert.ok(!malformed.detail.includes("Hash"));
  });

  test("history quick picks distinguish Agent Host completion and uncertain outcomes", async () => {
    const { __testOnly } = await import("../../extension");
    const [queued, completed, unknown] = __testOnly.buildExecutionHistoryQuickPickItems([
      {
        taskId: "queued",
        taskName: "Queued",
        trigger: "manual",
        status: "success",
        executedAt: "2026-07-30T09:00:00.000Z",
        turnOutcome: "queued",
      },
      {
        taskId: "completed",
        taskName: "Completed",
        trigger: "manual",
        status: "success",
        executedAt: "2026-07-30T09:00:00.000Z",
        turnOutcome: "completed",
        responseText: "not_observed",
      },
      {
        taskId: "unknown",
        taskName: "Unknown",
        trigger: "auto",
        status: "failed",
        executedAt: "2026-07-30T09:00:00.000Z",
        turnOutcome: "unknown",
      },
    ]);
    assert.ok(queued.description.includes(messages.executionResultQueued()));
    assert.ok(!queued.description.includes(messages.executionResultDispatched()));
    assert.ok(queued.detail.includes(messages.executionHistoryTurnQueued()));
    assert.ok(completed.description.includes(messages.executionResultTurnCompleted()));
    assert.ok(completed.detail.includes(messages.executionHistoryResponseTextNotObserved()));
    assert.ok(unknown.detail.includes(messages.executionHistoryTurnUnknown()));
  });

  test("enqueueExecutionHistory rejects the failed write and recovers the queue", async () => {
    const { __testOnly } = await import("../../extension");
    const enqueueExecutionHistory =
      __testOnly.enqueueExecutionHistory as (entry: {
        taskId: string;
        taskName: string;
        trigger: "manual" | "auto";
        status: "success" | "failed";
        executedAt: string;
        nextRunAt?: string;
        detail?: string;
      }) => Promise<void>;
    const getExecutionHistoryEntries =
      __testOnly.getExecutionHistoryEntries as () => Array<{
        taskId: string;
        taskName: string;
      }>;
    const setExtensionContextForTests =
      __testOnly.setExtensionContextForTests as (
        context:
          | {
              globalState: {
                get<T>(key: string, defaultValue?: T): T;
                update(key: string, value: unknown): Thenable<void>;
              };
            }
          | undefined,
      ) => void;
    const resetExecutionHistoryQueueForTests =
      __testOnly.resetExecutionHistoryQueueForTests as () => void;

    const storedEntries: unknown[] = [];
    let updateCalls = 0;

    try {
      setExtensionContextForTests({
        globalState: {
          get<T>(_key: string, defaultValue?: T): T {
            return ((storedEntries as unknown) || defaultValue) as T;
          },
          update(_key: string, value: unknown): Thenable<void> {
            updateCalls += 1;
            if (updateCalls === 1) {
              return Promise.reject(new Error("history write failed"));
            }
            storedEntries.splice(
              0,
              storedEntries.length,
              ...((value as unknown[]) || []),
            );
            return Promise.resolve();
          },
        },
      });
      resetExecutionHistoryQueueForTests();

      await assert.rejects(
        () =>
          enqueueExecutionHistory({
            taskId: "task-1",
            taskName: "Task 1",
            trigger: "manual",
            status: "success",
            executedAt: "2026-04-10T00:00:00.000Z",
          }),
        /history write failed/,
      );

      await enqueueExecutionHistory({
        taskId: "task-2",
        taskName: "Task 2",
        trigger: "manual",
        status: "failed",
        executedAt: "2026-04-10T00:01:00.000Z",
        detail: "second call should still persist",
      });

      const entries = getExecutionHistoryEntries();
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]?.taskId, "task-2");
      assert.strictEqual(updateCalls, 2);
    } finally {
      setExtensionContextForTests(undefined);
      resetExecutionHistoryQueueForTests();
    }
  });

  test("getExecutionHistoryEntries ignores persisted entries with invalid trigger or status", async () => {
    const { __testOnly } = await import("../../extension");
    const getExecutionHistoryEntries =
      __testOnly.getExecutionHistoryEntries as () => Array<{
        taskId: string;
        taskName: string;
        trigger: "manual" | "auto";
        status: "success" | "failed";
      }>;
    const setExtensionContextForTests =
      __testOnly.setExtensionContextForTests as (
        context:
          | {
              globalState: {
                get<T>(key: string, defaultValue?: T): T;
                update(key: string, value: unknown): Thenable<void>;
              };
            }
          | undefined,
      ) => void;

    try {
      setExtensionContextForTests({
        globalState: {
          get<T>(_key: string, defaultValue?: T): T {
            void defaultValue;
            return [
              {
                taskId: "task-valid",
                taskName: "Valid",
                trigger: "manual",
                status: "success",
                executedAt: "2026-04-10T00:00:00.000Z",
              },
              {
                taskId: "task-invalid-trigger",
                taskName: "Invalid Trigger",
                trigger: "scheduled",
                status: "success",
                executedAt: "2026-04-10T00:01:00.000Z",
              },
              {
                taskId: "task-invalid-status",
                taskName: "Invalid Status",
                trigger: "auto",
                status: "done",
                executedAt: "2026-04-10T00:02:00.000Z",
              },
            ] as unknown as T;
          },
          update(): Thenable<void> {
            return Promise.resolve();
          },
        },
      });

      const entries = getExecutionHistoryEntries();
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]?.taskId, "task-valid");
      assert.strictEqual(entries[0]?.trigger, "manual");
      assert.strictEqual(entries[0]?.status, "success");
    } finally {
      setExtensionContextForTests(undefined);
    }
  });
});

suite("Per-occurrence execution isolation", () => {
  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function task(
    id: string,
    dueAt = "2026-11-19T00:00:00.000Z",
  ): ScheduledTask {
    return {
      id,
      name: "Isolation test",
      cronExpression: "0 * * * *",
      prompt: "saved snapshot",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      allowOverlappingRuns: true,
      lastFiredDueAt: new Date(dueAt),
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
      updatedAt: new Date("2026-11-01T00:00:00.000Z"),
    };
  }

  test("concurrent automatic runs retain their own results, prompts and guarded snapshots", async () => {
    const { __testOnly } = await import("../../extension");
    const { computePromptHash } = await import("../../promptResolver");
    const older = {
      ...task("occurrence-results"),
      promptSource: "local" as const,
      promptPath: ".github\\prompts\\test.md",
    };
    const newer = {
      ...older,
      lastFiredDueAt: new Date("2026-11-19T01:00:00.000Z"),
    };
    let currentTask = { ...newer };
    const started = [deferred<void>(), deferred<void>()];
    const results = [
      deferred<ExecutePromptResult>(),
      deferred<ExecutePromptResult>(),
    ];
    const history: ExecutionHistoryEntry[] = [];
    const notifications: string[] = [];
    const options: ExecuteOptions[] = [];
    const updates: Array<{
      id: string;
      prompt: string;
      expectedSnapshot?: string;
    }> = [];
    const deps = {
      resolvePromptSnapshot: async (selected: ScheduledTask) => {
        const index =
          selected.lastFiredDueAt?.getTime() === newer.lastFiredDueAt.getTime()
            ? 1
            : 0;
        const text = index ? "new file content" : "old file content";
        return {
          text,
          source: "file" as const,
          resolvedPath: "C:\\private\\prompts\\test.md",
          hash: computePromptHash(text),
          resolvedAt: index
            ? "2026-11-19T01:00:01.000Z"
            : "2026-11-19T00:00:01.000Z",
          candidateCount: 1,
        };
      },
      executePrompt: async (
        prompt: string,
        executionOptions: ExecuteOptions,
      ) => {
        const index = prompt === "new file content" ? 1 : 0;
        options[index] = executionOptions;
        started[index].resolve();
        return results[index].promise;
      },
      updateTaskPrompts: async (
        changes: Array<{ id: string; prompt: string; expectedSnapshot?: string }>,
      ) => {
        const change = changes[0];
        updates.push(change);
        if (JSON.stringify(currentTask) !== change.expectedSnapshot) return 0;
        currentTask = {
          ...currentTask,
          prompt: change.prompt,
          updatedAt: new Date("2026-11-19T01:00:02.000Z"),
        };
        return 1;
      },
      recordHistory: async (entry: ExecutionHistoryEntry) => {
        history.push(entry);
      },
      notifyInfo: (message: string) => notifications.push(message),
    };
    const olderRun = __testOnly.executeTask(older, "auto", undefined, deps);
    const newerRun = __testOnly.executeTask(newer, "auto", undefined, deps);
    try {
      await Promise.all(started.map((item) => item.promise));
      results[1].resolve({
        agentHostRun: {
          requestedModel: "new-model",
          appliedModel: "new-model",
          turnOutcome: "completed",
          responseText: "observed",
          workspaceMode: "worktree",
          workspaceModeApplication: "new_session_config_confirmed",
        },
        modelExecution: {
          route: "agentHost",
          requestedModel: "new-model",
          reportedModel: "new-model",
          verification: "reported_match",
        },
      });
      await newerRun;
      assert.strictEqual(currentTask.prompt, "new file content");
      currentTask = {
        ...currentTask,
        prompt: "user edit",
        updatedAt: new Date("2026-11-19T01:00:03.000Z"),
      };
      results[0].resolve({
        modelFallback: { from: "old-model", to: "old-fallback" },
        agentHostRun: {
          requestedModel: "old-fallback",
          turnOutcome: "queued",
        },
        modelExecution: {
          route: "agentHost",
          requestedModel: "old-fallback",
          verification: "unverified",
        },
      });
      await olderRun;

      assert.strictEqual(currentTask.prompt, "user edit");
      assert.deepStrictEqual(updates.map((item) => item.expectedSnapshot), [
        JSON.stringify(newer),
        JSON.stringify(older),
      ]);
      assert.deepStrictEqual(updates.map((item) => item.prompt), [
        "new file content",
        "old file content",
      ]);
      assert.strictEqual(
        options[0].queueOccurrenceId,
        older.lastFiredDueAt?.toISOString(),
      );
      assert.strictEqual(
        options[1].queueOccurrenceId,
        newer.lastFiredDueAt.toISOString(),
      );
      const completed = history.find(
        (entry) => entry.dueAt === newer.lastFiredDueAt.toISOString(),
      );
      const queued = history.find(
        (entry) => entry.dueAt === older.lastFiredDueAt?.toISOString(),
      );
      if (!completed || !queued) throw new Error("Missing occurrence history");
      assert.strictEqual(
        completed.promptHash,
        computePromptHash("new file content"),
      );
      assert.strictEqual(completed.promptResolvedAt, "2026-11-19T01:00:01.000Z");
      assert.strictEqual(completed.turnOutcome, "completed");
      assert.strictEqual(completed.responseText, "observed");
      assert.strictEqual(completed.workspaceMode, "worktree");
      assert.strictEqual(completed.modelExecution?.requestedModel, "new-model");
      assert.strictEqual(queued.promptHash, computePromptHash("old file content"));
      assert.strictEqual(queued.promptResolvedAt, "2026-11-19T00:00:01.000Z");
      assert.strictEqual(queued.turnOutcome, "queued");
      assert.strictEqual(queued.modelExecution?.requestedModel, "old-fallback");
      assert.ok(queued.detail?.includes("old-fallback"));
      assert.ok(!completed.detail?.includes("old-fallback"));
      assert.ok(!queued.promptPathDisplay?.includes("private"));
      assert.ok(!completed.promptPathDisplay?.includes("private"));
      assert.ok(
        notifications.some((message) =>
          message.includes(messages.executionResultQueued()),
        ),
      );
      assert.ok(
        notifications.some((message) =>
          message.includes(messages.executionResultTurnCompleted()),
        ),
      );
    } finally {
      results[0].resolve({});
      results[1].resolve({});
      await Promise.allSettled([olderRun, newerRun]);
    }
  });

  test("automatic runs cannot erase or consume an overlapping manual run's metadata", async () => {
    const { __testOnly } = await import("../../extension");
    const { computePromptHash } = await import("../../promptResolver");
    const { createPromptBlockedError } = await import(
      "../../promptExecutionErrors"
    );
    const manualTask = {
      ...task("manual-auto-isolation"),
      prompt: "manual prompt",
    };
    const manualStarted = deferred<void>();
    const manualResult = deferred<ExecutePromptResult>();
    const historyStarted = deferred<void>();
    const releaseHistory = deferred<void>();
    const automaticHistory: ExecutionHistoryEntry[] = [];
    const manualHistory: ExecutionHistoryEntry[] = [];
    const seenOptions: Array<{ prompt: string; options: ExecuteOptions }> = [];
    const deps = {
      resolvePromptSnapshot: async (selected: ScheduledTask) => ({
        text: selected.prompt,
        source: "inline" as const,
        hash: computePromptHash(selected.prompt),
        resolvedAt: "2026-11-19T02:00:00.000Z",
        candidateCount: 0,
      }),
      executePrompt: async (prompt: string, options: ExecuteOptions) => {
        seenOptions.push({ prompt, options });
        if (prompt === "manual prompt") {
          manualStarted.resolve();
          return manualResult.promise;
        }
        if (prompt === "blocked auto") {
          throw createPromptBlockedError(
            "blocked",
            "modelConfigurationUnavailable",
          );
        }
        if (prompt === "manual cli" || prompt === "auto cli") {
          return {
            cliRun: { requestedModel: prompt, appliedModel: prompt },
            modelExecution: {
              route: "copilotCli" as const,
              requestedModel: prompt,
              verification: "unverified" as const,
            },
          };
        }
        return {
          agentHostRun: {
            requestedModel: "auto-model",
            turnOutcome: "queued" as const,
          },
          modelExecution: {
            route: "agentHost" as const,
            requestedModel: "auto-model",
            verification: "unverified" as const,
          },
        };
      },
      recordHistory: async (entry: ExecutionHistoryEntry) => {
        automaticHistory.push(entry);
      },
      notifyInfo: () => {},
    };
    const manual = __testOnly.runTaskManually(manualTask, {
      run: async () => {
        await __testOnly.executeTask(manualTask, "manual", undefined, deps);
        return { ok: true as const };
      },
      recordHistory: async (historyTask, result) => {
        historyStarted.resolve();
        await releaseHistory.promise;
        await __testOnly.appendManualRunHistory(historyTask, result, {
          getTask: () => historyTask,
          recordHistory: async (entry) => {
            manualHistory.push(entry);
          },
          notifyInfo: () => {},
        });
      },
      refresh: () => assert.fail("successful manual run should not refresh"),
    });
    try {
      await manualStarted.promise;
      await assert.rejects(
        __testOnly.executeTask(
          { ...manualTask, prompt: "blocked auto" },
          "auto",
          undefined,
          deps,
        ),
      );
      manualResult.resolve({
        modelFallback: { from: "manual-requested", to: "manual-model" },
        agentHostRun: {
          requestedModel: "manual-model",
          turnOutcome: "completed",
          responseText: "observed",
        },
        modelExecution: {
          route: "agentHost",
          requestedModel: "manual-model",
          verification: "unverified",
        },
      });
      await historyStarted.promise;
      await __testOnly.executeTask(
        {
          ...manualTask,
          prompt: "queued auto",
          lastFiredDueAt: new Date("2026-11-19T01:00:00.000Z"),
        },
        "auto",
        undefined,
        deps,
      );
      releaseHistory.resolve();
      assert.deepStrictEqual(await manual, {
        ok: true,
        turnOutcome: "completed",
        responseText: "observed",
      });
      assert.strictEqual(manualHistory.length, 1);
      assert.strictEqual(
        manualHistory[0].promptHash,
        computePromptHash("manual prompt"),
      );
      assert.strictEqual(manualHistory[0].turnOutcome, "completed");
      assert.strictEqual(
        manualHistory[0].modelExecution?.requestedModel,
        "manual-model",
      );
      assert.ok(manualHistory[0].detail?.includes("manual-requested"));
      assert.ok(!manualHistory[0].detail?.includes("auto-model"));
      assert.deepStrictEqual(
        automaticHistory.map((entry) => entry.status),
        ["blocked", "success"],
      );
      assert.deepStrictEqual(
        automaticHistory.map((entry) => entry.promptHash),
        [computePromptHash("blocked auto"), computePromptHash("queued auto")],
      );
      assert.strictEqual(automaticHistory[0].modelExecution, undefined);
      assert.strictEqual(automaticHistory[1].turnOutcome, "queued");
      assert.strictEqual(
        automaticHistory[1].modelExecution?.requestedModel,
        "auto-model",
      );
      assert.ok(!Object.hasOwn(seenOptions[0].options, "queueOccurrenceId"));

      const cliTask = {
        ...manualTask,
        id: "manual-cli-isolation",
        prompt: "manual cli",
      };
      await __testOnly.executeTask(cliTask, "manual", undefined, deps);
      await __testOnly.executeTask(
        { ...cliTask, prompt: "auto cli" },
        "auto",
        undefined,
        deps,
      );
      await __testOnly.appendManualRunHistory(cliTask, { ok: true }, {
        getTask: () => cliTask,
        recordHistory: async (entry) => {
          manualHistory.push(entry);
        },
        notifyInfo: () => {},
      });
      assert.ok(manualHistory[1].detail?.includes("manual cli"));
      assert.ok(!manualHistory[1].detail?.includes("auto cli"));
      assert.ok(automaticHistory[2].detail?.includes("auto cli"));
      assert.strictEqual(manualHistory[1].modelExecution?.route, "copilotCli");
    } finally {
      manualResult.resolve({});
      releaseHistory.resolve();
      await Promise.allSettled([manual]);
    }
  });

  test("failed, unknown and blocked runs retain only their own prompt metadata", async () => {
    const { __testOnly } = await import("../../extension");
    const { computePromptHash } = await import("../../promptResolver");
    const { createPromptBlockedError } = await import(
      "../../promptExecutionErrors"
    );
    const history: ExecutionHistoryEntry[] = [];
    const deps = {
      resolvePromptSnapshot: async (selected: ScheduledTask) => ({
        text: selected.prompt,
        source: "snapshotFallback" as const,
        resolvedPath: "C:\\private\\prompts\\missing.md",
        hash: computePromptHash(selected.prompt),
        resolvedAt: "2026-11-19T02:00:00.000Z",
        fallbackReason: "readFailed" as const,
        candidateCount: 1,
      }),
      executePrompt: async (prompt: string): Promise<ExecutePromptResult> => {
        if (prompt === "unknown") {
          throw createPromptBlockedError(
            "unknown",
            "agentHostFailed",
            "unknown",
          );
        }
        if (prompt === "blocked") {
          throw createPromptBlockedError(
            "blocked",
            "modelConfigurationUnavailable",
          );
        }
        throw new Error("failed at C:\\private\\prompts\\missing.md");
      },
      recordHistory: async (entry: ExecutionHistoryEntry) => {
        history.push(entry);
      },
      notifyInfo: () => {},
    };
    for (const prompt of ["unknown", "blocked", "failed"]) {
      await assert.rejects(
        __testOnly.executeTask(
          { ...task("failed-isolation"), prompt },
          "auto",
          undefined,
          deps,
        ),
      );
    }
    assert.deepStrictEqual(history.map((entry) => entry.status), [
      "failed",
      "blocked",
      "failed",
    ]);
    assert.strictEqual(history[0].turnOutcome, "unknown");
    for (const [index, prompt] of ["unknown", "blocked", "failed"].entries()) {
      assert.strictEqual(history[index].promptHash, computePromptHash(prompt));
      assert.strictEqual(history[index].promptSource, "snapshotFallback");
      assert.strictEqual(history[index].promptFallbackReason, "readFailed");
      assert.ok(!history[index].promptPathDisplay?.includes("private"));
      assert.ok(!history[index].detail?.includes("private"));
    }

    const descriptor = Object.getOwnPropertyDescriptor(
      vscode.workspace,
      "getConfiguration",
    );
    const originalGetConfiguration = vscode.workspace.getConfiguration;
    let dispatches = 0;
    try {
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: (...args: Parameters<typeof vscode.workspace.getConfiguration>) => {
          const config = originalGetConfiguration.apply(vscode.workspace, args);
          return {
            ...config,
            get<T>(name: string, fallback?: T): T {
              return name === "promptFileFallback"
                ? ("blockAlways" as T)
                : config.get<T>(name, fallback as T);
            },
          } as vscode.WorkspaceConfiguration;
        },
      });
      await assert.rejects(
        __testOnly.executeTask(
          {
            ...task("blocked-before-dispatch"),
            prompt: "pre-dispatch",
            promptSource: "local",
            promptPath: ".github\\prompts\\missing.md",
          },
          "auto",
          undefined,
          {
            ...deps,
            executePrompt: async () => {
              dispatches++;
              return {};
            },
          },
        ),
      );
      assert.strictEqual(dispatches, 0);
      assert.strictEqual(history.at(-1)?.status, "blocked");
      assert.strictEqual(
        history.at(-1)?.promptHash,
        computePromptHash("pre-dispatch"),
      );
      assert.strictEqual(history.at(-1)?.promptFallbackReason, "readFailed");
    } finally {
      if (descriptor) {
        Object.defineProperty(vscode.workspace, "getConfiguration", descriptor);
      } else {
        Reflect.deleteProperty(vscode.workspace, "getConfiguration");
      }
    }
  });

  test("occurrence IDs are opt-in and one-time cleanup still depends on history", async () => {
    const { __testOnly } = await import("../../extension");
    const { computePromptHash } = await import("../../promptResolver");
    const options: ExecuteOptions[] = [];
    const history: ExecutionHistoryEntry[] = [];
    let failHistory = false;
    const deps = {
      resolvePromptSnapshot: async (selected: ScheduledTask) => ({
        text: selected.prompt,
        source: "inline" as const,
        hash: computePromptHash(selected.prompt),
        resolvedAt: "2026-11-19T02:00:00.000Z",
        candidateCount: 0,
      }),
      executePrompt: async (
        _prompt: string,
        executionOptions: ExecuteOptions,
      ) => {
        options.push(executionOptions);
        return {};
      },
      recordHistory: async (entry: ExecutionHistoryEntry) => {
        history.push(entry);
      },
      enqueueHistory: async (entry: ExecutionHistoryEntry) => {
        history.push(entry);
        if (failHistory) throw new Error("history failed");
      },
      notifyInfo: () => {},
    };
    const base = task("occurrence-option");
    await __testOnly.executeTask(
      { ...base, allowOverlappingRuns: undefined },
      "auto",
      undefined,
      deps,
    );
    await __testOnly.executeTask(
      { ...base, allowOverlappingRuns: false },
      "auto",
      undefined,
      deps,
    );
    await __testOnly.executeTask(
      { ...base, lastFiredDueAt: new Date(NaN) },
      "auto",
      undefined,
      deps,
    );
    const oneTime = {
      ...base,
      runAt: "2026-11-19T00:00:00.000Z",
      afterRun: "delete" as const,
    };
    assert.strictEqual(
      await __testOnly.executeTask(oneTime, "auto", undefined, deps),
      undefined,
    );
    failHistory = true;
    assert.deepStrictEqual(
      await __testOnly.executeTask(oneTime, "auto", undefined, deps),
      { retainOneTimeTask: true },
    );
    for (const item of options) {
      assert.ok(!Object.hasOwn(item, "queueOccurrenceId"));
    }
    assert.strictEqual(history.at(-1)?.runAt, oneTime.runAt);
    assert.strictEqual(history.at(-1)?.status, "success");
  });
});

suite("Agent Host input notifications", () => {
  test("deduplicates observers, opens the session, and clears only after both stop", async () => {
    const { __testOnly } = await import("../../extension");
    const properties: Array<[object, string]> = [
      [vscode.workspace, "getConfiguration"],
      [vscode.window, "createStatusBarItem"],
      [vscode.window, "showWarningMessage"],
      [vscode.commands, "executeCommand"],
    ];
    const descriptors = properties.map(([owner, key]) => [
      owner, key, Object.getOwnPropertyDescriptor(owner, key)!,
    ] as const);
    const item = {
      text: "",
      tooltip: "",
      command: undefined as vscode.Command | undefined,
      show: () => { shown++; },
      dispose: () => { disposed++; },
    };
    let shown = 0;
    let disposed = 0;
    let warnings = 0;
    const commands: Array<{ command: string; args: unknown[] }> = [];
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      configurable: true,
      value: () => ({ get: (_key: string, defaultValue: unknown) => defaultValue }),
    });
    Object.defineProperty(vscode.window, "createStatusBarItem", {
      configurable: true, value: () => item,
    });
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: async (_message: string, action: string) => { warnings++; return action; },
    });
    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: async (command: string, ...args: unknown[]) => { commands.push({ command, args }); },
    });
    const first = __testOnly.createAgentHostInputHandler();
    const second = __testOnly.createAgentHostInputHandler();
    const ref = { sessionUri: "ahp-session:/session", chatUri: "ahp-chat:/chat" };
    const waiting = { id: "request", kind: "toolConfirmation", waiting: true } as const;
    try {
      first(ref, waiting);
      second(ref, waiting);
      first(ref, waiting);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(shown, 1);
      assert.strictEqual(warnings, 1);
      assert.strictEqual(item.command?.command, "workbench.action.chat.openSessionInEditorGroup");
      assert.strictEqual(commands.length, 1);
      assert.strictEqual(commands[0].command, item.command?.command);
      assert.strictEqual(
        (commands[0].args[0] as { resource: vscode.Uri }).resource.toString(),
        "agent-host-copilotcli:/session",
      );
      first(ref, { ...waiting, waiting: false });
      assert.strictEqual(disposed, 0);
      second(ref, { ...waiting, waiting: false });
      assert.strictEqual(disposed, 1);
    } finally {
      first(ref, { ...waiting, waiting: false });
      second(ref, { ...waiting, waiting: false });
      for (const [owner, key, descriptor] of descriptors) {
        Object.defineProperty(owner, key, descriptor);
      }
    }
  });

  test("respects quiet notification settings while keeping an actionable status", async () => {
    const { __testOnly } = await import("../../extension");
    const properties: Array<[object, string]> = [
      [vscode.workspace, "getConfiguration"],
      [vscode.window, "createStatusBarItem"],
      [vscode.window, "showWarningMessage"],
      [vscode.window, "withProgress"],
    ];
    const descriptors = properties.map(([owner, key]) => [
      owner, key, Object.getOwnPropertyDescriptor(owner, key)!,
    ] as const);
    let enabled = true;
    let mode = "silentToast";
    let statusCount = 0;
    let toastCount = 0;
    let warningCount = 0;
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      configurable: true,
      value: () => ({
        get: (key: string, defaultValue: unknown) =>
          key === "showNotifications" ? enabled :
          key === "notificationMode" ? mode : defaultValue,
      }),
    });
    Object.defineProperty(vscode.window, "createStatusBarItem", {
      configurable: true,
      value: () => ({ show: () => { statusCount++; }, dispose: () => undefined }),
    });
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true, value: async () => { warningCount++; },
    });
    Object.defineProperty(vscode.window, "withProgress", {
      configurable: true, value: async () => { toastCount++; },
    });
    const handler = __testOnly.createAgentHostInputHandler();
    const ref = { sessionUri: "ahp-session:/quiet", chatUri: "ahp-chat:/quiet" };
    const waiting = { id: "request", kind: "chatInput", waiting: true } as const;
    try {
      handler(ref, waiting);
      handler(ref, { ...waiting, waiting: false });
      enabled = false;
      mode = "sound";
      handler(ref, waiting);
      handler(ref, { ...waiting, waiting: false });
      assert.strictEqual(statusCount, 2);
      assert.strictEqual(toastCount, 1);
      assert.strictEqual(warningCount, 0);
    } finally {
      handler(ref, { ...waiting, waiting: false });
      for (const [owner, key, descriptor] of descriptors) {
        Object.defineProperty(owner, key, descriptor);
      }
    }
  });

  test("shows a queued-task warning with the chat action and removes it when cleared", async () => {
    const { __testOnly } = await import("../../extension");
    const properties: Array<[object, string]> = [
      [vscode.workspace, "getConfiguration"],
      [vscode.window, "createStatusBarItem"],
      [vscode.window, "showWarningMessage"],
    ];
    const descriptors = properties.map(([owner, key]) => [
      owner, key, Object.getOwnPropertyDescriptor(owner, key)!,
    ] as const);
    let disposed = 0;
    let warning = "";
    const item = {
      text: "",
      tooltip: "",
      command: undefined as vscode.Command | undefined,
      show: () => undefined,
      dispose: () => { disposed++; },
    };
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      configurable: true,
      value: () => ({ get: (_key: string, defaultValue: unknown) => defaultValue }),
    });
    Object.defineProperty(vscode.window, "createStatusBarItem", {
      configurable: true, value: () => item,
    });
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true, value: async (message: string) => { warning = message; },
    });
    const handler = __testOnly.createAgentHostQueueBlockedHandler();
    const ref = { sessionUri: "ahp-session:/queue", chatUri: "ahp-chat:/queue" };
    try {
      handler(ref, { id: "message", waiting: true });
      assert.strictEqual(item.command?.command, "workbench.action.chat.openSessionInEditorGroup");
      assert.strictEqual(item.text, `$(comment-discussion) ${messages.agentHostQueueBlockedStatus()}`);
      assert.strictEqual(warning, messages.agentHostQueueBlocked());
      handler(ref, { id: "message", waiting: false });
      assert.strictEqual(disposed, 1);
    } finally {
      handler(ref, { id: "message", waiting: false });
      for (const [owner, key, descriptor] of descriptors) {
        Object.defineProperty(owner, key, descriptor);
      }
    }
  });
});

suite("Manual Run Workspace Confirmation Tests", () => {
  function task(scope: "global" | "workspace"): ScheduledTask {
    return {
      id: `confirm-${scope}`,
      name: "Confirm task",
      cronExpression: "0 * * * *",
      prompt: "hello",
      enabled: true,
      scope,
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  test("allows global and matching workspace tasks without prompting", async () => {
    const { __testOnly } = await import("../../extension");
    const confirm = __testOnly.confirmManualRunIfWorkspaceMismatch;
    let promptCalls = 0;
    const deps = {
      shouldRunInCurrentWorkspace: () => true,
      showWarningMessage: async () => {
        promptCalls += 1;
        return undefined;
      },
    };

    assert.strictEqual(await confirm(task("global"), deps), true);
    assert.strictEqual(await confirm(task("workspace"), deps), true);
    assert.strictEqual(promptCalls, 0);
  });

  test("manual run rejects duplicates through history completion without stealing metadata", async () => {
    const { __testOnly } = await import("../../extension");
    const selectedTask = task("global");
    let releaseRun!: () => void;
    let releaseHistory!: () => void;
    let historyStarted!: () => void;
    const historyReady = new Promise<void>((resolve) => {
      historyStarted = resolve;
    });
    const runPending = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const historyPending = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let calls = 0;
    let histories = 0;
    let refreshes = 0;
    const deps = {
      run: async () => {
        calls++;
        await runPending;
        return { ok: true as const };
      },
      recordHistory: async () => {
        histories++;
        historyStarted();
        await historyPending;
      },
      refresh: () => {
        refreshes++;
      },
    };
    const firstRun = __testOnly.runTaskManually(selectedTask, deps);
    try {
      assert.deepStrictEqual(
        await __testOnly.runTaskManually(selectedTask, deps),
        {
          ok: false,
          reason: "alreadyRunning",
        },
      );
      assert.strictEqual(histories, 0);
      releaseRun();
      await historyReady;
      assert.deepStrictEqual(
        await __testOnly.runTaskManually(selectedTask, deps),
        {
          ok: false,
          reason: "alreadyRunning",
        },
      );
      assert.strictEqual(calls, 1);
      assert.strictEqual(histories, 1);
      assert.strictEqual(refreshes, 0);
    } finally {
      releaseRun();
      releaseHistory();
      await firstRun;
    }
    assert.deepStrictEqual(
      await __testOnly.runTaskManually(selectedTask, deps),
      { ok: true },
    );
    assert.strictEqual(calls, 2);
  });

  test("manual run preserves the snapshot selected before confirmation", async () => {
    const { __testOnly } = await import("../../extension");
    const selectedTask = task("workspace");
    const confirmedSnapshot = JSON.stringify(selectedTask);
    selectedTask.prompt = "changed while confirmation was open";
    const result = await __testOnly.runTaskManually(selectedTask, {
      run: async (_id, snapshot) => {
        assert.strictEqual(snapshot, confirmedSnapshot);
        return { ok: false, reason: "taskChanged" };
      },
      recordHistory: async () => assert.fail("Nothing was dispatched"),
      refresh: () => assert.fail("Nothing was dispatched"),
    }, confirmedSnapshot);
    assert.deepStrictEqual(result, { ok: false, reason: "taskChanged" });
  });

  test("manual run rejections leave execution history untouched and release the guard", async () => {
    const { __testOnly } = await import("../../extension");
    const selectedTask = task("global");
    for (const reason of [
      "alreadyRunning",
      "oneTimeCompleted",
      "claimFailed",
      "taskChanged",
      "taskNotFound",
      "executorUnavailable",
    ] as const) {
      const result = await __testOnly.runTaskManually(selectedTask, {
        run: async () => ({ ok: false, reason }),
        recordHistory: async () => {
          assert.fail("No dispatch, so no history metadata may be consumed");
        },
        refresh: () => {
          assert.fail("No run state was changed");
        },
      });
      assert.deepStrictEqual(result, { ok: false, reason });
    }
    const deps = {
      run: async () => {
        throw new Error("runner failed");
      },
      recordHistory: async () => {},
      refresh: () => {},
    };
    await assert.rejects(
      __testOnly.runTaskManually(selectedTask, deps),
      /runner failed/,
    );
    assert.deepStrictEqual(
      await __testOnly.runTaskManually(selectedTask, {
        ...deps,
        run: async () => ({ ok: true }),
      }),
      { ok: true },
    );
  });

  test("manual run dispatch failures retain history and refresh rollback state", async () => {
    const { __testOnly } = await import("../../extension");
    for (const reason of [
      "promptBlocked",
      "executionFailed",
      "saveFailed",
    ] as const) {
      let histories = 0;
      let refreshes = 0;
      await __testOnly.runTaskManually(task("global"), {
        run: async () => ({ ok: false, reason }),
        recordHistory: async (_task, result) => {
          assert.deepStrictEqual(result, { ok: false, reason });
          histories++;
        },
        refresh: () => {
          refreshes++;
        },
      });
      assert.strictEqual(histories, 1);
      assert.strictEqual(refreshes, 1);
    }
  });

  test("manual run returns Agent Host observations after history consumes them", async () => {
    const { __testOnly } = await import("../../extension");
    const selectedTask = { ...task("global"), id: "agent-host-result" };
    const result = await __testOnly.runTaskManually(selectedTask, {
      run: async () => {
        __testOnly.lastAgentHostRunByTaskId.set(selectedTask.id, {
          turnOutcome: "completed",
          responseText: "observed",
        });
        return { ok: true };
      },
      recordHistory: async () => {
        __testOnly.lastAgentHostRunByTaskId.delete(selectedTask.id);
      },
      refresh: () => {},
    });
    assert.deepStrictEqual(result, {
      ok: true,
      turnOutcome: "completed",
      responseText: "observed",
    });
  });

  test("manual run retains the completed turn when saving run state fails", async () => {
    const { __testOnly } = await import("../../extension");
    const selectedTask = { ...task("global"), id: "agent-host-save-failed" };
    const result = await __testOnly.runTaskManually(selectedTask, {
      run: async () => {
        __testOnly.lastAgentHostRunByTaskId.set(selectedTask.id, {
          turnOutcome: "completed",
          responseText: "not_observed",
        });
        return { ok: false, reason: "saveFailed" };
      },
      recordHistory: async () => {
        __testOnly.lastAgentHostRunByTaskId.delete(selectedTask.id);
      },
      refresh: () => {},
    });
    assert.deepStrictEqual(result, {
      ok: false,
      reason: "saveFailed",
      turnOutcome: "completed",
      responseText: "not_observed",
    });
  });

  test("requires explicit confirmation for another workspace", async () => {
    const { __testOnly } = await import("../../extension");
    const confirm = __testOnly.confirmManualRunIfWorkspaceMismatch;
    const choices: Array<string | undefined> = [
      undefined,
      messages.confirmRunAnyway(),
    ];
    const deps = {
      shouldRunInCurrentWorkspace: () => false,
      showWarningMessage: async () => choices.shift(),
    };

    assert.strictEqual(await confirm(task("workspace"), deps), false);
    assert.strictEqual(await confirm(task("workspace"), deps), true);
  });
});

suite("Execution History View Routing Tests", () => {
  test("notifies instead of opening QuickPick when history is empty", async () => {
    const { __testOnly } = await import("../../extension");
    const notifications: string[] = [];
    let quickPickCalls = 0;

    await __testOnly.showExecutionHistoryView({
      getHistoryEntries: () => [],
      notifyInfo: (message) => notifications.push(message),
      showQuickPick: async () => {
        quickPickCalls += 1;
      },
    });

    assert.deepStrictEqual(notifications, [messages.executionHistoryEmpty()]);
    assert.strictEqual(quickPickCalls, 0);
  });

  test("opens searchable QuickPick with execution history items", async () => {
    const { __testOnly } = await import("../../extension");
    let captured:
      | {
          items: Array<{ label: string; detail: string }>;
          options: {
            placeHolder: string;
            matchOnDescription: boolean;
            matchOnDetail: boolean;
          };
        }
      | undefined;

    await __testOnly.showExecutionHistoryView({
      getHistoryEntries: () => [
        {
          taskId: "history-view",
          taskName: "History view",
          trigger: "manual",
          status: "success",
          executedAt: "2026-07-30T09:00:00.000Z",
          promptSource: "file",
          promptHash: "abc123def456",
        },
      ],
      notifyInfo: () => undefined,
      showQuickPick: async (items, options) => {
        captured = { items, options };
      },
    });

    assert.ok(captured);
    assert.strictEqual(captured.items.length, 1);
    assert.ok(captured.items[0].detail.includes("abc123def456"));
    assert.deepStrictEqual(captured.options, {
      placeHolder: messages.executionHistoryPickPlaceholder(),
      matchOnDescription: true,
      matchOnDetail: true,
    });
  });
});

suite("Cron Expression Tests", () => {
  test("minimum interval warning only follows a new or changed cron", async () => {
    const { __testOnly } = await import("../../extension");
    const shouldWarn = __testOnly.shouldWarnCronInterval;
    assert.strictEqual(shouldWarn(undefined, "* * * * *"), true);
    assert.strictEqual(shouldWarn("* * * * *", "* * * * *"), false);
    assert.strictEqual(shouldWarn("0 9 * * *", "* * * * *"), true);
    assert.strictEqual(shouldWarn("* * * * *", ""), false);
  });
  test("Valid cron expressions should be accepted", () => {
    const validCronExpressions = [
      "* * * * *",
      "0 * * * *",
      "15 9 * * 1-5",
      "0 0 1 * *",
    ];

    for (const expression of validCronExpressions) {
      assert.doesNotThrow(
        () => parseExpression(expression).next().toDate(),
        `Expected cron expression to be accepted: ${expression}`,
      );
    }
  });
});

suite("i18n Tests", () => {
  test("Messages should be defined", async () => {
    // Import dynamically to avoid activation issues
    const { messages } = await import("../../i18n");

    assert.ok(typeof messages.extensionActive === "function");
    assert.ok(typeof messages.taskCreated === "function");
    assert.ok(typeof messages.taskDeleted === "function");
    assert.ok(typeof messages.promptFileExecutionNote === "function");
    assert.ok(typeof messages.confirmReplacePromptEdits === "function");
  });

  test("formatCronForDisplay renders common schedules as human summaries", async () => {
    const { formatCronForDisplay, messages } = await import("../../i18n");

    assert.strictEqual(
      formatCronForDisplay("*/20 * * * *"),
      messages.cronPreviewEveryNMinutes().replace("{n}", "20"),
    );
    assert.strictEqual(
      formatCronForDisplay("0 */2 * * *"),
      messages.cronPreviewEveryNHours().replace("{n}", "2"),
    );
    assert.strictEqual(
      formatCronForDisplay("0 * * * *"),
      messages.cronPreviewEveryHour(),
    );
    assert.strictEqual(
      formatCronForDisplay("0 9 * * *"),
      messages.cronPreviewDailyAt().replace("{t}", "09:00"),
    );
    assert.strictEqual(
      formatCronForDisplay("0 9 * * 1-5"),
      messages.cronPreviewWeekdaysAt().replace("{t}", "09:00"),
    );
    assert.strictEqual(
      formatCronForDisplay("0 9 * * 1"),
      messages
        .cronPreviewWeeklyOnAt()
        .replace("{d}", messages.dayMon())
        .replace("{t}", "09:00"),
    );
    assert.strictEqual(
      formatCronForDisplay("0 9 1 * *"),
      messages
        .cronPreviewMonthlyOnAt()
        .replace("{dom}", "1")
        .replace("{t}", "09:00"),
    );
  });

  test("formatCronForDisplay summarizes multi-line strict intervals", async () => {
    const { formatCronForDisplay, messages } = await import("../../i18n");

    assert.strictEqual(
      formatCronForDisplay(
        ["0 0,3,6,9,12,15,18,21 * * *", "30 1,4,7,10,13,16,19,22 * * *"].join(
          "\n",
        ),
      ),
      messages.cronPreviewEveryNMinutes().replace("{n}", "90"),
    );
    assert.strictEqual(
      formatCronForDisplay("0 0,3 * * *\n30 1,4 * * *"),
      messages.cronPreviewMultipleExpressions(),
    );
  });
});

suite("Webview Test Prompt Wiring Tests", () => {
  test("List/Edit webview commands pass test-prompt callback", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const createGuiStart = source.indexOf(
      "function registerCreateTaskGuiCommand(",
    );
    assert.ok(createGuiStart >= 0, "registerCreateTaskGuiCommand not found");
    const createGuiEnd = source.indexOf(
      "function registerListTasksCommand(",
      createGuiStart,
    );
    assert.ok(
      createGuiEnd > createGuiStart,
      "registerCreateTaskGuiCommand end not found",
    );
    const createGuiBlock = source.slice(createGuiStart, createGuiEnd);
    assert.ok(
      createGuiBlock.includes("handleTestPromptAction"),
      "registerCreateTaskGuiCommand should pass handleTestPromptAction to SchedulerWebview.show",
    );
    assert.ok(createGuiBlock.includes("handlePromptPreviewRequest"));
    assert.ok(createGuiBlock.includes("handleOpenPromptFile"));

    const listCmdStart = createGuiEnd;
    assert.ok(listCmdStart >= 0, "registerListTasksCommand not found");
    const listCmdEnd = source.indexOf(
      "function registerEditTaskCommand(",
      listCmdStart,
    );
    assert.ok(
      listCmdEnd > listCmdStart,
      "registerListTasksCommand end not found",
    );
    const listCmdBlock = source.slice(listCmdStart, listCmdEnd);
    assert.ok(
      listCmdBlock.includes("handleTestPromptAction"),
      "registerListTasksCommand should pass handleTestPromptAction to SchedulerWebview.show",
    );
    assert.ok(listCmdBlock.includes("handlePromptPreviewRequest"));
    assert.ok(listCmdBlock.includes("handleOpenPromptFile"));

    const editCmdStart = listCmdEnd;
    const editCmdEnd = source.indexOf(
      "function registerDeleteTaskCommand()",
      editCmdStart,
    );
    assert.ok(
      editCmdEnd > editCmdStart,
      "registerEditTaskCommand end not found",
    );
    const editCmdBlock = source.slice(editCmdStart, editCmdEnd);
    assert.ok(
      editCmdBlock.includes("handleTestPromptAction"),
      "registerEditTaskCommand should pass handleTestPromptAction to SchedulerWebview.show",
    );
    assert.ok(editCmdBlock.includes("handlePromptPreviewRequest"));
    assert.ok(editCmdBlock.includes("handleOpenPromptFile"));
  });

  test("Task QuickPick items include workspace/scope metadata", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    assert.ok(
      source.includes(
        "function buildTaskQuickPickMeta(task: ScheduledTask): string",
      ),
      "extension should define a shared helper for task QuickPick metadata",
    );
    assert.ok(
      source.includes("detail: buildTaskQuickPickMeta(task),"),
      "task QuickPick items should include workspace/scope metadata in detail",
    );
    assert.ok(
      source.includes("messages.labelScopeWorkspace()") &&
        source.includes("messages.labelScopeGlobal()"),
      "task QuickPick metadata should distinguish global and workspace tasks",
    );
  });

  test("buildPromptExecutionOptions keeps structured model selection fields", async () => {
    const { __testOnly } = await import("../../extension");
    const buildPromptExecutionOptions =
      __testOnly.buildPromptExecutionOptions as unknown as
        | ((request: ScheduledTask) => Record<string, unknown>)
        | undefined;

    assert.ok(typeof buildPromptExecutionOptions === "function");

    const options = buildPromptExecutionOptions({
      id: "t-model-options",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      agent: "edit",
      chatSession: "continue",
      model: "gpt-5.4",
      modelName: "GPT-5.4",
      modelVendor: "OpenAI",
      modelFamily: "gpt-5.4",
      modelVersion: "high",
      agentHostModelId: "OpenAI/provider/gpt-5.4",
      modelReasoningEffort: "high",
      preventAgentHostFallback: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    assert.deepStrictEqual(options, {
      agent: "edit",
      chatSession: "continue",
      model: "gpt-5.4",
      modelName: "GPT-5.4",
      modelVendor: "OpenAI",
      modelFamily: "gpt-5.4",
      modelVersion: "high",
      agentHostModelId: "OpenAI/provider/gpt-5.4",
      modelReasoningEffort: "high",
      preventAgentHostFallback: true,
      targetChatId: undefined,
      attachFilePaths: undefined,
    });
  });

  test("buildPromptExecutionOptions blocks the run when an attachment disappeared after save", async () => {
    const { __testOnly } = await import("../../extension");
    const { getPromptBlockedReason, isPromptBlockedError } =
      await import("../../promptExecutionErrors");
    const buildPromptExecutionOptions =
      __testOnly.buildPromptExecutionOptions as unknown as (
        request: ScheduledTask,
        localAttachmentRoots?: string[],
      ) => { attachFilePaths?: string[] };

    assert.ok(typeof buildPromptExecutionOptions === "function");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-attach-block-"));
    const attached = path.join(root, "team.instructions.md");
    fs.writeFileSync(attached, "guidance", "utf8");

    const task: ScheduledTask = {
      id: "t-attach-block",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "workspace",
      promptSource: "inline",
      attachments: [{ source: "local", path: "team.instructions.md" }],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      assert.deepStrictEqual(
        buildPromptExecutionOptions(task, [root]).attachFilePaths,
        [attached],
        "an existing attachment must resolve to an absolute path at execution time",
      );

      fs.renameSync(attached, path.join(root, "renamed.instructions.md"));

      assert.throws(
        () => buildPromptExecutionOptions(task, [root]),
        (error: unknown) =>
          isPromptBlockedError(error) &&
          getPromptBlockedReason(error) === "attachmentMissing" &&
          String((error as Error).message).includes("team.instructions.md"),
        "a missing attachment must fail closed instead of running without it",
      );

      assert.throws(
        () => buildPromptExecutionOptions(task, []),
        (error: unknown) =>
          isPromptBlockedError(error) &&
          getPromptBlockedReason(error) === "attachmentMissing",
        "a local attachment with no local root must fail closed",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a blocked attachment warns once per attachment set and clears after a successful run", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    assert.ok(
      /getPromptBlockedReason\(error\) === "attachmentMissing" &&\s*attachmentBlockNotifications\.get\(task\.id\) !== attachmentSignature\s*\)\s*\{\s*attachmentBlockNotifications\.set\(task\.id, attachmentSignature\);\s*void vscode\.window\.showWarningMessage\(/.test(
        source,
      ),
      "the attachment warning must be keyed by the failing attachment set so a scheduled task cannot warn on every tick",
    );
    assert.ok(
      source.includes("attachmentBlockNotifications.delete(task.id);"),
      "a successful run must clear the notification so a later block warns again",
    );
  });

  test("editing a blocked task's attachments makes the next failure audible again", async () => {
    const { __testOnly } = await import("../../extension");
    const getAttachmentSignature =
      __testOnly.getAttachmentSignature as unknown as (
        task: ScheduledTask,
      ) => string;
    const notifications =
      __testOnly.attachmentBlockNotifications as unknown as Map<string, string>;

    const base: ScheduledTask = {
      id: "t-attach-signature",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "workspace",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    assert.strictEqual(getAttachmentSignature(base), "");
    assert.strictEqual(
      getAttachmentSignature({
        ...base,
        attachments: [
          { source: "local", path: "a.md" },
          { source: "global", path: "b.md" },
        ],
      }),
      "local:a.md|global:b.md",
    );

    const broken = {
      ...base,
      attachments: [{ source: "local" as const, path: "gone.md" }],
    };
    const repaired = {
      ...base,
      attachments: [{ source: "local" as const, path: "other.md" }],
    };

    notifications.delete(base.id);
    try {
      const shouldWarn = (task: ScheduledTask): boolean =>
        notifications.get(task.id) !== getAttachmentSignature(task);

      assert.strictEqual(shouldWarn(broken), true);
      notifications.set(broken.id, getAttachmentSignature(broken));
      assert.strictEqual(
        shouldWarn(broken),
        false,
        "the same broken attachment set must not warn twice",
      );
      assert.strictEqual(
        shouldWarn(repaired),
        true,
        "a changed attachment set must warn again instead of failing silently",
      );
    } finally {
      notifications.delete(base.id);
    }
  });

  test("runtime caches drop tasks that no longer exist", async () => {
    const { __testOnly } = await import("../../extension");
    const prune = __testOnly.pruneRuntimeCachesForRemovedTasks as unknown as (
      taskIds: Set<string>,
    ) => void;
    const notifications =
      __testOnly.attachmentBlockNotifications as unknown as Map<string, string>;

    notifications.set("t-kept", "local:a.md");
    notifications.set("t-deleted", "local:b.md");
    try {
      prune(new Set(["t-kept"]));

      assert.strictEqual(notifications.get("t-kept"), "local:a.md");
      assert.strictEqual(
        notifications.has("t-deleted"),
        false,
        "a deleted task must not keep leaking its notification state",
      );
    } finally {
      notifications.delete("t-kept");
      notifications.delete("t-deleted");
    }
  });

  test("the tasks-changed hook prunes runtime caches before refreshing the webview", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    assert.ok(
      /addOnTasksChangedCallback\(\(\) => \{\s*const tasks = scheduleManager\.getAllTasks\(\);\s*pruneRuntimeCachesForRemovedTasks\(/.test(
        source,
      ),
      "task deletions must prune per-task runtime caches",
    );
  });

  test("deactivate clears every per-task runtime cache", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");
    const start = source.indexOf("export function deactivate(): void {");
    assert.ok(start >= 0, "deactivate not found");
    const body = source.slice(start, source.indexOf("\n}", start));

    for (const cache of [
      "manualRunInFlightTaskIds",
      "attachmentBlockNotifications",
      "lastPromptResolutionByTaskId",
    ]) {
      assert.ok(
        body.includes(`${cache}.clear();`),
        `deactivate must clear ${cache} so a reactivated host does not inherit stale per-task state`,
      );
    }
    assert.ok(
      body.includes("disposePromptResourceWatchers();"),
      "deactivate must cancel prompt watchers and pending preview refreshes",
    );
  });

  test("every successful run records how many files it attached", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const payloads = [
      ...source.matchAll(
        /(?:recordExecutionHistoryBestEffort\(|const entry: ExecutionHistoryEntry = )\{([^}]*)\}/g,
      ),
    ].map((match) => match[1]);

    const successPayloads = payloads.filter((payload) =>
      payload.includes('status: "success"'),
    );

    assert.ok(
      successPayloads.length >= 2,
      "both the scheduled and the manual success paths should write history",
    );
    for (const payload of successPayloads) {
      assert.ok(
        payload.includes("attachmentCount:"),
        `a success history entry must record attachmentCount: ${payload.trim()}`,
      );
    }
  });

  test("every automatic run records its scheduled due time", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");
    const payloads = [
      ...source.matchAll(
        /(?:recordExecutionHistoryBestEffort\(|\(deps\?\.recordHistory \?\? recordExecutionHistoryBestEffort\)\(|const entry: ExecutionHistoryEntry = )\{([^}]*)\}/g,
      ),
    ].map((match) => match[1]);
    const automaticPayloads = payloads.filter((payload) =>
      payload.includes("trigger,"),
    );

    assert.strictEqual(automaticPayloads.length, 3);
    for (const payload of automaticPayloads) {
      assert.ok(
        payload.includes("dueAt,"),
        `an automatic history entry must record dueAt: ${payload.trim()}`,
      );
    }
  });

  test("resolveNotificationMode normalizes invalid values and keeps legacy silentStatus", async () => {
    const { __testOnly } = await import("../../extension");
    const resolveNotificationMode = __testOnly.resolveNotificationMode as
      | ((showNotificationsEnabled: boolean, mode: unknown) => string)
      | undefined;

    assert.ok(typeof resolveNotificationMode === "function");
    assert.strictEqual(resolveNotificationMode(true, "sound"), "sound");
    assert.strictEqual(
      resolveNotificationMode(true, "silentToast"),
      "silentToast",
    );
    assert.strictEqual(resolveNotificationMode(true, "invalid-mode"), "sound");
    assert.strictEqual(resolveNotificationMode(true, undefined), "sound");
    assert.strictEqual(
      resolveNotificationMode(false, "invalid-mode"),
      "silentStatus",
    );
  });

  test("ensureCreatedTaskAcceptedAfterDisclaimer rolls back new task when disclaimer is declined", async () => {
    const { __testOnly } = await import("../../extension");
    const ensureCreatedTaskAcceptedAfterDisclaimer =
      __testOnly.ensureCreatedTaskAcceptedAfterDisclaimer as
        | ((
            task: ScheduledTask,
            deps: {
              maybeShowDisclaimer: (task: ScheduledTask) => Promise<boolean>;
              deleteTask: (id: string) => Promise<boolean>;
              disableTask: (id: string) => Promise<ScheduledTask | undefined>;
              onTasksChanged: () => void;
              notifyInfo: (message: string) => void;
              notifyError: (message: string) => void;
            },
          ) => Promise<boolean>)
        | undefined;

    assert.ok(typeof ensureCreatedTaskAcceptedAfterDisclaimer === "function");

    const task: ScheduledTask = {
      id: "t-created-decline",
      name: "New task",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let deletedId: string | undefined;
    let disabledId: string | undefined;
    let updateCount = 0;
    let infoMessage: string | undefined;

    const accepted = await ensureCreatedTaskAcceptedAfterDisclaimer!(task, {
      maybeShowDisclaimer: async () => false,
      deleteTask: async (id) => {
        deletedId = id;
        return true;
      },
      disableTask: async (id) => {
        disabledId = id;
        return undefined;
      },
      onTasksChanged: () => {
        updateCount += 1;
      },
      notifyInfo: (message) => {
        infoMessage = message;
      },
      notifyError: () => {
        assert.fail("notifyError should not be called when delete succeeds");
      },
    });

    assert.strictEqual(accepted, false);
    assert.strictEqual(deletedId, task.id);
    assert.strictEqual(disabledId, undefined);
    assert.strictEqual(updateCount, 1);
    assert.strictEqual(
      infoMessage,
      (await import("../../i18n")).messages.disclaimerDeclinedTaskCanceled(
        task.name,
      ),
    );
  });

  test("ensureCreatedTaskAcceptedAfterDisclaimer falls back to disable when rollback fails", async () => {
    const { __testOnly } = await import("../../extension");
    const ensureCreatedTaskAcceptedAfterDisclaimer =
      __testOnly.ensureCreatedTaskAcceptedAfterDisclaimer as
        | ((
            task: ScheduledTask,
            deps: {
              maybeShowDisclaimer: (task: ScheduledTask) => Promise<boolean>;
              deleteTask: (id: string) => Promise<boolean>;
              disableTask: (id: string) => Promise<ScheduledTask | undefined>;
              onTasksChanged: () => void;
              notifyInfo: (message: string) => void;
              notifyError: (message: string) => void;
            },
          ) => Promise<boolean>)
        | undefined;

    assert.ok(typeof ensureCreatedTaskAcceptedAfterDisclaimer === "function");

    const task: ScheduledTask = {
      id: "t-created-disable-fallback",
      name: "Fallback task",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let deleteCount = 0;
    let disabledId: string | undefined;
    let updateCount = 0;
    let infoMessage: string | undefined;

    const accepted = await ensureCreatedTaskAcceptedAfterDisclaimer!(task, {
      maybeShowDisclaimer: async () => false,
      deleteTask: async () => {
        deleteCount += 1;
        return false;
      },
      disableTask: async (id) => {
        disabledId = id;
        return task;
      },
      onTasksChanged: () => {
        updateCount += 1;
      },
      notifyInfo: (message) => {
        infoMessage = message;
      },
      notifyError: () => {
        assert.fail("notifyError should not be called when disable succeeds");
      },
    });

    assert.strictEqual(accepted, false);
    assert.strictEqual(deleteCount, 1);
    assert.strictEqual(disabledId, task.id);
    assert.strictEqual(updateCount, 1);
    assert.strictEqual(
      infoMessage,
      (await import("../../i18n")).messages.disclaimerDeclinedTaskDisabled(
        task.name,
      ),
    );
  });

  test("Configuration and workspace watchers keep webview defaults and templates in sync", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const configWatcherStart = source.indexOf(
      "const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {",
    );
    assert.ok(configWatcherStart >= 0, "configWatcher not found");

    const workspaceWatcherStart = source.indexOf(
      "const workspaceFoldersWatcher = vscode.workspace.onDidChangeWorkspaceFolders(",
      configWatcherStart,
    );
    assert.ok(
      workspaceWatcherStart > configWatcherStart,
      "workspaceFoldersWatcher not found",
    );

    const configWatcherBlock = source.slice(
      configWatcherStart,
      workspaceWatcherStart,
    );
    const configTokens = [
      'e.affectsConfiguration("copilotScheduler.defaultScope")',
      'e.affectsConfiguration("copilotScheduler.autoModeDefault")',
      'e.affectsConfiguration("copilotScheduler.chatSession")',
      'e.affectsConfiguration("copilotScheduler.jitterSeconds")',
      "SchedulerWebview.refreshFormDefaults();",
      'e.affectsConfiguration("copilotScheduler.globalPromptsPath")',
      'e.affectsConfiguration("copilotScheduler.globalAgentsPath")',
      "registerPromptResourceWatchers();",
    ];

    for (const token of configTokens) {
      assert.ok(
        configWatcherBlock.includes(token),
        `Config watcher should include token: ${token}`,
      );
    }

    const subscriptionsStart = source.indexOf(
      "  // Register subscriptions",
      workspaceWatcherStart,
    );
    assert.ok(
      subscriptionsStart > workspaceWatcherStart,
      "subscriptions anchor not found",
    );

    const workspaceWatcherBlock = source.slice(
      workspaceWatcherStart,
      subscriptionsStart,
    );
    assert.ok(
      workspaceWatcherBlock.includes(
        "void SchedulerWebview.refreshCachesAndNotifyPanel(true);",
      ),
      "workspaceFoldersWatcher should refresh cached webview data",
    );
    assert.ok(
      workspaceWatcherBlock.includes("registerPromptResourceWatchers();"),
      "workspaceFoldersWatcher should re-register prompt resource watchers",
    );
  });

  test("Prompt resource watchers cover workspace prompts and global prompt roots", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const watcherBlock = extractBlockFromStartToken(
      source,
      "function registerPromptResourceWatchers(): void {",
    );

    const watcherTokens = [
      'watchPattern("**/.github/prompts/**/*.md", schedulePromptPreviewRefresh);',
      'resolveGlobalPromptsRoot(config.get<string>("globalPromptsPath", ""))',
      'resolveGlobalAgentRoots(config.get<string>("globalAgentsPath", ""))',
      'new vscode.RelativePattern(vscode.Uri.file(root), "**/*.md")',
      "watcher.onDidCreate(handle)",
      "watcher.onDidChange(handle)",
      "watcher.onDidDelete(handle)",
      "onPromptFileChanged?.(uri)",
    ];

    for (const token of watcherTokens) {
      assert.ok(
        watcherBlock.includes(token),
        `Prompt resource watcher block should include token: ${token}`,
      );
    }
  });

  test("disposing prompt resource watchers cancels pending preview refresh", async () => {
    const { __testOnly } = await import("../../extension");
    const scheduleRefresh = __testOnly.schedulePromptPreviewRefresh;
    const disposeWatchers = __testOnly.disposePromptResourceWatchers;
    const getRefreshState = __testOnly.getPromptPreviewRefreshState;

    try {
      scheduleRefresh(
        vscode.Uri.file("C:\\workspace\\.github\\prompts\\daily.md"),
      );
      assert.deepStrictEqual(getRefreshState(), {
        pendingPathCount: 1,
        timerScheduled: true,
      });

      disposeWatchers();
      assert.deepStrictEqual(getRefreshState(), {
        pendingPathCount: 0,
        timerScheduled: false,
      });
    } finally {
      disposeWatchers();
    }
  });

  test("Command move-to-current-workspace errors stay out of webview inline errors", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const commandStart = source.indexOf(
      "function registerMoveToCurrentWorkspaceCommand(): vscode.Disposable {",
    );
    assert.ok(
      commandStart >= 0,
      "registerMoveToCurrentWorkspaceCommand not found",
    );

    const commandEnd = source.indexOf(
      "function registerOpenSettingsCommand(): vscode.Disposable {",
      commandStart,
    );
    assert.ok(
      commandEnd > commandStart,
      "registerMoveToCurrentWorkspaceCommand end not found",
    );

    const commandBlock = source.slice(commandStart, commandEnd);
    assert.ok(
      commandBlock.includes("notifyError(errorMessage);"),
      "move-to-current-workspace command should still notify VS Code errors",
    );
    assert.ok(
      !commandBlock.includes("SchedulerWebview.showError(errorMessage);"),
      "move-to-current-workspace command should not push command errors into the webview",
    );
  });

  test("Manual run failure paths resync task lists after run-state rollback", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const helperStart = source.indexOf("async function runTaskManually(");
    const helperEnd = source.indexOf(
      "async function confirmManualRunIfWorkspaceMismatch(",
      helperStart,
    );
    assert.ok(helperStart >= 0 && helperEnd > helperStart);
    const helperBlock = source.slice(helperStart, helperEnd);
    assert.ok(
      helperBlock.includes(
        "SchedulerWebview.updateTasks(scheduleManager.getAllTasks())",
      ),
      "shared manual-run failure path should refresh cached task state",
    );

    const webviewRunBlock = extractBlockFromStartToken(source, 'case "run": {');
    assert.ok(
      webviewRunBlock.includes("runTaskManually(runTask, undefined, confirmedTaskSnapshot)"),
      "webview manual run should use the shared failure-resync path",
    );

    const commandStart = source.indexOf('"copilotScheduler.runNow",');
    assert.ok(commandStart >= 0, "runNow command registration not found");

    const commandEnd = source.indexOf(
      "function registerCopyPromptCommand(): vscode.Disposable {",
      commandStart,
    );
    assert.ok(commandEnd > commandStart, "runNow command end not found");

    const commandBlock = source.slice(commandStart, commandEnd);
    assert.ok(
      commandBlock.includes("runTaskManually(task, undefined, confirmedTaskSnapshot)"),
      "command manual run should use the shared failure-resync path",
    );
  });

  test("Webview move-to-current-workspace reports taskNotFound inline on move failure", () => {
    const sourcePath = path.resolve(__dirname, "../../../src/extension.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    const actionBlock = extractBlockFromStartToken(
      source,
      'case "moveToCurrentWorkspace": {',
    );
    assert.ok(
      actionBlock.includes(
        "const moved = await scheduleManager.moveTaskToCurrentWorkspace(task.id);",
      ),
      "webview action should attempt to move the task",
    );
    assert.ok(
      actionBlock.includes("const msg = messages.taskNotFound();"),
      "webview action should build a localized task-not-found error",
    );
    assert.ok(
      actionBlock.includes("notifyError(msg);"),
      "webview action should notify VS Code when move fails",
    );
    assert.ok(
      actionBlock.includes("SchedulerWebview.showError(msg);"),
      "webview action should surface inline error when move fails inside the webview",
    );
  });
});

suite("Error Message Sanitization Tests", () => {
  test("Sanitizes absolute paths to basenames (Windows and POSIX)", async () => {
    const { __testOnly } = await import("../../extension");
    const { messages } = await import("../../i18n");
    const sanitize = __testOnly.sanitizeErrorDetailsForLog as
      | ((message: string) => string)
      | undefined;

    assert.ok(typeof sanitize === "function");
    runSharedSanitizerCases(sanitize!, messages.redactedPlaceholder());
  });

  test("Falls back to localized unknown on empty/whitespace outputs", async () => {
    const { __testOnly } = await import("../../extension");
    const { messages } = await import("../../i18n");
    const sanitize = __testOnly.sanitizeErrorDetailsForLog as
      | ((message: string) => string)
      | undefined;

    assert.ok(typeof sanitize === "function");
    assert.strictEqual(sanitize!(""), messages.webviewUnknown());
    assert.strictEqual(sanitize!("   \t\n"), messages.webviewUnknown());
  });
});

suite("Error Message Display Fallback Tests", () => {
  test("Falls back to localized unknown when message is whitespace only", async () => {
    const { __testOnly } = await import("../../extension");
    const { messages } = await import("../../i18n");
    const resolveDisplay = __testOnly.resolveDisplayErrorMessage as
      | ((message: string) => string)
      | undefined;

    assert.ok(typeof resolveDisplay === "function");
    assert.strictEqual(resolveDisplay!("   \t\n"), messages.webviewUnknown());
  });

  test("Keeps non-empty message after sanitization", async () => {
    const { __testOnly } = await import("../../extension");
    const resolveDisplay = __testOnly.resolveDisplayErrorMessage as
      | ((message: string) => string)
      | undefined;

    assert.ok(typeof resolveDisplay === "function");
    const display = resolveDisplay!(
      "ENOENT: no such file or directory, open 'C:\\Users\\me\\secret folder\\a b.md'",
    );
    assert.ok(display.includes("a b.md"));
    assert.ok(!display.includes("C:\\Users\\me"));
  });

  test("Uses first line only for multi-line errors", async () => {
    const { __testOnly } = await import("../../extension");
    const resolveDisplay = __testOnly.resolveDisplayErrorMessage as
      | ((message: string) => string)
      | undefined;

    assert.ok(typeof resolveDisplay === "function");
    const display = resolveDisplay!("First line\nSecond line");
    assert.strictEqual(display, "First line");
  });
});

suite("toSafeErrorDetails Fallback Tests", () => {
  test("CopilotExecutor toSafeErrorDetails falls back to localized unknown on whitespace", async () => {
    const { __testOnly } = await import("../../copilotExecutor");
    const { messages } = await import("../../i18n");
    const toSafe = __testOnly.toSafeErrorDetails as
      | ((error: unknown) => string)
      | undefined;

    assert.ok(typeof toSafe === "function");
    assert.strictEqual(toSafe!(""), messages.webviewUnknown());
    assert.strictEqual(toSafe!("   \t\n"), messages.webviewUnknown());

    const sanitized = toSafe!("Authorization:Bearer abc.def.ghi");
    assert.ok(!sanitized.includes("abc.def.ghi"));
    assert.ok(
      sanitized.includes(
        `Authorization:Bearer ${messages.redactedPlaceholder()}`,
      ),
    );
  });

  test("ScheduleManager toSafeErrorDetails masks Authorization and falls back on empty", async () => {
    const { __testOnly } = await import("../../scheduleManager");
    const { messages } = await import("../../i18n");
    const toSafe = __testOnly.toSafeErrorDetails as
      | ((error: unknown) => string)
      | undefined;

    assert.ok(typeof toSafe === "function");
    assert.strictEqual(toSafe!(""), messages.webviewUnknown());

    const sanitized = toSafe!("Authorization:Bearer abc.def.ghi");
    assert.ok(!sanitized.includes("abc.def.ghi"));
    assert.ok(
      sanitized.includes(
        `Authorization:Bearer ${messages.redactedPlaceholder()}`,
      ),
    );
  });
});

suite("resolvePromptText Tests", () => {
  function setWorkspaceFoldersForTest(root: string): () => void {
    const wsAny = vscode.workspace as unknown as {
      workspaceFolders?: Array<{ uri: vscode.Uri }>;
    };
    const original = wsAny.workspaceFolders;
    try {
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        value: [{ uri: vscode.Uri.file(root) }],
        configurable: true,
      });
    } catch {
      // Best-effort; tests will fail if the host disallows patching.
    }
    return () => {
      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: original,
          configurable: true,
        });
      } catch {
        // ignore
      }
    };
  }

  test("Prefers open document text when preferOpenDocument=true", async () => {
    const wsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-ws-"),
    );
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");

    const fileName = `__test_resolvePromptText_openDoc_${Date.now()}.md`;
    const absPath = path.join(promptsDir, fileName);
    const relPath = path.join(".github", "prompts", fileName);
    const uri = vscode.Uri.file(absPath);
    let doc: vscode.TextDocument | undefined;

    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(absPath, "DISK", "utf8");

      doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      assert.ok(editor, "An editor should be available");

      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      await editor!.edit((b) => b.replace(fullRange, "UNSAVED"));
      assert.strictEqual(doc.isDirty, true);

      const { __testOnly } = await import("../../extension");
      const task = {
        id: "t-open-doc",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "FALLBACK",
        enabled: true,
        scope: "global",
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      const resolved = await __testOnly.resolvePromptText(task, true);
      assert.strictEqual(resolved, "UNSAVED");
    } finally {
      restoreWs();
      try {
        if (doc) {
          await vscode.window.showTextDocument(doc);
          if (vscode.window.activeTextEditor?.document === doc) {
            try {
              await vscode.commands.executeCommand(
                "workbench.action.revertAndCloseActiveEditor",
              );
            } catch {
              await doc.save();
              await vscode.commands.executeCommand(
                "workbench.action.closeActiveEditor",
              );
            }
          }
        }
      } catch {
        // ignore
      }
      try {
        fs.rmSync(wsRoot, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("Reads persisted file when preferOpenDocument=false", async () => {
    const wsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-ws-"),
    );
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");

    const fileName = `__test_resolvePromptText_diskOnly_${Date.now()}.md`;
    const absPath = path.join(promptsDir, fileName);
    const relPath = path.join(".github", "prompts", fileName);
    const uri = vscode.Uri.file(absPath);
    let doc: vscode.TextDocument | undefined;

    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(absPath, "DISK", "utf8");

      doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      assert.ok(editor, "An editor should be available");

      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      await editor!.edit((b) => b.replace(fullRange, "UNSAVED"));
      assert.strictEqual(doc.isDirty, true);

      const { __testOnly } = await import("../../extension");
      const task = {
        id: "t-disk-only",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "FALLBACK",
        enabled: true,
        scope: "global",
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      const resolved = await __testOnly.resolvePromptText(task, false);
      assert.strictEqual(resolved, "DISK");
    } finally {
      restoreWs();
      try {
        if (doc) {
          await vscode.window.showTextDocument(doc);
          if (vscode.window.activeTextEditor?.document === doc) {
            try {
              await vscode.commands.executeCommand(
                "workbench.action.revertAndCloseActiveEditor",
              );
            } catch {
              await doc.save();
              await vscode.commands.executeCommand(
                "workbench.action.closeActiveEditor",
              );
            }
          }
        }
      } catch {
        // ignore
      }
      try {
        fs.rmSync(wsRoot, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("Throws when open prompt template is empty instead of falling back to stored prompt", async () => {
    const wsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-ws-"),
    );
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");

    const fileName = `__test_resolvePromptText_emptyOpenDoc_${Date.now()}.md`;
    const absPath = path.join(promptsDir, fileName);
    const relPath = path.join(".github", "prompts", fileName);
    const uri = vscode.Uri.file(absPath);
    let doc: vscode.TextDocument | undefined;

    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(absPath, "DISK", "utf8");

      doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      assert.ok(editor, "An editor should be available");

      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      await editor!.edit((b) => b.replace(fullRange, "   \n"));
      assert.strictEqual(doc.isDirty, true);

      const { __testOnly } = await import("../../extension");
      const { messages } = await import("../../i18n");
      const task = {
        id: "t-empty-open-doc",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "FALLBACK",
        enabled: true,
        scope: "global",
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      await assert.rejects(
        () => __testOnly.resolvePromptText(task, true),
        (error: unknown) =>
          error instanceof Error &&
          error.message === messages.promptTemplateEmpty(fileName),
      );
    } finally {
      restoreWs();
      try {
        if (doc) {
          await vscode.window.showTextDocument(doc);
          if (vscode.window.activeTextEditor?.document === doc) {
            try {
              await vscode.commands.executeCommand(
                "workbench.action.revertAndCloseActiveEditor",
              );
            } catch {
              await doc.save();
              await vscode.commands.executeCommand(
                "workbench.action.closeActiveEditor",
              );
            }
          }
        }
      } catch {
        // ignore
      }
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      // An editor or file watcher can hold the file for a moment after it closes.
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          fs.rmSync(wsRoot, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  });

  test("Throws when persisted prompt template is empty instead of falling back to stored prompt", async () => {
    const wsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-ws-"),
    );
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");

    const fileName = `__test_resolvePromptText_emptyFile_${Date.now()}.md`;
    const absPath = path.join(promptsDir, fileName);
    const relPath = path.join(".github", "prompts", fileName);

    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(absPath, "  \n", "utf8");

      const { __testOnly } = await import("../../extension");
      const { messages } = await import("../../i18n");
      const task = {
        id: "t-empty-file",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "FALLBACK",
        enabled: true,
        scope: "global",
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      await assert.rejects(
        () => __testOnly.resolvePromptText(task, false),
        (error: unknown) =>
          error instanceof Error &&
          error.message === messages.promptTemplateEmpty(fileName),
      );
    } finally {
      restoreWs();
      try {
        fs.rmSync(wsRoot, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  function setMultiRootWorkspaceFoldersForTest(roots: string[]): () => void {
    const wsAny = vscode.workspace as unknown as {
      workspaceFolders?: Array<{ uri: vscode.Uri }>;
    };
    const original = wsAny.workspaceFolders;
    try {
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        value: roots.map((root) => ({ uri: vscode.Uri.file(root) })),
        configurable: true,
      });
    } catch {
      // Best-effort; tests will fail if the host disallows patching.
    }
    return () => {
      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: original,
          configurable: true,
        });
      } catch {
        // ignore
      }
    };
  }

  test("Falls through to the workspace folder that actually has the file", async () => {
    const ws1 = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-a-"));
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-b-"));
    const restoreWs = setMultiRootWorkspaceFoldersForTest([ws1, ws2]);

    const fileName = `__test_multiroot_${Date.now()}.md`;
    const relPath = path.join(".github", "prompts", fileName);

    try {
      // Only ws2 has the file, but ws1 comes first in the folder list.
      fs.mkdirSync(path.join(ws2, ".github", "prompts"), { recursive: true });
      fs.writeFileSync(
        path.join(ws2, ".github", "prompts", fileName),
        "WS2_CONTENT",
        "utf8",
      );

      const { __testOnly } = await import("../../extension");
      const task = {
        id: "t-multiroot-fallthrough",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "SNAPSHOT",
        enabled: true,
        scope: "workspace",
        workspacePath: ws2,
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      const resolved = await __testOnly.resolvePromptText(task, false);
      assert.strictEqual(resolved, "WS2_CONTENT");
    } finally {
      restoreWs();
      for (const root of [ws1, ws2]) {
        try {
          fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 50,
          });
        } catch {
          // ignore
        }
      }
    }
  });

  test("Prefers the task's own workspace when both folders have the file", async () => {
    const ws1 = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-a-"));
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scheduler-b-"));
    const restoreWs = setMultiRootWorkspaceFoldersForTest([ws1, ws2]);

    const fileName = `__test_multiroot_same_${Date.now()}.md`;
    const relPath = path.join(".github", "prompts", fileName);

    try {
      for (const [root, content] of [
        [ws1, "WS1_CONTENT"],
        [ws2, "WS2_CONTENT"],
      ] as const) {
        fs.mkdirSync(path.join(root, ".github", "prompts"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(root, ".github", "prompts", fileName),
          content,
          "utf8",
        );
      }

      const { __testOnly } = await import("../../extension");
      const task = {
        id: "t-multiroot-preferred",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "SNAPSHOT",
        enabled: true,
        scope: "workspace",
        workspacePath: ws2,
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      const resolved = await __testOnly.resolvePromptText(task, false);
      assert.strictEqual(resolved, "WS2_CONTENT");
    } finally {
      restoreWs();
      for (const root of [ws1, ws2]) {
        try {
          fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 50,
          });
        } catch {
          // ignore
        }
      }
    }
  });

  test("resolvePromptSnapshot reports file source, hash, and path", async () => {
    const wsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-scheduler-ws-"),
    );
    const restoreWs = setWorkspaceFoldersForTest(wsRoot);
    const promptsDir = path.join(wsRoot, ".github", "prompts");

    const fileName = `__test_snapshot_meta_${Date.now()}.md`;
    const absPath = path.join(promptsDir, fileName);
    const relPath = path.join(".github", "prompts", fileName);

    try {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(absPath, "FILE_CONTENT", "utf8");

      const { __testOnly } = await import("../../extension");
      const { computePromptHash } = await import("../../promptResolver");
      const resolvePromptSnapshot = __testOnly.resolvePromptSnapshot as (
        task: ScheduledTask,
        preferOpenDocument?: boolean,
      ) => Promise<{
        text: string;
        source: string;
        resolvedPath?: string;
        hash: string;
        candidateCount: number;
        fallbackReason?: string;
      }>;

      const task = {
        id: "t-snapshot-meta",
        name: "t",
        cronExpression: "0 * * * *",
        prompt: "SNAPSHOT",
        enabled: true,
        scope: "global",
        promptSource: "local",
        promptPath: relPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledTask;

      const resolution = await resolvePromptSnapshot(task, false);
      assert.strictEqual(resolution.source, "file");
      assert.strictEqual(resolution.text, "FILE_CONTENT");
      assert.strictEqual(resolution.hash, computePromptHash("FILE_CONTENT"));
      assert.strictEqual(resolution.candidateCount, 1);
      assert.strictEqual(resolution.fallbackReason, undefined);
      assert.ok(resolution.resolvedPath);

      fs.rmSync(absPath, { force: true });
      const missing = await resolvePromptSnapshot(task, false);
      assert.strictEqual(missing.source, "snapshotFallback");
      assert.strictEqual(missing.text, "SNAPSHOT");
      assert.ok(
        missing.fallbackReason === "readFailed" ||
          missing.fallbackReason === "pathUnresolved",
      );
    } finally {
      restoreWs();
      try {
        fs.rmSync(wsRoot, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch {
        // ignore
      }
    }
  });

  test("unavailable prompt preview clears stale file actions", async () => {
    const { __testOnly } = await import("../../extension");
    const buildUnavailable = __testOnly.buildUnavailablePromptPreview as (
      task: ScheduledTask,
    ) => {
      source: string;
      prompt?: string;
      canOpenPromptFile: boolean;
      hasSnapshotDiff: boolean;
      hash: string;
    };
    const task = {
      id: "unavailable-preview",
      name: "Unavailable",
      cronExpression: "0 * * * *",
      prompt: "SAVED_SNAPSHOT",
      enabled: true,
      scope: "workspace",
      promptSource: "local",
      promptPath: ".github/prompts/empty.md",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const preview = buildUnavailable(task);
    assert.strictEqual(preview.source, "snapshotFallback");
    assert.strictEqual(preview.prompt, undefined);
    assert.strictEqual(preview.canOpenPromptFile, false);
    assert.strictEqual(preview.hasSnapshotDiff, false);
    assert.strictEqual(preview.hash.length, 12);
  });
});

suite("Frontmatter Resolution Tests", () => {
  test("forwards the task workspace creation preference through prompt resolution and execution options", async () => {
    const { __testOnly } = await import("../../extension");
    const base = {
      id: "workspace-mode-forwarding",
      name: "Workspace preference",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;
    for (const agentHostWorkspaceMode of [undefined, "folder", "worktree"] as const) {
      const resolved = await __testOnly.resolvePromptExecution(
        { ...base, agentHostWorkspaceMode },
        true,
      );
      assert.strictEqual(resolved.agentHostWorkspaceMode, agentHostWorkspaceMode);
      const options = __testOnly.buildPromptExecutionOptions(resolved);
      assert.strictEqual(options.agentHostWorkspaceMode, agentHostWorkspaceMode);
      assert.strictEqual(options.useCopilotCli, undefined);
      assert.strictEqual(options.targetChatId, undefined);
    }
  });

  test("Uses frontmatter agent/model when task options are not set", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-frontmatter-default",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: '---\nagent: "edit"\nmodel: gpt-4o\n---\nBody',
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "Body");
    assert.strictEqual(resolved.agent, "edit");
    assert.strictEqual(resolved.model, "gpt-4o");
  });

  test("Task agent/model override frontmatter values", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-frontmatter-override",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "---\nagent: ask\nmodel: gpt-4o\n---\nBody",
      enabled: true,
      agent: "edit",
      model: "claude-sonnet-4",
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "Body");
    assert.strictEqual(resolved.agent, "edit");
    assert.strictEqual(resolved.model, "claude-sonnet-4");
  });

  test("Preserves structured model selection metadata from task", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{
          prompt: string;
          agent?: string;
          model?: string;
          modelName?: string;
          modelVendor?: string;
          modelFamily?: string;
          modelVersion?: string;
          modelReasoningEffort?: string;
        }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-frontmatter-structured-model",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      agent: "edit",
      model: "gpt-5.4",
      modelName: "GPT-5.4",
      modelVendor: "OpenAI",
      modelFamily: "gpt-5.4",
      modelVersion: "high",
      modelReasoningEffort: "high",
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "Body");
    assert.strictEqual(resolved.agent, "edit");
    assert.strictEqual(resolved.model, "gpt-5.4");
    assert.strictEqual(resolved.modelName, "GPT-5.4");
    assert.strictEqual(resolved.modelVendor, "OpenAI");
    assert.strictEqual(resolved.modelFamily, "gpt-5.4");
    assert.strictEqual(resolved.modelVersion, "high");
    assert.strictEqual(resolved.modelReasoningEffort, "high");
  });

  test("Explicit empty task agent/model fallback to frontmatter", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-frontmatter-empty",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "---\nagent: ask\nmodel: gpt-4o\n---\nBody",
      enabled: true,
      agent: "",
      model: "",
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "Body");
    assert.strictEqual(resolved.agent, "ask");
    assert.strictEqual(resolved.model, "gpt-4o");
  });

  test("Strips frontmatter even when prompt body is empty", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const rawPrompt = "---\nagent: ask\nmodel: gpt-4o\n---\n";
    const task = {
      id: "t-frontmatter-empty-body",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: rawPrompt,
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "");
    assert.strictEqual(resolved.agent, "ask");
    assert.strictEqual(resolved.model, "gpt-4o");
  });

  test("Does not strip frontmatter block when agent/model keys are missing", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const rawPrompt = "---\ndescription: sample\ntools: []\n---\nBody";
    const task = {
      id: "t-frontmatter-no-keys",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: rawPrompt,
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, rawPrompt);
    assert.strictEqual(resolved.agent, undefined);
    assert.strictEqual(resolved.model, undefined);
  });

  test("Inserts auto hint after frontmatter when frontmatter has no agent/model", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-auto-mode-frontmatter-no-keys",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "---\ndescription: sample\ntools: []\n---\nBody",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      autoMode: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(
      resolved.prompt,
      "---\ndescription: sample\ntools: []\n---\n[auto] Proceed autonomously. Apply all changes directly without asking for confirmation.\n\nBody",
    );
  });

  test("Inserts auto hint at beginning when task.autoMode is true", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-auto-mode-on",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      autoMode: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(
      resolved.prompt,
      "[auto] Proceed autonomously. Apply all changes directly without asking for confirmation.\n\nBody",
    );
  });

  test("Carries the model fallback opt-in into execution options only when enabled", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as (
      task: ScheduledTask,
      preferOpenDocument?: boolean,
    ) => Promise<{ prompt: string; modelFallback?: boolean }>;
    const buildPromptExecutionOptions =
      __testOnly.buildPromptExecutionOptions as (request: {
        prompt: string;
        modelFallback?: boolean;
      }) => { modelFallback?: boolean };

    const base = {
      id: "t-model-fallback",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const optedIn = await resolvePromptExecution(
      { ...base, modelFallback: true },
      true,
    );
    assert.strictEqual(optedIn.modelFallback, true);
    assert.strictEqual(
      buildPromptExecutionOptions(optedIn).modelFallback,
      true,
    );

    const optedOut = await resolvePromptExecution(base, true);
    assert.ok(!("modelFallback" in optedOut));
    assert.ok(!("modelFallback" in buildPromptExecutionOptions(optedOut)));
  });

  test("Does not prefix the auto hint to a prompt that starts with a slash command", async () => {
    const { __testOnly } = await import("../../extension");
    const applyAutoModeHint = __testOnly.applyAutoModeHint as (
      promptText: string,
      enabled: boolean,
    ) => string;

    for (const text of [
      "/my-skill do the thing",
      "/my-skill",
      "  /my-skill\nsecond line",
      "\uFEFF/skill.v2:run args",
      "---\ndescription: x\n---\n/my-skill args",
    ]) {
      assert.strictEqual(applyAutoModeHint(text, true), text, text);
    }

    for (const text of [
      "/usr/bin/tool should be checked",
      "/ not a command",
      "please run /my-skill later",
    ]) {
      assert.ok(
        applyAutoModeHint(text, true).startsWith("[auto] Proceed autonomously"),
        text,
      );
    }

    assert.strictEqual(
      applyAutoModeHint("/my-skill x", false),
      "/my-skill x",
    );
  });

  test("A task whose skill is gone is blocked before it is sent, and a stale reference is ignored", async () => {
    const { __testOnly } = await import("../../extension");
    const assertSkillAvailable = __testOnly.assertSkillAvailable as (
      task: ScheduledTask,
      promptText: string,
    ) => Promise<void>;

    const base = {
      id: "t-skill-check",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "/zz-scheduler-test-missing-skill go",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;
    const skillRef = {
      name: "zz-scheduler-test-missing-skill",
      scope: "user" as const,
      root: ".copilot/skills",
    };

    await assertSkillAvailable(base, base.prompt);
    await assertSkillAvailable({ ...base, skillRef }, "no skill here");
    await assertSkillAvailable(
      { ...base, skillRef: { name: "Bad Name", scope: "user", root: "x" } },
      base.prompt,
    );
    await assert.rejects(
      assertSkillAvailable({ ...base, skillRef }, base.prompt),
      (error: unknown) =>
        (error as Record<string, unknown>).copilotSchedulerPromptBlocked ===
        "skillUnavailable",
    );
  });

  test("Does not insert auto hint when task.autoMode is false", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-auto-mode-off",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      autoMode: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "Body");
  });

  test("Does not duplicate auto hint when prompt already contains auto", async () => {
    const { __testOnly } = await import("../../extension");
    const resolvePromptExecution = __testOnly.resolvePromptExecution as
      | ((
          task: ScheduledTask,
          preferOpenDocument?: boolean,
        ) => Promise<{ prompt: string; agent?: string; model?: string }>)
      | undefined;

    assert.ok(typeof resolvePromptExecution === "function");

    const task = {
      id: "t-auto-mode-no-dup",
      name: "t",
      cronExpression: "0 * * * *",
      prompt: "Body\n\nauto",
      enabled: true,
      scope: "global",
      promptSource: "inline",
      autoMode: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTask;

    const resolved = await resolvePromptExecution(task, true);
    assert.strictEqual(resolved.prompt, "Body\n\nauto");
  });
});
