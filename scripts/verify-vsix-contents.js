#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

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

if (require.main === module) {
  let vsixPaths = process.argv.slice(2);
  if (vsixPaths.length === 0) {
    vsixPaths = findDefaultVsixPaths();
    if (vsixPaths.length === 0) {
      console.error(
        "Usage: node scripts/verify-vsix-contents.js [path-to.vsix ...]",
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
      ok = verifyVsix(vsixPath) && ok;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    ok = false;
  }
  process.exitCode = ok ? 0 : 1;
}

module.exports = { listZipEntries, verifyVsix };
