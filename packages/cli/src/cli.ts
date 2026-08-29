#!/usr/bin/env node

import { runCli } from "./run-cli.js";

async function main(): Promise<void> {
  const abortController = new AbortController();

  process.once("SIGINT", () => abortController.abort());

  const exitCode = await runCli({
    args: process.argv.slice(2),
    environment: process.env,
    signal: abortController.signal,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
  });

  process.exitCode = exitCode;
}

void main();
