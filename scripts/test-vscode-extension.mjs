import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

const projectRootDirPath = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const extensionRequire = module.createRequire(path.join(projectRootDirPath, "packages/vscode/package.json"));
const temporaryDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "vscx-extension-tests-"));

try {
  const testFileNames = ["terminal-environment.test", "terminal-ownership.test"];

  await extensionRequire("esbuild").build({
    bundle: true,
    entryPoints: testFileNames.map((testFileName) => path.join(projectRootDirPath, "packages/vscode/src", `${testFileName}.ts`)),
    format: "cjs",
    outdir: temporaryDirPath,
    outExtension: { ".js": ".cjs" },
    platform: "node",
    target: "node22",
  });

  const testResult = childProcess.spawnSync(process.execPath, ["--test", ...testFileNames.map((testFileName) => path.join(temporaryDirPath, `${testFileName}.cjs`))], { cwd: projectRootDirPath, stdio: "inherit" });

  if (testResult.error) throw testResult.error;

  process.exitCode = testResult.status ?? 1;
} finally {
  await fs.rm(temporaryDirPath, { force: true, recursive: true });
}
