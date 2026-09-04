#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function readNls(filePath) {
  const resolvedPath = path.resolve(filePath);
  const value = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${path.basename(resolvedPath)} must contain a JSON object.`,
    );
  }
  return value;
}

function findMissingKeys(source, target) {
  return Object.keys(source)
    .filter((key) => !Object.hasOwn(target, key))
    .sort();
}

function findInvalidValues(nls) {
  return Object.entries(nls)
    .filter(([, value]) => typeof value !== "string" || !value.trim())
    .map(([key]) => key)
    .sort();
}

function verifyNlsConsistency(defaultPath, localizedPath) {
  const defaultNls = readNls(defaultPath);
  const localizedNls = readNls(localizedPath);
  const missingLocalized = findMissingKeys(defaultNls, localizedNls);
  const missingDefault = findMissingKeys(localizedNls, defaultNls);
  const invalidDefault = findInvalidValues(defaultNls);
  const invalidLocalized = findInvalidValues(localizedNls);

  if (
    missingLocalized.length ||
    missingDefault.length ||
    invalidDefault.length ||
    invalidLocalized.length
  ) {
    if (missingLocalized.length) {
      console.error(
        `Missing from ${path.basename(localizedPath)}: ${missingLocalized.join(", ")}`,
      );
    }
    if (missingDefault.length) {
      console.error(
        `Missing from ${path.basename(defaultPath)}: ${missingDefault.join(", ")}`,
      );
    }
    if (invalidDefault.length) {
      console.error(
        `Invalid values in ${path.basename(defaultPath)}: ${invalidDefault.join(", ")}`,
      );
    }
    if (invalidLocalized.length) {
      console.error(
        `Invalid values in ${path.basename(localizedPath)}: ${invalidLocalized.join(", ")}`,
      );
    }
    return false;
  }

  console.log(
    `Verified NLS consistency: ${Object.keys(defaultNls).length} keys match.`,
  );
  return true;
}

if (require.main === module) {
  const defaultPath = process.argv[2] || "package.nls.json";
  const localizedPath = process.argv[3] || "package.nls.ja.json";
  try {
    if (!verifyNlsConsistency(defaultPath, localizedPath)) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { findInvalidValues, findMissingKeys, verifyNlsConsistency };
