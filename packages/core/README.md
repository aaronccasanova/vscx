# @vscx/core

`@vscx/core` is the host-neutral control-plane library for VSCX. It provides the versioned protocol, authenticated loopback transport, endpoint discovery, user-only runtime registry, bounded serialization, structured errors, and job lifecycle primitives used by the CLI and VS Code extension.

## Install

```sh
pnpm add @vscx/core
```

Node.js 22 or newer is required.

## Package boundary

This package has no dependency on the `vscode` module. A host integration starts a bridge server, publishes a runtime registry entry, and implements request handling for its environment. Agent-driven clients should normally use `@vscx/cli` instead of assembling protocol requests directly.

See the [VSCX repository](https://github.com/aaronccasanova/vscx) for architecture, security boundaries, examples, and release notes.

## Resolve a bridge

`resolveBridgeTargets()` is asynchronous because automatic terminal ownership requires live authenticated probes:

```ts
import { resolveBridgeTargets } from "@vscx/core";

const bridgeTargets = await resolveBridgeTargets();
```

To resolve the owner of another local process:

```ts
const bridgeTargets = await resolveBridgeTargets({ selector: { processId: 12345 } });
```

`processId` must be a positive safe integer and cannot be combined with another selector. It reads the requested process's ancestry on macOS or Linux, probes registered local windows, and returns the nearest terminal owner with `source: "terminal"`. It never falls back to the caller's environment, current workspace, or the only window. Explicit process selection requires complete ancestry. It ignores the optional `ancestorProcessIds` override, which only supplies ancestry for automatic caller discovery. Remote terminal PIDs are excluded.

Failures use `invalid-process`, `incompatible-targets`, `terminal-owner-not-found`, `terminal-ownership-unavailable`, or `ambiguous-window`. Ownership error `details` include the requested `processId`, resolved `runtimeDirectory`, and `runtimeDirectoryExists`. A PID can be recycled and is not identity across process revival. Callers must maintain their own session checks when routing consequential operations.

Window, workspace, all-window, and endpoint selectors bypass ownership inference. Host adapters can implement `terminals.processes` by returning `{ complete: boolean, processIds: number[] }`. Return `complete: false` when active native terminal process IDs are still pending. Include all confirmed process IDs even in a partial report. The resolver can use them when desktop process ancestry rules out a closer owner among unresolved windows. Unknown or truncated host ancestry remains unresolved, and a potentially closer nested owner requires explicit selection.
