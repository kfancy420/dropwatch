// The desktop app: one window, a tray icon, and the engine behind them.

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  session,
  shell,
  Tray,
} from "electron";
import { fileURLToPath } from "node:url";

import iconPath from "../../build/icon.png?asset";
import trayIconPath from "../../build/tray.png?asset";
import { guardedFetch } from "../../src/guard.js";
import { USER_AGENT } from "../../src/http.js";
import type { AppState, CallResult, MethodName, Methods } from "../shared/types.js";
import { Engine, UserError, type Notice } from "./engine.js";

const APP_ID = "com.kfancy.dropwatch";
const RELEASES_API = "https://api.github.com/repos/kfancy420/dropwatch/releases/latest";
const RELEASES_PAGE = "https://github.com/kfancy420/dropwatch/releases/latest";
const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;

// Tests point the app at a throwaway folder and place the window themselves.
if (process.env.DROPWATCH_DATA_DIR) app.setPath("userData", process.env.DROPWATCH_DATA_DIR);
const startHidden = process.argv.includes("--hidden");
// The dev server address is only honoured when running from source.
const rendererUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const rendererFile = fileURLToPath(new URL("../renderer/index.html", import.meta.url));

let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let engine: Engine | undefined;
let quitting = false;
let update: AppState["update"];
let pushTimer: NodeJS.Timeout | undefined;
let lastReloadAt = 0;
const liveNotifications = new Set<Notification>();

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function openExternal(url: string): void {
  // Only ever hand a web address to the system, never an arbitrary string.
  if (isWebUrl(url)) void shell.openExternal(new URL(url).href);
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function notify(notice: Notice): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: notice.title,
    body: notice.body,
    icon: nativeImage.createFromPath(iconPath),
  });
  // Held until closed so the click handler is not collected with it.
  liveNotifications.add(notification);
  const release = () => liveNotifications.delete(notification);
  notification.on("click", () => {
    if (notice.url) openExternal(notice.url);
    else showWindow();
    release();
  });
  notification.on("close", release);
  notification.on("failed", release);
  notification.show();
}

function playSound(): void {
  if (win && !win.isDestroyed()) win.webContents.send("dropwatch:sound");
  else shell.beep();
}

function launchAtLogin(): boolean {
  return app.isPackaged && app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin;
}

function state(): AppState {
  return {
    ...engine!.view(),
    version: app.getVersion(),
    platform: process.platform,
    launchAtLogin: launchAtLogin(),
    canLaunchAtLogin: app.isPackaged,
    update,
  };
}

function pushState(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    if (!engine) return;
    if (win && !win.isDestroyed()) win.webContents.send("dropwatch:state", state());
    refreshTray();
  }, 50);
}

function refreshTray(): void {
  if (!tray || !engine) return;
  const count = engine.watchingCount;
  const what = `${count} product${count === 1 ? "" : "s"}`;
  tray.setToolTip(engine.paused ? "Dropwatch is paused" : `Dropwatch is watching ${what}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Dropwatch", click: showWindow },
      {
        label: engine.paused ? "Resume watching" : "Pause watching",
        click: () => engine?.setPaused(!engine.paused),
      },
      { type: "separator" },
      {
        label: "Quit Dropwatch",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  return {
    color: "#00000000",
    symbolColor: nativeTheme.shouldUseDarkColors ? "#ECEEF8" : "#171A2B",
    height: 40,
  };
}

function windowPosition(): { x: number; y: number } | undefined {
  const match = /^(-?\d+),(-?\d+)$/.exec(process.env.DROPWATCH_WINDOW_POS ?? "");
  return match ? { x: Number(match[1]), y: Number(match[2]) } : undefined;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 600,
    ...windowPosition(),
    show: false,
    title: "Dropwatch",
    icon: iconPath,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1B1E33" : "#F6F7FB",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform !== "darwin" && { titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The alarm plays from this window, so it must keep running when hidden.
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  // The window shows this app and nothing else; links open in the real browser.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });

  win.once("ready-to-show", () => {
    if (!startHidden) win?.show();
  });

  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win?.hide();
    if (engine && !engine.trayNoticeShown) {
      engine.markTrayNoticeShown();
      notify({
        title: "Dropwatch is still watching",
        body: "It lives next to the clock. Right-click its icon there and choose Quit to stop it.",
      });
    }
  });
  // Signing out of Windows ends the app without a "before-quit".
  win.on("session-end", () => engine?.close());
  // The alarm plays in the window. If the window's page dies, bring it back, but not in a loop.
  win.webContents.on("render-process-gone", () => {
    if (quitting || Date.now() - lastReloadAt < 60_000) return;
    lastReloadAt = Date.now();
    win?.webContents.reload();
  });

  if (rendererUrl) void win.loadURL(rendererUrl);
  else void win.loadFile(rendererFile);
}

// ---- Requests from the window -------------------------------------------

function text(value: unknown, max = 2048): string {
  if (typeof value !== "string" || value.length > max) throw new UserError("That value is not valid.");
  return value;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new UserError("That value is not valid.");
  return value;
}

function optional<T>(value: unknown, read: (v: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : read(value);
}

function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new UserError("That price is not valid.");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UserError("That value is not valid.");
  }
  return value as Record<string, unknown>;
}

type Handlers = {
  [K in MethodName]: (args: unknown[]) => ReturnType<Methods[K]> | Promise<ReturnType<Methods[K]>>;
};

function handlers(core: Engine): Handlers {
  return {
    getState: () => state(),
    previewProduct: (a) => core.previewProduct(text(a[0]), optional(a[1], (v) => text(v, 200))),
    addProduct: (a) => {
      const input = record(a[0]);
      core.addProduct({
        url: text(input.url),
        name: text(input.name, 500),
        maxPrice: optional(input.maxPrice, amount),
      });
    },
    updateProduct: (a) => {
      const patch = record(a[1]);
      core.updateProduct(text(a[0], 200), {
        name: text(patch.name, 500),
        maxPrice: optional(patch.maxPrice, amount),
      });
    },
    removeProduct: (a) => core.removeProduct(text(a[0], 200)),
    checkNow: (a) => core.checkNow(text(a[0], 200)),
    addReminder: (a) => {
      const input = record(a[0]);
      core.addReminder({ name: text(input.name, 500), url: text(input.url), at: text(input.at, 64) });
    },
    removeReminder: (a) => core.removeReminder(text(a[0], 200)),
    updateAlerts: (a) => {
      const patch = record(a[0]);
      core.updateAlerts({
        openBrowser: optional(patch.openBrowser, flag),
        sound: optional(patch.sound, flag),
        desktop: optional(patch.desktop, flag),
        discordWebhook: optional(patch.discordWebhook, (v) => text(v, 400)),
      });
    },
    newNtfyTopic: () => core.newNtfyTopic(),
    clearNtfyTopic: () => core.clearNtfyTopic(),
    setBestBuyKey: (a) => core.setBestBuyKey(text(a[0], 200)),
    testAlert: () => core.testAlert(),
    setPaused: (a) => core.setPaused(flag(a[0])),
    setLaunchAtLogin: (a) => {
      const on = flag(a[0]);
      if (!app.isPackaged) throw new UserError("This only works in the installed app.");
      app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
      pushState();
    },
    openExternal: (a) => {
      const url = text(a[0]);
      if (!isWebUrl(url)) throw new UserError("That is not a web link.");
      openExternal(url);
    },
    completeOnboarding: () => core.completeOnboarding(),
    clearActivity: () => core.clearActivity(),
  };
}

function fromOurWindow(event: Electron.IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!win || !frame || event.sender !== win.webContents || frame !== win.webContents.mainFrame) return false;
  if (rendererUrl) return frame.url.startsWith(rendererUrl);
  try {
    return fileURLToPath(frame.url) === rendererFile;
  } catch {
    return false;
  }
}

function listen(core: Engine): void {
  const table = handlers(core);
  ipcMain.handle(
    "dropwatch:call",
    async (event, method: unknown, args: unknown): Promise<CallResult<unknown>> => {
      if (!fromOurWindow(event)) return { ok: false, error: "Not allowed." };
      if (typeof method !== "string" || !Object.hasOwn(table, method) || !Array.isArray(args)) {
        return { ok: false, error: "Dropwatch did not understand that request." };
      }
      try {
        const value = await table[method as MethodName](args);
        return { ok: true, value };
      } catch (err) {
        if (err instanceof UserError) return { ok: false, error: err.message };
        console.error(err);
        return { ok: false, error: "Something went wrong inside Dropwatch. Try that again." };
      }
    },
  );
}

// ---- Updates --------------------------------------------------------------

function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return;
    const latest = (await res.json()) as { tag_name?: unknown };
    if (typeof latest.tag_name !== "string" || !/^v?\d+\.\d+\.\d+$/.test(latest.tag_name)) return;
    if (isNewer(latest.tag_name, app.getVersion())) {
      update = { version: latest.tag_name.replace(/^v/, ""), url: RELEASES_PAGE };
      pushState();
    }
  } catch {
    // Offline or rate limited; the next check will do.
  }
}

// ---- Start ----------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  // Closing the window leaves the app watching from the tray.
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    quitting = true;
    engine?.close();
  });

  void app.whenReady().then(() => {
    if (app.isPackaged) Menu.setApplicationMenu(null);
    // The only permission the window gets is writing to the clipboard, for
    // the "Copy" button next to the phone alert channel.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, allow) =>
      allow(permission === "clipboard-sanitized-write"),
    );

    engine = new Engine({
      dir: app.getPath("userData"),
      openExternal,
      notify,
      playSound,
      onState: pushState,
      // The end-to-end test runs a pretend shop on this computer. Nothing else may be reached here.
      ...(process.env.DROPWATCH_ALLOW_LOOPBACK === "1" && {
        fetchImpl: guardedFetch({ allowLoopback: true }),
      }),
    });
    listen(engine);
    createWindow();

    tray = new Tray(nativeImage.createFromPath(trayIconPath));
    tray.on("click", showWindow);
    refreshTray();

    nativeTheme.on("updated", () => {
      if (process.platform !== "darwin" && win && !win.isDestroyed()) {
        win.setTitleBarOverlay(titleBarOverlay());
      }
    });

    const core = engine;
    setInterval(() => void core.pulse().catch((err) => console.error(err)), 1000);
    setInterval(() => core.flush(), 5000);
    setTimeout(() => void checkForUpdate(), 8000);
    setInterval(() => void checkForUpdate(), UPDATE_CHECK_MS);
  });
}
