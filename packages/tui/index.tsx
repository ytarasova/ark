#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { App } from "./App.js";

process.on("unhandledRejection", () => {});

// Enter fullscreen alt buffer
process.stdout.write("\x1b[?1049h\x1b[?25l");
process.on("exit", () => {
  process.stdout.write("\x1b[?1049l\x1b[?25h");
});

const { unmount, waitUntilExit } = render(<App />, { patchConsole: false });
await waitUntilExit();
