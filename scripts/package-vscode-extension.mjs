#!/usr/bin/env node

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const scriptFilePath = url.fileURLToPath(import.meta.url);
const projectRootDirPath = path.resolve(path.dirname(scriptFilePath), "..");
const extensionDirPath = path.join(projectRootDirPath, "packages", "vscode");
const artifactDirPath = path.join(projectRootDirPath, "artifacts");
const supportedArguments = new Set(["--snapshot", "--pre-release", "--install"]);

function main() {
  const packageOptions = parsePackageOptions();

  if (process.platform === "win32") {
    throw new Error(
      "The packaging helper supports macOS and Linux. On Windows, use the manual build and installation commands in README.md.",
    );
  }

  if (packageOptions.shouldInstallExtension) {
    runCommand("code", ["--version"], projectRootDirPath);
    runCommand("pnpm", ["install", "--frozen-lockfile"], projectRootDirPath);
  }

  const extensionPackageFilePath = path.join(extensionDirPath, "package.json");
  const extensionPackageFileContent = fs.readFileSync(
    extensionPackageFilePath,
    "utf8",
  );
  const extensionPackageConfig = JSON.parse(extensionPackageFileContent);
  const artifactFileName = buildArtifactFileName(
    extensionPackageConfig.version,
    packageOptions,
  );
  const artifactFilePath = path.join(artifactDirPath, artifactFileName);
  const packageCommandArguments = [
    "exec",
    "vsce",
    "package",
    "--no-dependencies",
    ...(packageOptions.shouldCreatePreRelease ? ["--pre-release"] : []),
    "--out",
    artifactFilePath,
  ];

  fs.mkdirSync(artifactDirPath, { recursive: true });

  runCommand(
    "pnpm",
    ["--filter", "@vscx/core", "run", "build"],
    projectRootDirPath,
  );
  runCommand("pnpm", ["run", "build"], extensionDirPath);
  runCommand("pnpm", packageCommandArguments, extensionDirPath);

  console.log(`Created ${artifactFilePath}`);

  if (!packageOptions.shouldInstallExtension) {
    const artifactFilePathQuoted = "'" + artifactFilePath.replaceAll("'", "'\"'\"'") + "'";

    console.log(
      `Install with:\ncode --install-extension ${artifactFilePathQuoted} --force`,
    );

    return;
  }

  runCommand(
    "code",
    ["--install-extension", artifactFilePath, "--force"],
    projectRootDirPath,
  );

  console.log(
    'Installed VSCX. Run "Developer: Reload Window" in VS Code, then run vscx doctor and vscx info in a new integrated terminal to verify the bundled CLI and connection.',
  );
}

function parsePackageOptions() {
  const packageArguments = process.argv.slice(2);

  for (const packageArgument of packageArguments) {
    if (supportedArguments.has(packageArgument)) continue;

    throw new Error(`Unknown argument: ${packageArgument}`);
  }

  const packageOptions = {
    shouldCreateSnapshot: packageArguments.includes("--snapshot"),
    shouldCreatePreRelease: packageArguments.includes("--pre-release"),
    shouldInstallExtension: packageArguments.includes("--install"),
  };

  if (
    packageOptions.shouldCreateSnapshot &&
    packageOptions.shouldCreatePreRelease
  ) {
    throw new Error("A VSIX cannot be both a local snapshot and a pre-release.");
  }

  return packageOptions;
}

function buildArtifactFileName(extensionVersion, packageOptions) {
  if (packageOptions.shouldCreatePreRelease) {
    return `vscx-${extensionVersion}-pre-release.vsix`;
  }

  if (!packageOptions.shouldCreateSnapshot) {
    return `vscx-${extensionVersion}.vsix`;
  }

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
  const commandResult = childProcess.spawnSync(
    commandName,
    commandArguments,
    {
      cwd: currentDirPath,
      stdio: "inherit",
    },
  );

  if (commandResult.error?.code === "ENOENT") {
    const installHint = commandName === "code"
      ? 'Install VS Code\'s command-line launcher (on macOS, run "Shell Command: Install \'code\' command in PATH" from the Command Palette), then retry.'
      : "Install the pnpm version declared in package.json, then retry.";

    throw new Error(`${commandName} is not available on PATH. ${installHint}`);
  }

  if (commandResult.error) throw commandResult.error;
  if (commandResult.status === 0) return;

  console.error(`${commandName} ${commandArguments.join(" ")} failed.`);
  process.exit(commandResult.status ?? 1);
}

main();
