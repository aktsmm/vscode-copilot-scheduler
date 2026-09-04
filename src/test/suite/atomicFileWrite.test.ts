import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  cleanupOrphanedAtomicWriteTemps,
  ORPHANED_ATOMIC_TEMP_MINIMUM_AGE_MS,
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

  test("cleans only stale orphaned temp files owned by dead processes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-atomic-"));
    const target = path.join(root, "scheduledTasks.json");
    const now = Date.UTC(2026, 8, 4, 0, 0, 0);
    const old = now - ORPHANED_ATOMIC_TEMP_MINIMUM_AGE_MS - 1000;
    const names = {
      stale: `.scheduledTasks.json.101.${old}.stale.tmp`,
      live: `.scheduledTasks.json.202.${old}.live.tmp`,
      fresh: `.scheduledTasks.json.303.${now}.fresh.tmp`,
      otherTarget: `.scheduledTasks.meta.json.101.${old}.other.tmp`,
      malformed: `.scheduledTasks.json.invalid.${old}.bad.tmp`,
      directory: `.scheduledTasks.json.101.${old}.directory.tmp`,
    };

    try {
      for (const name of [
        names.stale,
        names.live,
        names.fresh,
        names.otherTarget,
        names.malformed,
      ]) {
        fs.writeFileSync(path.join(root, name), "temp", "utf8");
      }
      fs.mkdirSync(path.join(root, names.directory));
      const oldDate = new Date(old);
      fs.utimesSync(path.join(root, names.stale), oldDate, oldDate);
      fs.utimesSync(path.join(root, names.live), oldDate, oldDate);
      fs.utimesSync(path.join(root, names.otherTarget), oldDate, oldDate);
      fs.utimesSync(path.join(root, names.malformed), oldDate, oldDate);

      const removed = await cleanupOrphanedAtomicWriteTemps(target, {
        now,
        isProcessAlive: (pid) => pid === 202,
      });

      assert.strictEqual(removed, 1);
      assert.strictEqual(fs.existsSync(path.join(root, names.stale)), false);
      for (const name of Object.values(names).filter(
        (name) => name !== names.stale,
      )) {
        assert.strictEqual(
          fs.existsSync(path.join(root, name)),
          true,
          `${name} should be retained`,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps stale temp files owned by the current process", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-atomic-"));
    const target = path.join(root, "scheduledTasks.json");
    const now = Date.now();
    const old = now - ORPHANED_ATOMIC_TEMP_MINIMUM_AGE_MS - 1000;
    const name = `.scheduledTasks.json.${process.pid}.${old}.active.tmp`;
    const tempPath = path.join(root, name);

    try {
      fs.writeFileSync(tempPath, "temp", "utf8");
      const oldDate = new Date(old);
      fs.utimesSync(tempPath, oldDate, oldDate);

      assert.strictEqual(
        await cleanupOrphanedAtomicWriteTemps(target, { now }),
        0,
      );
      assert.strictEqual(fs.existsSync(tempPath), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows concurrent cleanup attempts to converge safely", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-atomic-"));
    const target = path.join(root, "scheduledTasks.json");
    const now = Date.now();
    const old = now - ORPHANED_ATOMIC_TEMP_MINIMUM_AGE_MS - 1000;
    const tempPath = path.join(
      root,
      `.scheduledTasks.json.404.${old}.concurrent.tmp`,
    );

    try {
      fs.writeFileSync(tempPath, "temp", "utf8");
      const oldDate = new Date(old);
      fs.utimesSync(tempPath, oldDate, oldDate);
      const options = { now, isProcessAlive: () => false };

      const removedCounts = await Promise.all([
        cleanupOrphanedAtomicWriteTemps(target, options),
        cleanupOrphanedAtomicWriteTemps(target, options),
      ]);

      assert.ok(removedCounts.every((count) => count === 0 || count === 1));
      assert.ok(removedCounts.some((count) => count === 1));
      assert.strictEqual(fs.existsSync(tempPath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
