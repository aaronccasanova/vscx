---
"@vscx/core": minor
"@vscx/cli": minor
"vscode-vscx": minor
---

Add explicit local process targeting through --process, core selector.processId, and RPC target.processId, with strict ownership checks and no workspace fallback. Report resolved registry paths and existence in doctor and discovery errors. Recover the macOS per-user runtime registry when TMPDIR is missing while preserving explicit overrides.
