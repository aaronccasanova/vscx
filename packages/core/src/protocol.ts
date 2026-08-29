export const protocolVersion = 1 as const;
export const defaultRequestTimeoutMs = 30_000;
export const maximumRequestTimeoutMs = 300_000;

export type JsonPrimitive = boolean | null | number | string;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type BridgeOperation =
  | "api.commands"
  | "api.declarations"
  | "api.find"
  | "eval"
  | "info"
  | "jobs.cancel"
  | "jobs.dispose"
  | "jobs.get"
  | "jobs.list";

export interface BridgeRequest {
  version: typeof protocolVersion;
  id: string;
  op: BridgeOperation;
  code?: string;
  input?: JsonValue;
  jobId?: string;
  query?: string;
  timeoutMs?: number;
}

export interface BridgeErrorData {
  code: string;
  message: string;
  details?: JsonValue;
  stack?: string;
}

export interface BridgeResponseMetadata {
  elapsedMs: number;
  extensionVersion: string;
  protocolVersion: typeof protocolVersion;
  windowId: string;
}

export type BridgeResponse =
  | (BridgeResponseMetadata & {
      id: string;
      ok: true;
      value: JsonValue;
    })
  | (BridgeResponseMetadata & {
      id: string;
      ok: false;
      error: BridgeErrorData;
    });

export interface BridgeConnection {
  endpoint: string;
  token: string;
  windowId?: string;
}

export interface BridgeHostMetadata {
  appHost: string;
  appName: string;
  extensionHostKind: string;
  extensionVersion: string;
  isTrusted: boolean;
  protocolVersion: typeof protocolVersion;
  remoteAuthority?: string;
  vscodeVersion: string;
  windowId: string;
  workspaceFile?: string;
  workspaceFolders: string[];
}

const bridgeOperations = new Set<BridgeOperation>([
  "api.commands",
  "api.declarations",
  "api.find",
  "eval",
  "info",
  "jobs.cancel",
  "jobs.dispose",
  "jobs.get",
  "jobs.list",
]);

export function parseBridgeRequest(requestValue: unknown): BridgeRequest {
  if (!isRecord(requestValue)) {
    throw new Error("The request must be a JSON object.");
  }

  if (requestValue.version !== protocolVersion) {
    throw new Error(
      `Unsupported protocol version ${String(requestValue.version)}. Expected ${protocolVersion}.`,
    );
  }

  if (typeof requestValue.id !== "string" || requestValue.id.length === 0) {
    throw new Error("The request must include a non-empty string id.");
  }

  if (
    typeof requestValue.op !== "string" ||
    !bridgeOperations.has(requestValue.op as BridgeOperation)
  ) {
    throw new Error(`Unsupported bridge operation ${String(requestValue.op)}.`);
  }

  if (requestValue.code !== undefined && typeof requestValue.code !== "string") {
    throw new Error("The request code must be a string.");
  }

  if (
    requestValue.timeoutMs !== undefined &&
    (typeof requestValue.timeoutMs !== "number" ||
      !Number.isInteger(requestValue.timeoutMs) ||
      requestValue.timeoutMs < 1 ||
      requestValue.timeoutMs > maximumRequestTimeoutMs)
  ) {
    throw new Error(
      `The request timeoutMs must be an integer from 1 to ${maximumRequestTimeoutMs}.`,
    );
  }

  if (requestValue.op === "eval" && typeof requestValue.code !== "string") {
    throw new Error("An eval request must include code.");
  }

  if (
    requestValue.op.startsWith("jobs.") &&
    !["jobs.list"].includes(requestValue.op) &&
    typeof requestValue.jobId !== "string"
  ) {
    throw new Error(`${requestValue.op} requires a jobId.`);
  }

  if (requestValue.op === "api.find" && typeof requestValue.query !== "string") {
    throw new Error("api.find requires a query.");
  }

  return requestValue as unknown as BridgeRequest;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
