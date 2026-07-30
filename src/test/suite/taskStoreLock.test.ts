import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  TaskStoreLockBusyError,
  withTaskStoreLock,
} from "../../task-store-lock";

suite("Task Store Lock", () => {
  test("rejects a second writer while the lock is held", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lock-"));
    const lockPath = path.join(root, "scheduledTasks.lock");
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    try {
      const first = withTaskStoreLock(lockPath, async () => {
        resolveStarted?.();
        await gate;
      });
      await started;
      await assert.rejects(
        () =>
          withTaskStoreLock(lockPath, async () => undefined, {
            timeoutMs: 10,
            retryDelayMs: 2,
          }),
        (error: unknown) => error instanceof TaskStoreLockBusyError,
      );
      releaseFirst?.();
      await first;
      assert.strictEqual(fs.existsSync(lockPath), false);
    } finally {
      releaseFirst?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers a stale lock file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lock-"));
    const lockPath = path.join(root, "scheduledTasks.lock");
    fs.mkdirSync(lockPath);
    const old = new Date(Date.now() - 10000);
    fs.utimesSync(lockPath, old, old);

    try {
      const result = await withTaskStoreLock(
        lockPath,
        async () => "recovered",
        { staleLockMs: 1 },
      );
      assert.strictEqual(result, "recovered");
      assert.strictEqual(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
