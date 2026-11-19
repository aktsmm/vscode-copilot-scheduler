/**
 * Test-only guard. A ScheduleManager starts a background save as soon as it
 * loads, so a test that removes its temp folder right away can have the folder
 * recreated by that save. After each test this waits for those saves and
 * removes such folders again. Only folders a test already removed, that still
 * hold nothing but scheduler store files, are touched.
 */
import nodeFs = require("fs");
import * as os from "os";
import * as path from "path";
import { ScheduleManager } from "../../scheduleManager";

const SETTLE_TIMEOUT_MS = 1500;
const FOLDER_PREFIX = "copilot-scheduler-";

const pendingSaves = new Set<Promise<unknown>>();
const removedFolders = new Set<string>();

type SaveHost = { enqueueSave: (...args: unknown[]) => Promise<unknown> };
const saveHost = ScheduleManager.prototype as unknown as SaveHost;
const originalEnqueueSave = saveHost.enqueueSave;
saveHost.enqueueSave = function (this: unknown, ...args: unknown[]) {
  const save = originalEnqueueSave.apply(this, args);
  pendingSaves.add(save);
  const forget = () => {
    pendingSaves.delete(save);
  };
  save.then(forget, forget);
  return save;
};

const originalRmSync = nodeFs.rmSync;
Object.defineProperty(nodeFs, "rmSync", {
  configurable: true,
  writable: true,
  value: (target: nodeFs.PathLike, options?: nodeFs.RmOptions) => {
    if (options?.recursive) removedFolders.add(path.resolve(String(target)));
    return originalRmSync(target, options);
  },
});

function holdsOnlySchedulerStoreFiles(folder: string): boolean {
  return nodeFs
    .readdirSync(folder)
    .every((name) => name.startsWith("scheduledTasks") || name.startsWith(".scheduledTasks"));
}

teardown(async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...pendingSaves]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SETTLE_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  const tempRoot = path.resolve(os.tmpdir());
  for (const folder of removedFolders) {
    try {
      if (
        path.dirname(folder) === tempRoot &&
        path.basename(folder).startsWith(FOLDER_PREFIX) &&
        nodeFs.existsSync(folder) &&
        holdsOnlySchedulerStoreFiles(folder)
      ) {
        originalRmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    } catch {
      // Best effort: a folder that cannot be removed is left for the OS temp cleanup.
    }
  }
  removedFolders.clear();
});
