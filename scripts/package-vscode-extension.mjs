#!/usr/bin/env node

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const scriptFilePath = url.fileURLToPath(import.meta.url);
const projectRootDirPath = path.resolve(path.dirname(scriptFilePath), "..");
const extensionDirPath = path.join(projectRootDirPath, "packages", "vscode");
const artifactDirPath = path.join(projectRootDirPath, "artifacts");

function main() {
  const extensionPackageFilePath = path.join(extensionDirPath, "package.json");
  const extensionPackageFileContent = fs.readFileSync(
    extensionPackageFilePath,
    "utf8",
  );
  const extensionPackageConfig = JSON.parse(extensionPackageFileContent);
  const shouldCreateSnapshot = process.argv.includes("--snapshot");
  const shouldCreatePreRelease = process.argv.includes("--pre-release");
  const shouldInstallExtension = process.argv.includes("--install");

  if (shouldCreateSnapshot && shouldCreatePreRelease) {
    throw new Error("A VSIX cannot be both a local snapshot and a pre-release.");
  }

  const artifactFileName = buildArtifactFileName(
    extensionPackageConfig.version,
    shouldCreateSnapshot,
    shouldCreatePreRelease,
  );
  const artifactFilePath = path.join(artifactDirPath, artifactFileName);
  const packageCommandArguments = [
    "exec",
    "vsce",
    "package",
    "--no-dependencies",
    ...(shouldCreatePreRelease ? ["--pre-release"] : []),
    "--out",
    artifactFilePath,
  ];

  fs.mkdirSync(artifactDirPath, { recursive: true });

  runCommand("pnpm", ["run", "build"], extensionDirPath);
  runCommand("pnpm", packageCommandArguments, extensionDirPath);

  console.log(`Created ${artifactFilePath}`);

  if (!shouldInstallExtension) {
    console.log(
      `Install with:\ncode --install-extension ${JSON.stringify(artifactFilePath)} --force`,
    );

    return;
  }

  runCommand(
    "code",
    ["--install-extension", artifactFilePath, "--force"],
    projectRootDirPath,
  );
}

function buildArtifactFileName(
  extensionVersion,
  shouldCreateSnapshot,
  shouldCreatePreRelease,
) {
  if (shouldCreatePreRelease) {
    return `vscx-${extensionVersion}-pre-release.vsix`;
  }

  if (!shouldCreateSnapshot) return `vscx-${extensionVersion}.vsix`;

  const snapshotTimestamp = formatSnapshotTimestamp(new Date());

  return `vscx-${extensionVersion}-snapshot.${snapshotTimestamp}.vsix`;
}

function formatSnapshotTimestamp(snapshotDate) {
  return snapshotDate
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "");
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
