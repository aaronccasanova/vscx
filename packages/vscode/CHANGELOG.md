# VSCX

## 0.2.0

### Minor Changes

- 21575c9: Keep the bundled CLI available in restored terminals and discover fresh authenticated connections after reloads and restarts. Select the owning window through bounded live terminal process probes, ignore stale injected connection values, and require explicit selection when ownership cannot be established. Retain confirmed PIDs from partial reports and use desktop process ancestry to keep unrelated unresolved windows from blocking a known owner, while preserving the guard against a closer nested owner. Persist only stable CLI and runtime paths, with no connection credentials in terminal environments.
  
  `resolveBridgeTargets()` now returns a promise. Core consumers must await its result. Doctor now reports actual window resolution and connection health.

### Patch Changes

- Updated dependencies [21575c9]
  - @vscx/core@0.2.0
  - @vscx/cli@0.2.0

## 0.1.0

### Minor Changes

- 55e2e80: Publish the initial VSCX pre-release with the core library, agent-friendly CLI, and VS Code extension distributed through their native ecosystems.

### Patch Changes

- Updated dependencies [55e2e80]
  - @vscx/core@0.1.0
  - @vscx/cli@0.1.0

## 0.0.1

### Patch changes

- Add the initial authenticated VS Code bridge, terminal integration, status commands, bundled CLI, and documented API evaluator.
