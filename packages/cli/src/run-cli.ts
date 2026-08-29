import * as fs from "node:fs";
import * as path from "node:path";
import type * as stream from "node:stream";

import {
  createBridgeRequest,
  getBridgeErrorData,
  getEnvironmentTarget,
  probeBridgeConnection,
  protocolVersion,
  parseBridgeRequest,
  pruneStaleRuntimeRegistryEntries,
  resolveBridgeTargets,
  sendBridgeRequest,
  vscxVersion,
  VscxError,
  type BridgeOperation,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeTargetSelector,
  type JsonValue,
  type ResolvedBridgeTarget,
  type RuntimeRegistryEntry,
} from "@vscx/core";

export interface RunCliOptions {
  args: string[];
  currentDirPath?: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stderr: stream.Writable;
  stdin: stream.Readable;
  stdout: stream.Writable;
}

interface ParsedCliArguments {
  commandName: string;
  commandArguments: string[];
  json: boolean;
  selector: BridgeTargetSelector;
  timeoutMs?: number;
}

interface CommandContext {
  arguments: ParsedCliArguments;
  currentDirPath: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stderr: stream.Writable;
  stdin: stream.Readable;
  stdout: stream.Writable;
}

interface WindowDescription {
  active: boolean;
  appName: string;
  endpoint: string;
  extensionVersion: string;
  health: "healthy" | "stale";
  latencyMs: number;
  remoteAuthority?: string;
  vscodeVersion: string;
  windowId: string;
  workspaceFolders: string[];
}

export async function runCli(options: RunCliOptions): Promise<number> {
  let parsedCliArguments: ParsedCliArguments;

  try {
    parsedCliArguments = parseCliArguments(options.args);
  } catch (error) {
    writeCliError(options.stderr, error, false);

    return 2;
  }

  const commandContext: CommandContext = {
    arguments: parsedCliArguments,
    currentDirPath: path.resolve(options.currentDirPath ?? process.cwd()),
    environment: options.environment,
    signal: options.signal,
    stderr: options.stderr,
    stdin: options.stdin,
    stdout: options.stdout,
  };

  try {
    return await runCliCommand(commandContext);
  } catch (error) {
    writeCliError(options.stderr, error, parsedCliArguments.json);

    return 1;
  }
}

export function parseCliArguments(args: string[]): ParsedCliArguments {
  const commandArguments: string[] = [];
  const selector: BridgeTargetSelector = {};
  let commandName: string | undefined;
  let json = false;
  let timeoutMs: number | undefined;

  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex += 1) {
    const argument = args[argumentIndex];

    if (!argument) continue;

    if (argument === "--json") {
      json = true;

      continue;
    }

    if (argument === "--all") {
      selector.all = true;

      continue;
    }

    if (["--endpoint", "--window", "--workspace", "--timeout"].includes(argument)) {
      const optionValue = args[argumentIndex + 1];

      if (!optionValue) throw new VscxError("missing-option", `${argument} requires a value.`);

      argumentIndex += 1;

      if (argument === "--endpoint") selector.endpoint = optionValue;
      if (argument === "--window") selector.windowId = optionValue;
      if (argument === "--workspace") selector.workspace = optionValue;
      if (argument === "--timeout") {
        timeoutMs = Number(optionValue);

        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
          throw new VscxError(
            "invalid-timeout",
            "--timeout must be an integer from 1 to 300000.",
          );
        }
      }

      continue;
    }

    if (!commandName) {
      commandName = argument;

      continue;
    }

    commandArguments.push(argument);
  }

  return {
    commandArguments,
    commandName: commandName ?? "help",
    json,
    selector,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

async function runCliCommand(commandContext: CommandContext): Promise<number> {
  switch (commandContext.arguments.commandName) {
    case "help":
    case "--help":
    case "-h":
      writeOutput(commandContext.stdout, getHelpFileContent());

      return 0;
    case "version":
    case "--version":
    case "-v":
      writeOutput(commandContext.stdout, vscxVersion);

      return 0;
    case "info":
      return runInfoCommand(commandContext);
    case "windows":
      return runWindowsCommand(commandContext);
    case "eval":
      return runEvalCommand(commandContext);
    case "rpc":
      return runRpcCommand(commandContext);
    case "jobs":
      return runJobsCommand(commandContext);
    case "api":
      return runApiCommand(commandContext);
    case "doctor":
      return runDoctorCommand(commandContext);
    default:
      throw new VscxError(
        "unknown-command",
        `Unknown command ${commandContext.arguments.commandName}. Run 'vscx help'.`,
      );
  }
}

async function runInfoCommand(commandContext: CommandContext): Promise<number> {
  const showConnection = commandContext.arguments.commandArguments.includes(
    "--show-connection",
  );
  const bridgeRequest = createBridgeRequest({
    op: "info",
    timeoutMs: commandContext.arguments.timeoutMs,
  });
  const requestResults = await sendRequestToSelectedTargets(
    commandContext,
    bridgeRequest,
  );
  const printableRequestResults = requestResults.map((requestResult) => ({
    cliVersion: vscxVersion,
    ...(showConnection
      ? {
          connection: {
            endpoint: requestResult.target.endpoint,
            source: requestResult.target.source,
            token: redactSecret(requestResult.target.token),
          },
        }
      : {}),
    response: requestResult.response,
  }));

  writeCommandResults(commandContext, printableRequestResults);

  return getRequestResultsExitCode(requestResults);
}

async function runWindowsCommand(commandContext: CommandContext): Promise<number> {
  const runtimeRegistryEntries = pruneStaleRuntimeRegistryEntries({
    environment: commandContext.environment,
  });
  const environmentTarget = getEnvironmentTarget(commandContext.environment);
  const windowDescriptions = await Promise.all(
    runtimeRegistryEntries.map(async (runtimeRegistryEntry) => {
      const bridgeProbe = await probeBridgeConnection({
        endpoint: runtimeRegistryEntry.endpoint,
        token: runtimeRegistryEntry.token,
      });
      const windowDescription: WindowDescription = {
        active: environmentTarget?.windowId === runtimeRegistryEntry.windowId,
        appName: runtimeRegistryEntry.appName,
        endpoint: runtimeRegistryEntry.endpoint,
        extensionVersion: runtimeRegistryEntry.extensionVersion,
        health: bridgeProbe.ok ? "healthy" : "stale",
        latencyMs: bridgeProbe.elapsedMs,
        ...(runtimeRegistryEntry.remoteAuthority
          ? { remoteAuthority: runtimeRegistryEntry.remoteAuthority }
          : {}),
        vscodeVersion: runtimeRegistryEntry.vscodeVersion,
        windowId: runtimeRegistryEntry.windowId,
        workspaceFolders: runtimeRegistryEntry.workspaceFolders,
      };

      return windowDescription;
    }),
  );

  if (commandContext.arguments.json) {
    writeJson(commandContext.stdout, windowDescriptions, true);

    return 0;
  }

  writeOutput(
    commandContext.stdout,
    formatWindowsTable(windowDescriptions),
  );

  return 0;
}

async function runEvalCommand(commandContext: CommandContext): Promise<number> {
  const commandOptions = parseEvalCommandOptions(
    commandContext.arguments.commandArguments,
  );
  const code = await getEvaluationCode(commandContext, commandOptions);
  const input = commandOptions.input
    ? parseJsonValue(commandOptions.input, "--input")
    : null;
  const bridgeRequest = createBridgeRequest({
    code,
    input,
    op: "eval",
    timeoutMs: commandContext.arguments.timeoutMs,
  });
  const requestResults = await sendRequestToSelectedTargets(
    commandContext,
    bridgeRequest,
  );

  writeCommandResults(commandContext, requestResults.map((result) => result.response));

  return getRequestResultsExitCode(requestResults);
}

async function runRpcCommand(commandContext: CommandContext): Promise<number> {
  const standardInputFileContent = await readStandardInputFileContent(
    commandContext.stdin,
  );
  const requestLines = standardInputFileContent
    .split(/\r?\n/)
    .filter((requestLine) => requestLine.trim().length > 0);
  let exitCode = 0;

  for (const requestLine of requestLines) {
    try {
      const requestValue: unknown = JSON.parse(requestLine);
      const rpcRequest = buildRpcRequest(requestValue, commandContext.arguments.timeoutMs);
      const rpcCommandContext = buildRpcCommandContext(commandContext, requestValue);
      const requestResults = await sendRequestToSelectedTargets(
        rpcCommandContext,
        rpcRequest,
      );
      const responseValue =
        requestResults.length === 1
          ? requestResults[0]?.response
          : requestResults.map((requestResult) => requestResult.response);

      writeJson(commandContext.stdout, responseValue ?? null, false);

      if (getRequestResultsExitCode(requestResults) !== 0) exitCode = 1;
    } catch (error) {
      writeJson(
        commandContext.stdout,
        {
          error: getBridgeErrorData(error, false),
          id: getRequestIdFromLine(requestLine),
          ok: false,
          protocolVersion,
        },
        false,
      );
      exitCode = 1;
    }
  }

  return exitCode;
}

async function runJobsCommand(commandContext: CommandContext): Promise<number> {
  const jobAction = commandContext.arguments.commandArguments[0] ?? "list";
  const jobOperationByAction: Record<string, BridgeOperation> = {
    cancel: "jobs.cancel",
    dispose: "jobs.dispose",
    get: "jobs.get",
    list: "jobs.list",
  };
  const jobOperation = jobOperationByAction[jobAction];

  if (!jobOperation) {
    throw new VscxError(
      "unknown-job-action",
      "The jobs action must be list, get, cancel, or dispose.",
    );
  }

  const jobId = commandContext.arguments.commandArguments[1];

  if (jobAction !== "list" && !jobId) {
    throw new VscxError("missing-job-id", `jobs ${jobAction} requires a job ID.`);
  }

  const bridgeRequest = createBridgeRequest({
    jobId,
    op: jobOperation,
    timeoutMs: commandContext.arguments.timeoutMs,
  });
  const requestResults = await sendRequestToSelectedTargets(
    commandContext,
    bridgeRequest,
  );

  writeCommandResults(commandContext, requestResults.map((result) => result.response));

  return getRequestResultsExitCode(requestResults);
}

async function runApiCommand(commandContext: CommandContext): Promise<number> {
  const apiArguments = commandContext.arguments.commandArguments;
  let apiOperation: BridgeOperation = "api.declarations";
  let query: string | undefined;

  if (apiArguments.includes("--commands")) apiOperation = "api.commands";

  const findOptionIndex = apiArguments.indexOf("--find");

  if (findOptionIndex >= 0) {
    apiOperation = "api.find";
    query = apiArguments[findOptionIndex + 1];

    if (!query) throw new VscxError("missing-query", "--find requires a query.");
  }

  const bridgeRequest = createBridgeRequest({
    op: apiOperation,
    query,
    timeoutMs: commandContext.arguments.timeoutMs,
  });
  const requestResults = await sendRequestToSelectedTargets(
    commandContext,
    bridgeRequest,
  );

  writeCommandResults(commandContext, requestResults.map((result) => result.response));

  return getRequestResultsExitCode(requestResults);
}

async function runDoctorCommand(commandContext: CommandContext): Promise<number> {
  const runtimeRegistryEntries = pruneStaleRuntimeRegistryEntries({
    environment: commandContext.environment,
  });
  const environmentTarget = getEnvironmentTarget(commandContext.environment);
  const registryChecks = await Promise.all(
    runtimeRegistryEntries.map(async (runtimeRegistryEntry) => ({
      endpointReachable: (
        await probeBridgeConnection({
          endpoint: runtimeRegistryEntry.endpoint,
          token: runtimeRegistryEntry.token,
        })
      ).ok,
      windowId: runtimeRegistryEntry.windowId,
    })),
  );
  const healthyWindowCount = registryChecks.filter(
    (registryCheck) => registryCheck.endpointReachable,
  ).length;
  const doctorResult = {
    checks: {
      environmentConnection: Boolean(environmentTarget),
      healthyWindowCount,
      registryEntryCount: runtimeRegistryEntries.length,
      runtimeDirectory:
        commandContext.environment.VSCX_RUNTIME_DIR ?? "platform default",
    },
    guidance: getDoctorGuidance(
      Boolean(environmentTarget),
      runtimeRegistryEntries,
      healthyWindowCount,
    ),
    ok: healthyWindowCount > 0,
    windows: registryChecks,
  };

  if (commandContext.arguments.json) {
    writeJson(commandContext.stdout, doctorResult, true);
  } else {
    const doctorLines = [
      `VSCX doctor: ${doctorResult.ok ? "ready" : "not ready"}`,
      `Environment connection: ${doctorResult.checks.environmentConnection ? "present" : "missing"}`,
      `Registered windows: ${doctorResult.checks.registryEntryCount}`,
      `Healthy windows: ${doctorResult.checks.healthyWindowCount}`,
      ...doctorResult.guidance.map((guidanceLine) => `- ${guidanceLine}`),
    ];

    writeOutput(commandContext.stdout, doctorLines.join("\n"));
  }

  return doctorResult.ok ? 0 : 1;
}

interface RequestResult {
  response: BridgeResponse;
  target: ResolvedBridgeTarget;
}

async function sendRequestToSelectedTargets(
  commandContext: CommandContext,
  bridgeRequest: BridgeRequest,
): Promise<RequestResult[]> {
  const bridgeTargets = resolveBridgeTargets({
    currentDirPath: commandContext.currentDirPath,
    environment: commandContext.environment,
    selector: commandContext.arguments.selector,
  });

  return Promise.all(
    bridgeTargets.map(async (bridgeTarget) => {
      const startedAt = performance.now();

      try {
        return {
          response: await sendBridgeRequest(bridgeTarget, bridgeRequest, {
            signal: commandContext.signal,
          }),
          target: bridgeTarget,
        };
      } catch (error) {
        const bridgeResponse: BridgeResponse = {
          elapsedMs: Math.round(performance.now() - startedAt),
          error: getBridgeErrorData(error, false),
          extensionVersion:
            bridgeTarget.registryEntry?.extensionVersion ?? "unknown",
          id: bridgeRequest.id,
          ok: false,
          protocolVersion,
          windowId: bridgeTarget.windowId ?? "unknown",
        };

        return { response: bridgeResponse, target: bridgeTarget };
      }
    }),
  );
}

function buildRpcRequest(
  requestValue: unknown,
  defaultTimeoutMs?: number,
): BridgeRequest {
  if (!isRecord(requestValue)) {
    throw new VscxError("invalid-request", "Each RPC line must be a JSON object.");
  }

  const op = requestValue.op;

  if (typeof op !== "string") {
    throw new VscxError("invalid-request", "Each RPC request requires an op.");
  }

  const bridgeRequest = createBridgeRequest({
    code: typeof requestValue.code === "string" ? requestValue.code : undefined,
    id: typeof requestValue.id === "string" ? requestValue.id : undefined,
    input: requestValue.input as JsonValue | undefined,
    jobId: typeof requestValue.jobId === "string" ? requestValue.jobId : undefined,
    op: op as BridgeOperation,
    query: typeof requestValue.query === "string" ? requestValue.query : undefined,
    timeoutMs:
      typeof requestValue.timeoutMs === "number"
        ? requestValue.timeoutMs
        : defaultTimeoutMs,
  });

  return parseBridgeRequest(bridgeRequest);
}

function buildRpcCommandContext(
  commandContext: CommandContext,
  requestValue: unknown,
): CommandContext {
  if (!isRecord(requestValue) || requestValue.target === undefined) {
    return commandContext;
  }

  const rpcSelector: BridgeTargetSelector = {};

  if (requestValue.target === "all") rpcSelector.all = true;
  if (typeof requestValue.target === "string" && requestValue.target !== "current") {
    rpcSelector.windowId = requestValue.target;
  }
  if (isRecord(requestValue.target)) {
    if (typeof requestValue.target.windowId === "string") {
      rpcSelector.windowId = requestValue.target.windowId;
    }
    if (typeof requestValue.target.workspace === "string") {
      rpcSelector.workspace = requestValue.target.workspace;
    }
  }

  return {
    ...commandContext,
    arguments: {
      ...commandContext.arguments,
      selector: rpcSelector,
    },
  };
}

interface EvalCommandOptions {
  code?: string;
  fileName?: string;
  input?: string;
}

function parseEvalCommandOptions(commandArguments: string[]): EvalCommandOptions {
  const commandOptions: EvalCommandOptions = {};

  for (
    let argumentIndex = 0;
    argumentIndex < commandArguments.length;
    argumentIndex += 1
  ) {
    const argument = commandArguments[argumentIndex];

    if (!["--code", "--file", "--input"].includes(argument ?? "")) {
      throw new VscxError("unknown-option", `Unknown eval option ${argument}.`);
    }

    const optionValue = commandArguments[argumentIndex + 1];

    if (!optionValue) throw new VscxError("missing-option", `${argument} requires a value.`);

    argumentIndex += 1;

    if (argument === "--code") commandOptions.code = optionValue;
    if (argument === "--file") commandOptions.fileName = optionValue;
    if (argument === "--input") commandOptions.input = optionValue;
  }

  if (commandOptions.code && commandOptions.fileName) {
    throw new VscxError("incompatible-inputs", "Use only one of --code or --file.");
  }

  return commandOptions;
}

async function getEvaluationCode(
  commandContext: CommandContext,
  commandOptions: EvalCommandOptions,
): Promise<string> {
  if (commandOptions.code !== undefined) return commandOptions.code;

  if (commandOptions.fileName) {
    const evaluationFilePath = path.resolve(
      commandContext.currentDirPath,
      commandOptions.fileName,
    );

    return fs.readFileSync(evaluationFilePath, "utf8");
  }

  const standardInputFileContent = await readStandardInputFileContent(
    commandContext.stdin,
  );

  if (standardInputFileContent.trim().length > 0) return standardInputFileContent;

  throw new VscxError(
    "missing-code",
    "Provide evaluation code through stdin, --file, or --code.",
  );
}

async function readStandardInputFileContent(
  stdin: stream.Readable,
): Promise<string> {
  const standardInputChunks: Buffer[] = [];

  for await (const standardInputChunkValue of stdin) {
    standardInputChunks.push(
      Buffer.isBuffer(standardInputChunkValue)
        ? standardInputChunkValue
        : Buffer.from(standardInputChunkValue),
    );
  }

  return Buffer.concat(standardInputChunks).toString("utf8");
}

function parseJsonValue(value: string, sourceName: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    throw new VscxError("invalid-json", `${sourceName} must contain valid JSON.`);
  }
}

function writeCommandResults(
  commandContext: CommandContext,
  commandResults: unknown[],
): void {
  const printableValue = commandResults.length === 1 ? commandResults[0] : commandResults;

  if (commandContext.arguments.json) {
    writeJson(commandContext.stdout, printableValue ?? null, true);

    return;
  }

  if (commandResults.length === 1 && isBridgeResponse(commandResults[0])) {
    const bridgeResponse = commandResults[0];

    if (bridgeResponse.ok) {
      writeHumanValue(commandContext.stdout, bridgeResponse.value);

      return;
    }

    writeOutput(
      commandContext.stdout,
      `${bridgeResponse.error.code}: ${bridgeResponse.error.message}`,
    );

    return;
  }

  writeJson(commandContext.stdout, printableValue ?? null, true);
}

function writeHumanValue(stdout: stream.Writable, value: JsonValue): void {
  if (typeof value === "string") {
    writeOutput(stdout, value);

    return;
  }

  writeJson(stdout, value, true);
}

function writeJson(
  stdout: stream.Writable,
  value: unknown,
  pretty: boolean,
): void {
  writeOutput(stdout, JSON.stringify(value, null, pretty ? 2 : undefined));
}

function writeOutput(stdout: stream.Writable, value: string): void {
  stdout.write(`${value}\n`);
}

function writeCliError(
  stderr: stream.Writable,
  error: unknown,
  json: boolean,
): void {
  const bridgeError = getBridgeErrorData(error, false);

  if (json) {
    writeJson(stderr, { error: bridgeError, ok: false }, false);

    return;
  }

  stderr.write(`vscx: ${bridgeError.message}\n`);
}

function getRequestResultsExitCode(requestResults: RequestResult[]): number {
  return requestResults.every((requestResult) => requestResult.response.ok) ? 0 : 1;
}

function getRequestIdFromLine(requestLine: string): string {
  try {
    const requestValue: unknown = JSON.parse(requestLine);

    if (isRecord(requestValue) && typeof requestValue.id === "string") {
      return requestValue.id;
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

function getDoctorGuidance(
  hasEnvironmentTarget: boolean,
  runtimeRegistryEntries: RuntimeRegistryEntry[],
  healthyWindowCount: number,
): string[] {
  const guidance: string[] = [];

  if (!hasEnvironmentTarget) {
    guidance.push(
      "This shell has no injected connection. Open a new integrated terminal after VSCX activates.",
    );
  }

  if (runtimeRegistryEntries.length === 0) {
    guidance.push(
      "No extension endpoint is registered. Install the local VSIX and run 'VSCX: Show bridge status'.",
    );
  } else if (healthyWindowCount === 0) {
    guidance.push(
      "All registry entries are stale. Reload a VS Code window with VSCX enabled.",
    );
  }

  if (runtimeRegistryEntries.some((entry) => entry.remoteAuthority)) {
    guidance.push(
      "A remote workspace was detected. This prototype requires the VSCX extension to run in the local UI extension host.",
    );
  }

  if (guidance.length === 0) guidance.push("The bridge is ready.");

  return guidance;
}

function formatWindowsTable(windowDescriptions: WindowDescription[]): string {
  if (windowDescriptions.length === 0) {
    return "No VSCX windows are registered.";
  }

  const rows = [
    ["ACTIVE", "WINDOW", "HEALTH", "VS CODE", "WORKSPACE"],
    ...windowDescriptions.map((windowDescription) => [
      windowDescription.active ? "*" : "",
      windowDescription.windowId,
      windowDescription.health,
      windowDescription.vscodeVersion,
      windowDescription.workspaceFolders.join(", ") || "(empty window)",
    ]),
  ];
  const columnWidths = rows[0]?.map((_column, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex]?.length ?? 0)),
  ) ?? [];

  return rows
    .map((row) =>
      row
        .map((column, columnIndex) => column.padEnd(columnWidths[columnIndex] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function redactSecret(secret: string): string {
  if (secret.length <= 8) return "[redacted]";

  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBridgeResponse(value: unknown): value is BridgeResponse {
  return isRecord(value) && typeof value.ok === "boolean";
}

function getHelpFileContent(): string {
  return `VSCX ${vscxVersion}

Usage:
  vscx [target] <command> [options]

Commands:
  info                 Show the selected extension host and API versions
  windows              List discoverable VS Code windows
  eval                 Evaluate JavaScript from stdin, --file, or --code
  rpc                  Process newline-delimited JSON requests on stdin
  jobs [action]        List, get, cancel, or dispose bridge jobs
  api                  Read declarations, search declarations, or list commands
  doctor               Diagnose discovery and connection state

Target options:
  --window <id>        Select a registered window
  --workspace <path>  Select the unique window containing a path
  --endpoint <url>     Use an endpoint with VSCX_TOKEN from the environment
  --all                Explicitly fan out to all registered windows

Shared options:
  --json               Emit machine-readable JSON
  --timeout <ms>       Set the operation timeout (1-300000)

Examples:
  vscx info
  vscx eval --code "return vscode.version"
  vscx eval --input '{"text":"hello"}' < automation.js
  printf '%s\\n' '{"op":"info","target":"current"}' | vscx rpc`;
}
