import * as childProcess from "node:child_process";
import * as fs from "node:fs";

export interface ProcessAncestry {
  complete: boolean;
  processIds: number[];
}

export interface ProcessAncestryReaderOptions {
  platform?: NodeJS.Platform;
  readLinuxProcessStat?: (processId: number) => string;
  readMacProcessTable?: () => string;
}

const maximumAncestorCount = 64;

/** Reuses one process table or cached parent reads across related ancestry checks. */
export function createProcessAncestryReader(
  options: ProcessAncestryReaderOptions = {},
): (processId?: number) => ProcessAncestry {
  const platform = options.platform ?? process.platform;
  const parentProcessIds = new Map<number, number | undefined>();
  let processTableRead = false;

  return (processId = process.pid) => {
    if (!["darwin", "linux"].includes(platform)) {
      return { complete: false, processIds: [] };
    }

    if (!Number.isSafeInteger(processId) || processId < 1) {
      return { complete: false, processIds: [] };
    }

    if (platform === "darwin" && !processTableRead) {
      processTableRead = true;

      try {
        const processTable = (options.readMacProcessTable ?? readMacProcessTable)();

        for (const processLine of processTable.trim().split("\n")) {
          const processFields = processLine.trim().split(/\s+/);
          const childProcessId = Number(processFields[0]);
          const parentProcessId = Number(processFields[1]);

          if (
            processFields.length !== 2 ||
            !Number.isSafeInteger(childProcessId) || childProcessId < 1 ||
            !Number.isSafeInteger(parentProcessId) || parentProcessId < 0
          ) {
            continue;
          }

          // Conflicting rows cannot establish a trustworthy parent relationship.
          if (parentProcessIds.has(childProcessId) && parentProcessIds.get(childProcessId) !== parentProcessId) {
            parentProcessIds.set(childProcessId, undefined);

            continue;
          }

          parentProcessIds.set(childProcessId, parentProcessId);
        }
      } catch {
        // A failed snapshot remains unavailable for the lifetime of this reader.
      }
    }

    const processIds: number[] = [];
    let currentProcessId = processId;

    while (currentProcessId > 1 && processIds.length < maximumAncestorCount) {
      if (processIds.includes(currentProcessId)) {
        return { complete: false, processIds };
      }

      processIds.push(currentProcessId);

      if (platform === "linux" && !parentProcessIds.has(currentProcessId)) {
        let parentProcessId: number | undefined;

        try {
          const processStat = (options.readLinuxProcessStat ?? readLinuxProcessStat)(currentProcessId);
          const commandEndIndex = processStat.lastIndexOf(")");
          const processFields = processStat.slice(commandEndIndex + 1).trim().split(/\s+/);
          const parsedParentProcessId = Number(processFields[1]);

          if (
            processStat.startsWith(`${currentProcessId} (`) &&
            commandEndIndex >= 0 &&
            /^[a-zA-Z]$/.test(processFields[0] ?? "") &&
            Number.isSafeInteger(parsedParentProcessId) && parsedParentProcessId >= 0
          ) {
            parentProcessId = parsedParentProcessId;
          }
        } catch {
          // A missing process or unreadable stat file leaves the chain incomplete.
        }

        parentProcessIds.set(currentProcessId, parentProcessId);
      }

      const parentProcessId = parentProcessIds.get(currentProcessId);

      if (parentProcessId === undefined) return { complete: false, processIds };
      if (parentProcessId <= 1) return { complete: true, processIds };

      currentProcessId = parentProcessId;
    }

    return { complete: currentProcessId <= 1, processIds };
  };
}

/** Returns nearest ancestors first, excluding PID 1. Partial chains are not exclusion evidence. */
export function getAncestorProcessIds(processId = process.pid): number[] {
  return createProcessAncestryReader()(processId).processIds;
}

function readMacProcessTable(): string {
  return childProcess.execFileSync("/bin/ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
  });
}

function readLinuxProcessStat(processId: number): string {
  return fs.readFileSync(`/proc/${processId}/stat`, "utf8");
}
