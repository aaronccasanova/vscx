import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as nodeTest from "node:test";

import {
  createBridgeServer,
  getAncestorProcessIds,
  isRecord,
  protocolVersion,
  resolveBridgeTargets,
  VscxError,
  writeRuntimeRegistryEntry,
  type BridgeServer,
  type BridgeTargetSelector,
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

for (const scenario of [
  { name: "an older host in the same VS Code instance", response: new VscxError("unsupported-operation", "Unsupported operation."), hostAncestors: [500, 900] },
  { name: "a stalled host in the same VS Code instance", response: new Promise<JsonValue>(() => {}), hostAncestors: [500, 900] },
  { name: "an incomplete host in a separate VS Code instance", response: { complete: false, processIds: [] }, hostAncestors: [600, 900] },
]) {
  nodeTest.test(`keeps a matched terminal usable alongside ${scenario.name}`, async () => {
    const runtimeDirPath = createRuntimeDirPath();

    await registerWindow(runtimeDirPath, "owner-window", [200]);
    await registerWindow(runtimeDirPath, "unresolved-window", scenario.response);

    const targets = await resolveBridgeTargets({
      ancestorProcessIds: [100, 200, 400, 500, 900],
      environment: { TERM_PROGRAM: "vscode" },
      getProcessAncestry: (processId) => ({ complete: true, processIds: [processId, ...scenario.hostAncestors] }),
      runtimeDirPath,
    });

    assert.equal(targets[0]?.windowId, "owner-window");
    assert.equal(targets[0]?.source, "terminal");
  });
}

nodeTest.test("uses a confirmed terminal PID from a partial ownership report", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "owner-with-pseudoterminal", { complete: false, processIds: [200] });

  const targets = await resolveBridgeTargets({
    ancestorProcessIds: [100, 200, 400, 500],
    environment: { TERM_PROGRAM: "vscode" },
    getProcessAncestry: (processId) => ({ complete: true, processIds: [processId, 500] }),
    runtimeDirPath,
  });

  assert.equal(targets[0]?.windowId, "owner-with-pseudoterminal");
});

nodeTest.test("rejects duplicate ownership even when one matching report is partial", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "window-a", [200]);
  await registerWindow(runtimeDirPath, "window-b", { complete: false, processIds: [200] });

  await assert.rejects(resolveBridgeTargets({
    ancestorProcessIds: [100, 200, 500],
    environment: { TERM_PROGRAM: "vscode" },
    getProcessAncestry: (processId) => ({ complete: true, processIds: [processId, 500] }),
    runtimeDirPath,
  }), (error: unknown) => error instanceof VscxError && error.code === "ambiguous-window");
});

nodeTest.test("does not choose an outer terminal while a closer window is unresolved", async () => {
  const runtimeDirPath = createRuntimeDirPath();
  const innerWindow = await registerWindow(runtimeDirPath, "inner-window", { complete: false, processIds: [] });

  await registerWindow(runtimeDirPath, "outer-window", [300]);

  for (const environment of [{ TERM_PROGRAM: "vscode" }, {}]) {
    await assert.rejects(resolveBridgeTargets({
      ancestorProcessIds: [100, 200, 250, 300, 500],
      environment,
      getProcessAncestry: (processId) => {
        assert.equal(processId, innerWindow.processId);

        return { complete: true, processIds: [processId, 250, 300, 500] };
      },
      runtimeDirPath,
    }), (error: unknown) => error instanceof VscxError && error.code === "terminal-ownership-unavailable");
  }
});

for (const processIds of [[], [700, 800]]) {
  nodeTest.test(`fails closed when an unresolved host's ancestry is ${processIds.length ? "truncated" : "unavailable"}`, async () => {
    const runtimeDirPath = createRuntimeDirPath();

    await registerWindow(runtimeDirPath, "owner-window", [200]);
    await registerWindow(runtimeDirPath, "unresolved-window", { complete: false, processIds: [] });

    await assert.rejects(resolveBridgeTargets({
      ancestorProcessIds: [100, 200, 500],
      environment: { TERM_PROGRAM: "vscode" },
      getProcessAncestry: () => ({ complete: false, processIds }),
      runtimeDirPath,
    }), (error: unknown) => error instanceof VscxError && error.code === "terminal-ownership-unavailable");
  });
}

nodeTest.test("requires explicit selection for unresolved hosts outside the desktop topology", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "owner-window", [200]);
  await registerWindow(runtimeDirPath, "unknown-topology", { complete: false, processIds: [] }, { appHost: "custom" });

  await assert.rejects(resolveBridgeTargets({
    ancestorProcessIds: [100, 200, 500],
    environment: { TERM_PROGRAM: "vscode" },
    getProcessAncestry: (processId) => ({ complete: true, processIds: [processId, 900] }),
    runtimeDirPath,
  }), (error: unknown) => error instanceof VscxError && error.code === "terminal-ownership-unavailable");
});

nodeTest.test("collects the caller's real process ancestry on supported local platforms", () => {
  if (!["darwin", "linux"].includes(process.platform)) return;

  const ancestorProcessIds = getAncestorProcessIds();

  assert.equal(ancestorProcessIds[0], process.pid);
  assert.ok(ancestorProcessIds.includes(process.ppid));
  assert.ok(ancestorProcessIds.length <= 64);
});

nodeTest.test("explicit process selection uses the requested ancestry and nearest owner after reactivation", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "caller-window", [process.pid]);
  await registerWindow(runtimeDirPath, "outer-window", [300]);
  await registerWindow(runtimeDirPath, "new-owner-window", [200], { workspaceFolders: [] });

  const targets = await resolveBridgeTargets({
    ancestorProcessIds: [process.pid],
    environment: { VSCX_WINDOW_ID: "old-owner-window" },
    getProcessAncestry: (processId) => {
      assert.equal(processId, 100);

      return { complete: true, processIds: [100, 200, 300] };
    },
    runtimeDirPath,
    selector: { processId: 100 },
  });

  assert.equal(targets[0]?.windowId, "new-owner-window");
  assert.equal(targets[0]?.source, "terminal");
});

nodeTest.test("explicit process selection never falls back to workspace, sole window, or remote PID collisions", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "other-window", [800]);

  for (const remoteWindow of [false, true]) {
    if (remoteWindow) {
      await registerWindow(runtimeDirPath, "remote-window", [200], { remoteAuthority: "ssh-remote+example" });
    }

    await assert.rejects(resolveBridgeTargets({
      environment: {},
      getProcessAncestry: () => ({ complete: true, processIds: [100, 200] }),
      runtimeDirPath,
      selector: { processId: 100 },
    }), (error: unknown) => {
      assert.ok(error instanceof VscxError);
      assert.ok(isRecord(error.details));
      assert.equal(error.code, "terminal-owner-not-found");
      assert.equal(error.details.processId, 100);
      assert.equal(error.details.runtimeDirectory, runtimeDirPath);

      return true;
    });
  }
});

nodeTest.test("explicit process selection rejects missing or incomplete ancestry before trusting a reported PID", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "stale-owner", [100]);

  for (const processIds of [[], [100], [100, 200]]) {
    await assert.rejects(resolveBridgeTargets({
      environment: {},
      getProcessAncestry: () => ({ complete: false, processIds }),
      runtimeDirPath,
      selector: { processId: 100 },
    }), (error: unknown) => error instanceof VscxError && error.code === "terminal-ownership-unavailable");
  }
});

nodeTest.test("explicit process selection fails closed on unavailable probes even outside integrated terminals", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "unavailable-window", { complete: false, processIds: [] });

  await assert.rejects(resolveBridgeTargets({
    environment: {},
    getProcessAncestry: () => ({ complete: true, processIds: [100, 200] }),
    runtimeDirPath,
    selector: { processId: 100 },
  }), (error: unknown) => error instanceof VscxError && error.code === "terminal-ownership-unavailable");
});

nodeTest.test("explicit process selection cannot skip an unresolved closer owner", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "outer-window", [300]);
  await registerWindow(runtimeDirPath, "unresolved-inner-window", { complete: false, processIds: [] });

  await assert.rejects(resolveBridgeTargets({
    environment: {},
    getProcessAncestry: (processId) => ({
      complete: true,
      processIds: processId === 100 ? [100, 200, 300, 500] : [processId, 200, 300, 500],
    }),
    runtimeDirPath,
    selector: { processId: 100 },
  }), (error: unknown) => error instanceof VscxError && error.code === "terminal-ownership-unavailable");
});

nodeTest.test("explicit process selection rejects duplicate ownership and identifies the requested PID", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  await registerWindow(runtimeDirPath, "window-a", [100]);
  await registerWindow(runtimeDirPath, "window-b", [100]);

  await assert.rejects(resolveBridgeTargets({
    environment: {},
    getProcessAncestry: () => ({ complete: true, processIds: [100, 200] }),
    runtimeDirPath,
    selector: { processId: 100 },
  }), (error: unknown) => {
    assert.ok(error instanceof VscxError);
    assert.ok(isRecord(error.details));
    assert.equal(error.code, "ambiguous-window");
    assert.equal(error.details.processId, 100);

    return true;
  });
});

nodeTest.test("validates process selectors before any registry access or target fallback", async () => {
  for (const processId of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100", null]) {
    await assert.rejects(resolveBridgeTargets({
      runtimeDirPath: "/does-not-exist/vscx-test",
      selector: { processId } as BridgeTargetSelector,
    }), (error: unknown) => error instanceof VscxError && error.code === "invalid-process");
  }

  for (const selector of [{ all: true }, { endpoint: "http://localhost" }, { windowId: "window-a" }, { workspace: "/example" }]) {
    await assert.rejects(resolveBridgeTargets({
      selector: { ...selector, processId: 100 },
    }), (error: unknown) => error instanceof VscxError && error.code === "incompatible-targets");
  }
});

nodeTest.test("empty and missing registry errors name the resolved directory and its existence", async () => {
  const runtimeDirPath = createRuntimeDirPath();

  for (const runtimeDirectory of [runtimeDirPath, path.join(runtimeDirPath, "missing")]) {
    for (const selector of [{}, { all: true }, { windowId: "unknown-window" }, { workspace: "/missing-project" }]) {
      await assert.rejects(resolveBridgeTargets({
        ancestorProcessIds: [],
        environment: {},
        runtimeDirPath: runtimeDirectory,
        selector,
      }), (error: unknown) => {
        assert.ok(error instanceof VscxError);
        assert.ok(isRecord(error.details));
        assert.equal(error.code, "windowId" in selector ? "window-not-found" : "workspace" in selector ? "workspace-not-found" : "no-windows");
        assert.equal(error.details.runtimeDirectory, runtimeDirectory);
        assert.equal(error.details.runtimeDirectoryExists, runtimeDirectory === runtimeDirPath);
        assert.ok(error.message.includes(runtimeDirectory));
        assert.match(error.message, /VSCX_RUNTIME_DIR/);

        return true;
      });
    }
  }
});

function createRuntimeDirPath(): string {
  const runtimeDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "vscx-discovery-"));

  runtimeDirPaths.push(runtimeDirPath);

  return runtimeDirPath;
}

async function registerWindow(
  runtimeDirPath: string,
  windowId: string,
  terminalProcessIds: JsonValue | Promise<JsonValue> | Error,
  overrides: Partial<RuntimeRegistryEntry> = {},
): Promise<RuntimeRegistryEntry> {
  const bridgeServer = await createBridgeServer({
    extensionVersion: "0.1.0",
    handleRequest: async () => {
      if (terminalProcessIds instanceof Error) throw terminalProcessIds;

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
