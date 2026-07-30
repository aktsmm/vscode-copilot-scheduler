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
