#!/usr/bin/env node

import * as childProcess from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

const scriptFilePath = url.fileURLToPath(import.meta.url);
const projectRootDirPath = path.resolve(path.dirname(scriptFilePath), "..");

function main() {
  if (!hasVersionedVscodeExtension()) {
    console.log("Skipping VS Code Marketplace publish: extension version is unchanged.");

    return;
  }

  runCommand(
    "node",
    ["scripts/publish-vscode-extension.mjs", ...process.argv.slice(2)],
    projectRootDirPath,
  );
}

function hasVersionedVscodeExtension() {
  const previousVscodeExtensionVersion = getVscodeExtensionVersion("HEAD^");
  const currentVscodeExtensionVersion = getVscodeExtensionVersion("HEAD");

  return previousVscodeExtensionVersion !== currentVscodeExtensionVersion;
}

function getVscodeExtensionVersion(gitRevision) {
  const extensionPackageFileContent = childProcess.execFileSync(
    "git",
    ["show", `${gitRevision}:packages/vscode/package.json`],
    {
      cwd: projectRootDirPath,
      encoding: "utf8",
    },
  );
  const extensionPackageConfig = JSON.parse(extensionPackageFileContent);

  if (typeof extensionPackageConfig.version === "string") {
    return extensionPackageConfig.version;
  }

  throw new Error(
    `Could not read the VS Code extension version at ${gitRevision}. The release checkout must include HEAD and HEAD^.`,
  );
}

function runCommand(commandName, commandArguments, currentDirPath) {
  const executableFileName =
    process.platform === "win32" ? `${commandName}.cmd` : commandName;
  const commandResult = childProcess.spawnSync(
    executableFileName,
    commandArguments,
    {
      cwd: currentDirPath,
      stdio: "inherit",
    },
  );

  if (commandResult.error) throw commandResult.error;
  if (commandResult.status === 0) return;

  process.exit(commandResult.status ?? 1);
}

main();
