import * as path from "node:path";

import { VscxError } from "./errors.js";
import type { BridgeConnection } from "./protocol.js";
import {
  pruneStaleRuntimeRegistryEntries,
  type RuntimeRegistryEntry,
  type RuntimeRegistryOptions,
} from "./registry.js";

export interface BridgeTargetSelector {
  all?: boolean;
  endpoint?: string;
  windowId?: string;
  workspace?: string;
}

export interface ResolveBridgeTargetsOptions extends RuntimeRegistryOptions {
  currentDirPath?: string;
  environment?: NodeJS.ProcessEnv;
  selector?: BridgeTargetSelector;
}

export interface ResolvedBridgeTarget extends BridgeConnection {
  source: "environment" | "explicit-endpoint" | "registry";
  registryEntry?: RuntimeRegistryEntry;
}

export function resolveBridgeTargets(
  options: ResolveBridgeTargetsOptions = {},
): ResolvedBridgeTarget[] {
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

  if (!selector.windowId && !selector.all && !selector.workspace) {
    const environmentTarget = getEnvironmentTarget(
      options.environment ?? process.env,
    );

    if (environmentTarget) return [environmentTarget];
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
        `No registered VS Code window has ID ${selector.windowId}.`,
      );
    }

    return [buildRegistryTarget(matchingEntry)];
  }

  if (selector.all) {
    if (runtimeRegistryEntries.length === 0) {
      throw new VscxError("no-windows", "No VSCX windows are registered.");
    }

    return runtimeRegistryEntries.map(buildRegistryTarget);
  }

  if (selector.workspace) {
    const workspaceTargets = getWorkspaceTargets(
      runtimeRegistryEntries,
      selector.workspace,
    );

    return getUniqueTargetOrThrow(workspaceTargets, selector.workspace);
  }

  const currentDirPath = path.resolve(options.currentDirPath ?? process.cwd());
  const currentWorkspaceTargets = getWorkspaceTargets(
    runtimeRegistryEntries,
    currentDirPath,
  );

  if (currentWorkspaceTargets.length > 0) {
    return getUniqueTargetOrThrow(currentWorkspaceTargets, currentDirPath);
  }

  if (runtimeRegistryEntries.length === 1 && runtimeRegistryEntries[0]) {
    return [buildRegistryTarget(runtimeRegistryEntries[0])];
  }

  if (runtimeRegistryEntries.length === 0) {
    throw new VscxError(
      "no-windows",
      "No VSCX window is discoverable. Install or activate the extension, then open a new integrated terminal.",
    );
  }

  throw new VscxError(
    "ambiguous-window",
    "Several VSCX windows are registered. Run 'vscx windows' and select one with --window.",
    { windowIds: runtimeRegistryEntries.map((entry) => entry.windowId) },
  );
}

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
  const selectedTargetCount = [
    selector.all,
    selector.endpoint,
    selector.windowId,
    selector.workspace,
  ].filter(Boolean).length;

  if (selectedTargetCount <= 1) return;

  throw new VscxError(
    "incompatible-targets",
    "Use only one of --all, --endpoint, --window, or --workspace.",
  );
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
): ResolvedBridgeTarget[] {
  if (targets.length === 1) return targets;

  if (targets.length === 0) {
    throw new VscxError(
      "workspace-not-found",
      `No registered VSCX window contains ${workspace}.`,
    );
  }

  throw new VscxError(
    "ambiguous-window",
    `Several VSCX windows match ${workspace}. Select one with --window.`,
    { windowIds: targets.map((target) => target.windowId ?? "unknown") },
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
