import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as nodeTest from "node:test";

import type * as vscode from "vscode";

import { configureTerminalEnvironment } from "./terminal-environment";

nodeTest.test("persistent CLI contribution removes old credentials before caching stable values", async (testContext) => {
  const fixture = await createFixture(testContext);

  fixture.environmentMutations.set("PATH", "old-extension/bin:");
  fixture.environmentMutations.set("VSCX_TOKEN", "stale-value");

  await configureTerminalEnvironment(fixture.options);

  assert.equal(fixture.environmentVariableCollection.persistent, true);
  assert.deepEqual([...fixture.environmentMutations], [
    ["PATH", `${fixture.cliBinDirPath}${path.delimiter}`],
    ["VSCX_RUNTIME_DIR", fixture.options.runtimeDirPath],
  ]);

  assert.equal(fixture.environmentMutations.get("PATH"), `${fixture.cliBinDirPath}${path.delimiter}`);

  if (process.platform !== "win32") {
    assert.equal((await fs.stat(fixture.cliBinDirPath)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(fixture.cliBinDirPath, "vscx"))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(fixture.cliFilePath)).mode & 0o777, 0o600);
  }
});

nodeTest.test("stored CLI runs with the cached PATH before activation after the old extension is removed", async (testContext) => {
  const fixture = await createFixture(testContext);

  await configureTerminalEnvironment(fixture.options);

  const cachedEnvironment = createCachedEnvironment(fixture);
  const versionResult = runStoredCli(fixture, cachedEnvironment, ["--version"]);

  assert.equal(versionResult.status, 0, versionResult.stderr);
  assert.match(versionResult.stdout.trim(), /^\d+\.\d+\.\d+/);

  await fs.rm(fixture.options.extensionDirPath, { recursive: true });

  const restoredVersionResult = runStoredCli(fixture, cachedEnvironment, ["--version"]);

  assert.equal(restoredVersionResult.status, 0, restoredVersionResult.stderr);
  assert.equal(restoredVersionResult.stdout, versionResult.stdout);

  const invalidCommandResult = runStoredCli(fixture, cachedEnvironment, ["unknown-command"]);

  assert.equal(invalidCommandResult.status, 1);
});

nodeTest.test("upgrades refresh the CLI used by an unchanged terminal environment", async (testContext) => {
  const fixture = await createFixture(testContext);

  await configureTerminalEnvironment(fixture.options);

  const cachedEnvironment = createCachedEnvironment(fixture);
  const environmentMutationsBeforeUpgrade = [...fixture.environmentMutations];
  const upgradedExtensionDirPath = path.join(fixture.temporaryDirPath, "extension-v2");

  await fs.cp(fixture.options.extensionDirPath, upgradedExtensionDirPath, { recursive: true });
  await fs.writeFile(path.join(upgradedExtensionDirPath, "dist", "cli.js"), 'process.stdout.write("upgraded CLI");\n');
  await fs.rm(fixture.options.extensionDirPath, { recursive: true });
  await configureTerminalEnvironment({ ...fixture.options, extensionDirPath: upgradedExtensionDirPath });

  const versionResult = runStoredCli(fixture, cachedEnvironment, ["--version"]);

  assert.equal(versionResult.status, 0, versionResult.stderr);
  assert.equal(versionResult.stdout, "upgraded CLI");
  assert.deepEqual([...fixture.environmentMutations], environmentMutationsBeforeUpgrade);
});

nodeTest.test("concurrent activations publish complete CLI bundles to shared storage", async (testContext) => {
  const fixture = await createFixture(testContext);
  const otherExtensionDirPath = path.join(fixture.temporaryDirPath, "other-extension");
  const cliContents = [
    `process.stdout.write("first build");\n// ${"a".repeat(1024 * 1024)}\n`,
    `process.stdout.write("second build");\n// ${"b".repeat(1024 * 1024)}\n`,
  ];

  await fs.cp(fixture.options.extensionDirPath, otherExtensionDirPath, { recursive: true });
  await fs.writeFile(path.join(fixture.options.extensionDirPath, "dist", "cli.js"), cliContents[0]!);
  await fs.writeFile(path.join(otherExtensionDirPath, "dist", "cli.js"), cliContents[1]!);
  await configureTerminalEnvironment(fixture.options);

  const activations = Array.from({ length: 8 }, (_, activationIndex) => configureTerminalEnvironment({
    ...fixture.options,
    extensionDirPath: activationIndex % 2 === 0 ? fixture.options.extensionDirPath : otherExtensionDirPath,
  }));
  const observations = (async () => {
    for (let observationIndex = 0; observationIndex < 40; observationIndex += 1) {
      const cliContent = await fs.readFile(fixture.cliFilePath, "utf8");

      assert.ok(cliContents.includes(cliContent), "readers must see one complete bundled CLI");
    }
  })();

  await Promise.all([...activations, observations]);

  const versionResult = runStoredCli(fixture, createCachedEnvironment(fixture), ["--version"]);

  assert.equal(versionResult.status, 0, versionResult.stderr);
  assert.ok(["first build", "second build"].includes(versionResult.stdout));
  assert.deepEqual((await fs.readdir(path.dirname(fixture.cliFilePath))).sort(), ["cli.js"]);
  assert.deepEqual((await fs.readdir(fixture.cliBinDirPath)).sort(), ["vscx", "vscx.cmd"]);
});

nodeTest.test("an incomplete extension leaves the previous CLI and contribution available", async (testContext) => {
  const fixture = await createFixture(testContext);

  await configureTerminalEnvironment(fixture.options);

  const previousCliContent = await fs.readFile(fixture.cliFilePath, "utf8");
  const previousEnvironmentMutations = [...fixture.environmentMutations];

  await fs.writeFile(path.join(fixture.options.extensionDirPath, "dist", "cli.js"), "new incomplete build");
  await fs.rm(path.join(fixture.options.extensionDirPath, "bin", "vscx.cmd"));

  await assert.rejects(configureTerminalEnvironment(fixture.options), { code: "ENOENT" });
  assert.equal(await fs.readFile(fixture.cliFilePath, "utf8"), previousCliContent);
  assert.deepEqual([...fixture.environmentMutations], previousEnvironmentMutations);
  assert.equal(fixture.environmentVariableCollection.persistent, true);
});

async function createFixture(testContext: nodeTest.TestContext) {
  const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "vscx persistent cli "));

  testContext.after(() => fs.rm(temporaryDirPath, { recursive: true, force: true }));

  const extensionDirPath = path.join(temporaryDirPath, "extension-v1");
  const globalStorageDirPath = path.join(temporaryDirPath, "global storage");
  const cliBinDirPath = path.join(globalStorageDirPath, "cli", "bin");
  const cliFilePath = path.join(globalStorageDirPath, "cli", "dist", "cli.js");
  const environmentMutations = new Map<string, string>();
  let persistent = false;
  const environmentVariableCollection = {
    get persistent() { return persistent; },
    set persistent(value: boolean) {
      if (value) assert.equal(environmentMutations.has("VSCX_TOKEN"), false);

      persistent = value;
    },
    description: undefined as string | undefined,
    delete: (variable: string) => environmentMutations.delete(variable),
    replace: (variable: string, value: string) => environmentMutations.set(variable, value),
    prepend: (variable: string, value: string) => {
      environmentMutations.set(variable, value);
    },
  };
  const options = {
    environmentVariableCollection: environmentVariableCollection as unknown as vscode.GlobalEnvironmentVariableCollection,
    extensionDirPath,
    globalStorageDirPath,
    runtimeDirPath: path.join(temporaryDirPath, "runtime"),
  };

  await fs.mkdir(path.join(extensionDirPath, "dist"), { recursive: true });
  await fs.copyFile(path.resolve("packages/vscode/dist/cli.js"), path.join(extensionDirPath, "dist", "cli.js"));
  await fs.cp(path.resolve("packages/vscode/bin"), path.join(extensionDirPath, "bin"), { recursive: true });

  return {
    temporaryDirPath,
    options,
    environmentVariableCollection,
    environmentMutations,
    cliBinDirPath,
    cliFilePath,
  };
}

function createCachedEnvironment(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fixture.environmentMutations.get("PATH")}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
  };

  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  delete environment.VSCX_TOKEN;

  return environment;
}

function runStoredCli(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  environment: NodeJS.ProcessEnv,
  cliArguments: string[],
) {
  const commandOptions = {
    cwd: fixture.temporaryDirPath,
    encoding: "utf8" as const,
    env: environment,
  };

  if (process.platform === "win32") {
    // Windows launcher behavior needs a Windows desktop smoke test.
    return childProcess.spawnSync(process.execPath, [fixture.cliFilePath, ...cliArguments], commandOptions);
  }

  return childProcess.spawnSync("vscx", cliArguments, commandOptions);
}
