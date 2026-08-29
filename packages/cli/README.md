# @vscx/cli

`@vscx/cli` provides the `vscx` command and a reusable `runCli()` entrypoint for controlling a VSCX-enabled VS Code window.

## Install

```sh
pnpm add --global @vscx/cli
```

The VS Code extension also bundles this CLI and adds it to new integrated terminals automatically. Node.js 22 or newer is required.

## Start safely

```sh
vscx doctor
vscx info
vscx windows
vscx eval --code 'return vscode.version'
```

The CLI discovers the authenticated loopback bridge created by the VSCX extension. Evaluation executes JavaScript in the extension host and is not a security sandbox. Keep bridge credentials secret and obtain authorization before changing editor, workspace, terminal, or external state.

See the [VSCX repository](https://github.com/aaronccasanova/vscx) for the complete CLI reference and agent skill.
