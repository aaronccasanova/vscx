# Changesets

Add a changeset to every pull request that changes a shipped package or the VS Code extension:

```sh
pnpm changeset
```

Select every affected package, choose the appropriate SemVer bump, and write a user-facing summary. Select `vscode-vscx` for the VS Code extension. Its package manifest sets `"private": true` only to prevent npm publication, so Changesets still versions it and updates its changelog before a separate script publishes its VSIX to the Marketplace.

Here, `public` and `private` refer only to package registry settings. They do not describe repository visibility, source availability, licensing, intended audience, or confidentiality.

VSCX releases core, CLI, and the extension as a fixed version group. A change to any member advances all three so the standalone packages and bundled extension report one coherent VSCX version.

Changes that do not affect a shipped deliverable do not need a changeset.
