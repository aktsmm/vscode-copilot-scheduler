import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  MAX_TASK_ATTACHMENTS,
  getAttachmentDisplayName,
  isDeniedAttachmentPath,
  normalizeAttachmentPath,
  normalizeAttachments,
  resolveAttachments,
} from "../../attachmentResolver";
import type { TaskAttachment } from "../../types";

function makeAttachments(count: number): TaskAttachment[] {
  return Array.from({ length: count }, (_, index) => ({
    source: "local" as const,
    path: `docs/file-${index}.md`,
  }));
}

suite("Attachment Resolver", () => {
  test("normalizeAttachmentPath rejects absolute paths and traversal", () => {
    assert.strictEqual(normalizeAttachmentPath("docs/a.md"), "docs/a.md");
    assert.strictEqual(normalizeAttachmentPath(".\\docs\\a.md"), "docs/a.md");
    assert.strictEqual(normalizeAttachmentPath("  docs/a.md  "), "docs/a.md");
    assert.strictEqual(normalizeAttachmentPath("../secret.md"), undefined);
    assert.strictEqual(normalizeAttachmentPath("docs/../../x.md"), undefined);
    assert.strictEqual(normalizeAttachmentPath("C:/Windows/win.ini"), undefined);
    assert.strictEqual(normalizeAttachmentPath("/etc/passwd"), undefined);
    assert.strictEqual(normalizeAttachmentPath(""), undefined);
    assert.strictEqual(normalizeAttachmentPath(42), undefined);
  });

  test("isDeniedAttachmentPath blocks secret-bearing files", () => {
    assert.ok(isDeniedAttachmentPath(".env"));
    assert.ok(isDeniedAttachmentPath("config/.env.local"));
    assert.ok(isDeniedAttachmentPath("certs/server.pem"));
    assert.ok(isDeniedAttachmentPath("certs/server.key"));
    assert.ok(isDeniedAttachmentPath("keys/id_rsa"));
    assert.ok(isDeniedAttachmentPath("secrets/tokens.md"));
    assert.ok(isDeniedAttachmentPath(".ssh/config"));
    assert.ok(!isDeniedAttachmentPath("docs/readme.md"));
    assert.ok(!isDeniedAttachmentPath(".github/instructions/a.instructions.md"));
  });

  test("normalizeAttachments rejects local attachments on global-scope tasks", () => {
    const result = normalizeAttachments(
      [{ source: "local", path: "docs/a.md" }],
      "global",
    );

    assert.strictEqual(result.attachments.length, 0);
    assert.strictEqual(result.rejected[0]?.reason, "localOnGlobalScope");
  });

  test("normalizeAttachments keeps global attachments on global-scope tasks", () => {
    const result = normalizeAttachments(
      [{ source: "global", path: "shared/notes.md" }],
      "global",
    );

    assert.deepStrictEqual(result.attachments, [
      { source: "global", path: "shared/notes.md" },
    ]);
    assert.strictEqual(result.rejected.length, 0);
  });

  test("normalizeAttachments reports traversal, absolute and denied paths", () => {
    const traversal = normalizeAttachments(
      [{ source: "local", path: "../outside.md" }],
      "workspace",
    );
    assert.strictEqual(traversal.rejected[0]?.reason, "traversal");

    const absolute = normalizeAttachments(
      [{ source: "local", path: "/etc/passwd" }],
      "workspace",
    );
    assert.strictEqual(absolute.rejected[0]?.reason, "absolutePath");

    const denied = normalizeAttachments(
      [{ source: "local", path: ".env" }],
      "workspace",
    );
    assert.strictEqual(denied.rejected[0]?.reason, "denied");
  });

  test("normalizeAttachments de-duplicates and enforces the limit", () => {
    const duplicated = normalizeAttachments(
      [
        { source: "local", path: "docs/a.md" },
        { source: "local", path: "docs/a.md" },
      ],
      "workspace",
    );
    assert.strictEqual(duplicated.attachments.length, 1);
    assert.strictEqual(duplicated.changed, true);

    const tooMany = normalizeAttachments(
      makeAttachments(MAX_TASK_ATTACHMENTS + 1),
      "workspace",
    );
    assert.strictEqual(tooMany.attachments.length, MAX_TASK_ATTACHMENTS);
    assert.strictEqual(tooMany.rejected[0]?.reason, "tooMany");
  });

  test("normalizeAttachments heals corrupted persisted values", () => {
    const notArray = normalizeAttachments("nope", "workspace");
    assert.strictEqual(notArray.attachments.length, 0);
    assert.strictEqual(notArray.changed, true);

    const badEntries = normalizeAttachments(
      [null, { source: "weird", path: "a.md" }, { source: "local", path: 5 }],
      "workspace",
    );
    assert.strictEqual(badEntries.attachments.length, 0);
    assert.strictEqual(badEntries.changed, true);

    const empty = normalizeAttachments(undefined, "workspace");
    assert.strictEqual(empty.attachments.length, 0);
    assert.strictEqual(empty.changed, false);
  });

  test("resolveAttachments resolves existing files and reports missing ones", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-attachments-"));
    try {
      const localRoot = path.join(tmp, "workspace");
      const globalRoot = path.join(tmp, "global");
      fs.mkdirSync(path.join(localRoot, "docs"), { recursive: true });
      fs.mkdirSync(globalRoot, { recursive: true });
      fs.writeFileSync(path.join(localRoot, "docs", "a.md"), "a", "utf8");
      fs.writeFileSync(path.join(globalRoot, "shared.md"), "s", "utf8");

      const result = resolveAttachments(
        [
          { source: "local", path: "docs/a.md" },
          { source: "global", path: "shared.md" },
          { source: "local", path: "docs/missing.md" },
        ],
        { localRoots: [localRoot], globalRoot },
      );

      assert.strictEqual(result.resolved.length, 2);
      assert.strictEqual(result.missing.length, 1);
      assert.strictEqual(result.missing[0]?.path, "docs/missing.md");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test("resolveAttachments re-applies the denylist and boundary at run time", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-attachments-"));
    try {
      const localRoot = path.join(tmp, "workspace");
      fs.mkdirSync(localRoot, { recursive: true });
      fs.writeFileSync(path.join(localRoot, ".env"), "SECRET=1", "utf8");
      fs.writeFileSync(path.join(tmp, "outside.md"), "x", "utf8");

      const denied = resolveAttachments([{ source: "local", path: ".env" }], {
        localRoots: [localRoot],
      });
      assert.strictEqual(denied.resolved.length, 0);
      assert.strictEqual(denied.missing.length, 1);

      const outside = resolveAttachments(
        [{ source: "local", path: "../outside.md" }],
        { localRoots: [localRoot] },
      );
      assert.strictEqual(outside.resolved.length, 0);
      assert.strictEqual(outside.missing.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test("resolveAttachments treats a directory as missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-attachments-"));
    try {
      fs.mkdirSync(path.join(tmp, "docs"), { recursive: true });
      const result = resolveAttachments([{ source: "local", path: "docs" }], {
        localRoots: [tmp],
      });
      assert.strictEqual(result.resolved.length, 0);
      assert.strictEqual(result.missing.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test("getAttachmentDisplayName returns the file name", () => {
    assert.strictEqual(
      getAttachmentDisplayName({
        source: "local",
        path: ".github/instructions/style.instructions.md",
      }),
      "style.instructions.md",
    );
    assert.strictEqual(
      getAttachmentDisplayName({ source: "local", path: "../bad" }),
      "",
    );
  });
});
