import * as childProcess from "node:child_process";
import * as fs from "node:fs";

const maximumAncestorCount = 64;

/** Returns nearest ancestors first. An unavailable process table is not ownership evidence. */
export function getAncestorProcessIds(processId = process.pid): number[] {
  const ancestorProcessIds: number[] = [];
  const parentProcessIds = new Map<number, number>();

  if (process.platform === "darwin") {
    try {
      const processTable = childProcess.execFileSync("/bin/ps", ["-axo", "pid=,ppid="], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 1_000,
      });

      for (const processLine of processTable.trim().split("\n")) {
        const [childProcessId, parentProcessId] = processLine.trim().split(/\s+/).map(Number);

        if (childProcessId && parentProcessId) {
          parentProcessIds.set(childProcessId, parentProcessId);
        }
      }
    } catch {
      return [];
    }
  } else if (process.platform !== "linux") {
    return [];
  }

  let currentProcessId = processId;

  while (currentProcessId > 1 && ancestorProcessIds.length < maximumAncestorCount) {
    if (ancestorProcessIds.includes(currentProcessId)) break;

    ancestorProcessIds.push(currentProcessId);

    if (process.platform === "linux") {
      try {
        const processFileContent = fs.readFileSync(`/proc/${currentProcessId}/stat`, "utf8");
        const processFields = processFileContent.slice(processFileContent.lastIndexOf(")") + 2).split(" ");

        currentProcessId = Number(processFields[1]);
      } catch {
        break;
      }

      continue;
    }

    currentProcessId = parentProcessIds.get(currentProcessId) ?? 0;
  }

  return ancestorProcessIds;
}
