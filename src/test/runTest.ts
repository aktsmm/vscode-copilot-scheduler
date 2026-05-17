/**
 * Copilot Scheduler - Test Runner
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const DEFAULT_TEST_VSCODE_VERSION = "1.115.0";

function getTestVSCodeVersion(): string {
  const configured = process.env.COPILOT_SCHEDULER_VSCODE_TEST_VERSION?.trim();
  return configured || DEFAULT_TEST_VSCODE_VERSION;
}

async function disableWin32VersionedUpdateForTests(
  vscodeExecutablePath: string,
): Promise<void> {
  // VS Code on Windows checks a named mutex `${win32MutexName}setup` when
  // `win32VersionedUpdate` is true. In some environments that mutex can remain
  // active and prevents launching, breaking CI/tests. For integration tests we
  // can safely disable that behavior by toggling the product flag.
  try {
    const appRoot = path.dirname(vscodeExecutablePath);

    const candidateProductJsonPaths: string[] = [];

    // Common layout: <install>/resources/app/product.json
    candidateProductJsonPaths.push(
      path.join(appRoot, "resources", "app", "product.json"),
    );

    // Archive layout: <install>/<commit>/resources/app/product.json
    try {
      const entries = await fs.promises.readdir(appRoot, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        candidateProductJsonPaths.push(
          path.join(appRoot, entry.name, "resources", "app", "product.json"),
        );
      }
    } catch {
      // ignore
    }

    const existingProductJsonPaths = Array.from(
      new Set(candidateProductJsonPaths.filter((p) => fs.existsSync(p))),
    );
    if (existingProductJsonPaths.length === 0) {
      return;
    }

    for (const productJsonPath of existingProductJsonPaths) {
      const raw = await fs.promises.readFile(productJsonPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      if (parsed.win32VersionedUpdate === true) {
        parsed.win32VersionedUpdate = false;
        await fs.promises.writeFile(
          productJsonPath,
          JSON.stringify(parsed, null, 2),
          "utf8",
        );
      }
    }
  } catch {
    // Best effort: if we can't patch the downloaded VS Code, tests may still
    // fail with the "currently being updated" error.
  }
}

async function main(): Promise<void> {
  let testUserDataDir: string | undefined;
  let testExtensionsDir: string | undefined;

  try {
    // The folder containing the Extension Manifest package.json
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");

    // The path to the extension test script
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    // Use a configurable, known-good VS Code build for tests so local stable
    // editor processes do not conflict with the downloaded test instance.
    const vscodeExecutablePath = await downloadAndUnzipVSCode(
      getTestVSCodeVersion(),
    );
    await disableWin32VersionedUpdateForTests(vscodeExecutablePath);

    testUserDataDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "copilot-scheduler-vscode-user-data-"),
    );
    testExtensionsDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "copilot-scheduler-vscode-extensions-"),
    );

    // Download VS Code, unzip it, and run the integration tests
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        "--user-data-dir",
        testUserDataDir,
        "--extensions-dir",
        testExtensionsDir,
        "--disable-updates",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-workspace-trust",
      ],
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled(
      [testUserDataDir, testExtensionsDir]
        .filter((dir): dir is string => typeof dir === "string")
        .map((dir) =>
          fs.promises.rm(dir, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 50,
          }),
        ),
    );
  }
}

main();
