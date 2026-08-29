import * as crypto from "node:crypto";
import * as path from "node:path";

import {
  BridgeJobManager,
  createBridgeServer,
  getRuntimeRegistryDirPath,
  protocolVersion,
  removeRuntimeRegistryEntry,
  VscxError,
  writeRuntimeRegistryEntry,
  type BridgeHostMetadata,
  type BridgeRequest,
  type BridgeServer,
  type BridgeServerContext,
  type RuntimeRegistryEntry,
} from "@vscx/core";
import * as vscode from "vscode";

import { readApiDeclarations, searchApiDeclarations } from "./declarations";
import { evaluateBridgeCode } from "./evaluator";

interface BridgeRuntimeStatus {
  cliFilePath: string;
  endpoint: string;
  metadata: BridgeHostMetadata;
  registryDirPath: string;
}

export class BridgeRuntime implements vscode.Disposable {
  readonly #extensionContext: vscode.ExtensionContext;
  readonly #jobManager = new BridgeJobManager();
  readonly #outputChannel = vscode.window.createOutputChannel("VSCX", {
    log: true,
  });
  readonly #token = crypto.randomBytes(32).toString("base64url");
  readonly #windowId = crypto.randomUUID();
  #bridgeServer: BridgeServer | undefined;
  #disposed = false;
  #statusBarItem: vscode.StatusBarItem | undefined;

  constructor(extensionContext: vscode.ExtensionContext) {
    this.#extensionContext = extensionContext;
  }

  async start(): Promise<void> {
    if (this.#bridgeServer) return;

    this.#bridgeServer = await createBridgeServer({
      extensionVersion: this.#getExtensionVersion(),
      handleRequest: (bridgeServerContext) =>
        this.#handleBridgeRequest(bridgeServerContext),
      includeStack: vscode.workspace
        .getConfiguration("vscx")
        .get("includeRemoteStacks", false),
      token: this.#token,
      windowId: this.#windowId,
    });

    const runtimeRegistryEntry = this.#buildRuntimeRegistryEntry(
      this.#bridgeServer.endpoint,
    );

    writeRuntimeRegistryEntry(runtimeRegistryEntry);
    this.#injectTerminalEnvironment(runtimeRegistryEntry);
    this.#registerUserInterface();

    this.#outputChannel.info(
      `Bridge listening on ${this.#bridgeServer.endpoint} for window ${this.#windowId}.`,
    );
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;

    this.#disposed = true;

    this.#extensionContext.environmentVariableCollection.clear();
    removeRuntimeRegistryEntry(this.#windowId);

    await this.#jobManager.disposeAll();
    await this.#bridgeServer?.close();

    this.#statusBarItem?.dispose();
    this.#outputChannel.dispose();
  }

  async #handleBridgeRequest(
    bridgeServerContext: BridgeServerContext,
  ): Promise<unknown> {
    switch (bridgeServerContext.request.op) {
      case "info":
        return this.#buildRuntimeStatus();
      case "eval":
        return evaluateBridgeCode({
          bridgeRequest: bridgeServerContext.request,
          jobManager: this.#jobManager,
          log: (message, value) => {
            this.#outputChannel.info(
              value === undefined
                ? message
                : `${message} ${JSON.stringify(value)}`,
            );
          },
          metadata: this.#getHostMetadata(),
          signal: bridgeServerContext.signal,
        });
      case "jobs.list":
        return this.#jobManager.list();
      case "jobs.get":
        return this.#jobManager.get(getRequestJobId(bridgeServerContext.request));
      case "jobs.cancel":
        return this.#jobManager.cancel(
          getRequestJobId(bridgeServerContext.request),
        );
      case "jobs.dispose":
        return this.#jobManager.dispose(
          getRequestJobId(bridgeServerContext.request),
        );
      case "api.declarations":
        return readApiDeclarations(this.#extensionContext.extensionPath);
      case "api.find":
        return searchApiDeclarations(
          this.#extensionContext.extensionPath,
          bridgeServerContext.request.query ?? "",
        );
      case "api.commands":
        return {
          commands: await vscode.commands.getCommands(true),
          metadata: this.#getHostMetadata(),
        };
    }
  }

  #buildRuntimeRegistryEntry(endpoint: string): RuntimeRegistryEntry {
    const metadata = this.#getHostMetadata();
    const now = new Date().toISOString();

    return {
      appHost: metadata.appHost,
      appName: metadata.appName,
      createdAt: now,
      endpoint,
      extensionHostKind: metadata.extensionHostKind,
      extensionVersion: metadata.extensionVersion,
      processId: process.pid,
      protocolVersion,
      ...(metadata.remoteAuthority
        ? { remoteAuthority: metadata.remoteAuthority }
        : {}),
      token: this.#token,
      updatedAt: now,
      vscodeVersion: metadata.vscodeVersion,
      windowId: this.#windowId,
      ...(metadata.workspaceFile
        ? { workspaceFile: metadata.workspaceFile }
        : {}),
      workspaceFolders: metadata.workspaceFolders,
    };
  }

  #getHostMetadata(): BridgeHostMetadata {
    const workspaceFolders =
      vscode.workspace.workspaceFolders?.map((workspaceFolder) =>
        workspaceFolder.uri.scheme === "file"
          ? workspaceFolder.uri.fsPath
          : workspaceFolder.uri.toString(),
      ) ?? [];

    return {
      appHost: vscode.env.appHost,
      appName: vscode.env.appName,
      extensionHostKind: "local-ui",
      extensionVersion: this.#getExtensionVersion(),
      isTrusted: vscode.workspace.isTrusted,
      protocolVersion,
      ...(vscode.env.remoteName ? { remoteAuthority: vscode.env.remoteName } : {}),
      vscodeVersion: vscode.version,
      windowId: this.#windowId,
      ...(vscode.workspace.workspaceFile
        ? { workspaceFile: vscode.workspace.workspaceFile.toString() }
        : {}),
      workspaceFolders,
    };
  }

  #getExtensionVersion(): string {
    const extensionPackageConfig = this.#extensionContext.extension.packageJSON as {
      version?: unknown;
    };

    return typeof extensionPackageConfig.version === "string"
      ? extensionPackageConfig.version
      : "0.0.0";
  }

  #injectTerminalEnvironment(runtimeRegistryEntry: RuntimeRegistryEntry): void {
    const environmentVariables =
      this.#extensionContext.environmentVariableCollection;
    const cliBinDirPath = path.join(
      this.#extensionContext.extensionPath,
      "bin",
    );

    environmentVariables.persistent = false;
    environmentVariables.description =
      "VSCX connects new terminals automatically. Recreate terminals opened before VSCX activated.";
    environmentVariables.replace("VSCX_ENDPOINT", runtimeRegistryEntry.endpoint);
    environmentVariables.replace("VSCX_TOKEN", runtimeRegistryEntry.token);
    environmentVariables.replace("VSCX_WINDOW_ID", runtimeRegistryEntry.windowId);
    environmentVariables.replace(
      "VSCX_PROTOCOL_VERSION",
      String(runtimeRegistryEntry.protocolVersion),
    );
    environmentVariables.replace(
      "VSCX_RUNTIME_DIR",
      getRuntimeRegistryDirPath(),
    );
    environmentVariables.prepend("PATH", `${cliBinDirPath}${path.delimiter}`);
  }

  #registerUserInterface(): void {
    this.#statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      10,
    );
    this.#statusBarItem.name = "VSCX bridge";
    this.#statusBarItem.text = "$(radio-tower) VSCX";
    this.#statusBarItem.tooltip =
      "The local VSCX bridge is running. New terminals connect automatically.";
    this.#statusBarItem.command = "vscx.showStatus";
    this.#statusBarItem.show();

    this.#extensionContext.subscriptions.push(
      this.#statusBarItem,
      this.#outputChannel,
      vscode.commands.registerCommand("vscx.showStatus", async () => {
        const bridgeRuntimeStatus = this.#buildRuntimeStatus();
        const selectedAction = await vscode.window.showInformationMessage(
          `VSCX is running for this window (${this.#windowId.slice(0, 8)}). New terminals connect automatically. Recreate terminals opened before VSCX activated.`,
          "Open connected terminal",
          "Show diagnostics",
        );

        if (selectedAction === "Open connected terminal") {
          this.#openConnectedTerminal();
        }

        if (selectedAction === "Show diagnostics") {
          this.#outputChannel.info(JSON.stringify(bridgeRuntimeStatus, null, 2));
          this.#outputChannel.show(true);
        }
      }),
      vscode.commands.registerCommand("vscx.openTerminal", () => {
        this.#openConnectedTerminal();
      }),
    );
  }

  #openConnectedTerminal(): void {
    const terminal = vscode.window.createTerminal({ name: "VSCX" });

    terminal.show();
  }

  #buildRuntimeStatus(): BridgeRuntimeStatus {
    if (!this.#bridgeServer) {
      throw new VscxError("bridge-not-started", "The VSCX bridge is not running.");
    }

    return {
      cliFilePath: path.join(this.#extensionContext.extensionPath, "bin", "vscx"),
      endpoint: this.#bridgeServer.endpoint,
      metadata: this.#getHostMetadata(),
      registryDirPath: getRuntimeRegistryDirPath(),
    };
  }
}

function getRequestJobId(bridgeRequest: BridgeRequest): string {
  if (bridgeRequest.jobId) return bridgeRequest.jobId;

  throw new VscxError("missing-job-id", `${bridgeRequest.op} requires a jobId.`);
}
