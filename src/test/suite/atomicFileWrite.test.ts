import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  writeFileAtomically,
  type AtomicFileWriteOps,
} from "../../atomic-file-write";

suite("Atomic File Write", () => {
  test("replaces the target and removes the temporary file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-atomic-"));
    const target = path.join(root, "scheduledTasks.json");
    fs.writeFileSync(target, "old", "utf8");

    try {
      await writeFileAtomically(target, "new");
      assert.strictEqual(fs.readFileSync(target, "utf8"), "new");
      assert.deepStrictEqual(
        fs.readdirSync(root).filter((name) => name.endsWith(".tmp")),
        [],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the previous target when atomic replacement fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-atomic-"));
    const target = path.join(root, "scheduledTasks.json");
    fs.writeFileSync(target, "old", "utf8");
    let tempPath = "";
    const ops: AtomicFileWriteOps = {
      async mkdir(dirPath) {
        await fs.promises.mkdir(dirPath, { recursive: true });
      },
      open(filePath) {
        tempPath = filePath;
        return fs.promises.open(filePath, "wx");
      },
      async rename() {
        throw new Error("rename failed");
      },
      async rm(filePath) {
        await fs.promises.rm(filePath, { force: true });
      },
    };

    try {
      await assert.rejects(
        () => writeFileAtomically(target, "new", ops),
        /rename failed/,
      );
      assert.strictEqual(fs.readFileSync(target, "utf8"), "old");
      assert.ok(tempPath);
      assert.strictEqual(fs.existsSync(tempPath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
