import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type * as vscode from "vscode";

interface ConfigureTerminalEnvironmentOptions {
  environmentVariableCollection: vscode.GlobalEnvironmentVariableCollection;
  extensionDirPath: string;
  globalStorageDirPath: string;
  runtimeDirPath: string;
}

/** Keep complete executable files available even before extension activation. */
export async function configureTerminalEnvironment(options: ConfigureTerminalEnvironmentOptions): Promise<void> {
  const cliDirPath = path.join(options.globalStorageDirPath, "cli");
  const cliBinDirPath = path.join(cliDirPath, "bin");
  const cliDistDirPath = path.join(cliDirPath, "dist");
  const cliFiles = await Promise.all([
    { fileName: "dist/cli.js", mode: 0o600 },
    { fileName: "bin/vscx", mode: 0o700 },
    { fileName: "bin/vscx.cmd", mode: 0o600 },
  ].map(async (cliFile) => ({
    ...cliFile,
    fileContent: await fs.readFile(path.join(options.extensionDirPath, cliFile.fileName)),
  })));

  for (const cliDirectory of [cliDirPath, cliBinDirPath, cliDistDirPath]) {
    await fs.mkdir(cliDirectory, { mode: 0o700, recursive: true });
    await fs.chmod(cliDirectory, 0o700);
  }

  for (const cliFile of cliFiles) {
    const cliFilePath = path.join(cliDirPath, cliFile.fileName);
    const temporaryFilePath = `${cliFilePath}.${crypto.randomUUID()}.tmp`;

    try {
      await fs.writeFile(temporaryFilePath, cliFile.fileContent, { flag: "wx", mode: cliFile.mode });
      await fs.rename(temporaryFilePath, cliFilePath);
    } finally {
      await fs.rm(temporaryFilePath, { force: true });
    }
  }

  const environmentVariables = options.environmentVariableCollection;

  environmentVariables.description = "VSCX keeps its CLI available in restored terminals and discovers the current bridge.";

  for (const variableName of ["VSCX_ENDPOINT", "VSCX_TOKEN", "VSCX_WINDOW_ID", "VSCX_PROTOCOL_VERSION"]) {
    environmentVariables.delete(variableName);
  }

  environmentVariables.persistent = true;
  environmentVariables.replace("VSCX_RUNTIME_DIR", options.runtimeDirPath);
  environmentVariables.prepend("PATH", `${cliBinDirPath}${path.delimiter}`);
}
