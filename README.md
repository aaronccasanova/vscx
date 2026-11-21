<p align="center">
  <img src="packages/vscode/media/vscx-wordmark.png" alt="VSCX" width="320">
</p>

VSCX is a local control plane for the documented API of a running VS Code extension host. It combines an authenticated per-window HTTP bridge, a JSON-first CLI, and a VS Code extension that keeps its CLI available in persistent integrated terminals.

Use it to inspect live editor state, query diagnostics, discover VS Code APIs, automate the active window, and maintain long-lived extension-host jobs from a terminal or AI agent.

## Install a local build

Local source builds are the primary development workflow. You can use the latest checkout without waiting for a release. npm and Marketplace publishing remain available for releases.

The one-command packaging and installation helpers support macOS and Linux. Requirements: Node.js 22 or newer, the pnpm version declared in `package.json`, desktop VS Code 1.100 or newer, and VS Code's `code` command on your `PATH`. On macOS, run "Shell Command: Install 'code' command in PATH" from VS Code's Command Palette if needed.

Clone the repository, then install from source:

```sh
git clone https://github.com/aaronccasanova/vscx.git
cd vscx
pnpm install:snapshot
```

The installer checks for `code`, runs `pnpm install --frozen-lockfile`, builds core and the extension, packages a timestamped VSIX under `artifacts/`, and runs `code --install-extension <artifact> --force`. The extension bundles the CLI from the same checkout. No separate CLI installation or publication is needed. Node.js 22 or newer must remain on `PATH` to run the CLI.

Run "Developer: Reload Window", open a trusted workspace, and create a new integrated terminal. Confirm the connection:

```sh
vscx doctor
vscx info
```

The extension contributes a stable bundled `vscx` path and discovers the current connection automatically. A terminal opened before this updated extension first activated may need one recreation, or `VSCX: Open connected terminal`, to receive that path. Subsequent reloads, restarts, and upgrades preserve CLI access.

To keep using local builds, disable auto-update for VSCX Host in VS Code's Extensions view so a later Marketplace release does not replace your build. Snapshot timestamps distinguish artifact filenames without changing source package versions.

### Pull main and reinstall

Use the same source checkout for later updates. Commit or otherwise preserve local changes before switching branches, then run:

```sh
git switch main
git pull --ff-only
pnpm install:snapshot
```

Reload the intended VS Code window and run `vscx doctor` and `vscx info` in an existing integrated terminal. If an agent handles "pull main and reinstall", it should use this checkout, preserve local changes, stop if the pull cannot fast-forward, and report the installed commit, VSIX path, and connection check. The installer builds the current checkout. It does not switch branches, pull, or publish on your behalf.

### Windows local builds

The Node packaging helper does not currently support Windows command launchers. From PowerShell, use these equivalent commands (not yet validated on Windows):

```powershell
pnpm install --frozen-lockfile
pnpm --filter @vscx/core run build
pnpm --filter vscode-vscx run build
New-Item -ItemType Directory -Force artifacts | Out-Null
pnpm --filter vscode-vscx exec vsce package --no-dependencies --out ../../artifacts/vscx-local.vsix
code --install-extension artifacts/vscx-local.vsix --force
```

Reload VS Code and verify the connection in a new terminal afterward. This fallback reuses `artifacts/vscx-local.vsix`.

## Explore a VS Code window

Inspect the active editor and workspace:

```sh
vscx eval --json --code '
return {
  activeFile: vscode.window.activeTextEditor?.document.uri.toString() ?? null,
  languageId: vscode.window.activeTextEditor?.document.languageId ?? null,
  workspaceFolders: vscode.workspace.workspaceFolders?.map(({ name, uri }) => ({
    name,
    uri: uri.toString(),
  })) ?? [],
};
'
```

Summarize workspace diagnostics:

```sh
vscx eval --json --code '
return vscode.languages.getDiagnostics().map(([uri, diagnostics]) => ({
  uri: uri.toString(),
  errors: diagnostics.filter(
    ({ severity }) => severity === vscode.DiagnosticSeverity.Error,
  ).length,
  total: diagnostics.length,
}));
'
```

Discover an unfamiliar API before using it:

```sh
vscx api --find TerminalShellIntegration
vscx api --commands --json
```

Evaluate a larger program through stdin and pass dynamic values as JSON input:

```sh
vscx eval --input '{"name":"VSCX scratch"}' --json <<'JS'
const terminal = vscode.window.createTerminal(input.name);
terminal.show();

return {
  name: terminal.name,
  terminalCount: vscode.window.terminals.length,
};
JS
```

Stream JSON-lines RPC from an agent or script:

```sh
printf '%s\n' \
  '{"id":"version","op":"eval","target":"current","code":"return vscode.version"}' \
  '{"id":"commands","op":"api.commands","target":"current"}' \
  | vscx rpc
```

## Agent skill

Install the skill globally from your source checkout:

```sh
npx skills add . --skill vscx --global
```

The bundled VSCX skill teaches compatible AI agents how to orient themselves, select a live window, discover the documented API, write structured evaluations, manage long-lived jobs, and diagnose the bridge.

The open `skills` installer supports Codex, Claude Code, Cursor, and other compatible agents. Start a new agent session after installation so it discovers the global skill. For example:

```text
Use $vscx to inspect the active VS Code window, summarize its current editor and diagnostics, and show me what else you can control.
```

Rerun the skill installation command after pulling skill updates, then start another new agent session.

## Architecture

```text
Integrated terminal or agent
  -> vscx CLI (standalone or bundled in the VSIX)
  -> @vscx/core discovery and authenticated RPC
  -> per-window loopback endpoint
  -> VS Code extension host
  -> documented vscode API
```

- `@vscx/core` owns the protocol contract, transport, endpoint registry, target discovery, serialization, errors, and job lifecycle.
- `@vscx/cli` exposes a reusable `runCli()` library and the `vscx` executable.
- `vscode-vscx` is the VS Code extension workspace. It consumes core directly and bundles the CLI so the local VSIX is self-contained.

The protocol types have no VS Code dependency and live in their own core module. They can move into a separate package later if an independent consumer needs that boundary, without changing the wire format.

## Target selection

The extension persistently contributes a stable CLI directory to `PATH` and sets `VSCX_RUNTIME_DIR`. It copies its self-contained CLI into VS Code's extension storage, so restored terminals can run it before activation and after a versioned extension directory is removed. Endpoints, tokens, and window IDs stay in the user-only runtime registry and are refreshed on every activation.

On macOS and Linux, the CLI asks registered local windows for their live terminal process IDs and matches its nearest process ancestor. This identifies the owning window after reloads, restarts, or terminal moves, including empty windows and shells whose current directory belongs to a different workspace. Confirmed process IDs remain usable in partial reports. An unrelated busy or older desktop window does not block a known owner when process ancestry rules out a closer terminal in that window. Explicit selectors take precedence.

If an integrated terminal's owner cannot be confirmed, VSCX requires `--window` or `--workspace`. Without an ownership match, integrated terminals never fall back to a window selected by working directory or window count. Windows, remote terminals, and unavailable process information may require explicit selection. A registered unresolved nested window still blocks selection when it could own a closer terminal. External shells retain unique workspace and sole-window fallbacks. Ambiguous matches always require selection.

`--process <pid>` selects the VS Code window that owns the integrated terminal associated with a live local process. The request runs in that window's extension host. VSCX reads the process's ancestry and matches the nearest registered local terminal owner, including after the extension host reactivates with a new window ID. The PID must be a positive safe integer and is exclusive with other selectors. No match, incomplete ancestry, ambiguous ownership, or a potentially closer unresolved owner fails without falling back to a workspace or sole window. This selector supports local macOS and Linux processes. Remote PIDs and unsupported platforms require a window or workspace selector. PIDs can be reused, so treat them as lookup keys, not persistent identifiers.

Only registered windows participate in discovery. Before using automatic selection in a nested editor instance, wait until that instance appears in `vscx windows`. Until then, a registered outer terminal can still match.

Terminals created before this update may need one recreation to receive the stable `PATH`. After that, reloads and restarts preserve CLI access without persisting credentials. If you run incompatible extension development builds, use separate VS Code user data directories: builds sharing extension storage share the last copied CLI.

```sh
vscx windows
vscx --window <window-id> info
vscx --process <terminal-shell-pid> info
vscx --workspace "$PWD" info
vscx --all eval --code 'return vscode.env.appName' --json
```

### Registry diagnostics

`vscx doctor` reports the resolved runtime registry directory and whether it exists in both text and JSON output. Discovery errors include `details.runtimeDirectory` and `details.runtimeDirectoryExists`. If a CLI outside VS Code cannot discover a window, compare that path with the extension's `registryDirPath` from `vscx info --json` in a connected terminal. Both processes must use the same `VSCX_RUNTIME_DIR` when you override it.

Registry resolution honors an explicit core `runtimeDirPath`, then `VSCX_RUNTIME_DIR`, Windows `LOCALAPPDATA`, and `XDG_RUNTIME_DIR`. Otherwise it uses a per-user directory under the temporary directory. On macOS, a nonempty `TMPDIR` stays authoritative. If it is missing or empty, VSCX asks `/usr/bin/getconf DARWIN_USER_TEMP_DIR` for the user's system temporary directory before falling back to the normal temporary-directory defaults. This lets cleared environments discover the default registry without moving existing registries.

## Evaluation and jobs

Evaluation source can be an async function body, an expression, or a callback of the form `async ({ vscode, bridge, input, signal, AbortSignal, helpers }) => value`. Function bodies and expressions receive these bindings directly:

- `vscode`: The real, documented `vscode` module from the selected extension host.
- `bridge`: Window metadata, structured logging, serialization, and named jobs.
- `input`: The JSON value supplied by `--input` or RPC.
- `signal`: An `AbortSignal` for cancellation and timeouts.
- `AbortSignal`: The platform constructor.
- `helpers`: `assertNotAborted()`, `sleep()`, and `toJSON()`.

For long-lived listeners, register resources under a named job:

```sh
vscx eval --code '
  const job = bridge.jobs.create({ id: "window-watch", label: "Window state watcher" });
  job.add(vscode.window.onDidChangeWindowState((state) => bridge.log("window state", state)));
  return job.describe();
'
vscx jobs list
vscx jobs dispose window-watch
```

## Runtime boundaries

- Evaluation is not a security sandbox. Authentication protects the endpoint from accidental access, but an authenticated client can execute JavaScript in the extension host and use any API available to this extension.
- No MCP server or adapter is required. The CLI is the agent-facing protocol client.
- Untrusted workspaces are not supported. Trust the workspace before activating VSCX.
- Desktop VS Code with the extension in the local UI host is the supported topology.
- Timeouts abort cooperative code and return promptly, but JavaScript already running on the extension-host thread cannot be forcibly terminated.
- API declarations describe the extension engine baseline. Runtime availability still depends on the installed VS Code version, host topology, workspace trust, and installed extensions.
- Error stack traces are excluded from bridge responses by default because they can contain local paths. Enable `vscx.includeRemoteStacks` only when detailed local diagnostics are needed.

## Develop and test

Install dependencies before running the development checks:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run test
pnpm run build
pnpm package:snapshot
```

The last command creates a timestamped local VSIX under `artifacts/` without installing or publishing it. `pnpm package:local` remains an alias. Packaging builds core before bundling the extension and CLI. To install the current checkout, use `pnpm install:snapshot` as described above.

## Release process

Changesets keeps core, CLI, and the extension on one synchronized version. Pull requests that change shipped behavior include a changeset. After merge, the release workflow creates a `Version Packages` pull request. Merging that reviewed release PR verifies the workspace, publishes npm packages first, and publishes the Marketplace pre-release second.

See [RELEASING.md](RELEASING.md) for changeset policy, local verification, trusted publishing setup, retry behavior, and the one-time rollout sequence.

### Package registry terminology

VSCX uses `public` and `private` only for package registry behavior. `"access": "public"` allows the scoped core and CLI packages to be published to npm. `"private": true` prevents npm from publishing the extension workspace package.

These settings do not describe repository visibility, source availability, licensing, intended audience, or confidentiality. The extension is excluded from npm because its distribution channel is the VS Code Marketplace.
