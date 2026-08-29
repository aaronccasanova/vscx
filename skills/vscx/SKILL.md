---
name: vscx
description: Inspect, automate, and extend a running VS Code window through the VSCX CLI and documented VS Code API. Use when an agent needs live editor, workspace, diagnostics, terminal, command, or extension-host context from VS Code, or when it needs to build an integration with @vscx/core.
---

# VSCX

Use VSCX as a local control plane for a running VS Code window. Prefer the CLI for agent-driven work. It discovers an authenticated bridge started by the VSCX extension and evaluates JavaScript against the documented `vscode` API in that window.

## Route the task

- Read [references/cli.md](references/cli.md) before selecting a window or invoking the CLI.
- Read [references/evaluation.md](references/evaluation.md) before using `vscx eval`, especially for workspace changes, commands, terminals, or other side effects.
- Read [references/jobs.md](references/jobs.md) before creating listeners or other resources that outlive one evaluation.
- Read [references/architecture.md](references/architecture.md) when diagnosing activation, terminal environment, discovery, authentication, remote workspaces, serialization, or package boundaries.

Read only the references needed for the current task.

## Follow the operating workflow

1. Run `vscx doctor`, then `vscx info`, before relying on the bridge.
2. Use the terminal's injected connection when it is healthy. If selection is ambiguous, run `vscx windows` and choose an exact `--window` or `--workspace` target. Do not guess.
3. Inspect relevant API declarations with `vscx api --find <name>` before using an unfamiliar VS Code API.
4. Use the smallest evaluation that retrieves or changes the relevant state.
5. For complex evaluations, pass code through stdin or `--file`, pass data through `--input`, and request `--json` when another program or agent will consume the result.
6. Confirm the returned `ok`, `windowId`, and value. Re-read affected state when the result depends on a change.
7. List and dispose named jobs when persistent resources are no longer needed.

VSCX evaluation runs arbitrary code in the extension host. Use the documented `vscode` API instead of extension-host internals, and never print, return, log, or persist `VSCX_TOKEN`.
