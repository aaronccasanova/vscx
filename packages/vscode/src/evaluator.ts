import {
  serializeValue,
  VscxError,
  type BridgeHostMetadata,
  type BridgeJobManager,
  type BridgeRequest,
  type JsonValue,
} from "@vscx/core";
import * as vscode from "vscode";

interface EvaluateBridgeCodeOptions {
  bridgeRequest: BridgeRequest;
  jobManager: BridgeJobManager;
  log(message: string, value?: JsonValue): void;
  metadata: BridgeHostMetadata;
  signal: AbortSignal;
}

interface EvaluationHelpers {
  assertNotAborted(): void;
  sleep(timeoutMs: number): Promise<void>;
  toJSON(value: unknown): JsonValue;
}

type AsyncEvaluationFunction = (
  vscodeApi: typeof vscode,
  bridge: unknown,
  input: JsonValue | undefined,
  signal: AbortSignal,
  abortSignalConstructor: typeof AbortSignal,
  helpers: EvaluationHelpers,
) => Promise<unknown>;

type AsyncFunctionConstructor = new (
  ...argumentsAndBody: string[]
) => AsyncEvaluationFunction;

const AsyncFunction = Object.getPrototypeOf(
  async function noop() {},
).constructor as AsyncFunctionConstructor;

export async function evaluateBridgeCode(
  options: EvaluateBridgeCodeOptions,
): Promise<unknown> {
  if (!options.bridgeRequest.code) {
    throw new VscxError("missing-code", "The eval request does not contain code.");
  }

  const helpers: EvaluationHelpers = {
    assertNotAborted: () => {
      if (!options.signal.aborted) return;

      throw new VscxError("request-cancelled", "The evaluation was cancelled.");
    },
    sleep: (timeoutMs) => sleep(timeoutMs, options.signal),
    toJSON: serializeValue,
  };
  const bridge = {
    jobs: {
      create: options.jobManager.create.bind(options.jobManager),
      get: options.jobManager.get.bind(options.jobManager),
      list: options.jobManager.list.bind(options.jobManager),
    },
    log: (message: string, value?: unknown) => {
      options.log(message, value === undefined ? undefined : serializeValue(value));
    },
    metadata: options.metadata,
    toJSON: serializeValue,
  };
  let evaluationFunction: AsyncEvaluationFunction;

  try {
    evaluationFunction = buildEvaluationFunction(
      options.bridgeRequest.code,
      options.bridgeRequest.id,
    );
  } catch (error) {
    throw new VscxError(
      "invalid-program",
      error instanceof Error ? error.message : String(error),
    );
  }

  helpers.assertNotAborted();

  return evaluationFunction(
    vscode,
    bridge,
    options.bridgeRequest.input,
    options.signal,
    AbortSignal,
    helpers,
  );
}

function buildEvaluationFunction(
  code: string,
  requestId: string,
): AsyncEvaluationFunction {
  const evaluationArgumentNames = [
    "vscode",
    "bridge",
    "input",
    "signal",
    "AbortSignal",
    "helpers",
  ];

  try {
    return new AsyncFunction(
      ...evaluationArgumentNames,
      `"use strict";
const evaluationValue = (${code});

if (typeof evaluationValue !== "function") return evaluationValue;

return evaluationValue({ vscode, bridge, input, signal, AbortSignal, helpers });
//# sourceURL=vscx-eval-${requestId}.js`,
    );
  } catch {
    return new AsyncFunction(
      ...evaluationArgumentNames,
      `"use strict";\n${code}\n//# sourceURL=vscx-eval-${requestId}.js`,
    );
  }
}

async function sleep(timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new VscxError(
      "invalid-sleep",
      "helpers.sleep requires a non-negative timeout.",
    );
  }

  if (signal.aborted) {
    throw new VscxError("request-cancelled", "The evaluation was cancelled.");
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(resolve, timeoutMs);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeoutHandle);
        reject(new VscxError("request-cancelled", "The evaluation was cancelled."));
      },
      { once: true },
    );
  });
}
