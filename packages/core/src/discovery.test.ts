import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as nodeTest from "node:test";

import {
  createBridgeServer,
  getAncestorProcessIds,
  protocolVersion,
  resolveBridgeTargets,
  VscxError,
  writeRuntimeRegistryEntry,
  type BridgeServer,
  type JsonValue,
  type RuntimeRegistryEntry,
} from "./index.js";

const bridgeServers: BridgeServer[] = [];
const runtimeDirPaths: string[] = [];

nodeTest.afterEach(async () => {
  await Promise.all(bridgeServers.splice(0).map((bridgeServer) => bridgeServer.close()));

  for (const runtimeDirPath of runtimeDirPaths.splice(0)) {
    fs.rmSync(runtimeDirPath, { recursive: true, force: true });
  }
});

nodeTest.test("resolves a restored empty-window terminal before another window matching cwd or stale environment", async () => {
  const runtimeDirPath = createRuntimeDirPath();
  const otherEntry = await registerWindow(runtimeDirPath, "other-window", [800]);

  await registerWindow(runtimeDirPath, "restored-owner", [200], { workspaceFolders: [] });

  const targets = await resolveBridgeTargets({
    ancestorProcessIds: [100, 200, 300],
    currentDirPath: process.cwd(),
    environment: {
      TERM_PROGRAM: "vscode",
      VSCX_ENDPOINT: otherEntry.endpoint,
      VSCX_TOKEN: otherEntry.token,
      VSCX_WINDOW_ID: otherEntry.windowId,
    },
    runtimeDirPath,
  });

  assert.equal(targets[0]?.windowId, "restored-owner");
  assert.equal(targets[0]?.source, "terminal");
});

nodeTest.test("uses the nearest terminal ancestor across nested windows", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "outer-window", [300]);
  await registerWindow(runtimeDirPath, "inner-window", [200]);

  const targets = await resolveBridgeTargets({
    ancestorProcessIds: [100, 200, 300],
    environment: { TERM_PROGRAM: "vscode" },
    runtimeDirPath,
  });

  assert.equal(targets[0]?.windowId, "inner-window");
});

nodeTest.test("rejects duplicate ownership rather than choosing a window", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "window-a", [200]);
  await registerWindow(runtimeDirPath, "window-b", [200]);

  await assert.rejects(
    resolveBridgeTargets({ ancestorProcessIds: [100, 200], environment: {}, runtimeDirPath }),
    (error: unknown) => error instanceof VscxError && error.code === "ambiguous-window",
  );
});

nodeTest.test("fails closed while an integrated terminal's own window is starting", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "only-other-window", [800]);

  for (const environment of [
    { TERM_PROGRAM: "vscode" },
    { VSCODE_IPC_HOOK_CLI: "/old/socket" },
    { VSCX_WINDOW_ID: "old-owner", VSCX_ENDPOINT: "invalid stale endpoint", VSCX_TOKEN: "old-token" },
  ]) {
    await assert.rejects(
      resolveBridgeTargets({ ancestorProcessIds: [100, 200], environment, runtimeDirPath }),
      (error: unknown) => error instanceof VscxError && error.code === "terminal-owner-not-found",
    );
  }
});

nodeTest.test("ignores remote terminal PIDs that collide with local ancestry", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "remote-window", [200], { remoteAuthority: "ssh-remote+example" });

  await assert.rejects(
    resolveBridgeTargets({ ancestorProcessIds: [100, 200], environment: { TERM_PROGRAM: "vscode" }, runtimeDirPath }),
    (error: unknown) => error instanceof VscxError && error.code === "terminal-owner-not-found",
  );
});

nodeTest.test("requires explicit selection when local ancestry is unavailable", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "window-a", [200]);

  await assert.rejects(
    resolveBridgeTargets({ ancestorProcessIds: [], environment: { TERM_PROGRAM: "vscode" }, runtimeDirPath }),
    (error: unknown) => error instanceof VscxError && error.code === "terminal-owner-not-found",
  );

  const targets = await resolveBridgeTargets({
    ancestorProcessIds: [],
    environment: { TERM_PROGRAM: "vscode" },
    runtimeDirPath,
    selector: { windowId: "window-a" },
  });

  assert.equal(targets[0]?.windowId, "window-a");
});

nodeTest.test("never uses live legacy credentials as proof of terminal ownership", async () => {
  const runtimeDirPath = createRuntimeDirPath();
  const runtimeRegistryEntry = await registerWindow(runtimeDirPath, "window-a", []);

  await assert.rejects(resolveBridgeTargets({
    ancestorProcessIds: [],
    environment: {
      VSCX_WINDOW_ID: runtimeRegistryEntry.windowId,
      VSCX_ENDPOINT: runtimeRegistryEntry.endpoint,
      VSCX_TOKEN: runtimeRegistryEntry.token,
    },
    runtimeDirPath,
  }), (error: unknown) => error instanceof VscxError && error.code === "terminal-owner-not-found");
});

nodeTest.test("preserves explicit endpoint selection without a registry", async () => {
  const targets = await resolveBridgeTargets({
    environment: { VSCX_TOKEN: "explicit-token" },
    runtimeDirPath: createRuntimeDirPath(),
    selector: { endpoint: "http://127.0.0.1:1234/" },
  });

  assert.deepEqual(targets, [{ endpoint: "http://127.0.0.1:1234", source: "explicit-endpoint", token: "explicit-token" }]);
});

nodeTest.test("retains workspace and sole-window selection for external shells", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "window-a", [], { workspaceFolders: [process.cwd()] });

  const workspaceTargets = await resolveBridgeTargets({ ancestorProcessIds: [], environment: {}, runtimeDirPath });
  const soleTargets = await resolveBridgeTargets({ ancestorProcessIds: [], currentDirPath: os.tmpdir(), environment: {}, runtimeDirPath });

  assert.equal(workspaceTargets[0]?.source, "workspace");
  assert.equal(soleTargets[0]?.source, "single-window");
});

nodeTest.test("bounds slow ownership probes and never falls through to another window", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "slow-window", new Promise(() => {}));
  await registerWindow(runtimeDirPath, "other-window", []);

  const startedAt = performance.now();

  await assert.rejects(
    resolveBridgeTargets({ ancestorProcessIds: [100, 200], environment: { TERM_PROGRAM: "vscode" }, runtimeDirPath }),
    (error: unknown) => error instanceof VscxError && error.code === "terminal-ownership-unavailable",
  );

  assert.ok(performance.now() - startedAt < 1_500);
});

nodeTest.test("ignores unsupported, malformed, or unauthenticated ownership responses", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "malformed-window", { processIds: [200] });
  await registerWindow(runtimeDirPath, "unauthenticated-window", [200], { token: "wrong-token" });

  await assert.rejects(
    resolveBridgeTargets({ ancestorProcessIds: [100, 200], environment: { TERM_PROGRAM: "vscode" }, runtimeDirPath }),
    (error: unknown) => error instanceof VscxError && error.code === "terminal-ownership-unavailable",
  );
});

nodeTest.test("does not choose an outer terminal while a closer window is unresolved", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "outer-window", [300]);
  await registerWindow(runtimeDirPath, "inner-window", { complete: false, processIds: [] });

  await assert.rejects(
    resolveBridgeTargets({ ancestorProcessIds: [100, 200, 300], environment: { TERM_PROGRAM: "vscode" }, runtimeDirPath }),
    (error: unknown) => error instanceof VscxError && error.code === "terminal-ownership-unavailable",
  );
});

nodeTest.test("collects the caller's real process ancestry on supported local platforms", () => {
  if (!["darwin", "linux"].includes(process.platform)) return;

  const ancestorProcessIds = getAncestorProcessIds();

  assert.equal(ancestorProcessIds[0], process.pid);
  assert.ok(ancestorProcessIds.includes(process.ppid));
  assert.ok(ancestorProcessIds.length <= 64);
});

function createRuntimeDirPath(): string {
  const runtimeDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "vscx-discovery-"));

  runtimeDirPaths.push(runtimeDirPath);

  return runtimeDirPath;
}

async function registerWindow(
  runtimeDirPath: string,
  windowId: string,
  terminalProcessIds: JsonValue | Promise<JsonValue>,
  overrides: Partial<RuntimeRegistryEntry> = {},
): Promise<RuntimeRegistryEntry> {
  const bridgeServer = await createBridgeServer({
    extensionVersion: "0.1.0",
    handleRequest: async () => {
      const resolvedTerminalProcessIds = await terminalProcessIds;

      return Array.isArray(resolvedTerminalProcessIds)
        ? { complete: true, processIds: resolvedTerminalProcessIds }
        : resolvedTerminalProcessIds;
    },
    token: "window-token",
    windowId,
  });

  bridgeServers.push(bridgeServer);

  const runtimeRegistryEntry: RuntimeRegistryEntry = {
    appHost: "desktop",
    appName: "Visual Studio Code",
    createdAt: new Date().toISOString(),
    endpoint: bridgeServer.endpoint,
    extensionHostKind: "local-ui",
    extensionVersion: "0.1.0",
    processId: process.pid,
    protocolVersion,
    token: "window-token",
    updatedAt: new Date().toISOString(),
    vscodeVersion: "1.100.0",
    windowId,
    workspaceFolders: [process.cwd()],
    ...overrides,
  };

  writeRuntimeRegistryEntry(runtimeRegistryEntry, { runtimeDirPath });

  return runtimeRegistryEntry;
}
