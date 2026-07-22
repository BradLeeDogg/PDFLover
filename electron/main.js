/* PDFLover desktop shell. The whole app is the static web UI in the repo
   root; this hosts it in a native window, served from an in-process HTTP
   server bound to localhost so web workers and wasm (pdf.js, Tesseract OCR)
   work the same as in a browser — file:// blocks them.

   OS integration: .pdf file association (open at launch, "Open with", and
   second-instance opens routed to the running window), a native menu, and
   window-size memory. */
"use strict";

const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

const APP_ROOT = path.join(__dirname, "..");
const STATE_FILE = () => path.join(app.getPath("userData"), "window-state.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
  ".pdf": "application/pdf",
};

let mainWindow = null;
let pendingFile = null;   // file to hand to the renderer once it asks

// ---- file-association helpers ----

function pdfArgIn(argv) {
  // Skip the executable/script args; accept the first existing .pdf path.
  return argv.slice(1).find((a) => /\.pdf$/i.test(a) && fs.existsSync(a)) || null;
}

function payloadFor(filePath) {
  try {
    return { name: path.basename(filePath), bytes: fs.readFileSync(filePath) };
  } catch (e) {
    console.error("Could not read", filePath, e.message);
    return null;
  }
}

function openInWindow(filePath) {
  const payload = payloadFor(filePath);
  if (!payload) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send("open-file", payload);
  } else {
    pendingFile = payload;
  }
}

// Single instance: a second launch (e.g. double-clicking another PDF) hands
// its file to the running window instead of opening a new one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const f = pdfArgIn(argv);
    if (f) openInWindow(f);
    else if (mainWindow) { mainWindow.restore(); mainWindow.focus(); }
  });
}

// macOS delivers opened files via this event (possibly before ready).
app.on("open-file", (e, filePath) => {
  e.preventDefault();
  openInWindow(filePath);
});

// Windows/Linux: the file arrives as a command-line argument.
{
  const f = pdfArgIn(process.argv);
  if (f) pendingFile = payloadFor(f);
}

ipcMain.handle("get-initial-file", () => {
  const f = pendingFile;
  pendingFile = null;
  return f;
});

// ---- static server ----

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const file = path.normalize(path.join(APP_ROOT, rel));
      if (!file.startsWith(APP_ROOT)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

// ---- window state ----

function readWindowState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")); } catch (e) { return {}; }
}

function saveWindowState(win) {
  try {
    if (!win.isMinimized() && !win.isMaximized()) {
      fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...win.getBounds(), maximized: false }));
    } else {
      const prev = readWindowState();
      fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...prev, maximized: win.isMaximized() }));
    }
  } catch (e) { /* best effort */ }
}

// ---- menu ----

function sendMenu(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("menu", action);
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "&File",
      submenu: [
        { label: "New PDF", accelerator: "CmdOrCtrl+N", click: () => sendMenu("new") },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => sendMenu("open") },
        { type: "separator" },
        { label: "Export PDF", accelerator: "CmdOrCtrl+S", click: () => sendMenu("export") },
        { label: "Print…", accelerator: "CmdOrCtrl+P", click: () => sendMenu("print") },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "&Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => sendMenu("undo") },
        { label: "Redo", accelerator: "CmdOrCtrl+Y", click: () => sendMenu("redo") },
        { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" },
        { type: "separator" },
        { label: "Find…", accelerator: "CmdOrCtrl+F", click: () => sendMenu("find") },
      ],
    },
    {
      label: "&Tools",
      submenu: [
        { label: "Convert…", click: () => sendMenu("convert") },
        { label: "OCR Scanned Pages", click: () => sendMenu("ocr") },
      ],
    },
    {
      label: "&View",
      submenu: [
        { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- window ----

async function createWindow() {
  const port = await startServer();
  const saved = readWindowState();
  mainWindow = new BrowserWindow({
    width: saved.width || 1400,
    height: saved.height || 900,
    x: saved.x,
    y: saved.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#16181d",
    title: "PDFLover",
    icon: path.join(APP_ROOT, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (saved.maximized) mainWindow.maximize();

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  mainWindow.on("close", () => saveWindowState(mainWindow));
  mainWindow.on("closed", () => { mainWindow = null; });

  // Any external link opens in the system browser, not in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith("http://127.0.0.1")) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
