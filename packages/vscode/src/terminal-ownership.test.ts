import * as assert from "node:assert/strict";
import * as nodeTest from "node:test";

import type * as vscode from "vscode";

import { getTerminalOwnership } from "./terminal-ownership";

nodeTest.test("reports live terminal processes without waiting on already exited terminals", async () => {
  const liveTerminal = createTerminal(Promise.resolve(42));
  const exitedTerminal = createTerminal(new Promise(() => {}));

  exitedTerminal.exitStatus = { code: 0, reason: 2 };

  assert.deepEqual(await getTerminalOwnership({ terminals: [liveTerminal, exitedTerminal] }), {
    complete: true,
    processIds: [42],
  });
});

nodeTest.test("marks unresolved terminal ownership incomplete instead of returning a misleading empty list", async () => {
  const startedAt = performance.now();
  const terminalOwnership = await getTerminalOwnership({ terminals: [createTerminal(new Promise(() => {}))] });

  assert.deepEqual(terminalOwnership, { complete: false, processIds: [] });
  assert.ok(performance.now() - startedAt < 1_000);
});

nodeTest.test("excludes processes that exit or close while another process is resolving", async () => {
  const exitedTerminal = createTerminal(Promise.resolve(42));
  const closedTerminal = createTerminal(Promise.resolve(43));
  let resolvePendingProcess: ((processId: number) => void) | undefined;
  const pendingTerminal = createTerminal(new Promise((resolve) => { resolvePendingProcess = resolve; }));
  const window = { terminals: [exitedTerminal, closedTerminal, pendingTerminal] };
  const ownershipPromise = getTerminalOwnership(window);

  await Promise.resolve();

  exitedTerminal.exitStatus = { code: 0, reason: 2 };
  window.terminals = [exitedTerminal, pendingTerminal];
  resolvePendingProcess!(44);

  assert.deepEqual(await ownershipPromise, { complete: true, processIds: [44] });
});

nodeTest.test("marks a concurrently added terminal as incomplete ownership evidence", async () => {
  const window = { terminals: [createTerminal(Promise.resolve(42))] };
  const ownershipPromise = getTerminalOwnership(window);

  window.terminals.push(createTerminal(Promise.resolve(43)));

  assert.equal((await ownershipPromise).complete, false);
});

nodeTest.test("marks rejected process lookup incomplete", async () => {
  const terminal = createTerminal(Promise.reject(new Error("closed during lookup")));

  assert.deepEqual(await getTerminalOwnership({ terminals: [terminal] }), { complete: false, processIds: [] });
});

nodeTest.test("does not treat a native terminal without a process ID as complete evidence", async () => {
  assert.deepEqual(await getTerminalOwnership({ terminals: [createTerminal(Promise.resolve(undefined))] }), {
    complete: false,
    processIds: [],
  });
});

nodeTest.test("ignores extension pseudoterminals with no native process", async () => {
  const terminal = { creationOptions: { pty: {} }, exitStatus: undefined, processId: new Promise(() => {}) } as unknown as vscode.Terminal;

  assert.deepEqual(await getTerminalOwnership({ terminals: [terminal] }), { complete: true, processIds: [] });
});

function createTerminal(processId: Promise<number | undefined>): vscode.Terminal & { exitStatus: vscode.TerminalExitStatus | undefined } {
  return { processId, exitStatus: undefined, creationOptions: {} } as unknown as vscode.Terminal & { exitStatus: vscode.TerminalExitStatus | undefined };
}
