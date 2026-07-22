/* Bridge between the OS-integrated main process and the sandboxed web app.
   Exposed as window.pdflover; the web app treats it as optional. */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pdflover", {
  /** PDF the OS asked us to open at launch: {name, bytes} or null. */
  getInitialFile: () => ipcRenderer.invoke("get-initial-file"),
  /** PDFs opened (double-click / "Open with") while the app is running. */
  onOpenFile: (cb) => ipcRenderer.on("open-file", (_e, file) => cb(file)),
  /** Native menu actions: "new" | "open" | "export" | "print" | "find" |
      "undo" | "redo" | "convert" | "ocr". */
  onMenu: (cb) => ipcRenderer.on("menu", (_e, action) => cb(action)),
});
