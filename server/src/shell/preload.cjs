// SPDX-License-Identifier: MIT
// The renderer's one door into the desktop shell: `window.appShell`, read only by the
// app's `src/services/native.js` (the family rule that replaced "no window.<app> global").
//
// Sandboxed preload, so CommonJS and only `electron`'s renderer modules. Exposes:
//   appShell.invoke(command, args) → Promise — the commands main.js handles (COMMANDS
//     there; this list must match it);
//   appShell.on(event, fn) → unsubscribe — the shell's pushes, `tray:*` only;
//   appShell.platform — "win32" | "darwin" | "linux".

const { contextBridge, ipcRenderer } = require("electron");

const COMMANDS = new Set([
  "pickDirectory",
  "pickFile",
  "saveFile",
  "storageGetRoot",
  "storageRelocate",
  "setKeepRunning",
  "setTrayLabels",
  "openExternal",
  "openPath",
]);

contextBridge.exposeInMainWorld("appShell", {
  invoke(command, args) {
    if (!COMMANDS.has(command)) return Promise.reject(new Error(`unknown shell command: ${command}`));
    return ipcRenderer.invoke(`shell:${command}`, args ?? {});
  },
  on(event, fn) {
    if (!String(event).startsWith("tray:")) throw new Error(`not a shell event: ${event}`);
    const listener = (_e, ...args) => fn(...args);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
  platform: process.platform,
});
