#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { currentPlatform } from "../lib/platform.mjs";

const require = createRequire(import.meta.url);

try {
  const platform = currentPlatform();
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  let manifestPath;
  try {
    manifestPath = require.resolve(`${platform.name}/package.json`);
  } catch {
    throw new Error(`Missing ${platform.name}@${version}. Reinstall with optional dependencies enabled: npm install -g @assistant-ui/tress@${version} --include=optional`);
  }
  const installed = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (installed.version !== version) {
    throw new Error(`Expected ${platform.name}@${version}, found ${installed.version}. Reinstall @assistant-ui/tress with optional dependencies enabled.`);
  }

  // Inherit the terminal, working directory, and environment without a shell.
  const child = spawn(join(dirname(manifestPath), "bin", "tress"), process.argv.slice(2), { stdio: "inherit" });
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
  child.once("error", (error) => {
    cleanup();
    console.error(`tress: Could not start the native client: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(`tress: ${error.message}`);
  process.exitCode = 1;
}
