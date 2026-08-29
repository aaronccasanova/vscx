#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const scriptFilePath = url.fileURLToPath(import.meta.url);
const projectRootDirPath = path.resolve(path.dirname(scriptFilePath), "..");
const packageFileNames = [
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/vscode/package.json",
];
const runtimeVersionFileName = "packages/core/src/version.ts";
const runtimeVersionPattern = /export const vscxVersion = "([^"]+)";/;

function main() {
  const packageVersions = getPackageVersions();
  const runtimeVersion = getRuntimeVersion();
  const expectedVersion = packageVersions[0];

  validatePackageVersions(packageVersions);

  if (runtimeVersion === expectedVersion) return;

  if (process.argv.includes("--check")) {
    throw new Error(
      `Runtime version ${runtimeVersion} does not match package version ${expectedVersion}. Run pnpm run version to synchronize generated release files.`,
    );
  }

  writeRuntimeVersion(expectedVersion);
}

function getPackageVersions() {
  return packageFileNames.map((packageFileName) => {
    const packageFilePath = path.join(projectRootDirPath, packageFileName);
    const packageFileContent = fs.readFileSync(packageFilePath, "utf8");
    const packageConfig = JSON.parse(packageFileContent);

    if (typeof packageConfig.version === "string") {
      return packageConfig.version;
    }

    throw new Error(`Package version is missing from ${packageFileName}.`);
  });
}

function getRuntimeVersion() {
  const runtimeVersionFilePath = path.join(
    projectRootDirPath,
    runtimeVersionFileName,
  );
  const runtimeVersionFileContent = fs.readFileSync(
    runtimeVersionFilePath,
    "utf8",
  );
  const runtimeVersionMatch = runtimeVersionFileContent.match(
    runtimeVersionPattern,
  );

  if (runtimeVersionMatch?.[1]) return runtimeVersionMatch[1];

  throw new Error(
    `Could not read the runtime version from ${runtimeVersionFileName}.`,
  );
}

function validatePackageVersions(packageVersions) {
  const expectedVersion = packageVersions[0];
  const mismatchedPackageFileNames = packageFileNames.filter(
    (_packageFileName, packageIndex) =>
      packageVersions[packageIndex] !== expectedVersion,
  );

  if (mismatchedPackageFileNames.length === 0) return;

  throw new Error(
    `Fixed VSCX package versions must match. Check: ${mismatchedPackageFileNames.join(", ")}.`,
  );
}

function writeRuntimeVersion(runtimeVersion) {
  const runtimeVersionFilePath = path.join(
    projectRootDirPath,
    runtimeVersionFileName,
  );
  const runtimeVersionFileContent = fs.readFileSync(
    runtimeVersionFilePath,
    "utf8",
  );
  const updatedRuntimeVersionFileContent = runtimeVersionFileContent.replace(
    runtimeVersionPattern,
    `export const vscxVersion = "${runtimeVersion}";`,
  );

  fs.writeFileSync(runtimeVersionFilePath, updatedRuntimeVersionFileContent);
  console.log(`Updated ${runtimeVersionFileName} to ${runtimeVersion}.`);
}

main();
