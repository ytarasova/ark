#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { App } from "./App.js";

process.on("unhandledRejection", () => {});

// Use Ink's built-in fullscreen support — no manual escape codes
const { waitUntilExit } = render(<App />, {
  patchConsole: false,
  exitOnCtrlC: true,
});

await waitUntilExit();
