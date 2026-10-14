#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual, parseArgs } = require("util");
const yauzl = require("yauzl");

const FORBIDDEN_PATTERNS = [
  /^extension\/research\//,
  /^extension\/artifacts\//,
  /^extension\/output_sessions\//,
  /^extension\/session\//,
  /^extension\/\.github\//,
  /^extension\/\.vscode\//,
  /^extension\/\.vscode-test\//,
  /^extension\/\.orchestrator\//,
  /^extension\/\.playwright-mcp\//,
  /^extension\/scripts\//,
  /^extension\/src\//,
  /^extension\/tmp[-_]/,
  /^extension\/\.eslintrc\./,
  /^extension\/.*\.vsix$/,
  /^extension\/.*\.map$/,
];

// A forbidden-only check passes on an empty listing, so require the runtime files too.
// vsce normalizes README/LICENSE casing and appends .txt to an extensionless LICENSE.
const REQUIRED_ENTRIES = [
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

function readUInt16(buffer, offset) {
  ensureBufferRange(buffer, offset, 2, "16-bit field");
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset) {
  ensureBufferRange(buffer, offset, 4, "32-bit field");
  return buffer.readUInt32LE(offset);
}

function ensureBufferRange(buffer, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > buffer.length - length
  ) {
    throw new Error(`Invalid VSIX: ${label} is outside the archive`);
  }
}

function findEndOfCentralDirectory(buffer) {
  if (buffer.length < 22) {
    throw new Error("Invalid VSIX: archive is shorter than the ZIP footer");
  }
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (readUInt32(buffer, offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("Invalid VSIX: end of central directory not found");
}

function listZipEntries(filePath) {
  const buffer = fs.readFileSync(filePath);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = readUInt16(buffer, eocdOffset + 10);
  const centralDirectorySize = readUInt32(buffer, eocdOffset + 12);
  const centralDirectoryOffset = readUInt32(buffer, eocdOffset + 16);
  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error("Invalid VSIX: ZIP64 archives are not supported");
  }
  if (
    centralDirectoryOffset > eocdOffset ||
    centralDirectorySize > eocdOffset - centralDirectoryOffset
  ) {
    throw new Error("Invalid VSIX: central directory is outside the archive");
  }
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  const entries = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index++) {
    ensureBufferRange(buffer, offset, 46, `central directory entry ${index}`);
    if (offset + 46 > centralDirectoryEnd) {
      throw new Error(
        `Invalid VSIX: central directory entry ${index} exceeds the declared directory size`,
      );
    }
    if (readUInt32(buffer, offset) !== 0x02014b50) {
      throw new Error(
        `Invalid VSIX: central directory entry ${index} is malformed`,
      );
    }
    const fileNameLength = readUInt16(buffer, offset + 28);
    const extraFieldLength = readUInt16(buffer, offset + 30);
    const fileCommentLength = readUInt16(buffer, offset + 32);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    const nextOffset = fileNameEnd + extraFieldLength + fileCommentLength;
    ensureBufferRange(
      buffer,
      fileNameStart,
      fileNameLength + extraFieldLength + fileCommentLength,
      `central directory entry ${index} variable fields`,
    );
    if (nextOffset > centralDirectoryEnd) {
      throw new Error(
        `Invalid VSIX: central directory entry ${index} exceeds the declared directory size`,
      );
    }
    entries.push(
      buffer.toString("utf8", fileNameStart, fileNameEnd).replace(/\\/g, "/"),
    );
    offset = nextOffset;
  }

  if (offset !== centralDirectoryEnd) {
    throw new Error(
      "Invalid VSIX: central directory size does not match its entries",
    );
  }

  return entries;
}

function verifyVsix(filePath) {
  const resolvedPath = path.resolve(filePath);
  const entries = listZipEntries(resolvedPath);
  const lowerEntries = new Set(entries.map((entry) => entry.toLowerCase()));
  let ok = true;

  const seenEntries = new Set();
  const duplicateEntries = [];
  for (const entry of entries) {
    const normalizedEntry = entry.toLowerCase();
    if (seenEntries.has(normalizedEntry)) {
      duplicateEntries.push(entry);
    } else {
      seenEntries.add(normalizedEntry);
    }
  }
  if (duplicateEntries.length > 0) {
    console.error(`Duplicate entries found in ${resolvedPath}:`);
    for (const entry of duplicateEntries) console.error(`- ${entry}`);
    ok = false;
  }

  const missingEntries = REQUIRED_ENTRIES.filter(
    (required) => !lowerEntries.has(required.toLowerCase()),
  );
  if (missingEntries.length > 0) {
    console.error(`Required entries missing from ${resolvedPath}:`);
    for (const entry of missingEntries) {
      console.error(`- ${entry}`);
    }
    ok = false;
  }

  const forbiddenEntries = entries.filter((entry) =>
    FORBIDDEN_PATTERNS.some((pattern) => pattern.test(entry.toLowerCase())),
  );
  if (forbiddenEntries.length > 0) {
    console.error(`Forbidden entries found in ${resolvedPath}:`);
    for (const entry of forbiddenEntries) {
      console.error(`- ${entry}`);
    }
    ok = false;
  }

  if (!ok) {
    return false;
  }

  console.log(
    `Verified ${path.basename(resolvedPath)}: ${entries.length} entries, ${REQUIRED_ENTRIES.length} required present, no dev-only artifacts found.`,
  );
  return true;
}

async function verifyVsixBuild(
  filePath,
  buildRoot = path.resolve(__dirname, ".."),
) {
  if (!verifyVsix(filePath)) return false;
  const manifest = JSON.parse(
    fs.readFileSync(path.join(buildRoot, "package.json"), "utf8"),
  );
  const expected = new Map(
    [
      "out/extension.js",
      "media/schedulerWebview.js",
      "package.nls.json",
      "package.nls.ja.json",
      "images/icon.png",
      "images/scheduler-icon.svg",
    ].map((name) => [
      `extension/${name}`,
      fs.readFileSync(path.join(buildRoot, name)),
    ]),
  );
  const seen = new Set();
  const manifestEntry = "extension/package.json";

  await new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, validateEntrySizes: true },
      (openError, zip) => {
        if (openError) return reject(openError);
        let failed = false;
        const fail = (error) => {
          if (failed) return;
          failed = true;
          zip.close();
          reject(error);
        };
        zip.on("error", fail);
        zip.on("end", () => {
          if (failed) return;
          for (const name of [...expected.keys(), manifestEntry]) {
            if (!seen.has(name))
              return fail(new Error(`Build entry missing: ${name}`));
          }
          resolve();
        });
        zip.on("entry", (entry) => {
          if (failed) return;
          const name = entry.fileName;
          if (!expected.has(name) && name !== manifestEntry) {
            zip.readEntry();
            return;
          }
          const expectedBytes = expected.get(name);
          const limit = expectedBytes ? expectedBytes.length : 1024 * 1024;
          if (
            entry.uncompressedSize > limit ||
            (expectedBytes && entry.uncompressedSize !== limit)
          ) {
            return fail(new Error(`Build content mismatch: ${name}`));
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(streamError);
            const chunks = [];
            let size = 0;
            stream.on("error", fail);
            stream.on("data", (chunk) => {
              size += chunk.length;
              if (size > limit) {
                stream.destroy();
                fail(new Error(`Build content mismatch: ${name}`));
                return;
              }
              chunks.push(chunk);
            });
            stream.on("end", () => {
              if (failed) return;
              try {
                const content = Buffer.concat(chunks);
                if (name === manifestEntry) {
                  const packaged = JSON.parse(content.toString("utf8"));
                  if (!isDeepStrictEqual(packaged, manifest)) {
                    throw new Error("Manifest mismatch: package.json");
                  }
                } else if (!content.equals(expectedBytes)) {
                  throw new Error(`Build content mismatch: ${name}`);
                }
                seen.add(name);
                zip.readEntry();
              } catch (error) {
                fail(error);
              }
            });
          });
        });
        zip.readEntry();
      },
    );
  });
  console.log(
    `Verified build identity: ${expected.size} runtime assets and manifest fields match.`,
  );
  return true;
}

/** The VSIX this repository builds for the current manifest version. */
function findDefaultVsixPaths() {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
  );
  const fileName = `${manifest.name}-${manifest.version}.vsix`;
  const candidates = [
    path.resolve(__dirname, "..", "artifacts", "vsix", fileName),
    path.resolve(__dirname, "..", fileName),
  ];
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

async function readVsixManifest(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      let found = false;
      zip.on("error", reject);
      zip.on("end", () => {
        if (!found) reject(new Error("VSIX manifest was not found"));
      });
      zip.on("entry", (entry) => {
        if (entry.fileName !== "extension/package.json") return zip.readEntry();
        if (entry.uncompressedSize > 1024 * 1024) {
          zip.close();
          reject(new Error("VSIX manifest exceeds the size limit"));
          return;
        }
        found = true;
        zip.openReadStream(entry, (readError, stream) => {
          if (readError) {
            zip.close();
            reject(readError);
            return;
          }
          const chunks = [];
          stream.on("error", (streamError) => {
            zip.close();
            reject(streamError);
          });
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            zip.close();
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (parseError) {
              reject(parseError);
            }
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function verifyVsixMarketplace(vsixPath, allowedProposals = []) {
  if (allowedProposals.some((proposal) => proposal !== "languageModelSystem")) {
    throw new Error("Unsupported publication exception: only languageModelSystem is permitted.");
  }
  const manifest = await readVsixManifest(vsixPath);
  if (
    manifest.enableProposedApi ||
    (Object.hasOwn(manifest, "enabledApiProposals") &&
      (!Array.isArray(manifest.enabledApiProposals) ||
        manifest.enabledApiProposals.some((proposal) => !allowedProposals.includes(proposal))))
  ) {
    throw new Error(
      "Marketplace publication blocked: the VSIX declares proposed APIs. Keep this build local or prepare an explicitly approved stable-API package.",
    );
  }
  console.log(
    "Verified Marketplace publication guard: only explicitly allowed proposals, if any.",
  );
  return true;
}

async function verifyInstalledVsix(vsixPath, executable) {
  if (!fs.existsSync(executable))
    throw new Error("Isolated VS Code executable is missing");
  const os = require("os");
  const crypto = require("crypto");
  const cp = require("child_process");
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "scheduler installed smoke-"),
  );
  const data = path.join(root, "user-data");
  const extensions = path.join(root, "extensions");
  const resultPath = path.join(root, "result.json");
  const runId = crypto.randomUUID();
  const expected = await readVsixManifest(vsixPath);
  const packageDigest = crypto
    .createHash("sha256")
    .update(fs.readFileSync(vsixPath))
    .digest("hex");
  const environment = { ...process.env };
  for (const name of Object.keys(environment))
    if (
      /^(?:ELECTRON_RUN_AS_NODE|VSCODE_PORTABLE|VSCODE_IPC_HOOK.*)$/i.test(name)
    )
      delete environment[name];
  const id = `${expected.publisher}.${expected.name}`;
  let ready = false;
  try {
    fs.mkdirSync(extensions, { recursive: true });
    const app = path.dirname(executable);
    const cliCandidates = [
      app,
      ...fs
        .readdirSync(app, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(app, entry.name)),
    ]
      .map((directory) => path.join(directory, "resources/app/out/cli.js"))
      .filter((file) => fs.existsSync(file));
    if (cliCandidates.length !== 1)
      throw new Error("The isolated host CLI location is ambiguous");
    const cli = [executable, cliCandidates[0]];
    const install = cp.spawnSync(
      cli[0],
      [
        ...cli.slice(1),
        "--user-data-dir",
        data,
        "--extensions-dir",
        extensions,
        "--install-extension",
        path.resolve(vsixPath),
        "--force",
        "--disable-updates",
      ],
      {
        encoding: "utf8",
        shell: false,
        env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    if (install.status !== 0)
      throw new Error(`Isolated VSIX install failed (${install.status})`);
    const helper = path.join(
      extensions,
      "local-check.scheduler-installed-smoke",
    );
    fs.mkdirSync(helper);
    fs.writeFileSync(
      path.join(helper, "package.json"),
      JSON.stringify({
        name: "scheduler-installed-smoke",
        publisher: "local-check",
        version: "0.0.1",
        engines: { vscode: "^1.141.0" },
        main: "entry.cjs",
        files: ["entry.cjs"],
        activationEvents: ["onStartupFinished"],
      }),
    );
    fs.writeFileSync(
      path.join(helper, "entry.cjs"),
      `const vscode=require('vscode'),fs=require('fs'),path=require('path'),assert=require('assert/strict');const file=${JSON.stringify(resultPath)},runId=${JSON.stringify(runId)};let phase='helperMode',activeToken;function mark(values){let old={runId};try{const parsed=JSON.parse(fs.readFileSync(file,'utf8'));if(parsed.runId===runId)old=parsed;}catch{}fs.writeFileSync(file,JSON.stringify({...old,...values}));}exports.activate=(context)=>{const watcher=fs.watch(${JSON.stringify(root)},(_event,name)=>{if(String(name)==='abort.json'){activeToken?.cancel();mark({passed:false,reason:'Installed smoke reached its deadline'});void vscode.commands.executeCommand('workbench.action.closeWindow');}});context.subscriptions.push({dispose:()=>watcher.close()});setImmediate(async()=>{const token=activeToken=new vscode.CancellationTokenSource();context.subscriptions.push(token);try{assert.equal(context.extensionMode,vscode.ExtensionMode.Production);phase='installedLocation';const target=vscode.extensions.getExtension(${JSON.stringify(id)});assert(target);const relative=path.relative(${JSON.stringify(extensions)},target.extensionUri.fsPath);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));phase='activation';await target.activate();phase='version';assert.equal(target.packageJSON.version,${JSON.stringify(expected.version)});phase='permission';const proposals=target.packageJSON.enabledApiProposals||[];assert(!proposals.includes('languageModelSystem'));phase='invokeQuery';const result=await vscode.lm.invokeTool('scheduler_query',{input:{kind:'list_models'}},token.token);phase='queryPayload';const text=result.content.map(part=>typeof part.value==='string'?part.value:'').join('');const payload=JSON.parse(text);assert.equal(payload.ok,true);assert.equal(payload.configurationExecutionRequirements.systemMessages,'blocked');assert.equal(payload.configurationExecutionRequirements.explicitChatParticipant,true);mark({passed:true,version:target.packageJSON.version,targetInstalledLocation:true,helperProductionMode:true,systemPermission:false,toolContractVerified:true,modelInferenceInvokedByProbe:false});}catch(error){mark({passed:false,reason:'Installed extension contract failed at '+phase,errorType:error?.name||'Error'});}finally{await vscode.commands.executeCommand('workbench.action.closeWindow');}});};exports.deactivate=()=>mark({windowClosed:true});`,
    );
    const helperVsix = path.join(root, "installed-smoke-helper.vsix");
    await require("@vscode/vsce").createVSIX({
      cwd: helper,
      packagePath: helperVsix,
      dependencies: false,
      allowMissingRepository: true,
      skipLicense: true,
    });
    const installHelper = cp.spawnSync(
      cli[0],
      [
        ...cli.slice(1),
        "--user-data-dir",
        data,
        "--extensions-dir",
        extensions,
        "--install-extension",
        helperVsix,
        "--force",
        "--disable-updates",
      ],
      {
        encoding: "utf8",
        shell: false,
        env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    if (installHelper.status !== 0)
      throw new Error(
        `Isolated helper VSIX install failed (${installHelper.status})`,
      );
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    await new Promise((resolve, reject) => {
      let processExited = false;
      let grace;
      const inspect = () => {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
          if (result.runId === runId && result.windowClosed && processExited) {
            clearTimeout(deadline);
            clearTimeout(grace);
            watcher.close();
            ready = true;
            result.passed ? resolve() : reject(new Error(result.reason));
          }
        } catch {}
      };
      const watcher = fs.watch(root, inspect);
      const deadline = setTimeout(() => {
        fs.writeFileSync(
          path.join(root, "abort.json"),
          JSON.stringify({ runId }),
        );
        grace = setTimeout(() => {
          watcher.close();
          reject(
            new Error(
              "Installed smoke did not close; environment retained for owned cleanup",
            ),
          );
        }, 15000);
      }, 90000);
      const child = cp.spawn(
        executable,
        [
          "--new-window",
          "--user-data-dir",
          data,
          "--extensions-dir",
          extensions,
          "--disable-updates",
          "--skip-welcome",
          "--skip-release-notes",
          "--disable-workspace-trust",
          workspace,
        ],
        { shell: false, stdio: "ignore", env: environment },
      );
      child.once("error", () => {
        clearTimeout(deadline);
        clearTimeout(grace);
        watcher.close();
        reject(new Error("Installed smoke launcher failed"));
      });
      child.once("exit", () => {
        processExited = true;
        inspect();
      });
    });
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    if (
      packageDigest !==
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(vsixPath))
        .digest("hex")
    )
      throw new Error("The VSIX changed during installed verification");
    console.log(
      JSON.stringify({
        installedSmoke: result,
        packageSha256: packageDigest,
      }),
    );
    return true;
  } finally {
    if (
      ready ||
      !fs.existsSync(
        path.join(extensions, "local-check.scheduler-installed-smoke"),
      )
    )
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    else
      console.error(`Owned incomplete smoke retained: ${path.basename(root)}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      "verify-build": { type: "boolean", default: false },
      "verify-marketplace": { type: "boolean", default: false },
      "allow-proposed-apis": { type: "string" },
      "verify-installed": { type: "boolean", default: false },
      "vscode-executable": { type: "string" },
    },
    allowPositionals: true,
  });
  let vsixPaths = positionals;
  if (vsixPaths.length === 0) {
    vsixPaths = findDefaultVsixPaths();
    if (vsixPaths.length === 0) {
      console.error(
        "Usage: node scripts/verify-vsix-contents.js [--verify-build] [--verify-marketplace] [path-to.vsix ...]",
      );
      console.error(
        "No argument was given and no VSIX for the current version was found in artifacts/vsix/ or the repository root. Run `npx @vscode/vsce package` first.",
      );
      process.exitCode = 2;
      return;
    }
  }

  let ok = true;
  try {
    for (const vsixPath of vsixPaths) {
      ok =
        (values["verify-build"]
          ? await verifyVsixBuild(vsixPath)
          : verifyVsix(vsixPath)) && ok;
      if (ok && values["verify-marketplace"]) {
        ok = await verifyVsixMarketplace(
          vsixPath,
          values["allow-proposed-apis"] ? [values["allow-proposed-apis"]] : [],
        );
      }
      if (ok && values["verify-installed"]) {
        if (!values["vscode-executable"])
          throw new Error("--verify-installed requires --vscode-executable");
        ok = await verifyInstalledVsix(
          vsixPath,
          path.resolve(values["vscode-executable"]),
        );
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    ok = false;
  }
  process.exitCode = ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  listZipEntries,
  verifyVsix,
  verifyVsixBuild,
  readVsixManifest,
  verifyVsixMarketplace,
};
