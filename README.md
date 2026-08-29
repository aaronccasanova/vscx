<p align="center">
  <img src="packages/vscode/media/vscx-wordmark.png" alt="VSCX" width="320">
</p>

VSCX is a local control plane for the documented API of a running VS Code extension host. It combines an authenticated per-window HTTP bridge, a JSON-first CLI, and a VS Code extension that injects the correct connection into new integrated terminals.

Use it to inspect live editor state, query diagnostics, discover VS Code APIs, automate the active window, and maintain long-lived extension-host jobs from a terminal or AI agent.

## Get started

1. Install the VSCX pre-release from the VS Code Marketplace.
2. Install the agent skill globally:

   ```sh
   npx skills add aaronccasanova/vscx --skill vscx --global
   ```

3. Reload VS Code, open a trusted workspace, and create a new integrated terminal.
4. Confirm the connection:

   ```sh
   vscx doctor
   vscx info
   ```

VSCX is now ready to use. The extension contributes the bundled `vscx` executable and the correct per-window connection to new integrated terminals. You do not need to install the CLI separately or configure connection credentials.

If `vscx` is missing from a terminal that was already open, recreate it or run `VSCX: Open connected terminal` from the Command Palette.

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

The bundled VSCX skill teaches compatible AI agents how to orient themselves, select a live window, discover the documented API, write structured evaluations, manage long-lived jobs, and diagnose the bridge.

The open `skills` installer supports Codex, Claude Code, Cursor, and other compatible agents. Start a new agent session after installation so it discovers the global skill. For example:

```text
Use $vscx to inspect the active VS Code window, summarize its current editor and diagnostics, and show me what else you can control.
```

To test changes to the skill from a local repository checkout, install that copy globally:

```sh
npx skills add . --skill vscx --global
```

Start another new agent session after replacing the installed skill.

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

The extension injects `VSCX_ENDPOINT`, `VSCX_TOKEN`, `VSCX_WINDOW_ID`, `VSCX_PROTOCOL_VERSION`, and `VSCX_RUNTIME_DIR` into new integrated terminals. It also prepends its bundled CLI directory to `PATH`.

When those variables are absent, the CLI checks the user-only runtime registry. It removes records whose extension-host process has ended, then uses an explicit selector, the unique window containing the current directory, or the only registered window. It never guesses between multiple matches.

```sh
vscx windows
vscx --window <window-id> info
vscx --workspace "$PWD" info
vscx --all eval --code 'return vscode.env.appName' --json
```

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

Requirements: Node.js 22 or newer, pnpm 11, desktop VS Code 1.100 or newer, and the `code` command on your `PATH`.

```sh
pnpm install
pnpm run check
pnpm run test
pnpm run build
pnpm package:local
```

The last command creates a timestamped local VSIX under `artifacts/`. It does not publish or install anything.

To build and install a local snapshot in VS Code:

```sh
pnpm install:snapshot
```

Reload the VS Code window after installation. VSCX requires a trusted workspace because an authenticated client can evaluate JavaScript in the extension host.

## Release process

Changesets keeps core, CLI, and the extension on one synchronized version. Pull requests that change shipped behavior include a changeset. After merge, the release workflow creates a `Version Packages` pull request. Merging that reviewed release PR verifies the workspace, publishes npm packages first, and publishes the Marketplace pre-release second.

See [RELEASING.md](RELEASING.md) for changeset policy, local verification, trusted publishing setup, retry behavior, and the one-time rollout sequence.

### Package registry terminology

VSCX uses `public` and `private` only for package registry behavior. `"access": "public"` allows the scoped core and CLI packages to be published to npm. `"private": true` prevents npm from publishing the extension workspace package.

These settings do not describe repository visibility, source availability, licensing, intended audience, or confidentiality. The extension is excluded from npm because its distribution channel is the VS Code Marketplace.
