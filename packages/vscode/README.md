<p align="center">
  <img src="https://raw.githubusercontent.com/aaronccasanova/vscx/main/packages/vscode/media/vscx-wordmark.png" alt="VSCX" width="320">
</p>

VSCX gives local tools and AI agents structured access to the documented API of a running VS Code window. It combines an authenticated per-window bridge with a bundled JSON-first CLI.

This is an early pre-release. The protocol and command surface may change before a stable release.

## Get started

Install VSCX, trust the workspace, and reload the VS Code window. New integrated terminals receive the authenticated connection and the bundled `vscx` executable automatically.

Run:

```sh
vscx doctor
vscx info
vscx eval --code 'return vscode.version'
vscx api --find WorkspaceEdit
```

If `vscx` is missing from a terminal that was already open, recreate that terminal. You can also run `VSCX: Open connected terminal` from the Command Palette.

## Use the CLI

The main commands are:

- `vscx doctor` diagnoses activation, discovery, and connectivity.
- `vscx windows` lists discoverable VS Code windows.
- `vscx info` describes the selected extension host.
- `vscx eval` evaluates JavaScript against the documented `vscode` API.
- `vscx api` searches bundled API declarations or lists commands.
- `vscx jobs` manages resources that outlive one evaluation.
- `vscx rpc` processes newline-delimited JSON requests for agents and scripts.

VSCX uses the current terminal's injected window first. Without that environment, it selects a unique window containing the current directory or the only registered window. It refuses ambiguous matches. Use `--window`, `--workspace`, or `--all` to make intent explicit.

## Understand the security boundary

Each window listens on a random `127.0.0.1` port and requires a random bearer token stored in a user-only runtime registry. VSCX never needs an internet-facing server or MCP adapter.

Evaluation is not sandboxed. An authenticated client can run JavaScript in the extension host and invoke APIs available to VSCX. Keep `VSCX_TOKEN` secret and review agent-requested changes with the same care as local code execution.

VSCX does not activate in untrusted workspaces. Error stack traces are excluded from bridge responses by default because they can contain local paths. Enable `vscx.includeRemoteStacks` only for detailed local diagnostics.

## Current boundaries

- Desktop VS Code 1.100 or newer.
- VSCX runs in the local UI extension host.
- Timeouts are cooperative and cannot interrupt synchronous JavaScript already occupying the extension-host thread.
- API availability can vary with VS Code version, workspace trust, host topology, and installed extensions.

Source, architecture, local build instructions, and the bundled agent skill are available in the [VSCX repository](https://github.com/aaronccasanova/vscx).
