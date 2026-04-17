/**
 * Electron preload script - exposes minimal API to the renderer.
 * Context isolation is enabled, so this is the only bridge.
 *
 * Tags <body> with platform classes so platform-specific CSS (e.g. macOS
 * traffic-light spacing in the sidebar header) can target the right OS.
 */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("arkDesktop", {
  platform: process.platform,
  isElectron: true,
});

// Tag the document so CSS can target Electron-on-macOS specifically.
window.addEventListener("DOMContentLoaded", () => {
  document.body.classList.add("is-electron");
  if (process.platform === "darwin") {
    document.body.classList.add("is-macos");
  }
});
