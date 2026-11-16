import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as test from "node:test";
import * as url from "node:url";

const scriptFilePath = url.fileURLToPath(new URL("./package-vscode-extension.mjs", import.meta.url));
const testOptions = { skip: process.platform === "win32" && "Executable stubs use POSIX shebangs." };

test.test("installs a snapshot from a fresh clone in dependency order without changing source versions", testOptions, (testContext) => {
  const fixture = createFixture(testContext);
  const packageResult = runPackage(fixture, ["--snapshot", "--install"]);
  const commandCalls = readCommandCalls(fixture);

  assert.equal(packageResult.status, 0, packageResult.stderr);
  assert.deepEqual(commandCalls.map((commandCall) => [commandCall.commandName, ...commandCall.commandArguments]), [
    ["code", "--version"],
    ["pnpm", "install", "--frozen-lockfile"],
    ["pnpm", "--filter", "@vscx/core", "run", "build"],
    ["pnpm", "run", "build"],
    ["pnpm", "exec", "vsce", "package", "--no-dependencies", "--out", commandCalls[4].commandArguments.at(-1)],
    ["code", "--install-extension", commandCalls[4].commandArguments.at(-1), "--force"],
  ]);
  assert.deepEqual(commandCalls.map((commandCall) => commandCall.currentDirPath), [
    fixture.projectRootDirPath,
    fixture.projectRootDirPath,
    fixture.projectRootDirPath,
    fixture.extensionDirPath,
    fixture.extensionDirPath,
    fixture.projectRootDirPath,
  ]);
  assert.match(path.basename(commandCalls[4].commandArguments.at(-1)), /^vscx-0\.1\.0-snapshot\.\d{8}T\d{9}Z\.vsix$/);
  assert.equal(fs.readFileSync(fixture.extensionPackageFilePath, "utf8"), fixture.extensionPackageFileContent);
  assert.match(packageResult.stdout, /Reload Window/);
  assert.match(packageResult.stdout, /vscx doctor and vscx info/);
});

test.test("packages snapshots without installing dependencies or invoking VS Code", testOptions, (testContext) => {
  const fixture = createFixture(testContext);
  const packageResult = runPackage(fixture, ["--snapshot"]);
  const commandCalls = readCommandCalls(fixture);

  assert.equal(packageResult.status, 0, packageResult.stderr);
  assert.deepEqual(commandCalls.map((commandCall) => commandCall.commandName), ["pnpm", "pnpm", "pnpm"]);
  assert.deepEqual(commandCalls[0].commandArguments, ["--filter", "@vscx/core", "run", "build"]);
  assert.match(packageResult.stdout, /Install with:/);
});

test.test("prints a copyable installation command for paths containing shell syntax", testOptions, (testContext) => {
  const fixture = createFixture(testContext, "'quoted' $VSCX_TEST_LITERAL `false` ");
  const packageResult = runPackage(fixture, ["--snapshot"]);
  const installCommand = packageResult.stdout.split("Install with:\n")[1].trim();
  const installResult = childProcess.spawnSync("/bin/sh", ["-c", installCommand], {
    cwd: fixture.projectRootDirPath,
    env: {
      ...process.env,
      PATH: fixture.executableDirPath,
      VSCX_TEST_COMMAND_LOG: fixture.commandLogFilePath,
      VSCX_TEST_LITERAL: "must-not-expand",
    },
    encoding: "utf8",
  });
  const commandCalls = readCommandCalls(fixture);

  assert.equal(packageResult.status, 0, packageResult.stderr);
  assert.equal(installResult.status, 0, installResult.stderr);
  assert.deepEqual(commandCalls[3].commandArguments, [
    "--install-extension", commandCalls[2].commandArguments.at(-1), "--force",
  ]);
});

test.test("retains stable and pre-release artifact packaging", testOptions, (testContext) => {
  const fixture = createFixture(testContext);
  const stablePackageResult = runPackage(fixture, []);
  const preReleasePackageResult = runPackage(fixture, ["--pre-release"]);
  const commandCalls = readCommandCalls(fixture);

  assert.equal(stablePackageResult.status, 0, stablePackageResult.stderr);
  assert.equal(preReleasePackageResult.status, 0, preReleasePackageResult.stderr);
  assert.equal(path.basename(commandCalls[2].commandArguments.at(-1)), "vscx-0.1.0.vsix");
  assert.deepEqual(commandCalls[5].commandArguments, [
    "exec", "vsce", "package", "--no-dependencies", "--pre-release", "--out",
    path.join(fixture.projectRootDirPath, "artifacts", "vscx-0.1.0-pre-release.vsix"),
  ]);
});

test.test("rejects invalid arguments before changing the machine", testOptions, (testContext) => {
  const fixture = createFixture(testContext);
  const conflictingPackageResult = runPackage(fixture, ["--snapshot", "--pre-release", "--install"]);
  const unknownPackageResult = runPackage(fixture, ["--install", "--unknown"]);

  assert.notEqual(conflictingPackageResult.status, 0);
  assert.match(conflictingPackageResult.stderr, /cannot be both/);
  assert.notEqual(unknownPackageResult.status, 0);
  assert.match(unknownPackageResult.stderr, /Unknown argument/);
  assert.deepEqual(readCommandCalls(fixture), []);
});

test.test("checks for the VS Code launcher before installing dependencies", testOptions, (testContext) => {
  const fixture = createFixture(testContext);

  fs.unlinkSync(path.join(fixture.executableDirPath, "code"));

  const packageResult = runPackage(fixture, ["--snapshot", "--install"]);

  assert.notEqual(packageResult.status, 0);
  assert.match(packageResult.stderr, /code is not available on PATH/);
  assert.match(packageResult.stderr, /Shell Command: Install/);
  assert.deepEqual(readCommandCalls(fixture), []);
});

for (const failureCase of [
  { commandMatch: "code --version", commandCount: 1 },
  { commandMatch: "pnpm install --frozen-lockfile", commandCount: 2 },
  { commandMatch: "pnpm --filter @vscx/core run build", commandCount: 3 },
  { commandMatch: "pnpm run build", commandCount: 4 },
  { commandMatch: "pnpm exec vsce package", commandCount: 5 },
  { commandMatch: "code --install-extension", commandCount: 6 },
]) {
  test.test(`stops when ${failureCase.commandMatch} fails`, testOptions, (testContext) => {
    const fixture = createFixture(testContext);
    const packageResult = runPackage(fixture, ["--snapshot", "--install"], failureCase.commandMatch);
    const commandCalls = readCommandCalls(fixture);

    assert.equal(packageResult.status, 17);
    assert.equal(commandCalls.length, failureCase.commandCount);
    assert.doesNotMatch(packageResult.stdout, /Installed VSCX/);
  });
}

function createFixture(testContext, projectDirNameSuffix = "") {
  const projectRootDirPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `vscx installer ${projectDirNameSuffix}`)),
  );
  const extensionDirPath = path.join(projectRootDirPath, "packages", "vscode");
  const executableDirPath = path.join(projectRootDirPath, "bin");
  const fixtureScriptFilePath = path.join(projectRootDirPath, "scripts", "package-vscode-extension.mjs");
  const extensionPackageFilePath = path.join(extensionDirPath, "package.json");
  const extensionPackageFileContent = JSON.stringify({ name: "vscx", version: "0.1.0" });
  const commandLogFilePath = path.join(projectRootDirPath, "commands.jsonl");

  testContext.after(() => fs.rmSync(projectRootDirPath, { recursive: true, force: true }));

  fs.mkdirSync(extensionDirPath, { recursive: true });
  fs.mkdirSync(executableDirPath);
  fs.mkdirSync(path.dirname(fixtureScriptFilePath));
  fs.copyFileSync(scriptFilePath, fixtureScriptFilePath);
  fs.writeFileSync(extensionPackageFilePath, extensionPackageFileContent);

  for (const commandName of ["pnpm", "code"]) {
    fs.writeFileSync(path.join(executableDirPath, commandName), `#!${process.execPath}
const fs = require("node:fs");
const commandArguments = process.argv.slice(2);
const commandName = ${JSON.stringify(commandName)};
fs.appendFileSync(process.env.VSCX_TEST_COMMAND_LOG, JSON.stringify({ commandName, commandArguments, currentDirPath: process.cwd() }) + "\\n");
if (process.env.VSCX_TEST_COMMAND_FAILURE && [commandName, ...commandArguments].join(" ").startsWith(process.env.VSCX_TEST_COMMAND_FAILURE)) process.exit(17);
`, { mode: 0o755 });
  }

  return {
    projectRootDirPath,
    extensionDirPath,
    executableDirPath,
    fixtureScriptFilePath,
    extensionPackageFilePath,
    extensionPackageFileContent,
    commandLogFilePath,
  };
}

function runPackage(fixture, packageArguments, commandFailure = "") {
  return childProcess.spawnSync(process.execPath, [fixture.fixtureScriptFilePath, ...packageArguments], {
    cwd: fixture.projectRootDirPath,
    env: {
      ...process.env,
      PATH: fixture.executableDirPath,
      VSCX_TEST_COMMAND_LOG: fixture.commandLogFilePath,
      VSCX_TEST_COMMAND_FAILURE: commandFailure,
    },
    encoding: "utf8",
  });
}

function readCommandCalls(fixture) {
  if (!fs.existsSync(fixture.commandLogFilePath)) return [];

  return fs.readFileSync(fixture.commandLogFilePath, "utf8").trim().split("\n").map((commandCall) => JSON.parse(commandCall));
}
