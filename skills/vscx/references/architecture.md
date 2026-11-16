# VSCX architecture reference

VSCX connects a local CLI to the documented API of a running VS Code extension host:

```text
Integrated terminal or agent
  -> vscx CLI
  -> @vscx/core discovery and authenticated RPC
  -> per-window loopback HTTP endpoint
  -> VSCX extension host
  -> documented vscode API
```

## Keep package responsibilities separate

- `@vscx/core` owns protocol types, transport, discovery, the runtime registry, bounded serialization, errors, and job lifecycle. It has no VS Code dependency.
- `@vscx/cli` wraps core discovery and RPC as `runCli()` and the `vscx` executable. It does not import or emulate VS Code.
- The `vscode-vscx` extension workspace owns activation, the authenticated per-window server, terminal environment injection, documented VS Code API evaluation, declarations, status UI, and the bundled CLI.

The protocol is versioned inside core. Extract it into a separate package only when an independent consumer needs that boundary.

## Understand activation and terminals

The extension starts its bridge after VS Code startup. Its persistent environment collection contains only `VSCX_RUNTIME_DIR` and a stable directory prepended to `PATH`. The CLI bundle and launchers are atomically refreshed under the extension's global storage `cli/` directory. Complete copied files remain callable before activation, across restarts, and after the old versioned extension directory is removed. Shutdown does not clear the contribution.

Endpoints, bearer tokens, and window IDs remain per activation and are read from the user-only registry. The CLI does not use old implicit `VSCX_ENDPOINT`, `VSCX_TOKEN`, or `VSCX_WINDOW_ID` values to choose a window. Explicit `--endpoint` remains available and requires `VSCX_TOKEN`.

For automatic selection on macOS and Linux, the CLI obtains its local process ancestry and probes all registered local windows in parallel with bounded timeouts. The authenticated `terminals.processes` operation reports active terminal PIDs and whether the report is complete. The nearest matching terminal ancestor wins, including confirmed process IDs from partial reports. Exited terminals and locally identified extension pseudoterminals are excluded. Some task or cross-host terminals never expose a process ID, so their reports can remain partial. An incomplete or unavailable desktop window only blocks a known owner when its process ancestry could intersect the caller below the matched terminal, or when that ancestry is unavailable or truncated. Unrelated busy or older windows therefore do not block a healthy owner. A registered potentially closer nested owner still prevents automatic selection. Remote window PIDs are excluded because they belong to a different process namespace.

Only registered windows participate. Before automatic selection in a nested editor instance, wait until it appears in `vscx windows`. An unregistered inner instance cannot block a match to an outer terminal.

If ownership cannot be established, integrated terminals require an explicit selector. This includes Windows, remote terminals, an older host lacking the ownership operation, or a window still starting. External shells retain unique workspace and sole-window fallbacks. Multiple matches always require selection.

VS Code cannot replace an already running process's environment. A terminal predating the first updated activation may need one recreation to receive the stable CLI path. `VSCX: Open connected terminal` is an optional convenience. After migration, restored terminals retain CLI access and discover the current bridge after it activates.

Development builds sharing extension storage share the last copied CLI. Use separate VS Code user data directories for incompatible versions. Atomic replacement guarantees complete files, not compatibility between separately running development builds.

## Understand the trust boundary

Each window listens only on `127.0.0.1` with a random port and a random bearer token. Registry directories and records are written with user-only permissions. The CLI redacts tokens from diagnostic connection output.

This prevents accidental unauthenticated access. It does not sandbox evaluation. Any client with the token can run arbitrary JavaScript in the extension host and invoke APIs available to VSCX. Keep the token secret and treat workspace trust metadata as meaningful context.

VSCX does not activate in an untrusted workspace. Workspace trust is a user-controlled prerequisite for starting the bridge.

Extension-host error stacks are omitted by default because they can contain local paths. The user can opt into them with `vscx.includeRemoteStacks` for local diagnostics.

Do not add an MCP server to reach the bridge. The CLI is the agent-facing protocol client and uses authenticated registry-based discovery.

## Account for topology and versions

The prototype supports desktop VS Code with VSCX in the local UI extension host. A workspace may still have a `remoteAuthority`. Do not assume extension-host code and workspace resources share a filesystem without checking metadata and URI schemes.

`vscx info --json` reports the window ID, VS Code version, extension version, workspace trust, remote authority, workspace folders, endpoint, and registry location. `vscx api` searches the declaration baseline bundled into the extension. Runtime availability can differ with the installed VS Code version, host topology, workspace trust, and installed extensions.

## Understand serialization and lifecycle

Requests and responses use versioned JSON envelopes. Serialization is bounded by depth, entry count, and string length. Common VS Code values receive tagged JSON forms. Map other API objects into plain data before returning them.

Ordinary evaluations end with their request. Long-lived resources must be attached to a named job. Jobs are in memory, scoped to one window, and disposed when the extension host shuts down. Request cancellation is cooperative and cannot interrupt synchronous JavaScript already occupying the extension-host thread.
