#!/usr/bin/env node

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as url from "node:url";

const scriptFilePath = url.fileURLToPath(import.meta.url);
const projectRootDirPath = path.resolve(path.dirname(scriptFilePath), "..");
const extensionDirPath = path.join(projectRootDirPath, "packages", "vscode");
const extensionDistDirPath = path.join(extensionDirPath, "dist");
const extensionRequire = createRequire(
  path.join(extensionDirPath, "package.json"),
);
const esbuild = extensionRequire("esbuild");

async function main() {
  fs.mkdirSync(extensionDistDirPath, { recursive: true });

  await Promise.all([
    esbuild.build({
      bundle: true,
      entryPoints: [path.join(extensionDirPath, "src", "extension.ts")],
      external: ["vscode"],
      format: "cjs",
      outfile: path.join(extensionDistDirPath, "extension.js"),
      platform: "node",
      sourcemap: true,
      target: "node20",
    }),
    esbuild.build({
      bundle: true,
      entryPoints: [
        path.join(projectRootDirPath, "packages", "cli", "src", "cli.ts"),
      ],
      format: "cjs",
      outfile: path.join(extensionDistDirPath, "cli.js"),
      platform: "node",
      sourcemap: true,
      target: "node20",
    }),
  ]);

  const vscodeDeclarationFilePath = path.join(
    extensionDirPath,
    "node_modules",
    "@types",
    "vscode",
    "index.d.ts",
  );

  fs.copyFileSync(
    vscodeDeclarationFilePath,
    path.join(extensionDistDirPath, "vscode.d.ts"),
  );
}

await main();
