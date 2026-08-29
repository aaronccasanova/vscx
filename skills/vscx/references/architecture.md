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
- The `vscx` extension owns activation, the authenticated per-window server, terminal environment injection, documented VS Code API evaluation, declarations, status UI, and the bundled CLI.

The protocol is versioned inside core. Extract it into a separate package only when an independent consumer needs that boundary.

## Understand activation and terminals

The extension starts its bridge after VS Code startup and contributes these values to terminals created afterward:

- `VSCX_ENDPOINT`
- `VSCX_TOKEN`
- `VSCX_WINDOW_ID`
- `VSCX_PROTOCOL_VERSION`
- `VSCX_RUNTIME_DIR`
- The bundled CLI directory prepended to `PATH`

VS Code cannot retroactively replace the environment of a shell process that is already running. Recreate a pre-existing terminal when `vscx` is missing. `VSCX: Open connected terminal` is an explicit way to create one with the current environment.

When environment values are unavailable, a callable CLI can discover per-window records from the user-only runtime registry. It removes records whose extension-host process has ended, selects a unique workspace or sole window, and refuses ambiguous matches.

## Understand the trust boundary

Each window listens only on `127.0.0.1` with a random port and a random bearer token. Registry directories and records are written with user-only permissions. The CLI redacts tokens from diagnostic connection output.

This prevents accidental unauthenticated access. It does not sandbox evaluation. Any client with the token can run arbitrary JavaScript in the extension host and invoke APIs available to VSCX. Keep the token secret and treat workspace trust metadata as meaningful context.

VSCX does not activate in an untrusted workspace. Workspace trust is a user-controlled prerequisite for starting the bridge.

Extension-host error stacks are omitted by default because they can contain local paths. The user can opt into them with `vscx.includeRemoteStacks` for local diagnostics.

Do not add an MCP server to reach the bridge. The CLI is the agent-facing protocol client and works in terminals where an agent can use environment-based or registry-based discovery.

## Account for topology and versions

The prototype supports desktop VS Code with VSCX in the local UI extension host. A workspace may still have a `remoteAuthority`. Do not assume extension-host code and workspace resources share a filesystem without checking metadata and URI schemes.

`vscx info --json` reports the window ID, VS Code version, extension version, workspace trust, remote authority, workspace folders, endpoint, and registry location. `vscx api` searches the declaration baseline bundled into the extension. Runtime availability can differ with the installed VS Code version, host topology, workspace trust, and installed extensions.

## Understand serialization and lifecycle

Requests and responses use versioned JSON envelopes. Serialization is bounded by depth, entry count, and string length. Common VS Code values receive tagged JSON forms. Map other API objects into plain data before returning them.

Ordinary evaluations end with their request. Long-lived resources must be attached to a named job. Jobs are in memory, scoped to one window, and disposed when the extension host shuts down. Request cancellation is cooperative and cannot interrupt synchronous JavaScript already occupying the extension-host thread.
