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

async function main() {
  const { values, positionals } = parseArgs({
    options: { "verify-build": { type: "boolean", default: false } },
    allowPositionals: true,
  });
  let vsixPaths = positionals;
  if (vsixPaths.length === 0) {
    vsixPaths = findDefaultVsixPaths();
    if (vsixPaths.length === 0) {
      console.error(
        "Usage: node scripts/verify-vsix-contents.js [--verify-build] [path-to.vsix ...]",
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

module.exports = { listZipEntries, verifyVsix, verifyVsixBuild };
