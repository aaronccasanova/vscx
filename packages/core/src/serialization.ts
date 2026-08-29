import type { JsonValue } from "./protocol.js";

export interface SerializeValueOptions {
  maximumDepth?: number;
  maximumEntries?: number;
  maximumStringLength?: number;
}

interface SerializeValueContext {
  entriesSeen: number;
  maximumDepth: number;
  maximumEntries: number;
  maximumStringLength: number;
  seenValues: WeakSet<object>;
}

const defaultMaximumDepth = 12;
const defaultMaximumEntries = 10_000;
const defaultMaximumStringLength = 1_000_000;

export function serializeValue(
  value: unknown,
  options: SerializeValueOptions = {},
): JsonValue {
  const context: SerializeValueContext = {
    entriesSeen: 0,
    maximumDepth: options.maximumDepth ?? defaultMaximumDepth,
    maximumEntries: options.maximumEntries ?? defaultMaximumEntries,
    maximumStringLength:
      options.maximumStringLength ?? defaultMaximumStringLength,
    seenValues: new WeakSet<object>(),
  };

  return serializeValueAtDepth(value, 0, context);
}

function serializeValueAtDepth(
  value: unknown,
  depth: number,
  context: SerializeValueContext,
): JsonValue {
  context.entriesSeen += 1;

  if (context.entriesSeen > context.maximumEntries) {
    return buildUnserializableValue("entry-limit");
  }

  if (depth > context.maximumDepth) {
    return buildUnserializableValue("depth-limit");
  }

  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return { $type: "number", value: String(value) };
    }

    return value;
  }

  if (typeof value === "string") {
    if (value.length <= context.maximumStringLength) return value;

    return {
      $type: "truncated-string",
      length: value.length,
      value: value.slice(0, context.maximumStringLength),
    };
  }

  if (typeof value === "undefined") return { $type: "undefined" };
  if (typeof value === "bigint") {
    return { $type: "bigint", value: value.toString() };
  }
  if (typeof value === "symbol") {
    return buildUnserializableValue("symbol", value.description);
  }
  if (typeof value === "function") {
    return buildUnserializableValue("function", value.name || undefined);
  }

  if (context.seenValues.has(value)) {
    return buildUnserializableValue("cycle");
  }

  context.seenValues.add(value);

  try {
    if (value instanceof Date) {
      return { $type: "date", value: value.toISOString() };
    }

    if (value instanceof Error) {
      return {
        $type: "error",
        message: value.message,
        name: value.name,
        ...(value.stack ? { stack: value.stack } : {}),
      };
    }

    if (value instanceof Uint8Array) {
      return {
        $type: "bytes",
        base64: Buffer.from(value).toString("base64"),
      };
    }

    const vscodeTaggedValue = serializeVscodeValue(value, depth, context);

    if (vscodeTaggedValue) return vscodeTaggedValue;

    if (Array.isArray(value)) {
      return value.map((entryValue) =>
        serializeValueAtDepth(entryValue, depth + 1, context),
      );
    }

    const valuePrototype = Object.getPrototypeOf(value);

    if (valuePrototype !== Object.prototype && valuePrototype !== null) {
      const constructorName = value.constructor?.name;

      return buildUnserializableValue(
        "unsupported-prototype",
        constructorName || undefined,
      );
    }

    const serializedEntries: [string, JsonValue][] = [];

    for (const propertyName of Object.keys(value)) {
      let propertyValue: unknown;

      try {
        propertyValue = value[propertyName as keyof typeof value];
      } catch (error) {
        propertyValue = {
          $type: "property-error",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      serializedEntries.push([
        propertyName,
        serializeValueAtDepth(propertyValue, depth + 1, context),
      ]);
    }

    return Object.fromEntries(serializedEntries);
  } finally {
    context.seenValues.delete(value);
  }
}

function serializeVscodeValue(
  value: object,
  depth: number,
  context: SerializeValueContext,
): JsonValue | undefined {
  if (isPosition(value)) {
    return { $type: "vscode.Position", line: value.line, character: value.character };
  }

  if (isRange(value)) {
    return {
      $type: "vscode.Range",
      start: serializeValueAtDepth(value.start, depth + 1, context),
      end: serializeValueAtDepth(value.end, depth + 1, context),
    };
  }

  if (isUri(value)) {
    return {
      $type: "vscode.Uri",
      scheme: value.scheme,
      authority: value.authority,
      path: value.path,
      query: value.query,
      fragment: value.fragment,
      fsPath: value.fsPath,
      value: value.toString(),
    };
  }

  if (isLocation(value)) {
    return {
      $type: "vscode.Location",
      uri: serializeValueAtDepth(value.uri, depth + 1, context),
      range: serializeValueAtDepth(value.range, depth + 1, context),
    };
  }

  if (isWorkspaceEdit(value)) {
    return {
      $type: "vscode.WorkspaceEdit",
      entries: serializeValueAtDepth([...value.entries()], depth + 1, context),
    };
  }

  return undefined;
}

function isPosition(value: object): value is { character: number; line: number } {
  return (
    "line" in value &&
    "character" in value &&
    typeof value.line === "number" &&
    typeof value.character === "number" &&
    !("start" in value)
  );
}

function isRange(value: object): value is {
  end: { character: number; line: number };
  start: { character: number; line: number };
} {
  return "start" in value && "end" in value && isObject(value.start) && isObject(value.end);
}

function isUri(value: object): value is {
  authority: string;
  fragment: string;
  fsPath: string;
  path: string;
  query: string;
  scheme: string;
  toString(): string;
} {
  return (
    "scheme" in value &&
    "fsPath" in value &&
    typeof value.scheme === "string" &&
    typeof value.fsPath === "string" &&
    typeof value.toString === "function"
  );
}

function isLocation(value: object): value is { range: object; uri: object } {
  return "uri" in value && "range" in value && isObject(value.uri) && isObject(value.range);
}

function isWorkspaceEdit(value: object): value is {
  entries(): Iterable<unknown>;
} {
  return (
    value.constructor?.name === "WorkspaceEdit" &&
    "entries" in value &&
    typeof value.entries === "function"
  );
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function buildUnserializableValue(reason: string, description?: string): JsonValue {
  return {
    $type: "unserializable",
    reason,
    ...(description ? { description } : {}),
  };
}
