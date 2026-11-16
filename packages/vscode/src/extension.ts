import * as vscode from "vscode";

import { BridgeRuntime } from "./bridge-runtime";

let bridgeRuntime: BridgeRuntime | undefined;

export async function activate(
  extensionContext: vscode.ExtensionContext,
): Promise<void> {
  bridgeRuntime = new BridgeRuntime(extensionContext);

  try {
    await bridgeRuntime.start();
  } catch (error) {
    await bridgeRuntime.dispose();

    bridgeRuntime = undefined;

    throw error;
  }
}

export async function deactivate(): Promise<void> {
  await bridgeRuntime?.dispose();

  bridgeRuntime = undefined;
}
