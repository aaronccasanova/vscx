import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as stream from "node:stream";
import * as nodeTest from "node:test";

import {
  createBridgeServer,
  getRuntimeRegistryDirPath,
  protocolVersion,
  vscxVersion,
  writeRuntimeRegistryEntry,
  type BridgeServer,
} from "@vscx/core";

import { parseCliArguments, runCli } from "./run-cli.js";

nodeTest.test("parses target options before or after the command", () => {
  assert.deepEqual(
    parseCliArguments([
      "--window",
      "window-a",
      "eval",
      "--code",
      "return 1",
      "--json",
    ]),
    {
      commandArguments: ["--code", "return 1"],
      commandName: "eval",
      json: true,
      selector: { windowId: "window-a" },
    },
  );
});

nodeTest.test("parses decimal process selectors before or after the command", () => {
  for (const args of [["--process", "123", "info"], ["info", "--process", "123"]]) {
    assert.deepEqual(parseCliArguments(args).selector, { processId: 123 });
  }
});

nodeTest.test("rejects malformed process selectors", () => {
  for (const processId of ["0", "-1", "1.5", "1e3", "0x10", " 123", "123 ", "Infinity", "NaN", "9007199254740992"]) {
    assert.throws(
      () => parseCliArguments(["info", "--process", processId]),
      { code: "invalid-process" },
    );
  }

  assert.throws(() => parseCliArguments(["info", "--process"]), { code: "missing-option" });
});

nodeTest.test("rejects process selectors combined with another target", () => {
  for (const targetArgs of [["--all"], ["--window", "window-a"], ["--workspace", "/tmp"], ["--endpoint", "http://127.0.0.1:1"]]) {
    assert.throws(
      () => parseCliArguments(["info", "--process", "123", ...targetArgs]),
      { code: "incompatible-targets" },
    );
  }
});

nodeTest.test("reports the package version", async () => {
  const bridgeServer = await createTestBridgeServer();

  try {
    const cliResult = await runTestCli(["version"], "", bridgeServer);

    assert.equal(cliResult.exitCode, 0);
    assert.equal(cliResult.stdout, `${vscxVersion}\n`);
    assert.equal(cliResult.stderr, "");
  } finally {
    await bridgeServer.close();
  }
});

nodeTest.test("runs info through current terminal ownership without exposing its token", async () => {
  const bridgeServer = await createTestBridgeServer();

  try {
    const cliResult = await runTestCli(
      ["info", "--json", "--show-connection"],
      "",
      bridgeServer,
    );

    assert.equal(cliResult.exitCode, 0);
    assert.match(cliResult.stdout, /"windowId": "window-test"/);
    assert.doesNotMatch(cliResult.stdout, /a-very-secret-token/);
    assert.equal(cliResult.stderr, "");
  } finally {
    await bridgeServer.close();
  }
});

nodeTest.test("selects the explicit process owner instead of the caller's window", {
  skip: !["darwin", "linux"].includes(process.platform),
}, async () => {
  const bridgeServer = await createTestBridgeServer();
  const processOwnerBridgeServer = await createTestBridgeServer({
    terminalProcessIds: [process.ppid],
    windowId: "process-owner",
  });
  const runtimeDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "vscx-cli-process-test-"));

  writeTestRuntimeRegistryEntry(bridgeServer, runtimeDirPath, "window-test");
  writeTestRuntimeRegistryEntry(processOwnerBridgeServer, runtimeDirPath, "process-owner");

  try {
    const cliResult = await runTestCli(
      ["info", "--process", String(process.ppid), "--json", "--show-connection"],
      "",
      bridgeServer,
      { VSCX_RUNTIME_DIR: runtimeDirPath },
    );
    const infoResult = JSON.parse(cliResult.stdout);

    assert.equal(cliResult.exitCode, 0);
    assert.equal(infoResult.response.windowId, "process-owner");
    assert.equal(infoResult.connection.source, "terminal");
    assert.equal(cliResult.stderr, "");

    const rpcResult = await runTestCli(
      ["rpc"],
      JSON.stringify({ id: "process", op: "info", target: { processId: process.ppid } }),
      bridgeServer,
      { VSCX_RUNTIME_DIR: runtimeDirPath },
    );

    assert.equal(rpcResult.exitCode, 0);
    assert.equal(JSON.parse(rpcResult.stdout).windowId, "process-owner");

    const windowsResult = await runTestCli(
      ["windows", "--process", String(process.ppid), "--json"],
      "",
      bridgeServer,
      { VSCX_RUNTIME_DIR: runtimeDirPath },
    );
    const windows = JSON.parse(windowsResult.stdout) as Array<{ active: boolean; windowId: string }>;

    assert.equal(windowsResult.exitCode, 0);
    assert.deepEqual(windows.filter((window) => window.active).map((window) => window.windowId), ["process-owner"]);
  } finally {
    await bridgeServer.close();
    await processOwnerBridgeServer.close();
    fs.rmSync(runtimeDirPath, { force: true, recursive: true });
  }
});

nodeTest.test("explicit process targets fail when only an unrelated window is healthy", {
  skip: !["darwin", "linux"].includes(process.platform),
}, async () => {
  const bridgeServer = await createTestBridgeServer();

  try {
    for (const commandName of ["info", "windows", "doctor"]) {
      const cliResult = await runTestCli(
        [commandName, "--process", String(process.ppid), "--json"],
        "",
        bridgeServer,
      );
      const resolutionError = commandName === "doctor"
        ? JSON.parse(cliResult.stdout).resolutionError
        : JSON.parse(cliResult.stderr).error;

      assert.equal(cliResult.exitCode, 1, commandName);
      assert.equal(resolutionError.code, "terminal-owner-not-found", commandName);
      assert.equal(resolutionError.details.processId, process.ppid, commandName);
    }

    const rpcResult = await runTestCli(
      ["rpc"],
      JSON.stringify({ id: "unowned", op: "info", target: { processId: process.ppid } }),
      bridgeServer,
    );
    const rpcResponse = JSON.parse(rpcResult.stdout);

    assert.equal(rpcResult.exitCode, 1);
    assert.equal(rpcResponse.id, "unowned");
    assert.equal(rpcResponse.error.code, "terminal-owner-not-found");
    assert.equal(rpcResponse.error.details.processId, process.ppid);
  } finally {
    await bridgeServer.close();
  }
});

nodeTest.test("rejects malformed RPC targets without falling back to the current window", async () => {
  const bridgeServer = await createTestBridgeServer();
  const targets = [
    {},
    { processId: "123" },
    { processId: null },
    { processId: false },
    { processId: 0 },
    { processId: -1 },
    { processId: 1.5 },
    { processId: 9007199254740992 },
    { processId: process.pid, windowId: "window-test" },
    { processId: process.pid, workspace: process.cwd() },
    { processId: process.pid, endpoint: "http://127.0.0.1:1" },
    { processId: process.pid, all: true },
    { windowId: 123 },
    { workspace: "" },
    { process: process.pid },
    null,
    123,
    [],
    "",
  ];

  try {
    const cliResult = await runTestCli(
      ["rpc"],
      targets.map((target, targetIndex) => JSON.stringify({ id: String(targetIndex), op: "info", target })).join("\n"),
      bridgeServer,
    );
    const responses = cliResult.stdout.trim().split("\n").map((line) => JSON.parse(line));

    assert.equal(cliResult.exitCode, 1);
    assert.equal(responses.length, targets.length);
    assert.equal(cliResult.stderr, "");

    for (const [responseIndex, response] of responses.entries()) {
      assert.equal(response.id, String(responseIndex));
      assert.equal(response.ok, false);
      assert.match(response.error.code, /^(invalid-process|invalid-target|incompatible-targets)$/);
    }
  } finally {
    await bridgeServer.close();
  }
});

nodeTest.test("preserves the RPC all target without treating it as a window ID", async () => {
  const bridgeServer = await createTestBridgeServer();

  try {
    const cliResult = await runTestCli(
      ["rpc"],
      JSON.stringify({ id: "all-windows", op: "info", target: "all" }),
      bridgeServer,
    );

    assert.equal(cliResult.exitCode, 0);
    assert.equal(JSON.parse(cliResult.stdout).windowId, "window-test");
    assert.equal(cliResult.stderr, "");
  } finally {
    await bridgeServer.close();
  }
});

nodeTest.test("sends eval code and input through the bridge", async () => {
  const bridgeServer = await createTestBridgeServer();

  try {
    const cliResult = await runTestCli(
      ["eval", "--input", '{"name":"Ada"}'],
      "return input.name",
      bridgeServer,
    );

    assert.equal(cliResult.exitCode, 0);
    assert.match(cliResult.stdout, /return input.name/);
    assert.match(cliResult.stdout, /Ada/);
  } finally {
    await bridgeServer.close();
  }
});

nodeTest.test("processes independent JSON-lines requests", async () => {
  const bridgeServer = await createTestBridgeServer();

  try {
    const cliResult = await runTestCli(
      ["rpc"],
      [
        JSON.stringify({ id: "one", op: "info" }),
        JSON.stringify({ id: "two", op: "eval", code: "return 2" }),
        "",
      ].join("\n"),
      bridgeServer,
    );
    const responseLines = cliResult.stdout.trim().split("\n");

    assert.equal(cliResult.exitCode, 0);
    assert.equal(responseLines.length, 2);
    assert.equal(JSON.parse(responseLines[0] ?? "{}").id, "one");
    assert.equal(JSON.parse(responseLines[1] ?? "{}").id, "two");
  } finally {
    await bridgeServer.close();
  }
});

nodeTest.test("preserves per-window failures during explicit fan-out", async () => {
  const bridgeServer = await createTestBridgeServer();
  const runtimeDirPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "vscx-cli-test-"),
  );
  const registryEntryBase = {
    appHost: "desktop",
    appName: "Visual Studio Code",
    createdAt: new Date().toISOString(),
    extensionHostKind: "local-ui",
    extensionVersion: "0.0.1",
    processId: process.pid,
    protocolVersion,
    token: "a-very-secret-token",
    updatedAt: new Date().toISOString(),
    vscodeVersion: "1.100.0",
    workspaceFolders: [process.cwd()],
  };

  writeRuntimeRegistryEntry(
    {
      ...registryEntryBase,
      endpoint: bridgeServer.endpoint,
      windowId: "healthy-window",
    },
    { runtimeDirPath },
  );
  writeRuntimeRegistryEntry(
    {
      ...registryEntryBase,
      endpoint: "http://127.0.0.1:1",
      windowId: "stale-window",
    },
    { runtimeDirPath },
  );

  try {
    const cliResult = await runTestCli(
      ["--all", "info", "--json"],
      "",
      bridgeServer,
      { VSCX_RUNTIME_DIR: runtimeDirPath },
    );
    const infoResults = JSON.parse(cliResult.stdout) as Array<{
      response: { ok: boolean; windowId: string };
    }>;

    assert.equal(cliResult.exitCode, 1);
    assert.equal(infoResults.length, 2);
    assert.deepEqual(
      infoResults.map((infoResult) => infoResult.response.ok).sort(),
      [false, true],
    );
  } finally {
    await bridgeServer.close();
    fs.rmSync(runtimeDirPath, { force: true, recursive: true });
  }
});

nodeTest.test("doctor reports actual terminal selection instead of stale environment presence", async () => {
  const bridgeServer = await createTestBridgeServer();

  try {
    const cliResult = await runTestCli(["doctor", "--json"], "", bridgeServer, {
      TERM_PROGRAM: "vscode",
      VSCX_ENDPOINT: "http://127.0.0.1:1",
      VSCX_TOKEN: "stale-token",
      VSCX_WINDOW_ID: "stale-window",
    });
    const doctorResult = JSON.parse(cliResult.stdout);

    assert.equal(cliResult.exitCode, 0);
    assert.equal(doctorResult.ok, true);
    assert.deepEqual(doctorResult.checks.selectedWindowIds, ["window-test"]);
    assert.deepEqual(doctorResult.checks.resolutionSources, ["terminal"]);
    assert.doesNotMatch(cliResult.stdout, /stale-token|a-very-secret-token/);
  } finally {
    await bridgeServer.close();
  }
});

nodeTest.test("doctor fails unresolved selection even when a different window is healthy", async () => {
  const bridgeServer = await createBridgeServer({
    extensionVersion: "0.1.0",
    handleRequest: async () => ({ complete: true, processIds: [] }),
    token: "a-very-secret-token",
    windowId: "window-test",
  });

  try {
    const cliResult = await runTestCli(["doctor", "--json"], "", bridgeServer, { TERM_PROGRAM: "vscode" });
    const doctorResult = JSON.parse(cliResult.stdout);

    assert.equal(cliResult.exitCode, 1);
    assert.equal(doctorResult.ok, false);
    assert.equal(doctorResult.checks.healthyWindowCount, 1);
    assert.equal(doctorResult.resolutionError.code, "terminal-owner-not-found");
  } finally {
    await bridgeServer.close();
  }
});

nodeTest.test("doctor reports an existing resolved registry directory in JSON and text", async () => {
  const bridgeServer = await createTestBridgeServer();
  const runtimeDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "vscx-cli-doctor-test-"));
  const runtimeDirName = path.relative(process.cwd(), runtimeDirPath);

  writeTestRuntimeRegistryEntry(bridgeServer, runtimeDirPath, "window-test");

  try {
    const cliResult = await runTestCli(["doctor", "--json"], "", bridgeServer, {
      VSCX_RUNTIME_DIR: runtimeDirName,
    });
    const doctorResult = JSON.parse(cliResult.stdout);

    assert.equal(cliResult.exitCode, 0);
    assert.equal(doctorResult.checks.runtimeDirectory, runtimeDirPath);
    assert.equal(doctorResult.checks.runtimeDirectoryExists, true);

    const textResult = await runTestCli(["doctor"], "", bridgeServer, {
      VSCX_RUNTIME_DIR: runtimeDirName,
    });

    assert.equal(textResult.exitCode, 0);
    assert.ok(textResult.stdout.includes(`Runtime directory: ${runtimeDirPath}`));
    assert.match(textResult.stdout, /Runtime directory exists: yes/);
  } finally {
    await bridgeServer.close();
    fs.rmSync(runtimeDirPath, { force: true, recursive: true });
  }
});

nodeTest.test("doctor reports missing directories and matching registry configuration guidance", async () => {
  const temporaryDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "vscx-cli-doctor-test-"));
  const runtimeDirPath = path.join(temporaryDirPath, "missing");
  const environment = { VSCX_RUNTIME_DIR: runtimeDirPath };

  try {
    const cliResult = await runTestCliWithEnvironment(["doctor", "--json"], "", environment);
    const doctorResult = JSON.parse(cliResult.stdout);

    assert.equal(cliResult.exitCode, 1);
    assert.equal(doctorResult.checks.runtimeDirectory, runtimeDirPath);
    assert.equal(doctorResult.checks.runtimeDirectoryExists, false);
    assert.equal(doctorResult.resolutionError.details.runtimeDirectory, runtimeDirPath);
    assert.equal(doctorResult.resolutionError.details.runtimeDirectoryExists, false);
    assert.match(doctorResult.guidance.join("\n"), /registry directory is missing/);
    assert.match(doctorResult.guidance.join("\n"), /VSCX_RUNTIME_DIR matches/);

    const textResult = await runTestCliWithEnvironment(["doctor"], "", environment);

    assert.equal(textResult.exitCode, 1);
    assert.ok(textResult.stdout.includes(`Runtime directory: ${runtimeDirPath}`));
    assert.match(textResult.stdout, /Runtime directory exists: no/);
    assert.match(textResult.stdout, /registry directory is missing/);
    assert.match(textResult.stdout, /VSCX_RUNTIME_DIR matches/);
    assert.equal(fs.existsSync(runtimeDirPath), false);
  } finally {
    fs.rmSync(temporaryDirPath, { force: true, recursive: true });
  }
});

nodeTest.test("doctor resolves an empty override and distinguishes an empty registry from a missing directory", async () => {
  const temporaryDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "vscx-cli-doctor-test-"));
  const environment = { VSCX_RUNTIME_DIR: "", XDG_RUNTIME_DIR: temporaryDirPath };
  const runtimeDirPath = getRuntimeRegistryDirPath({ environment });

  fs.mkdirSync(runtimeDirPath, { recursive: true });

  try {
    const cliResult = await runTestCliWithEnvironment(["doctor", "--json"], "", environment);
    const doctorResult = JSON.parse(cliResult.stdout);

    assert.equal(cliResult.exitCode, 1);
    assert.equal(doctorResult.checks.runtimeDirectory, runtimeDirPath);
    assert.equal(doctorResult.checks.runtimeDirectoryExists, true);
    assert.equal(doctorResult.checks.registryEntryCount, 0);
    assert.doesNotMatch(doctorResult.guidance.join("\n"), /directory is missing/);
    assert.match(doctorResult.guidance.join("\n"), /VSCX_RUNTIME_DIR matches/);
  } finally {
    fs.rmSync(temporaryDirPath, { force: true, recursive: true });
  }
});

async function createTestBridgeServer(
  options: { terminalProcessIds?: number[]; windowId?: string } = {},
): Promise<BridgeServer> {
  const windowId = options.windowId ?? "window-test";

  return createBridgeServer({
    extensionVersion: "0.0.1",
    handleRequest: async ({ request }) => {
      if (request.op === "terminals.processes") {
        return { complete: true, processIds: options.terminalProcessIds ?? [process.pid] };
      }

      if (request.op === "info") {
        return { windowId };
      }

      return { code: request.code, input: request.input };
    },
    token: "a-very-secret-token",
    windowId,
  });
}

async function runTestCli(
  args: string[],
  standardInputFileContent: string,
  bridgeServer: BridgeServer,
  environmentOverrides: NodeJS.ProcessEnv = {},
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const runtimeDirPath = environmentOverrides.VSCX_RUNTIME_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "vscx-cli-test-"));

  if (!environmentOverrides.VSCX_RUNTIME_DIR) {
    writeTestRuntimeRegistryEntry(bridgeServer, runtimeDirPath, "window-test");
  }

  try {
    return await runTestCliWithEnvironment(args, standardInputFileContent, {
      VSCX_RUNTIME_DIR: runtimeDirPath,
      VSCX_ENDPOINT: bridgeServer.endpoint,
      VSCX_TOKEN: "a-very-secret-token",
      VSCX_WINDOW_ID: "window-test",
      ...environmentOverrides,
    });
  } finally {
    if (!environmentOverrides.VSCX_RUNTIME_DIR) fs.rmSync(runtimeDirPath, { force: true, recursive: true });
  }
}

function writeTestRuntimeRegistryEntry(
  bridgeServer: BridgeServer,
  runtimeDirPath: string,
  windowId: string,
): void {
  writeRuntimeRegistryEntry({
    appHost: "desktop",
    appName: "Visual Studio Code",
    createdAt: new Date().toISOString(),
    endpoint: bridgeServer.endpoint,
    extensionHostKind: "local-ui",
    extensionVersion: "0.0.1",
    processId: process.pid,
    protocolVersion,
    token: "a-very-secret-token",
    updatedAt: new Date().toISOString(),
    vscodeVersion: "1.100.0",
    windowId,
    workspaceFolders: [process.cwd()],
  }, { runtimeDirPath });
}

async function runTestCliWithEnvironment(
  args: string[],
  standardInputFileContent: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  let standardOutputFileContent = "";
  let standardErrorFileContent = "";
  const stdout = new stream.Writable({
    write(chunk, _encoding, callback) {
      standardOutputFileContent += chunk.toString();
      callback();
    },
  });
  const stderr = new stream.Writable({
    write(chunk, _encoding, callback) {
      standardErrorFileContent += chunk.toString();
      callback();
    },
  });
  const exitCode = await runCli({
    args,
    currentDirPath: process.cwd(),
    environment,
    stderr,
    stdin: stream.Readable.from([standardInputFileContent]),
    stdout,
  });

  return {
    exitCode,
    stderr: standardErrorFileContent,
    stdout: standardOutputFileContent,
  };
}
