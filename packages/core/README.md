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
