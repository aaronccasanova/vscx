import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as nodeTest from "node:test";

import type { RuntimeRegistryOptions } from "./registry.js";

interface RegistryScenario {
  getconfFails?: boolean;
  getconfOutput?: string;
  options?: RuntimeRegistryOptions;
  optionsAfterFirst?: RuntimeRegistryOptions[];
  platform?: NodeJS.Platform;
  processEnvironment?: NodeJS.ProcessEnv;
}

interface RegistryScenarioResult {
  getconfCalls: {
    command: string;
    arguments: string[];
    options: {
      encoding: string;
      env: NodeJS.ProcessEnv;
      maxBuffer: number;
      stdio: string[];
      timeout: number;
    };
  }[];
  runtimeRegistryDirPaths: string[];
}

const userId = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
const registryDirName = `vscx-${userId}`;

nodeTest.test("preserves explicit runtime directory override priority on macOS", () => {
  const registryScenarioResult = runRegistryScenario({
    options: {
      environment: { VSCX_RUNTIME_DIR: "/environment-runtime", XDG_RUNTIME_DIR: "/xdg-runtime" },
      runtimeDirPath: "explicit-runtime",
    },
  });

  assert.deepEqual(registryScenarioResult.runtimeRegistryDirPaths, [path.resolve("explicit-runtime")]);
  assert.deepEqual(registryScenarioResult.getconfCalls, []);
});

nodeTest.test("preserves VSCX_RUNTIME_DIR and XDG_RUNTIME_DIR before macOS fallback", () => {
  const registryScenarioResult = runRegistryScenario({
    options: { environment: { VSCX_RUNTIME_DIR: "/environment-runtime", XDG_RUNTIME_DIR: "/xdg-runtime" } },
    optionsAfterFirst: [{ environment: { XDG_RUNTIME_DIR: "/xdg-runtime", TMPDIR: "/custom-temporary" } }],
  });

  assert.deepEqual(registryScenarioResult.runtimeRegistryDirPaths, [path.resolve("/environment-runtime"), path.join("/xdg-runtime", "vscx")]);
  assert.deepEqual(registryScenarioResult.getconfCalls, []);
});

nodeTest.test("preserves a custom TMPDIR from the supplied environment on macOS", () => {
  const registryScenarioResult = runRegistryScenario({
    options: { environment: { TMPDIR: "/custom-temporary/" } },
    processEnvironment: { TMPDIR: "/host-temporary" },
  });

  assert.deepEqual(registryScenarioResult.runtimeRegistryDirPaths, [path.join("/custom-temporary", registryDirName)]);
  assert.deepEqual(registryScenarioResult.getconfCalls, []);
});

nodeTest.test("discovers the macOS user temporary directory when TMPDIR is missing or empty", () => {
  for (const environment of [{}, { TMPDIR: "" }]) {
    const registryScenarioResult = runRegistryScenario({
      getconfOutput: "/var/folders/example/T/\n",
      options: { environment },
      processEnvironment: { TMPDIR: "/host-temporary" },
    });

    assert.deepEqual(registryScenarioResult.runtimeRegistryDirPaths, [path.join("/var/folders/example/T", registryDirName)]);
    assert.deepEqual(registryScenarioResult.getconfCalls, [{
      command: "/usr/bin/getconf",
      arguments: ["DARWIN_USER_TEMP_DIR"],
      options: {
        encoding: "utf8",
        env: environment,
        maxBuffer: 4 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      },
    }]);
  }
});

nodeTest.test("uses the process environment when no environment is supplied", () => {
  const registryScenarioResult = runRegistryScenario({
    getconfOutput: "/var/folders/example/T/\n",
    processEnvironment: { VSCX_REGISTRY_TEST: "present" },
  });

  assert.deepEqual(registryScenarioResult.runtimeRegistryDirPaths, [path.join("/var/folders/example/T", registryDirName)]);
  assert.equal(registryScenarioResult.getconfCalls[0]?.options.env.VSCX_REGISTRY_TEST, "present");
  assert.equal(registryScenarioResult.getconfCalls[0]?.options.env.TMPDIR, undefined);
});

nodeTest.test("caches a successful macOS lookup while preserving later overrides", () => {
  const registryScenarioResult = runRegistryScenario({
    getconfOutput: "/var/folders/example/T/\n",
    options: { environment: {} },
    optionsAfterFirst: [
      { environment: { TMPDIR: "" } },
      { environment: { TMPDIR: "/custom-temporary" } },
      { environment: { VSCX_RUNTIME_DIR: "/environment-runtime" } },
    ],
  });

  assert.deepEqual(registryScenarioResult.runtimeRegistryDirPaths, [
    path.join("/var/folders/example/T", registryDirName),
    path.join("/var/folders/example/T", registryDirName),
    path.join("/custom-temporary", registryDirName),
    path.resolve("/environment-runtime"),
  ]);
  assert.equal(registryScenarioResult.getconfCalls.length, 1);
});

nodeTest.test("uses the supplied environment for macOS fallback when getconf fails", () => {
  for (const [environment, temporaryDirPath] of [
    [{ TMP: "/tmp-value", TEMP: "/temp-value" }, "/tmp-value"],
    [{ TEMP: "/temp-value" }, "/temp-value"],
    [{ TMPDIR: "" }, "/tmp"],
    [{}, "/tmp"],
  ] as const) {
    const registryScenarioResult = runRegistryScenario({
      getconfFails: true,
      options: { environment },
      processEnvironment: { TMPDIR: "/host-temporary" },
    });

    assert.deepEqual(registryScenarioResult.runtimeRegistryDirPaths, [path.join(temporaryDirPath, registryDirName)]);
    assert.equal(registryScenarioResult.getconfCalls.length, 1);
  }
});

nodeTest.test("ignores empty, relative, or malformed macOS temporary-directory output", () => {
  for (const getconfOutput of ["", " \n", "relative-directory\n", "/tmp\0invalid\n", "/tmp\n/other\n"]) {
    const registryScenarioResult = runRegistryScenario({ getconfOutput, options: { environment: {} } });

    assert.deepEqual(registryScenarioResult.runtimeRegistryDirPaths, [path.join("/tmp", registryDirName)]);
  }
});

nodeTest.test("keeps the Windows local app data registry path without invoking getconf", () => {
  const registryScenarioResult = runRegistryScenario({
    options: { environment: { LOCALAPPDATA: "/local-app-data", XDG_RUNTIME_DIR: "/xdg-runtime" } },
    platform: "win32",
  });

  assert.deepEqual(registryScenarioResult.runtimeRegistryDirPaths, [path.join("/local-app-data", "vscx", "runtime")]);
  assert.deepEqual(registryScenarioResult.getconfCalls, []);
});

nodeTest.test("keeps the existing non-macOS temporary-directory fallback", () => {
  const registryScenarioResult = runRegistryScenario({
    options: { environment: {} },
    platform: "linux",
    processEnvironment: { TEMP: "/host-temporary", TMPDIR: "/host-temporary" },
  });

  assert.deepEqual(registryScenarioResult.runtimeRegistryDirPaths, [path.join("/host-temporary", registryDirName)]);
  assert.deepEqual(registryScenarioResult.getconfCalls, []);
});

function runRegistryScenario(registryScenario: RegistryScenario): RegistryScenarioResult {
  const registryModuleUrl = new URL("./registry.js", import.meta.url).href;
  const registryScenarioScript = `
    import * as module from "node:module";

    const registryScenario = JSON.parse(process.argv[1]);
    const require = module.createRequire(import.meta.url);
    const childProcess = require("node:child_process");
    const getconfCalls = [];

    Object.defineProperty(process, "platform", { value: registryScenario.platform ?? "darwin" });

    childProcess.execFileSync = (command, commandArguments, options) => {
      getconfCalls.push({ command, arguments: commandArguments, options });

      if (registryScenario.getconfFails) throw new Error("getconf unavailable");

      return registryScenario.getconfOutput ?? "/var/folders/default/T/\\n";
    };

    module.syncBuiltinESMExports();

    const { getRuntimeRegistryDirPath } = await import(${JSON.stringify(registryModuleUrl)});
    const runtimeRegistryDirPaths = [registryScenario.options, ...(registryScenario.optionsAfterFirst ?? [])]
      .map((options) => getRuntimeRegistryDirPath(options));

    process.stdout.write(JSON.stringify({ getconfCalls, runtimeRegistryDirPaths }));
  `;
  const registryScenarioOutput = childProcess.execFileSync(
    process.execPath,
    ["--input-type=module", "-e", registryScenarioScript, JSON.stringify(registryScenario)],
    {
      encoding: "utf8",
      env: registryScenario.processEnvironment ?? { TMPDIR: "/host-temporary" },
      maxBuffer: 64 * 1024,
      timeout: 5_000,
    },
  );

  return JSON.parse(registryScenarioOutput) as RegistryScenarioResult;
}
