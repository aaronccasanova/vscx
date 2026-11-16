import * as timers from "node:timers/promises";

import type * as vscode from "vscode";

interface TerminalOwnership {
  complete: boolean;
  processIds: number[];
}

/** Missing or pending process IDs must not make a different window look like the owner. */
export async function getTerminalOwnership(window: Pick<typeof vscode.window, "terminals">): Promise<TerminalOwnership> {
  const terminals = [...window.terminals];
  const processIdByTerminal = new Map<vscode.Terminal, number>();
  const abortController = new AbortController();
  let complete = true;
  const terminalProcesses = Promise.all(terminals.map(async (terminal) => {
    if (terminal.exitStatus !== undefined || "pty" in terminal.creationOptions) return;

    try {
      const processId = await terminal.processId;

      if (terminal.exitStatus !== undefined || !window.terminals.includes(terminal)) return;

      if (processId === undefined || !Number.isSafeInteger(processId) || processId <= 0) {
        complete = false;

        return;
      }

      processIdByTerminal.set(terminal, processId);
    } catch {
      complete = false;
    }
  }));

  try {
    const processIdsResolved = await Promise.race([
      terminalProcesses.then(() => true),
      timers.setTimeout(100, false, { signal: abortController.signal }),
    ]);

    complete = complete && processIdsResolved && window.terminals.every((terminal) => terminals.includes(terminal));
  } finally {
    abortController.abort();
  }

  const processIds = [...processIdByTerminal]
    .filter(([terminal]) => terminal.exitStatus === undefined && window.terminals.includes(terminal))
    .map(([, processId]) => processId);

  return { complete, processIds };
}
