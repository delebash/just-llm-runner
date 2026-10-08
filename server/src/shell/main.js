// SPDX-License-Identifier: MIT
// The family's desktop shell — the Electron main process every app runs, with a short
// per-app config (the Electron move's plan §0 and §4 "The shared Electron main module";
// it replaces the three Rust shells, which were kept in lock-step by hand).
//
// Main owns the window, the tray, the dialogs, the data folder and the server's life. No
// business logic lives here — the rule that kept logic out of Rust carries over.
//
//   - The data root is resolved before anything opens (dataRoot.js), and Chromium's own
//     files and the window position live under it — nothing lands where the user didn't
//     choose (the 2026-08-14 ruling Tauri broke).
//   - The server is the app's server module in a `utilityProcess`: it ends when main
//     dies, even on a hard kill (plan §1.1); it says when it listens; a stop asks it over
//     `parentPort`, waits, then kills — graceful for all three apps (JustWrite and docgen
//     only hard-killed under Tauri).
//   - The window loads the built UI from `app://<id>/` (ruling 3) — it opens even when
//     the server is down and shows the kit's connection-error screen; in development it
//     loads the Vite dev server instead.
//   - The renderer reaches main through ONE preload object, `window.appShell`, read only
//     by the app's `src/services/native.js`.
//   - Electron's security checklist (electronjs.org/docs/latest/tutorial/security), checked
//     2026-10-08: context isolation, the sandbox and no Node in the renderer; a written CSP on
//     app://; navigation, new windows and <webview> refused; permissions granted only to the
//     app's own page and only from an allow-list; every IPC call checked against the sender's
//     origin; one copy of the app at a time. The fuses are set per app at packaging
//     (package.json `build.electronFuses`).

import fs from "node:fs";
import net0 from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  shell,
  Tray,
  utilityProcess,
} from "electron";
import { checkOutput, run } from "../platform/procs.js";
import { CHROME_DIR, relocate, resolveDataRoot, storageInfo, sweepOldChromeDir } from "./dataRoot.js";

/** The renderer's commands — the preload exposes exactly these (`appShell.invoke`). */
export const COMMANDS = [
  "pickDirectory",
  "pickFile",
  "saveFile",
  "storageGetRoot",
  "storageRelocate",
  "setKeepRunning",
  "setTrayLabels",
  "openExternal",
  "openPath",
];

const DEFAULT_TRAY_LABELS = {
  show: "📺 Show window",
  hide: "🔵 Hide window",
  serverStart: "▶️ Start server",
  serverStop: "⏹ Stop server",
  serverRestart: "🔄 Restart server",
  openSettings: "⚙️ Open settings",
  copyUrl: "📋 Copy server URL",
  openLogs: "📜 Open log file",
  about: null, // "ℹ️ About <productName>"
  quit: null, // "🚪 Quit <productName>"
};

const STOP_WAIT_MS = 8000; // the server's own 3 s grace plus engine shutdown

/**
 * Run the desktop app. `config`:
 *   id            short id — the app:// host, tray id, window-state key (e.g. "justvoice")
 *   appName       the data folder's name under the OS fallback (`%LOCALAPPDATA%\<App>\<App>`)
 *   productName   shown in the tray and dialogs
 *   port          the app's registered server port (the family port registry)
 *   serverEntry   absolute path of the app's server module (runs `serve`)
 *   dataDirEnv    the app's data-dir variable (e.g. "JUSTVOICE_DATA_DIR")
 *   repoRoot      the checkout root (development: the data root is <repoRoot>/data)
 *   distDir       the built UI (vite build output)
 *   devUrl        the Vite dev server URL used when not packaged and DEV_URL is set
 *   window        {width, height, minWidth, minHeight, backgroundColor, title}
 *   icon          the window icon path
 *   trayIcon      the tray icon path (default: icon)
 *   logFile       the server's live log, relative to the data root (tray "Open log file")
 *   closeHoldMs   wait before closing so a `pagehide` save lands (JustWrite: 400)
 *   csp           the Content-Security-Policy for app:// pages (a default is used)
 *   cspAdd        sources added to the default's directives, e.g. {"img-src": ["https:"]}
 *   trayExtras    extra tray items [{id, label, event}] sent to the renderer as `tray:<event>`
 *   permissions   web permissions the app's page may have beyond the clipboard (e.g. "media"
 *                 for the microphone); every other request is denied
 */
export function runDesktopApp(config) {
  const state = {
    root: null,
    server: null, // the utilityProcess
    port: config.port,
    keepRunning: false,
    quitting: false,
    win: null,
    tray: null,
    trayLabels: { ...DEFAULT_TRAY_LABELS },
  };

  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);

  // ── the data root, before Chromium writes anything ─────────────────────────
  state.root = resolveDataRoot({
    appName: config.appName,
    dataDirEnv: config.dataDirEnv,
    repoRoot: config.repoRoot,
    packaged: app.isPackaged,
  });
  sweepOldChromeDir(state.root);
  const chromeDir = path.join(state.root, CHROME_DIR);
  fs.mkdirSync(chromeDir, { recursive: true });
  for (const k of ["userData", "sessionData", "crashDumps", "logs"]) app.setPath(k, path.join(chromeDir, k === "userData" ? "" : k));
  if (process.platform === "win32") app.setAppUserModelId(`com.${config.id}.app`);

  // One copy per data folder (the lock lives in userData, set just above): a second launch
  // would evict the first copy's server from the port. It hands over and quits; the first
  // shows its window (the "second-instance" handler at boot).
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }

  // The page the window loads, and so the one origin trusted with permissions and IPC.
  const devUrl = !app.isPackaged && process.env.DEV_URL ? process.env.DEV_URL : null;
  const home = devUrl || `app://${config.id}/index.html`;
  const homeOrigin = new URL(home).origin;
  const fromHome = (url) => {
    try {
      return new URL(url).origin === homeOrigin;
    } catch {
      return false;
    }
  };

  // ── the server ─────────────────────────────────────────────────────────────
  const serverUrl = () => `http://127.0.0.1:${state.port}`;

  async function evictStaleListener(port) {
    // A server left on the port by a crashed run would answer this app's UI with stale
    // code; the Rust shells evicted it the same way (netstat+taskkill / lsof+kill).
    if (!(await portInUse(port))) return;
    console.warn(`[shell] port ${port} already in use — evicting the stale listener`);
    try {
      if (process.platform === "win32") {
        const out = await checkOutput(["netstat", "-ano"]);
        const pids = new Set();
        for (const line of out.split(/\r?\n/)) {
          const cols = line.trim().split(/\s+/);
          if (cols.length < 5 || cols[0] !== "TCP" || !cols.includes("LISTENING")) continue;
          if (!cols[1].endsWith(`:${port}`)) continue;
          const pid = Number(cols[cols.length - 1]);
          if (pid) pids.add(pid);
        }
        for (const pid of pids) await run(["taskkill", "/F", "/PID", String(pid)]);
      } else {
        const out = await run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
        for (const pid of out.stdout.split(/\s+/).filter(Boolean)) await run(["kill", "-9", pid]);
      }
    } catch (e) {
      console.warn(`[shell] could not evict the stale listener: ${e.message}`);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && (await portInUse(port))) await new Promise((r) => setTimeout(r, 150));
  }

  async function startServer() {
    if (state.server) return;
    if (process.env[`${config.id.toUpperCase().replace(/-/g, "_")}_DEV_NO_SERVER`]) return; // run it yourself
    await evictStaleListener(config.port);
    const child = utilityProcess.fork(config.serverEntry, ["serve", "--port", String(config.port)], {
      env: { ...process.env, [config.dataDirEnv]: state.root },
      serviceName: `${config.productName} server`,
      stdio: "pipe",
    });
    state.server = child;
    child.stdout?.on("data", (d) => process.stdout.write(d));
    child.stderr?.on("data", (d) => process.stderr.write(d));
    child.on("message", (m) => {
      if (m?.type === "ready") {
        state.port = m.port;
        console.log(`[shell] server listening on ${m.port}`);
      }
    });
    child.on("exit", (code) => {
      if (state.server === child) state.server = null;
      if (!state.quitting) console.warn(`[shell] server exited (${code})`);
    });
  }

  function stopServer() {
    const child = state.server;
    if (!child) return Promise.resolve();
    state.server = null;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      child.once("exit", finish);
      try {
        child.postMessage({ type: "stop" });
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        if (!done) {
          console.warn("[shell] server did not stop in time — killing it");
          child.kill();
          setTimeout(finish, 500);
        }
      }, STOP_WAIT_MS);
    });
  }

  // ── app:// — the built UI, with a written CSP ──────────────────────────────
  const cspDefault = [
    ["default-src", "'self'"],
    ["script-src", "'self'"],
    ["style-src", "'self' 'unsafe-inline'"],
    ["img-src", "'self' data: blob: http://127.0.0.1:* http://localhost:*"],
    ["media-src", "'self' data: blob: http://127.0.0.1:* http://localhost:*"],
    ["font-src", "'self' data:"],
    ["connect-src", "'self' http://127.0.0.1:* http://localhost:*"],
    ["worker-src", "'self' blob:"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
  ];
  const csp =
    config.csp ||
    cspDefault.map(([d, src]) => [d, src, ...((config.cspAdd || {})[d] || [])].join(" ")).join("; ");

  function serveApp(request) {
    const url = new URL(request.url);
    const dist = path.resolve(config.distDir);
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.resolve(dist, `.${rel}`);
    if (!file.startsWith(dist + path.sep) && file !== dist) return new Response("Not Found", { status: 404 });
    let target = file;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target = path.join(dist, "index.html");
    return net.fetch(pathToFileURL(target).toString()).then((r) => {
      const headers = new Headers(r.headers);
      if (target.endsWith(".html")) headers.set("Content-Security-Policy", csp);
      return new Response(r.body, { status: r.status, headers });
    });
  }

  // ── the window ─────────────────────────────────────────────────────────────
  const stateFile = path.join(chromeDir, "window-state.json");
  function loadWindowState() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const fits = screen
        .getAllDisplays()
        .some(
          (d) =>
            s.x >= d.workArea.x - 50 &&
            s.y >= d.workArea.y - 50 &&
            s.x + 100 <= d.workArea.x + d.workArea.width &&
            s.y + 100 <= d.workArea.y + d.workArea.height,
        );
      return fits ? s : { width: s.width, height: s.height, maximized: s.maximized };
    } catch {
      return null;
    }
  }
  function saveWindowState(win) {
    try {
      const b = win.getNormalBounds();
      fs.writeFileSync(stateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }));
    } catch {
      /* best effort */
    }
  }

  function createWindow() {
    const w = config.window || {};
    const saved = loadWindowState();
    const win = new BrowserWindow({
      title: w.title || config.productName,
      width: saved?.width || w.width || 1280,
      height: saved?.height || w.height || 800,
      x: saved?.x,
      y: saved?.y,
      minWidth: w.minWidth,
      minHeight: w.minHeight,
      backgroundColor: w.backgroundColor,
      icon: config.icon,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(import.meta.dirname, "preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    if (saved?.maximized) win.maximize();
    win.once("ready-to-show", () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      if (new URL(url).origin !== homeOrigin) {
        e.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url);
      }
    });
    let holding = false;
    win.on("close", (e) => {
      saveWindowState(win);
      if (state.quitting) return;
      if (state.keepRunning) {
        e.preventDefault();
        win.hide();
        return;
      }
      // Closing stops everything. JustWrite holds the window a moment first so the page's
      // `pagehide` autosave reaches the server before it stops (closeHoldMs).
      if (config.closeHoldMs && !holding) {
        e.preventDefault();
        holding = true;
        setTimeout(() => quitApp(), config.closeHoldMs);
        return;
      }
      e.preventDefault();
      quitApp();
    });
    win.loadURL(home);
    state.win = win;
    return win;
  }

  function showWindow() {
    if (!state.win || state.win.isDestroyed()) createWindow();
    state.win.show();
    state.win.focus();
  }
  const send = (channel, ...args) => state.win && !state.win.isDestroyed() && state.win.webContents.send(channel, ...args);

  // ── the tray ───────────────────────────────────────────────────────────────
  function buildTrayMenu() {
    const L = state.trayLabels;
    const items = [
      { label: L.show, click: showWindow },
      { label: L.hide, click: () => state.win?.hide() },
      { type: "separator" },
      { label: L.serverStart, click: () => startServer() },
      { label: L.serverStop, click: () => stopServer() },
      {
        label: L.serverRestart,
        click: async () => {
          await stopServer();
          await startServer();
        },
      },
      { type: "separator" },
      ...(config.trayExtras || []).map((x) => ({
        label: L[x.id] || x.label,
        click: () => {
          showWindow();
          send(`tray:${x.event}`);
        },
      })),
      {
        label: L.openSettings,
        click: () => {
          showWindow();
          send("tray:open-settings");
        },
      },
      {
        label: L.copyUrl,
        click: () => {
          showWindow();
          send("tray:copy-url", serverUrl());
        },
      },
      {
        label: L.openLogs,
        click: () => {
          const live = path.join(state.root, config.logFile || "logs");
          shell.openPath(fs.existsSync(live) ? live : path.join(state.root, "logs"));
        },
      },
      { type: "separator" },
      {
        label: L.about || `ℹ️ About ${config.productName}`,
        click: () => {
          showWindow();
          send("tray:about");
        },
      },
      { label: L.quit || `🚪 Quit ${config.productName}`, click: () => quitApp() },
    ];
    return Menu.buildFromTemplate(items);
  }
  function createTray() {
    const tray = new Tray(nativeImage.createFromPath(config.trayIcon || config.icon));
    tray.setToolTip(config.productName);
    tray.setContextMenu(buildTrayMenu());
    tray.on("click", () => {
      if (state.win?.isVisible()) state.win.hide();
      else showWindow();
    });
    state.tray = tray;
  }

  async function quitApp() {
    if (state.quitting) return;
    state.quitting = true;
    await stopServer();
    app.quit();
  }

  // ── the renderer's commands ────────────────────────────────────────────────
  const handlers = {
    async pickDirectory({ title, defaultPath } = {}) {
      const r = await dialog.showOpenDialog(state.win, {
        title: title || "Choose a folder",
        defaultPath: defaultPath || undefined,
        properties: ["openDirectory", "createDirectory"],
      });
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    },
    async pickFile({ title, filterName, filterExt, defaultDir } = {}) {
      const r = await dialog.showOpenDialog(state.win, {
        title: title || "Open a file",
        defaultPath: defaultDir || undefined,
        properties: ["openFile"],
        filters: filterExt ? [{ name: filterName || filterExt, extensions: [String(filterExt).replace(/^\./, "")] }] : [],
      });
      if (r.canceled || !r.filePaths.length) return null;
      const p = r.filePaths[0];
      return { name: path.basename(p), dir: path.dirname(p), dataBase64: fs.readFileSync(p).toString("base64") };
    },
    async saveFile({ bytes, suggestedName, title, filterName, filterExt, defaultDir } = {}) {
      const r = await dialog.showSaveDialog(state.win, {
        title: title || "Save as",
        defaultPath: path.join(defaultDir || app.getPath("downloads"), suggestedName || ""),
        filters: filterExt ? [{ name: filterName || filterExt, extensions: [String(filterExt).replace(/^\./, "")] }] : [],
      });
      if (r.canceled || !r.filePath) return null;
      fs.writeFileSync(r.filePath, Buffer.from(bytes));
      return { ok: true, path: r.filePath };
    },
    storageGetRoot() {
      return storageInfo({ root: state.root, appName: config.appName, repoRoot: config.repoRoot, packaged: app.isPackaged });
    },
    async storageRelocate({ newRoot }) {
      // Stop the server so nothing holds the database open, move, then ALWAYS bring a
      // server back — under the new root on success, the old one on failure.
      // Chromium's folder can only move with a restart, so a successful move relaunches.
      await stopServer();
      let moved = null;
      try {
        moved = relocate({
          oldRoot: state.root,
          newRoot,
          appName: config.appName,
          packaged: app.isPackaged,
          repoRoot: config.repoRoot,
        });
      } catch (e) {
        await startServer();
        throw e;
      }
      if (!moved) {
        await startServer();
        return null;
      }
      state.quitting = true;
      app.relaunch();
      app.exit(0);
      return null;
    },
    setKeepRunning({ keepRunning }) {
      state.keepRunning = !!keepRunning;
      return null;
    },
    setTrayLabels({ labels }) {
      for (const [k, v] of Object.entries(labels || {})) if (k in state.trayLabels && v) state.trayLabels[k] = v;
      state.tray?.setContextMenu(buildTrayMenu());
      return null;
    },
    openExternal({ url }) {
      if (!/^(https?|mailto):/i.test(String(url))) throw new Error("only http(s) and mailto links open outside");
      return shell.openExternal(url);
    },
    async openPath({ path: p }) {
      const err = await shell.openPath(String(p));
      if (err) throw new Error(err);
      return null;
    },
  };
  for (const name of COMMANDS) {
    // Only the app's own page may call (the checklist's "validate the sender").
    ipcMain.handle(`shell:${name}`, (e, args) => {
      if (!fromHome(e.senderFrame?.url)) throw new Error(`shell:${name} refused: not the app's page`);
      return handlers[name](args || {});
    });
  }

  // Web permissions: the clipboard for every app, plus what the app names (JustVoice's
  // microphone), and only for the app's own page. Everything else is denied.
  const allowed = new Set(["clipboard-sanitized-write", "clipboard-read", ...(config.permissions || [])]);
  function guardPermissions() {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      callback(allowed.has(permission) && fromHome(details?.requestingUrl || wc?.getURL()));
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed.has(permission) && fromHome(requestingOrigin));
  }

  // ── boot ───────────────────────────────────────────────────────────────────
  app.on("second-instance", () => showWindow());
  // No page in these apps embeds a <webview>; refuse one outright.
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (ev) => ev.preventDefault());
  });
  app.on("window-all-closed", () => {
    // Keep-running hides the window instead of closing it; anything else quits.
    if (!state.keepRunning) quitApp();
  });
  app.on("before-quit", (e) => {
    if (!state.quitting) {
      e.preventDefault();
      quitApp();
    }
  });
  app.whenReady().then(async () => {
    protocol.handle("app", serveApp);
    guardPermissions();
    createWindow();
    createTray();
    await startServer();
  });
  return { state, startServer, stopServer, quitApp };
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net0.connect({ host: "127.0.0.1", port, timeout: 300 });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
    s.once("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });
}
