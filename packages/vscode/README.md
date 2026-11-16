<p align="center">
  <img src="https://raw.githubusercontent.com/aaronccasanova/vscx/main/packages/vscode/media/vscx-wordmark.png" alt="VSCX" width="320">
</p>

VSCX gives local tools and AI agents structured access to the documented API of a running VS Code window. It combines an authenticated per-window bridge with a bundled JSON-first CLI.

This is an early pre-release. The protocol and command surface may change before a stable release.

## Get started

Install VSCX, trust the workspace, and reload the VS Code window. Integrated terminals receive a stable bundled `vscx` path and discover fresh authenticated connections automatically.

Run:

```sh
vscx doctor
vscx info
vscx eval --code 'return vscode.version'
vscx api --find WorkspaceEdit
```

A terminal created before the first updated activation may need one recreation to receive the stable CLI path. You can also run `VSCX: Open connected terminal` from the Command Palette. Subsequent reloads and restarts preserve CLI access.

## Install or update from source

Local builds are the primary development workflow. Clone the [VSCX repository](https://github.com/aaronccasanova/vscx#install-a-local-build), then run `pnpm install:snapshot` from the checkout on macOS or Linux. It installs locked dependencies, builds core and the extension with its bundled CLI, and installs a timestamped VSIX in VS Code. The repository guide includes requirements and a manual Windows sequence.

For later updates, preserve local changes, switch to `main`, run `git pull --ff-only`, and rerun `pnpm install:snapshot`. Reload the intended VS Code window and verify `vscx doctor` and `vscx info` in an existing integrated terminal. Disable auto-update for VSCX Host if you want to retain local builds. Marketplace releases remain available.

## Use the CLI

The main commands are:

- `vscx doctor` diagnoses activation, discovery, and connectivity.
- `vscx windows` lists discoverable VS Code windows.
- `vscx info` describes the selected extension host.
- `vscx eval` evaluates JavaScript against the documented `vscode` API.
- `vscx api` searches bundled API declarations or lists commands.
- `vscx jobs` manages resources that outlive one evaluation.
- `vscx rpc` processes newline-delimited JSON requests for agents and scripts.

The persistent CLI discovers fresh credentials from the user-only registry. On macOS and Linux, it matches the current terminal's process ancestry against live windows before considering workspace paths. Reloads and restarts no longer require replacing the terminal. Terminals created before the first updated activation may need one recreation to receive the stable CLI path.

When ownership is unavailable or a window is still starting, select `--window` or `--workspace` explicitly. Windows and remote terminals may need these selectors. External shells can still select a unique workspace or the sole window. Use `--all` only for intentional fan-out.

## Understand the security boundary

Each window listens on a random `127.0.0.1` port and requires a random bearer token stored in a user-only runtime registry. VSCX never needs an internet-facing server or MCP adapter.

Evaluation is not sandboxed. An authenticated client can run JavaScript in the extension host and invoke APIs available to VSCX. Tokens are not injected into terminal environments or persisted environment collections. Protect registry access and review agent-requested changes with the same care as local code execution.

VSCX does not activate in untrusted workspaces. Error stack traces are excluded from bridge responses by default because they can contain local paths. Enable `vscx.includeRemoteStacks` only for detailed local diagnostics.

## Current boundaries

- Desktop VS Code 1.100 or newer.
- VSCX runs in the local UI extension host.
- Timeouts are cooperative and cannot interrupt synchronous JavaScript already occupying the extension-host thread.
- API availability can vary with VS Code version, workspace trust, host topology, and installed extensions.

Source, architecture, local build instructions, and the bundled agent skill are available in the [VSCX repository](https://github.com/aaronccasanova/vscx).
