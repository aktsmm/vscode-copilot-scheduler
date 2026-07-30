import { lock } from "proper-lockfile";

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_LOCK_MS = 120000;

export class TaskStoreLockBusyError extends Error {
  constructor() {
    super("Task store lock is busy");
    this.name = "TaskStoreLockBusyError";
  }
}

export async function withTaskStoreLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options?: {
    timeoutMs?: number;
    retryDelayMs?: number;
    staleLockMs?: number;
  },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleLockMs = options?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const retries = Math.max(0, Math.ceil(timeoutMs / retryDelayMs) - 1);
  let release: (() => Promise<void>) | undefined;

  try {
    release = await lock(lockPath, {
      realpath: false,
      lockfilePath: lockPath,
      stale: staleLockMs,
      update: Math.max(1000, Math.floor(staleLockMs / 3)),
      retries: {
        retries,
        factor: 1,
        minTimeout: retryDelayMs,
        maxTimeout: retryDelayMs,
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new TaskStoreLockBusyError();
    }
    throw error;
  }

  try {
    return await operation();
  } finally {
    await release();
  }
}
