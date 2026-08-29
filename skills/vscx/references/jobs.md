# VSCX jobs reference

Use a named job for listeners, watchers, timers, and other resources that must survive after one evaluation returns. Jobs belong to one VS Code window and one VSCX extension-host lifetime.

## Create a managed job

List existing jobs before choosing a stable ID:

```sh
vscx jobs list --json
```

Create the job and register every resource that needs cleanup:

```sh
vscx eval --json <<'JS'
const job = bridge.jobs.create({
  id: "active-editor-watch",
  label: "Log active editor changes",
});

job.add(
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    bridge.log("active editor changed", {
      uri: editor?.document.uri.toString() ?? null,
    });
  }),
);

return job.describe();
JS
```

`bridge.log()` writes to the VSCX output channel in VS Code. It is not a stream back to the CLI. Return the initial job description so the caller can confirm the ID and resource count.

`job.add()` accepts a VS Code disposable or an async cleanup function. Add resources immediately after creation so later disposal is complete. Use `job.signal` inside custom asynchronous loops and stop promptly when it is aborted.

## Inspect and clean up

```sh
vscx jobs list --json
vscx jobs get active-editor-watch --json
vscx jobs cancel active-editor-watch --json
vscx jobs dispose active-editor-watch --json
```

`cancel` aborts the job signal and records the cancelled state. It does not dispose registered resources. Use `dispose` to abort the signal, dispose resources in reverse registration order, and remove the job from the manager.

Prefer `dispose` when the work is finished. Confirm with `vscx jobs list --json`. Reloading, closing the window, disabling the extension, or stopping its extension host also disposes all jobs.

Do not create persistent jobs during open-ended exploration unless the user approves the ongoing behavior. State what the job will observe, how long it will remain active, where its output appears, and how it will be disposed.
