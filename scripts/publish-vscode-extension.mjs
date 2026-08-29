#!/usr/bin/env node

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const scriptFilePath = url.fileURLToPath(import.meta.url);
const projectRootDirPath = path.resolve(path.dirname(scriptFilePath), "..");
const extensionDirPath = path.join(projectRootDirPath, "packages", "vscode");
const artifactDirPath = path.join(projectRootDirPath, "artifacts");
const placeholderPublisherNames = new Set(["", "local-vscx"]);

function main() {
  const extensionPackageFilePath = path.join(extensionDirPath, "package.json");
  const extensionPackageFileContent = fs.readFileSync(
    extensionPackageFilePath,
    "utf8",
  );
  const extensionPackageConfig = JSON.parse(extensionPackageFileContent);

  validateMarketplacePublisher(extensionPackageConfig.publisher);
  validateMarketplaceCredential(process.env.VSCE_PAT);

  const shouldPublishPreRelease = process.argv.includes("--pre-release");
  const shouldCheckOnly = process.argv.includes("--check");
  const artifactFileName = shouldPublishPreRelease
    ? `vscx-${extensionPackageConfig.version}-pre-release.vsix`
    : `vscx-${extensionPackageConfig.version}.vsix`;
  const artifactFilePath = path.join(artifactDirPath, artifactFileName);

  if (!fs.existsSync(artifactFilePath)) {
    throw new Error(
      `Release artifact not found: ${artifactFilePath}\nRun pnpm release:verify before publishing.`,
    );
  }

  if (shouldCheckOnly) {
    console.log("Marketplace release configuration and artifact are ready.");

    return;
  }

  runCommand(
    "pnpm",
    [
      "exec",
      "vsce",
      "publish",
      "--packagePath",
      artifactFilePath,
      "--skip-duplicate",
    ],
    extensionDirPath,
  );
}

function validateMarketplacePublisher(publisherName) {
  if (
    typeof publisherName === "string" &&
    !placeholderPublisherNames.has(publisherName)
  ) {
    return;
  }

  throw new Error(
    "Replace the placeholder VS Code Marketplace publisher in packages/vscode/package.json before publishing.",
  );
}

function validateMarketplaceCredential(marketplaceCredential) {
  if (typeof marketplaceCredential === "string" && marketplaceCredential) {
    return;
  }

  throw new Error(
    "VSCE_PAT is required to publish the VS Code Marketplace extension.",
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
