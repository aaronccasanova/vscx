import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as stream from "node:stream";
import * as nodeTest from "node:test";

import {
  createBridgeServer,
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

async function createTestBridgeServer(): Promise<BridgeServer> {
  return createBridgeServer({
    extensionVersion: "0.0.1",
    handleRequest: async ({ request }) => {
      if (request.op === "terminals.processes") {
        return { complete: true, processIds: [process.pid] };
      }

      if (request.op === "info") {
        return { windowId: "window-test" };
      }

      return { code: request.code, input: request.input };
    },
    token: "a-very-secret-token",
    windowId: "window-test",
  });
}

async function runTestCli(
  args: string[],
  standardInputFileContent: string,
  bridgeServer: BridgeServer,
  environmentOverrides: NodeJS.ProcessEnv = {},
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
  const runtimeDirPath = environmentOverrides.VSCX_RUNTIME_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "vscx-cli-test-"));

  if (!environmentOverrides.VSCX_RUNTIME_DIR) {
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
      windowId: "window-test",
      workspaceFolders: [process.cwd()],
    }, { runtimeDirPath });
  }

  const exitCode = await runCli({
    args,
    currentDirPath: process.cwd(),
    environment: {
      VSCX_RUNTIME_DIR: runtimeDirPath,
      VSCX_ENDPOINT: bridgeServer.endpoint,
      VSCX_TOKEN: "a-very-secret-token",
      VSCX_WINDOW_ID: "window-test",
      ...environmentOverrides,
    },
    stderr,
    stdin: stream.Readable.from([standardInputFileContent]),
    stdout,
  });

  if (!environmentOverrides.VSCX_RUNTIME_DIR) fs.rmSync(runtimeDirPath, { force: true, recursive: true });

  return {
    exitCode,
    stderr: standardErrorFileContent,
    stdout: standardOutputFileContent,
  };
}
