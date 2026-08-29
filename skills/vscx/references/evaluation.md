# VSCX evaluation reference

Use `vscx eval` to run JavaScript with the documented VS Code API from the selected extension host. Evaluation is arbitrary extension-host code. Keep programs narrow and make their results observable.

## Inspect live state

Gather editor and workspace state:

```sh
vscx eval --json --code '
return {
  activeEditor: vscode.window.activeTextEditor?.document.uri.toString() ?? null,
  terminals: vscode.window.terminals.map((terminal) => terminal.name),
  visibleEditors: vscode.window.visibleTextEditors.map((editor) => ({
    languageId: editor.document.languageId,
    uri: editor.document.uri.toString(),
  })),
  workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => ({
    name: folder.name,
    uri: folder.uri.toString(),
  })) ?? [],
};
'
```

Summarize diagnostics without returning large or prototype-heavy objects:

```sh
vscx eval --json --code '
return vscode.languages.getDiagnostics().map(([uri, diagnostics]) => ({
  errors: diagnostics.filter(
    (diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error,
  ).length,
  total: diagnostics.length,
  uri: uri.toString(),
}));
'
```

Use `vscx api --commands --json` to discover command IDs before invoking them. Commands can change editor, workspace, extension, process, or external state, so understand the selected command's behavior first.

## Choose a code form

Evaluation source can be:

- An async function body, such as `return vscode.version`.
- An expression, such as `vscode.version`.
- A callback, such as `async ({ vscode, input, signal, helpers }) => value`.

All forms can access `vscode`, `bridge`, `input`, `signal`, `AbortSignal`, and `helpers`. `helpers` provides `assertNotAborted()`, `sleep()`, and `toJSON()`.

Use `--code` for a short expression. Use stdin or `--file` for a larger program:

```sh
vscx eval --input '{"languageId":"typescript"}' --json <<'JS'
const matchingDocuments = vscode.workspace.textDocuments
  .filter((document) => document.languageId === input.languageId)
  .map((document) => ({
    dirty: document.isDirty,
    lineCount: document.lineCount,
    uri: document.uri.toString(),
  }));

return matchingDocuments;
JS
```

Pass dynamic data through `--input` instead of interpolating it into JavaScript or shell source. Input must be JSON.

## Return useful JSON

VSCX serializes results into bounded JSON. It recognizes common VS Code values such as `Uri`, `Position`, `Range`, `Location`, and `WorkspaceEdit`. Other class instances may become an `unsupported-prototype` marker.

Map API results into small plain objects containing only fields needed for the task. Convert enum values into meaningful names when practical. Avoid returning complete documents, extension objects, diagnostics, symbols, or command catalogs when counts and selected fields answer the question.

Large strings, deep values, cycles, byte arrays, errors, unsupported prototypes, and non-JSON primitives receive tagged representations. Treat those tags as data, not as failures, unless a missing field prevents the task.

## Make observable changes

Identify the exact target and prefer documented, purpose-built VS Code APIs over generic command execution. For text changes, construct a `WorkspaceEdit` and call `vscode.workspace.applyEdit()`.

Return a concise receipt with the affected URI, operation count, and API result. Re-read affected state in a separate evaluation when the operation's result is not otherwise observable.

Use the documented `vscode` API instead of extension internals or undocumented members. Never print, return, log, or persist `process.env.VSCX_TOKEN`.

## Handle cancellation and timeouts

The default request timeout is 30 seconds. `--timeout` can set 1-300000 milliseconds.

Timeouts and Ctrl-C abort the supplied `signal`, but JavaScript already running synchronously on the extension-host thread cannot be forcibly stopped. For loops or staged async work, call `helpers.assertNotAborted()` and pass `signal` to APIs that accept it. Use `helpers.sleep()` instead of an unmanaged timer.

Do not start a listener, watcher, timer, or other long-lived resource in an ordinary evaluation. Register it as a named job and read [jobs.md](jobs.md).
