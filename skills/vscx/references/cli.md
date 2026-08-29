# VSCX CLI reference

Use the `vscx` executable bundled with the locally installed VSCX extension. During the prototype rollout, do not substitute `npx`, `pnpm dlx`, or a registry package until the corresponding npm release is confirmed.

## Choose a runner

Inside a new VS Code integrated terminal, prefer:

```sh
vscx help
```

The extension adds its bundled CLI to `PATH` when VS Code creates a terminal. A terminal that was already open when the extension activated keeps its old environment. Recreate that terminal, or run `VSCX: Open connected terminal`, when `vscx` is missing.

When developing this repository outside a packaged extension terminal, build first and use:

```sh
pnpm run build
pnpm vscx help
```

Use the same runner for the rest of a task.

## Diagnose and select a window

Start with:

```sh
vscx doctor
vscx info --json
```

The default target order is:

1. The connection injected into the current terminal.
2. The unique registered window containing the current working directory.
3. The only registered window.

VSCX refuses to guess when several windows match. Inspect and select one:

```sh
vscx windows
vscx --window <window-id> info
vscx --workspace /absolute/project/path info
```

Use `--all` only when fan-out to every registered window is explicitly intended. Each response includes its `windowId`, and one failed window makes the command fail without discarding other responses.

`--endpoint <url>` is a low-level diagnostic option. It requires `VSCX_TOKEN` in the environment. Do not expose that value in commands, output, or logs.

## Use the command surface

```text
vscx info
vscx windows
vscx eval [--code <source> | --file <path>] [--input <json>]
vscx rpc
vscx jobs [list|get|cancel|dispose] [job-id]
vscx api [--find <query> | --commands]
vscx doctor
```

Shared options:

- `--json` emits machine-readable output.
- `--timeout <ms>` sets a timeout from 1 to 300000 milliseconds.
- `--window`, `--workspace`, `--endpoint`, and `--all` select a target.

Without `--json`, a successful single request prints its value directly. With `--json`, it prints the complete response envelope. Inspect `ok` before consuming `value`. Parse or usage failures exit with a nonzero status.

## Discover the API

Search the bundled VS Code declarations before inventing an API shape:

```sh
vscx api --find 'window.activeTextEditor' --json
vscx api --find 'WorkspaceEdit' --json
vscx api --commands --json
```

Declaration search describes the extension's compiled API baseline. Check returned runtime metadata when behavior may depend on the installed VS Code version, workspace trust, host topology, or another extension.

## Stream JSON-lines RPC

Use `rpc` when an agent or program needs multiple structured requests over one process:

```sh
printf '%s\n' \
  '{"id":"status","op":"info","target":"current"}' \
  '{"id":"version","op":"eval","target":"current","code":"return vscode.version"}' \
  | vscx rpc
```

Input is one JSON object per line. Output is one response envelope per line. Supported `target` values are `"current"`, `"all"`, a window ID string, or an object with `windowId` or `workspace`. A request can supply `code`, `input`, `jobId`, `query`, and `timeoutMs` as appropriate for its operation.

Prefer `rpc` for a long-lived machine protocol. Prefer direct commands for interactive work and isolated actions.

## Recover from connection problems

- `vscx: command not found`: Recreate the terminal after VSCX activates, or run `VSCX: Open connected terminal`.
- No registered windows: Confirm the VSCX extension is installed and active, then reload the VS Code window.
- A stale window: Reload or close the corresponding window. Records are removed automatically after their extension-host process exits.
- An ambiguous window: Select an exact `--window` or `--workspace` target.
- An untrusted workspace: Explain that VSCX is disabled for untrusted workspaces. The user must decide whether to trust it.
- A timeout: Prefer a smaller operation. Increase `--timeout` only when the work is expected and cooperative.
- A remote workspace warning: Read [architecture.md](architecture.md) before assuming where the extension host or filesystem operation runs.
