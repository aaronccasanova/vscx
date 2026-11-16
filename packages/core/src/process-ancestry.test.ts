import * as assert from "node:assert/strict";
import * as nodeTest from "node:test";

import { createProcessAncestryReader, getAncestorProcessIds } from "./process-ancestry.js";

nodeTest.test("reads one macOS snapshot for related caller and host ancestry", () => {
  let processTableReads = 0;
  const getProcessAncestry = createProcessAncestryReader({
    platform: "darwin",
    readMacProcessTable: () => {
      processTableReads += 1;

      return "100 200\n200 300\n400 300\n300 1\n1 0\n";
    },
  });

  assert.equal(processTableReads, 0);
  assert.deepEqual(getProcessAncestry(100), { complete: true, processIds: [100, 200, 300] });
  assert.deepEqual(getProcessAncestry(400), { complete: true, processIds: [400, 300] });
  assert.equal(processTableReads, 1);
});

nodeTest.test("does not treat missing macOS rows as a complete chain", () => {
  const getProcessAncestry = createProcessAncestryReader({
    platform: "darwin",
    readMacProcessTable: () => "100 200\n200 300\n",
  });

  assert.deepEqual(getProcessAncestry(100), { complete: false, processIds: [100, 200, 300] });
});

nodeTest.test("caches an unavailable macOS snapshot without inventing ancestry", () => {
  let processTableReads = 0;
  const getProcessAncestry = createProcessAncestryReader({
    platform: "darwin",
    readMacProcessTable: () => {
      processTableReads += 1;

      throw new Error("ps unavailable");
    },
  });

  assert.deepEqual(getProcessAncestry(100), { complete: false, processIds: [100] });
  assert.deepEqual(getProcessAncestry(200), { complete: false, processIds: [200] });
  assert.equal(processTableReads, 1);
});

nodeTest.test("ignores malformed rows and rejects conflicting macOS parent relationships", () => {
  for (const processTable of [
    "100 nonsense\n",
    "100 -1\n",
    "100 1 trailing\n",
    "100 200\n100 1\n100 200\n200 1\n",
  ]) {
    const getProcessAncestry = createProcessAncestryReader({ platform: "darwin", readMacProcessTable: () => processTable });

    assert.deepEqual(getProcessAncestry(100), { complete: false, processIds: [100] });
  }
});

nodeTest.test("marks cycles and truncated chains incomplete", () => {
  const getCyclicProcessAncestry = createProcessAncestryReader({
    platform: "darwin",
    readMacProcessTable: () => "100 200\n200 100\n",
  });
  const getLongProcessAncestry = createProcessAncestryReader({
    platform: "darwin",
    readMacProcessTable: () => Array.from({ length: 65 }, (_, index) => `${index + 100} ${index === 64 ? 1 : index + 101}`).join("\n"),
  });

  assert.deepEqual(getCyclicProcessAncestry(100), { complete: false, processIds: [100, 200] });
  assert.equal(getLongProcessAncestry(100).complete, false);
  assert.equal(getLongProcessAncestry(100).processIds.length, 64);
});

nodeTest.test("accepts a chain reaching the root at the traversal limit", () => {
  const getProcessAncestry = createProcessAncestryReader({
    platform: "darwin",
    readMacProcessTable: () => Array.from({ length: 64 }, (_, index) => `${index + 100} ${index === 63 ? 1 : index + 101}`).join("\n"),
  });

  assert.equal(getProcessAncestry(100).complete, true);
  assert.equal(getProcessAncestry(100).processIds.length, 64);
});

nodeTest.test("parses Linux process names containing whitespace and closing parentheses", () => {
  const processStats = new Map([
    [100, "100 (worker (child) name)) S 200 0 0 0"],
    [200, "200 (parent) R 1 0 0 0"],
  ]);
  const getProcessAncestry = createProcessAncestryReader({
    platform: "linux",
    readLinuxProcessStat: (processId) => processStats.get(processId)!,
  });

  assert.deepEqual(getProcessAncestry(100), { complete: true, processIds: [100, 200] });
});

nodeTest.test("caches Linux parent reads across related process chains", () => {
  const processReadCounts = new Map<number, number>();
  const getProcessAncestry = createProcessAncestryReader({
    platform: "linux",
    readLinuxProcessStat: (processId) => {
      processReadCounts.set(processId, (processReadCounts.get(processId) ?? 0) + 1);

      return `${processId} (process) S ${processId === 300 ? 1 : 300} 0 0 0`;
    },
  });

  assert.deepEqual(getProcessAncestry(100), { complete: true, processIds: [100, 300] });
  assert.deepEqual(getProcessAncestry(200), { complete: true, processIds: [200, 300] });
  assert.deepEqual([...processReadCounts], [[100, 1], [300, 1], [200, 1]]);
});

nodeTest.test("preserves incomplete Linux chains after read errors without retrying", () => {
  let missingProcessReads = 0;
  const getProcessAncestry = createProcessAncestryReader({
    platform: "linux",
    readLinuxProcessStat: (processId) => {
      if (processId === 100) return "100 (caller) S 200 0 0 0";

      missingProcessReads += 1;

      throw new Error("process gone");
    },
  });

  assert.deepEqual(getProcessAncestry(100), { complete: false, processIds: [100, 200] });
  assert.deepEqual(getProcessAncestry(200), { complete: false, processIds: [200] });
  assert.equal(missingProcessReads, 1);
});

nodeTest.test("rejects malformed Linux stat data without inferring a root", () => {
  for (const processStat of [
    "100 (caller) S missing 0",
    "100 (caller) S -1 0",
    "100 (caller S 1 0",
    "999 (different process) S 1 0",
    "100 (caller) SS 1 0",
    "100 (caller) S 0.5 0",
  ]) {
    const getProcessAncestry = createProcessAncestryReader({ platform: "linux", readLinuxProcessStat: () => processStat });

    assert.deepEqual(getProcessAncestry(100), { complete: false, processIds: [100] });
  }
});

nodeTest.test("reports unavailable platforms and invalid process IDs conservatively", () => {
  const getUnsupportedProcessAncestry = createProcessAncestryReader({ platform: "win32" });
  const getProcessAncestry = createProcessAncestryReader({ platform: "darwin", readMacProcessTable: () => "1 0\n" });

  assert.deepEqual(getUnsupportedProcessAncestry(100), { complete: false, processIds: [] });
  assert.deepEqual(getProcessAncestry(1), { complete: true, processIds: [] });

  for (const processId of [-1, 0, 1.5, NaN, Infinity]) {
    assert.deepEqual(getProcessAncestry(processId), { complete: false, processIds: [] });
  }
});

nodeTest.test("preserves the ancestor list API for the current local process", () => {
  if (!["darwin", "linux"].includes(process.platform)) return;

  const processAncestry = createProcessAncestryReader()();
  const ancestorProcessIds = getAncestorProcessIds();

  assert.equal(processAncestry.complete, true);
  assert.equal(processAncestry.processIds[0], process.pid);
  assert.ok(processAncestry.processIds.includes(process.ppid));
  assert.deepEqual(ancestorProcessIds, processAncestry.processIds);
});
