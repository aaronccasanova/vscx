import type { BridgeErrorData, JsonValue } from "./protocol.js";
import { serializeValue } from "./serialization.js";

export class VscxError extends Error {
  readonly code: string;
  readonly details?: JsonValue;

  constructor(code: string, message: string, details?: JsonValue) {
    super(message);

    this.name = "VscxError";
    this.code = code;
    this.details = details;
  }
}

export function getBridgeErrorData(
  error: unknown,
  includeStack = true,
): BridgeErrorData {
  if (error instanceof VscxError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(includeStack && error.stack ? { stack: error.stack } : {}),
    };
  }

  if (error instanceof Error) {
    return {
      code: "evaluation-failed",
      message: error.message,
      ...(includeStack && error.stack ? { stack: error.stack } : {}),
    };
  }

  return {
    code: "evaluation-failed",
    message: "The bridge operation failed with a non-Error value.",
    details: serializeValue(error),
  };
}
