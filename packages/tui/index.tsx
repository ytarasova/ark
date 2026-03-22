#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { App } from "./App.js";

// Global error handling
process.on("unhandledRejection", (err: any) => {
  // Swallow gracefully - errors are shown in the TUI status bar
});

render(<App />);
