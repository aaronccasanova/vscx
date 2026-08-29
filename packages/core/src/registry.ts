import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isRecord, protocolVersion } from "./protocol.js";

export interface RuntimeRegistryEntry {
  appHost: string;
  appName: string;
  createdAt: string;
  endpoint: string;
  extensionHostKind: string;
  extensionVersion: string;
  processId: number;
  protocolVersion: typeof protocolVersion;
  remoteAuthority?: string;
  token: string;
  updatedAt: string;
  vscodeVersion: string;
  windowId: string;
  workspaceFile?: string;
  workspaceFolders: string[];
}

export interface RuntimeRegistryOptions {
  environment?: NodeJS.ProcessEnv;
  runtimeDirPath?: string;
}

const registryFileSuffix = ".json";

export function getRuntimeRegistryDirPath(
  options: RuntimeRegistryOptions = {},
): string {
  if (options.runtimeDirPath) return path.resolve(options.runtimeDirPath);

  const environment = options.environment ?? process.env;

  if (environment.VSCX_RUNTIME_DIR) {
    return path.resolve(environment.VSCX_RUNTIME_DIR);
  }

  if (process.platform === "win32" && environment.LOCALAPPDATA) {
    return path.join(environment.LOCALAPPDATA, "vscx", "runtime");
  }

  if (environment.XDG_RUNTIME_DIR) {
    return path.join(environment.XDG_RUNTIME_DIR, "vscx");
  }

  const userId = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;

  return path.join(os.tmpdir(), `vscx-${userId}`);
}

export function writeRuntimeRegistryEntry(
  runtimeRegistryEntry: RuntimeRegistryEntry,
  options: RuntimeRegistryOptions = {},
): string {
  const runtimeRegistryDirPath = getRuntimeRegistryDirPath(options);
  const runtimeRegistryFilePath = getRuntimeRegistryFilePath(
    runtimeRegistryEntry.windowId,
    options,
  );
  const temporaryRegistryFilePath = `${runtimeRegistryFilePath}.${process.pid}.tmp`;
  const runtimeRegistryFileContent = `${JSON.stringify(runtimeRegistryEntry, null, 2)}\n`;

  fs.mkdirSync(runtimeRegistryDirPath, { mode: 0o700, recursive: true });
  fs.chmodSync(runtimeRegistryDirPath, 0o700);
  fs.writeFileSync(temporaryRegistryFilePath, runtimeRegistryFileContent, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryRegistryFilePath, runtimeRegistryFilePath);
  fs.chmodSync(runtimeRegistryFilePath, 0o600);

  return runtimeRegistryFilePath;
}

export function readRuntimeRegistryEntries(
  options: RuntimeRegistryOptions = {},
): RuntimeRegistryEntry[] {
  const runtimeRegistryDirPath = getRuntimeRegistryDirPath(options);

  if (!fs.existsSync(runtimeRegistryDirPath)) return [];

  const runtimeRegistryEntries: RuntimeRegistryEntry[] = [];

  for (const runtimeRegistryFileName of fs.readdirSync(runtimeRegistryDirPath)) {
    if (!runtimeRegistryFileName.endsWith(registryFileSuffix)) continue;

    const runtimeRegistryFilePath = path.join(
      runtimeRegistryDirPath,
      runtimeRegistryFileName,
    );

    try {
      const runtimeRegistryFileContent = fs.readFileSync(
        runtimeRegistryFilePath,
        "utf8",
      );
      const runtimeRegistryValue: unknown = JSON.parse(runtimeRegistryFileContent);

      if (!isRuntimeRegistryEntry(runtimeRegistryValue)) continue;

      runtimeRegistryEntries.push(runtimeRegistryValue);
    } catch {
      continue;
    }
  }

  return runtimeRegistryEntries.sort((leftEntry, rightEntry) =>
    leftEntry.windowId.localeCompare(rightEntry.windowId),
  );
}

export function pruneStaleRuntimeRegistryEntries(
  options: RuntimeRegistryOptions = {},
): RuntimeRegistryEntry[] {
  const runtimeRegistryEntries = readRuntimeRegistryEntries(options);
  const activeRuntimeRegistryEntries: RuntimeRegistryEntry[] = [];

  for (const runtimeRegistryEntry of runtimeRegistryEntries) {
    if (isProcessRunning(runtimeRegistryEntry.processId)) {
      activeRuntimeRegistryEntries.push(runtimeRegistryEntry);

      continue;
    }

    removeRuntimeRegistryEntry(runtimeRegistryEntry.windowId, options);
  }

  return activeRuntimeRegistryEntries;
}

export function removeRuntimeRegistryEntry(
  windowId: string,
  options: RuntimeRegistryOptions = {},
): void {
  const runtimeRegistryFilePath = getRuntimeRegistryFilePath(windowId, options);

  try {
    fs.unlinkSync(runtimeRegistryFilePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;

    throw error;
  }
}

export function getRuntimeRegistryFilePath(
  windowId: string,
  options: RuntimeRegistryOptions = {},
): string {
  if (!/^[a-zA-Z0-9-]+$/.test(windowId)) {
    throw new Error("The window ID contains unsupported characters.");
  }

  return path.join(
    getRuntimeRegistryDirPath(options),
    `${windowId}${registryFileSuffix}`,
  );
}

function isRuntimeRegistryEntry(value: unknown): value is RuntimeRegistryEntry {
  return (
    isRecord(value) &&
    typeof value.windowId === "string" &&
    typeof value.endpoint === "string" &&
    typeof value.token === "string" &&
    typeof value.processId === "number" &&
    Number.isInteger(value.processId) &&
    value.processId > 0 &&
    value.protocolVersion === protocolVersion &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.extensionVersion === "string" &&
    typeof value.vscodeVersion === "string" &&
    typeof value.appName === "string" &&
    typeof value.appHost === "string" &&
    typeof value.extensionHostKind === "string" &&
    Array.isArray(value.workspaceFolders) &&
    value.workspaceFolders.every((folderValue) => typeof folderValue === "string")
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);

    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return false;

    return true;
  }
}
