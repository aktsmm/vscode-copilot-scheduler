import * as fs from "fs";
import * as path from "path";

export type AtomicFileWriteOps = {
  mkdir(dirPath: string): Promise<void>;
  open(filePath: string): Promise<fs.promises.FileHandle>;
  rename(sourcePath: string, targetPath: string): Promise<void>;
  rm(filePath: string): Promise<void>;
};

const defaultOps: AtomicFileWriteOps = {
  async mkdir(dirPath) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  },
  open(filePath) {
    return fs.promises.open(filePath, "wx");
  },
  rename(sourcePath, targetPath) {
    return fs.promises.rename(sourcePath, targetPath);
  },
  async rm(filePath) {
    await fs.promises.rm(filePath, { force: true });
  },
};

export const ORPHANED_ATOMIC_TEMP_MINIMUM_AGE_MS = 24 * 60 * 60 * 1000;

type OrphanedAtomicTempCleanupOptions = {
  now?: number;
  minimumAgeMs?: number;
  isProcessAlive?: (pid: number) => boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function cleanupOrphanedAtomicWriteTemps(
  targetPath: string,
  options: OrphanedAtomicTempCleanupOptions = {},
): Promise<number> {
  const directory = path.dirname(targetPath);
  const targetName = path.basename(targetPath);
  const pattern = new RegExp(
    `^\\.${escapeRegExp(targetName)}\\.(\\d+)\\.(\\d+)\\.([a-z0-9]+)\\.tmp$`,
  );
  const now = Number.isFinite(options.now) ? options.now! : Date.now();
  const minimumAgeMs =
    Number.isFinite(options.minimumAgeMs) && options.minimumAgeMs! >= 0
      ? options.minimumAgeMs!
      : ORPHANED_ATOMIC_TEMP_MINIMUM_AGE_MS;
  const checkProcessAlive = options.isProcessAlive ?? isProcessAlive;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = pattern.exec(entry.name);
    if (!match) continue;

    const ownerPid = Number(match[1]);
    const createdAt = Number(match[2]);
    if (checkProcessAlive(ownerPid)) continue;

    const tempPath = path.join(directory, entry.name);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(tempPath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    if (now - createdAt < minimumAgeMs || now - stats.mtimeMs < minimumAgeMs) {
      continue;
    }

    try {
      await fs.promises.rm(tempPath);
      removed += 1;
    } catch {
      // Another process may still own or have replaced the file.
    }
  }
  return removed;
}

export async function writeFileAtomically(
  targetPath: string,
  content: string,
  ops: AtomicFileWriteOps = defaultOps,
): Promise<void> {
  const dir = path.dirname(targetPath);
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  let handle: fs.promises.FileHandle | undefined;

  await ops.mkdir(dir);
  try {
    handle = await ops.open(tempPath);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await ops.rename(tempPath, targetPath);
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await ops.rm(tempPath).catch(() => undefined);
  }
}
