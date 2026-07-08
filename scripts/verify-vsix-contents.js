#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const FORBIDDEN_PATTERNS = [
  /^extension\/research\//,
  /^extension\/artifacts\//,
  /^extension\/output_sessions\//,
  /^extension\/session\//,
  /^extension\/\.github\//,
  /^extension\/scripts\//,
  /^extension\/src\//,
  /^extension\/.*\.vsix$/,
  /^extension\/.*\.map$/,
];

function readUInt16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer) {
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
  const centralDirectoryOffset = readUInt32(buffer, eocdOffset + 16);
  const entries = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index++) {
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
    entries.push(
      buffer.toString("utf8", fileNameStart, fileNameEnd).replace(/\\/g, "/"),
    );
    offset = fileNameEnd + extraFieldLength + fileCommentLength;
  }

  return entries;
}

function verifyVsix(filePath) {
  const resolvedPath = path.resolve(filePath);
  const entries = listZipEntries(resolvedPath);
  const forbiddenEntries = entries.filter((entry) =>
    FORBIDDEN_PATTERNS.some((pattern) => pattern.test(entry.toLowerCase())),
  );

  if (forbiddenEntries.length > 0) {
    console.error(`Forbidden entries found in ${resolvedPath}:`);
    for (const entry of forbiddenEntries) {
      console.error(`- ${entry}`);
    }
    return false;
  }

  console.log(
    `Verified ${path.basename(resolvedPath)}: ${entries.length} entries, no dev-only artifacts found.`,
  );
  return true;
}

const vsixPaths = process.argv.slice(2);
if (vsixPaths.length === 0) {
  console.error(
    "Usage: node scripts/verify-vsix-contents.js <path-to.vsix> [...]",
  );
  process.exit(2);
}

let ok = true;
for (const vsixPath of vsixPaths) {
  ok = verifyVsix(vsixPath) && ok;
}

process.exit(ok ? 0 : 1);
