#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ALLOWED_REGISTRY_HOSTS = new Set(["registry.npmjs.org"]);

function collectResolvedUrls(value, results = []) {
  if (!value || typeof value !== "object") return results;
  if (typeof value.resolved === "string") results.push(value.resolved);
  for (const child of Object.values(value)) {
    collectResolvedUrls(child, results);
  }
  return results;
}

function findInvalidResolvedUrls(lock) {
  return collectResolvedUrls(lock).filter((resolved) => {
    try {
      const url = new URL(resolved);
      return (
        url.protocol !== "https:" || !ALLOWED_REGISTRY_HOSTS.has(url.hostname)
      );
    } catch {
      return true;
    }
  });
}

function verifyPackageLockRegistry(filePath) {
  const resolvedPath = path.resolve(filePath);
  const lock = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  const resolvedUrls = collectResolvedUrls(lock);
  const invalid = findInvalidResolvedUrls(lock);

  if (invalid.length > 0) {
    console.error(
      `Non-public or invalid package-lock resolved URLs found in ${path.basename(resolvedPath)}:`,
    );
    for (const resolved of invalid) console.error(`- ${resolved}`);
    return false;
  }

  console.log(
    `Verified ${path.basename(resolvedPath)}: ${resolvedUrls.length} resolved URLs use the public npm registry.`,
  );
  return true;
}

if (require.main === module) {
  const filePath = process.argv[2] || "package-lock.json";
  if (!verifyPackageLockRegistry(filePath)) process.exitCode = 1;
}

module.exports = {
  collectResolvedUrls,
  findInvalidResolvedUrls,
  verifyPackageLockRegistry,
};
