/**
 * Electron preload script - exposes minimal API to the renderer.
 * Context isolation is enabled, so this is the only bridge.
 */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("arkDesktop", {
  platform: process.platform,
  isElectron: true,
});
