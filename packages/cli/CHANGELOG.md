# @vscx/cli

## 0.2.0

### Minor Changes

- a8a28bd: Add explicit local process targeting through --process, core selector.processId, and RPC target.processId, with strict ownership checks and no workspace fallback. Report resolved registry paths and existence in doctor and discovery errors. Recover the macOS per-user runtime registry when TMPDIR is missing while preserving explicit overrides.
- 21575c9: Keep the bundled CLI available in restored terminals and discover fresh authenticated connections after reloads and restarts. Select the owning window through bounded live terminal process probes, ignore stale injected connection values, and require explicit selection when ownership cannot be established. Retain confirmed PIDs from partial reports and use desktop process ancestry to keep unrelated unresolved windows from blocking a known owner, while preserving the guard against a closer nested owner. Persist only stable CLI and runtime paths, with no connection credentials in terminal environments.
  
  `resolveBridgeTargets()` now returns a promise. Core consumers must await its result. Doctor now reports actual window resolution and connection health.

### Patch Changes

- Updated dependencies [a8a28bd]
- Updated dependencies [21575c9]
  - @vscx/core@0.2.0

## 0.1.0

### Minor Changes

- 55e2e80: Publish the initial VSCX pre-release with the core library, agent-friendly CLI, and VS Code extension distributed through their native ecosystems.

### Patch Changes

- Updated dependencies [55e2e80]
  - @vscx/core@0.1.0

## 0.0.1

### Patch changes

- Add the initial JSON-first CLI and reusable `runCli()` entrypoint for controlling VSCX-enabled VS Code windows.
