import * as fs from "node:fs";
import * as path from "node:path";

import { createBridgeRequest, sendBridgeRequest } from "./client.js";
import { VscxError } from "./errors.js";
import { createProcessAncestryReader, type ProcessAncestry } from "./process-ancestry.js";
import { isRecord, type BridgeConnection } from "./protocol.js";
import {
  getRuntimeRegistryDirPath,
  pruneStaleRuntimeRegistryEntries,
  type RuntimeRegistryEntry,
  type RuntimeRegistryOptions,
} from "./registry.js";

export interface BridgeTargetSelector {
  all?: boolean;
  endpoint?: string;
  processId?: number;
  windowId?: string;
  workspace?: string;
}

export interface ResolveBridgeTargetsOptions extends RuntimeRegistryOptions {
  ancestorProcessIds?: readonly number[];
  currentDirPath?: string;
  environment?: NodeJS.ProcessEnv;
  getProcessAncestry?: (processId: number) => ProcessAncestry;
  selector?: BridgeTargetSelector;
}

export interface ResolvedBridgeTarget extends BridgeConnection {
  source:
    | "environment"
    | "explicit-endpoint"
    | "registry"
    | "terminal"
    | "workspace"
    | "single-window";
  registryEntry?: RuntimeRegistryEntry;
}

interface RegistryDiagnostics {
  runtimeDirectory: string;
  runtimeDirectoryExists: boolean;
  processId?: number;
}

export async function resolveBridgeTargets(
  options: ResolveBridgeTargetsOptions = {},
): Promise<ResolvedBridgeTarget[]> {
  const selector = options.selector ?? {};

  validateBridgeTargetSelector(selector);

  if (selector.endpoint) {
    const environment = options.environment ?? process.env;
    const token = environment.VSCX_TOKEN;

    if (!token) {
      throw new VscxError(
        "missing-token",
        "--endpoint requires VSCX_TOKEN in the environment.",
      );
    }

    return [
      {
        endpoint: normalizeEndpoint(selector.endpoint),
        source: "explicit-endpoint",
        token,
      },
    ];
  }

  const runtimeRegistryEntries = pruneStaleRuntimeRegistryEntries(options);

  if (selector.windowId) {
    const matchingEntry = runtimeRegistryEntries.find(
      (runtimeRegistryEntry) =>
        runtimeRegistryEntry.windowId === selector.windowId,
    );

    if (!matchingEntry) {
      throw new VscxError(
        "window-not-found",
        `No registered VS Code window has ID ${selector.windowId} in ${getRuntimeRegistryDirPath(options)}. Check that the CLI and extension use the same VSCX_RUNTIME_DIR.`,
        { ...getRegistryDiagnostics(options) },
      );
    }

    return [buildRegistryTarget(matchingEntry)];
  }

  if (selector.all) {
    if (runtimeRegistryEntries.length === 0) {
      throw new VscxError(
        "no-windows",
        `No VSCX windows are registered in ${getRuntimeRegistryDirPath(options)}. Check that the CLI and extension use the same VSCX_RUNTIME_DIR.`,
        { ...getRegistryDiagnostics(options) },
      );
    }

    return runtimeRegistryEntries.map(buildRegistryTarget);
  }

  if (selector.workspace) {
    const workspaceTargets = getWorkspaceTargets(
      runtimeRegistryEntries,
      selector.workspace,
    );

    return getUniqueTargetOrThrow(workspaceTargets, selector.workspace, getRegistryDiagnostics(options));
  }

  const terminalTargets = await getTerminalTargets(runtimeRegistryEntries, options);

  if (terminalTargets.length > 0) return terminalTargets;

  const currentDirPath = path.resolve(options.currentDirPath ?? process.cwd());
  const currentWorkspaceTargets = getWorkspaceTargets(
    runtimeRegistryEntries,
    currentDirPath,
  );

  if (currentWorkspaceTargets.length > 0) {
    return getUniqueTargetOrThrow(currentWorkspaceTargets, currentDirPath, getRegistryDiagnostics(options)).map((target) => ({
      ...target,
      source: "workspace",
    }));
  }

  if (runtimeRegistryEntries.length === 1 && runtimeRegistryEntries[0]) {
    return [{ ...buildRegistryTarget(runtimeRegistryEntries[0]), source: "single-window" }];
  }

  if (runtimeRegistryEntries.length === 0) {
    throw new VscxError(
      "no-windows",
      `No VSCX window is discoverable in ${getRuntimeRegistryDirPath(options)}. Check that the CLI and extension use the same VSCX_RUNTIME_DIR, then install or activate the extension in the intended VS Code window.`,
      { ...getRegistryDiagnostics(options) },
    );
  }

  throw new VscxError(
    "ambiguous-window",
    "Several VSCX windows are registered. Run 'vscx windows' and select one with --window.",
    { ...getRegistryDiagnostics(options), windowIds: runtimeRegistryEntries.map((entry) => entry.windowId) },
  );
}

/** @deprecated Environment values do not prove ownership. Use await resolveBridgeTargets(). */
export function getEnvironmentTarget(
  environment: NodeJS.ProcessEnv,
): ResolvedBridgeTarget | undefined {
  if (!environment.VSCX_ENDPOINT || !environment.VSCX_TOKEN) return undefined;

  return {
    endpoint: normalizeEndpoint(environment.VSCX_ENDPOINT),
    source: "environment",
    token: environment.VSCX_TOKEN,
    ...(environment.VSCX_WINDOW_ID
      ? { windowId: environment.VSCX_WINDOW_ID }
      : {}),
  };
}

export function validateBridgeTargetSelector(selector: BridgeTargetSelector): void {
  if (
    selector.processId !== undefined &&
    (!Number.isSafeInteger(selector.processId) || selector.processId < 1)
  ) {
    throw new VscxError("invalid-process", "--process must be a positive safe integer.");
  }

  const selectedTargetCount = [
    selector.all,
    selector.endpoint,
    selector.processId !== undefined,
    selector.windowId,
    selector.workspace,
  ].filter(Boolean).length;

  if (selectedTargetCount <= 1) return;

  throw new VscxError(
    "incompatible-targets",
    "Use only one of --all, --endpoint, --process, --window, or --workspace.",
  );
}

async function getTerminalTargets(
  runtimeRegistryEntries: RuntimeRegistryEntry[],
  options: ResolveBridgeTargetsOptions,
): Promise<ResolvedBridgeTarget[]> {
  const getProcessAncestry = options.getProcessAncestry ?? createProcessAncestryReader();
  const processId = options.selector?.processId;
  const processAncestry = processId === undefined ? undefined : getProcessAncestry(processId);

  if (processId !== undefined && processAncestry && !processAncestry.complete) {
    throw new VscxError(
      "terminal-ownership-unavailable",
      `Cannot determine local ancestry for process ${processId}. Process targeting requires a live local process on macOS or Linux.`,
      { ...getRegistryDiagnostics(options), processId },
    );
  }

  const ancestorProcessIds = processAncestry?.processIds ?? options.ancestorProcessIds ?? getProcessAncestry(process.pid).processIds;
  const terminalOwners = await Promise.all(
    runtimeRegistryEntries.map(async (runtimeRegistryEntry) => {
      if (runtimeRegistryEntry.remoteAuthority || ancestorProcessIds.length === 0) {
        return undefined;
      }

      try {
        const bridgeResponse = await sendBridgeRequest(
          buildRegistryTarget(runtimeRegistryEntry),
          createBridgeRequest({ op: "terminals.processes", timeoutMs: 500 }),
          { signal: AbortSignal.timeout(750) },
        );

        if (
          !bridgeResponse.ok ||
          bridgeResponse.windowId !== runtimeRegistryEntry.windowId ||
          !isRecord(bridgeResponse.value) ||
          typeof bridgeResponse.value.complete !== "boolean" ||
          !Array.isArray(bridgeResponse.value.processIds) ||
          !bridgeResponse.value.processIds.every((processId) =>
            typeof processId === "number" && Number.isInteger(processId) && processId > 0,
          )
        ) {
          return { complete: false, ancestorIndex: -1, runtimeRegistryEntry };
        }

        const terminalProcessIds = bridgeResponse.value.processIds;
        const ancestorIndex = ancestorProcessIds.findIndex((ancestorProcessId) =>
          terminalProcessIds.includes(ancestorProcessId),
        );

        return { complete: bridgeResponse.value.complete, ancestorIndex, runtimeRegistryEntry };
      } catch {
        return { complete: false, ancestorIndex: -1, runtimeRegistryEntry };
      }
    }),
  );
  const matchingTerminalOwners = terminalOwners
    .filter((terminalOwner) => terminalOwner !== undefined)
    .filter((terminalOwner) => terminalOwner.ancestorIndex >= 0);
  const environment = options.environment ?? process.env;
  const integratedTerminal = Boolean(
    environment.TERM_PROGRAM === "vscode" ||
    environment.VSCODE_IPC_HOOK_CLI ||
    environment.VSCX_WINDOW_ID,
  );

  const nearestAncestorIndex = Math.min(
    ...matchingTerminalOwners.map((terminalOwner) => terminalOwner.ancestorIndex),
  );
  const closerAncestorProcessIds = new Set(ancestorProcessIds.slice(0, nearestAncestorIndex));
  const ownershipIncomplete = terminalOwners.some((terminalOwner) => {
    if (!terminalOwner || terminalOwner.complete) return false;

    if (matchingTerminalOwners.length === 0) return true;

    if (closerAncestorProcessIds.size === 0) return false;

    // Desktop terminals and extension hosts share a VS Code main process. An
    // unresolved closer owner must share ancestry below the matched terminal.
    if (terminalOwner.runtimeRegistryEntry.appHost !== "desktop") return true;

    const processAncestry = getProcessAncestry(terminalOwner.runtimeRegistryEntry.processId);

    return !processAncestry.complete || processAncestry.processIds.some((processId) =>
      closerAncestorProcessIds.has(processId),
    );
  });

  if (ownershipIncomplete && (processId !== undefined || integratedTerminal || matchingTerminalOwners.length > 0)) {
    throw new VscxError(
      "terminal-ownership-unavailable",
      `A VSCX window could not confirm terminal ownership${processId === undefined ? "" : ` for process ${processId}`} and may own a closer terminal. Wait for activation or terminal startup, then retry, or select --window explicitly.`,
      { ...getRegistryDiagnostics(options), ...(processId === undefined ? {} : { processId }) },
    );
  }

  const terminalTargets = matchingTerminalOwners
    .filter((terminalOwner) => terminalOwner.ancestorIndex === nearestAncestorIndex)
    .map((terminalOwner) => ({
      ...buildRegistryTarget(terminalOwner.runtimeRegistryEntry),
      source: "terminal" as const,
    }));

  if (terminalTargets.length > 0) {
    return getUniqueTargetOrThrow(
      terminalTargets,
      processId === undefined ? "the current terminal" : `process ${processId}`,
      { ...getRegistryDiagnostics(options), ...(processId === undefined ? {} : { processId }) },
    );
  }

  // Per-activation values in old terminals cannot establish current ownership.
  // In particular, a terminal can move while its original window remains live.
  if (processId !== undefined || integratedTerminal) {
    throw new VscxError(
      "terminal-owner-not-found",
      processId === undefined
        ? "The current integrated terminal's VSCX window is not ready or its ownership cannot be determined. Wait for VSCX to activate, or run 'vscx windows' and select --window explicitly."
        : `No registered local VSCX window owns process ${processId}. Wait for activation or terminal startup, or run 'vscx windows' and select --window explicitly.`,
      { ...getRegistryDiagnostics(options), ...(processId === undefined ? {} : { processId }) },
    );
  }

  return [];
}

function getRegistryDiagnostics(options: RuntimeRegistryOptions): RegistryDiagnostics {
  const runtimeDirPath = getRuntimeRegistryDirPath(options);

  return { runtimeDirectory: runtimeDirPath, runtimeDirectoryExists: fs.existsSync(runtimeDirPath) };
}

function getWorkspaceTargets(
  runtimeRegistryEntries: RuntimeRegistryEntry[],
  workspace: string,
): ResolvedBridgeTarget[] {
  const workspacePath = path.resolve(workspace);

  return runtimeRegistryEntries
    .filter((runtimeRegistryEntry) =>
      runtimeRegistryEntry.workspaceFolders.some((workspaceFolder) => {
        const workspaceFolderPath = path.resolve(workspaceFolder);
        const relativeFileName = path.relative(workspaceFolderPath, workspacePath);

        return (
          relativeFileName === "" ||
          (!relativeFileName.startsWith("..") && !path.isAbsolute(relativeFileName))
        );
      }),
    )
    .map(buildRegistryTarget);
}

function getUniqueTargetOrThrow(
  targets: ResolvedBridgeTarget[],
  workspace: string,
  registryDiagnostics: RegistryDiagnostics,
): ResolvedBridgeTarget[] {
  if (targets.length === 1) return targets;

  if (targets.length === 0) {
    throw new VscxError(
      "workspace-not-found",
      `No registered VSCX window contains ${workspace}. Searched ${registryDiagnostics.runtimeDirectory}. Check that the CLI and extension use the same VSCX_RUNTIME_DIR.`,
      { ...registryDiagnostics },
    );
  }

  throw new VscxError(
    "ambiguous-window",
    `Several VSCX windows match ${workspace}. Select one with --window.`,
    { ...registryDiagnostics, windowIds: targets.map((target) => target.windowId ?? "unknown") },
  );
}

function buildRegistryTarget(
  runtimeRegistryEntry: RuntimeRegistryEntry,
): ResolvedBridgeTarget {
  return {
    endpoint: normalizeEndpoint(runtimeRegistryEntry.endpoint),
    registryEntry: runtimeRegistryEntry,
    source: "registry",
    token: runtimeRegistryEntry.token,
    windowId: runtimeRegistryEntry.windowId,
  };
}

function normalizeEndpoint(endpoint: string): string {
  const endpointUrl = new URL(endpoint);

  if (!["http:", "https:"].includes(endpointUrl.protocol)) {
    throw new VscxError(
      "invalid-endpoint",
      "The bridge endpoint must use http or https.",
    );
  }

  return endpointUrl.href.replace(/\/$/, "");
}
