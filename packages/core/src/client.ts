import * as crypto from "node:crypto";

import { VscxError } from "./errors.js";
import {
  defaultRequestTimeoutMs,
  isRecord,
  protocolVersion,
  type BridgeConnection,
  type BridgeOperation,
  type BridgeRequest,
  type BridgeResponse,
  type JsonValue,
} from "./protocol.js";

export interface CreateBridgeRequestOptions {
  code?: string;
  id?: string;
  input?: JsonValue;
  jobId?: string;
  op: BridgeOperation;
  query?: string;
  timeoutMs?: number;
}

export interface SendBridgeRequestOptions {
  signal?: AbortSignal;
}

export function createBridgeRequest(
  options: CreateBridgeRequestOptions,
): BridgeRequest {
  return {
    version: protocolVersion,
    id: options.id ?? crypto.randomUUID(),
    op: options.op,
    ...(options.code === undefined ? {} : { code: options.code }),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
}

export async function sendBridgeRequest(
  bridgeConnection: BridgeConnection,
  bridgeRequest: BridgeRequest,
  options: SendBridgeRequestOptions = {},
): Promise<BridgeResponse> {
  const timeoutMs = bridgeRequest.timeoutMs ?? defaultRequestTimeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs + 2_000);
  const requestSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  let response: Response;
  let responseFileContent: string;

  try {
    response = await fetch(`${bridgeConnection.endpoint}/rpc`, {
      body: JSON.stringify(bridgeRequest),
      headers: {
        authorization: `Bearer ${bridgeConnection.token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: requestSignal,
    });
    responseFileContent = await response.text();
  } catch (error) {
    if (options.signal?.aborted) {
      throw new VscxError(
        "request-cancelled",
        "The VSCX request was cancelled.",
      );
    }

    if (timeoutSignal.aborted) {
      throw new VscxError(
        "connection-timeout",
        `The VSCX endpoint did not respond within ${timeoutMs + 2_000}ms.`,
      );
    }

    throw new VscxError(
      "connection-failed",
      `Could not connect to ${bridgeConnection.endpoint}.`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  if (response.status === 401) {
    throw new VscxError(
      "unauthorized",
      "The VSCX endpoint rejected the connection token.",
    );
  }

  let responseValue: unknown;

  try {
    responseValue = JSON.parse(responseFileContent);
  } catch {
    throw new VscxError(
      "invalid-response",
      `The VSCX endpoint returned HTTP ${response.status} with invalid JSON.`,
    );
  }

  if (!isBridgeResponse(responseValue)) {
    throw new VscxError(
      "invalid-response",
      "The VSCX endpoint returned an invalid response envelope.",
    );
  }

  return responseValue;
}

export async function probeBridgeConnection(
  bridgeConnection: BridgeConnection,
  timeoutMs = 1_000,
): Promise<{ elapsedMs: number; ok: boolean; status?: number }> {
  const startedAt = performance.now();

  try {
    const response = await fetch(`${bridgeConnection.endpoint}/health`, {
      headers: { authorization: `Bearer ${bridgeConnection.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    return {
      elapsedMs: Math.round(performance.now() - startedAt),
      ok: response.ok,
      status: response.status,
    };
  } catch {
    return {
      elapsedMs: Math.round(performance.now() - startedAt),
      ok: false,
    };
  }
}

function isBridgeResponse(value: unknown): value is BridgeResponse {
  if (!isRecord(value)) return false;

  if (
    typeof value.id !== "string" ||
    typeof value.ok !== "boolean" ||
    typeof value.windowId !== "string" ||
    typeof value.extensionVersion !== "string" ||
    typeof value.elapsedMs !== "number" ||
    value.protocolVersion !== protocolVersion
  ) {
    return false;
  }

  if (value.ok) return "value" in value;

  return isRecord(value.error) && typeof value.error.message === "string";
}
