import * as http from "node:http";

import { getBridgeErrorData, VscxError } from "./errors.js";
import {
  defaultRequestTimeoutMs,
  parseBridgeRequest,
  protocolVersion,
  type BridgeRequest,
  type BridgeResponse,
  type JsonValue,
} from "./protocol.js";
import { serializeValue } from "./serialization.js";

export interface BridgeServerContext {
  request: BridgeRequest;
  signal: AbortSignal;
}

export interface BridgeServerOptions {
  extensionVersion: string;
  handleRequest(context: BridgeServerContext): Promise<unknown>;
  includeStack?: boolean;
  maximumBodyBytes?: number;
  token: string;
  windowId: string;
}

export interface BridgeServer {
  endpoint: string;
  close(): Promise<void>;
}

const defaultMaximumBodyBytes = 2 * 1024 * 1024;

export async function createBridgeServer(
  options: BridgeServerOptions,
): Promise<BridgeServer> {
  const httpServer = http.createServer((request, response) => {
    void handleHttpRequest(request, response, options);
  });

  httpServer.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const serverAddress = httpServer.address();

  if (!serverAddress || typeof serverAddress === "string") {
    httpServer.close();

    throw new Error("The VSCX bridge could not determine its loopback address.");
  }

  return {
    endpoint: `http://127.0.0.1:${serverAddress.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);

            return;
          }

          resolve();
        });
      }),
  };
}

async function handleHttpRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: BridgeServerOptions,
): Promise<void> {
  setSecurityHeaders(response);

  if (!hasValidAuthorization(request, options.token)) {
    writeJsonResponse(response, 401, { error: "unauthorized" });

    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    writeJsonResponse(response, 200, {
      ok: true,
      protocolVersion,
      windowId: options.windowId,
    });

    return;
  }

  if (request.method !== "POST" || request.url !== "/rpc") {
    writeJsonResponse(response, 404, { error: "not-found" });

    return;
  }

  const startedAt = performance.now();
  let bridgeRequest: BridgeRequest | undefined;

  try {
    const requestFileContent = await readRequestFileContent(
      request,
      options.maximumBodyBytes ?? defaultMaximumBodyBytes,
    );
    const requestValue: unknown = JSON.parse(requestFileContent);

    bridgeRequest = parseBridgeRequest(requestValue);

    const controller = new AbortController();
    const timeoutMs = bridgeRequest.timeoutMs ?? defaultRequestTimeoutMs;
    const handleRequestPromise = options.handleRequest({
      request: bridgeRequest,
      signal: controller.signal,
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new VscxError(
            "request-timeout",
            `The bridge operation exceeded ${timeoutMs}ms.`,
          ),
        );
        controller.abort();
      }, timeoutMs);
    });

    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (response.writableEnded) return;

      controller.abort();
    });

    try {
      const resultValue = await Promise.race([
        handleRequestPromise,
        timeoutPromise,
      ]);
      const bridgeResponse: BridgeResponse = {
        elapsedMs: Math.round(performance.now() - startedAt),
        extensionVersion: options.extensionVersion,
        id: bridgeRequest.id,
        ok: true,
        protocolVersion,
        value: serializeValue(resultValue),
        windowId: options.windowId,
      };

      writeJsonResponse(response, 200, bridgeResponse);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  } catch (error) {
    const bridgeResponse: BridgeResponse = {
      elapsedMs: Math.round(performance.now() - startedAt),
      error: getBridgeErrorData(error, options.includeStack ?? true),
      extensionVersion: options.extensionVersion,
      id: bridgeRequest?.id ?? "unknown",
      ok: false,
      protocolVersion,
      windowId: options.windowId,
    };
    const responseStatus =
      error instanceof SyntaxError || bridgeResponse.error.code === "invalid-request"
        ? 400
        : 200;

    writeJsonResponse(response, responseStatus, bridgeResponse);
  }
}

function hasValidAuthorization(
  request: http.IncomingMessage,
  expectedToken: string,
): boolean {
  return request.headers.authorization === `Bearer ${expectedToken}`;
}

async function readRequestFileContent(
  request: http.IncomingMessage,
  maximumBodyBytes: number,
): Promise<string> {
  const bodyChunks: Buffer[] = [];
  let bodyByteLength = 0;

  for await (const bodyChunkValue of request) {
    const bodyChunk = Buffer.isBuffer(bodyChunkValue)
      ? bodyChunkValue
      : Buffer.from(bodyChunkValue);

    bodyByteLength += bodyChunk.byteLength;

    if (bodyByteLength > maximumBodyBytes) {
      throw new VscxError(
        "request-too-large",
        `The request body exceeds ${maximumBodyBytes} bytes.`,
      );
    }

    bodyChunks.push(bodyChunk);
  }

  return Buffer.concat(bodyChunks).toString("utf8");
}

function setSecurityHeaders(response: http.ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
}

function writeJsonResponse(
  response: http.ServerResponse,
  statusCode: number,
  value: JsonValue | BridgeResponse,
): void {
  response.statusCode = statusCode;
  response.end(`${JSON.stringify(value)}\n`);
}
