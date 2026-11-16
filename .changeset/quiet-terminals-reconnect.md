---
"@vscx/core": minor
"@vscx/cli": minor
"vscode-vscx": minor
---

Keep the bundled CLI available in restored terminals and discover fresh authenticated connections after reloads and restarts. Select the owning window through bounded live terminal process probes, ignore stale injected connection values, and require explicit selection when ownership cannot be established. Retain confirmed PIDs from partial reports and use desktop process ancestry to keep unrelated unresolved windows from blocking a known owner, while preserving the guard against a closer nested owner. Persist only stable CLI and runtime paths, with no connection credentials in terminal environments.

`resolveBridgeTargets()` now returns a promise. Core consumers must await its result. Doctor now reports actual window resolution and connection health.
