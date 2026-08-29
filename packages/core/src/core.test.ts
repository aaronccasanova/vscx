import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as nodeTest from "node:test";
import * as url from "node:url";

import {
  BridgeJobManager,
  createBridgeRequest,
  createBridgeServer,
  parseBridgeRequest,
  pruneStaleRuntimeRegistryEntries,
  protocolVersion,
  readRuntimeRegistryEntries,
  resolveBridgeTargets,
  sendBridgeRequest,
  serializeValue,
  VscxError,
  vscxVersion,
  writeRuntimeRegistryEntry,
  type RuntimeRegistryEntry,
} from "./index.js";

const temporaryDirPaths: string[] = [];

nodeTest.afterEach(() => {
  for (const temporaryDirPath of temporaryDirPaths.splice(0)) {
    fs.rmSync(temporaryDirPath, { force: true, recursive: true });
  }
});

nodeTest.test("keeps package and runtime versions aligned", () => {
  const coreDistDirPath = path.dirname(url.fileURLToPath(import.meta.url));
  const projectRootDirPath = path.resolve(coreDistDirPath, "../../..");
  const packageFileNames = [
    "packages/core/package.json",
    "packages/cli/package.json",
    "packages/vscode/package.json",
  ];

  for (const packageFileName of packageFileNames) {
    const packageFilePath = path.join(projectRootDirPath, packageFileName);
    const packageFileContent = fs.readFileSync(packageFilePath, "utf8");
    const packageConfig = JSON.parse(packageFileContent) as { version?: unknown };

    assert.equal(packageConfig.version, vscxVersion, packageFileName);
  }
});

nodeTest.test("parses a valid protocol request", () => {
  const bridgeRequest = parseBridgeRequest({
    version: protocolVersion,
    id: "request-1",
    op: "eval",
    code: "return 1",
  });

  assert.equal(bridgeRequest.id, "request-1");
  assert.equal(bridgeRequest.op, "eval");
});

nodeTest.test("rejects an incompatible protocol version", () => {
  assert.throws(
    () =>
      parseBridgeRequest({
        version: 2,
        id: "request-1",
        op: "info",
      }),
    /Unsupported protocol version/,
  );
});

nodeTest.test("serializes tagged values and cycles without throwing", () => {
  const cycle: { child?: unknown; name: string } = { name: "root" };

  cycle.child = cycle;

  assert.deepEqual(serializeValue(cycle), {
    name: "root",
    child: { $type: "unserializable", reason: "cycle" },
  });
  assert.deepEqual(serializeValue(42n), { $type: "bigint", value: "42" });
  assert.deepEqual(serializeValue(new Uint8Array([1, 2, 3])), {
    $type: "bytes",
    base64: "AQID",
  });
  assert.deepEqual(serializeValue({ line: 4, character: 8 }), {
    $type: "vscode.Position",
    line: 4,
    character: 8,
  });

  class ExtensionHostObject {}

  assert.deepEqual(serializeValue(new ExtensionHostObject()), {
    $type: "unserializable",
    reason: "unsupported-prototype",
    description: "ExtensionHostObject",
  });
});

nodeTest.test("writes and reads user-only registry entries", () => {
  const temporaryDirPath = createTemporaryDirPath();
  const runtimeRegistryEntry = buildRuntimeRegistryEntry({ windowId: "window-a" });
  const runtimeRegistryFilePath = writeRuntimeRegistryEntry(runtimeRegistryEntry, {
    runtimeDirPath: temporaryDirPath,
  });
  const runtimeRegistryEntries = readRuntimeRegistryEntries({
    runtimeDirPath: temporaryDirPath,
  });

  assert.deepEqual(runtimeRegistryEntries, [runtimeRegistryEntry]);

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(temporaryDirPath).mode & 0o777, 0o700);
    assert.equal(fs.statSync(runtimeRegistryFilePath).mode & 0o777, 0o600);
  }
});

nodeTest.test("prunes registry entries for stopped processes", () => {
  const temporaryDirPath = createTemporaryDirPath();
  const stoppedProcessResult = childProcess.spawnSync(process.execPath, [
    "-e",
    "process.exit(0)",
  ]);

  assert.equal(stoppedProcessResult.status, 0);
  assert.ok(stoppedProcessResult.pid);

  writeRuntimeRegistryEntry(
    buildRuntimeRegistryEntry({ processId: stoppedProcessResult.pid }),
    { runtimeDirPath: temporaryDirPath },
  );

  const activeRuntimeRegistryEntries = pruneStaleRuntimeRegistryEntries({
    runtimeDirPath: temporaryDirPath,
  });

  assert.deepEqual(activeRuntimeRegistryEntries, []);
  assert.deepEqual(
    readRuntimeRegistryEntries({ runtimeDirPath: temporaryDirPath }),
    [],
  );
});

nodeTest.test("prefers injected environment for the current target", () => {
  const bridgeTargets = resolveBridgeTargets({
    environment: {
      VSCX_ENDPOINT: "http://127.0.0.1:1234",
      VSCX_TOKEN: "secret",
      VSCX_WINDOW_ID: "window-a",
    },
    runtimeDirPath: createTemporaryDirPath(),
  });

  assert.deepEqual(bridgeTargets, [
    {
      endpoint: "http://127.0.0.1:1234",
      source: "environment",
      token: "secret",
      windowId: "window-a",
    },
  ]);
});

nodeTest.test("rejects ambiguous workspace targets", () => {
  const temporaryDirPath = createTemporaryDirPath();

  writeRuntimeRegistryEntry(
    buildRuntimeRegistryEntry({ windowId: "window-a" }),
    { runtimeDirPath: temporaryDirPath },
  );
  writeRuntimeRegistryEntry(
    buildRuntimeRegistryEntry({ windowId: "window-b" }),
    { runtimeDirPath: temporaryDirPath },
  );

  assert.throws(
    () =>
      resolveBridgeTargets({
        currentDirPath: process.cwd(),
        environment: {},
        runtimeDirPath: temporaryDirPath,
      }),
    (error: unknown) =>
      error instanceof VscxError && error.code === "ambiguous-window",
  );
});

nodeTest.test("manages job resources through cancellation and disposal", async () => {
  const bridgeJobManager = new BridgeJobManager();
  const disposedResourceNames: string[] = [];
  const bridgeJobHandle = bridgeJobManager.create({ id: "watcher" });

  bridgeJobHandle.add(() => {
    disposedResourceNames.push("function");
  });
  bridgeJobHandle.add({
    dispose: () => {
      disposedResourceNames.push("object");
    },
  });

  await bridgeJobManager.cancel("watcher");

  assert.equal(bridgeJobHandle.signal.aborted, true);
  assert.equal(bridgeJobManager.get("watcher").state, "cancelled");

  const disposedBridgeJob = await bridgeJobManager.dispose("watcher");

  assert.equal(disposedBridgeJob.state, "disposed");
  assert.deepEqual(disposedResourceNames.sort(), ["function", "object"]);
  assert.deepEqual(bridgeJobManager.list(), []);
});

nodeTest.test("round trips authenticated bridge requests", async () => {
  const bridgeServer = await createBridgeServer({
    extensionVersion: "0.0.1",
    handleRequest: async ({ request }) => ({ operation: request.op }),
    token: "secret",
    windowId: "window-a",
  });

  try {
    const bridgeResponse = await sendBridgeRequest(
      { endpoint: bridgeServer.endpoint, token: "secret" },
      createBridgeRequest({ op: "info" }),
    );

    assert.equal(bridgeResponse.ok, true);

    if (bridgeResponse.ok) {
      assert.deepEqual(bridgeResponse.value, { operation: "info" });
    }
  } finally {
    await bridgeServer.close();
  }
});

nodeTest.test("reports an invalid bridge token as unauthorized", async () => {
  const bridgeServer = await createBridgeServer({
    extensionVersion: "0.0.1",
    handleRequest: async () => null,
    token: "secret",
    windowId: "window-a",
  });

  try {
    await assert.rejects(
      () =>
        sendBridgeRequest(
          { endpoint: bridgeServer.endpoint, token: "wrong" },
          createBridgeRequest({ op: "info" }),
        ),
      (error: unknown) =>
        error instanceof VscxError && error.code === "unauthorized",
    );
  } finally {
    await bridgeServer.close();
  }
});

nodeTest.test("reports caller cancellation separately from timeout", async () => {
  const abortController = new AbortController();

  abortController.abort();

  await assert.rejects(
    () =>
      sendBridgeRequest(
        { endpoint: "http://127.0.0.1:1", token: "secret" },
        createBridgeRequest({ op: "info" }),
        { signal: abortController.signal },
      ),
    (error: unknown) =>
      error instanceof VscxError && error.code === "request-cancelled",
  );
});

nodeTest.test("returns a structured timeout error and aborts the handler", async () => {
  let handlerWasAborted = false;
  const bridgeServer = await createBridgeServer({
    extensionVersion: "0.0.1",
    handleRequest: async ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            handlerWasAborted = true;
            reject(new Error("handler aborted"));
          },
          { once: true },
        );
      }),
    token: "secret",
    windowId: "window-a",
  });

  try {
    const bridgeResponse = await sendBridgeRequest(
      { endpoint: bridgeServer.endpoint, token: "secret" },
      createBridgeRequest({ op: "info", timeoutMs: 20 }),
    );

    assert.equal(bridgeResponse.ok, false);
    assert.equal(handlerWasAborted, true);

    if (!bridgeResponse.ok) {
      assert.equal(bridgeResponse.error.code, "request-timeout");
    }
  } finally {
    await bridgeServer.close();
  }
});

function createTemporaryDirPath(): string {
  const temporaryDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "vscx-test-"));

  temporaryDirPaths.push(temporaryDirPath);

  return temporaryDirPath;
}

function buildRuntimeRegistryEntry(
  overrides: Partial<RuntimeRegistryEntry>,
): RuntimeRegistryEntry {
  return {
    appHost: "desktop",
    appName: "Visual Studio Code",
    createdAt: "2026-01-01T00:00:00.000Z",
    endpoint: "http://127.0.0.1:1234",
    extensionHostKind: "local-process",
    extensionVersion: "0.0.1",
    processId: process.pid,
    protocolVersion,
    token: "secret",
    updatedAt: "2026-01-01T00:00:00.000Z",
    vscodeVersion: "1.100.0",
    windowId: "window-a",
    workspaceFolders: [process.cwd()],
    ...overrides,
  };
}
