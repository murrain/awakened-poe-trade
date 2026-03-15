import path from "path";
import { BrowserWindow, Menu, screen, shell } from "electron";
import type { ServerEvents } from "../server";
import type { Logger } from "../RemoteLogger";
import type { GameWindow } from "./GameWindow";

interface ItemTextPayload {
  target: string;
  clipboard: string;
  item?: unknown;
  position: { x: number; y: number };
  gameBounds?: { x: number; y: number; width: number; height: number };
  focusOverlay: boolean;
}

export class LinuxPriceCheckWindow {
  private window: BrowserWindow | null = null;
  private serverPort = 0;
  private pendingPayload: ItemTextPayload | null = null;
  private rendererReady = false;

  constructor(
    private server: ServerEvents,
    private logger: Logger,
    private poeWindow: GameWindow,
  ) {
    this.server.onEventAnyClient("OVERLAY->MAIN::focus-game", () => {
      if (this.window?.isVisible()) {
        this.hideWindow();
      }
    });

    // Hide when POE focus changes while the price-check window is visible.
    // Both blur (user alt-tabs away) and focus (user clicks back into POE)
    // should dismiss the price-check panel.
    this.poeWindow.on("active-change", (_isActive: boolean) => {
      if (this.window?.isVisible()) {
        this.hideWindow();
      }
    });

    // The standalone renderer signals readiness via a dedicated event after
    // Host.init() completes and the component mounts. This is the reliable
    // signal that the renderer is ready to receive item-text events via
    // executeJavaScript (the DOM event listener is registered by then).
    this.server.onEventAnyClient("CLIENT->MAIN::price-check-ready", () => {
      if (this.rendererReady) return;
      this.rendererReady = true;
      this.logger.write(
        "debug [LinuxPriceCheck] renderer ready (price-check-ready received)",
      );
      if (this.pendingPayload) {
        this.dispatchItemText(this.pendingPayload);
        this.pendingPayload = null;
      }
    });
  }

  loadAppPage(port: number) {
    this.serverPort = port;
    this.createWindow();
  }

  private createWindow() {
    if (this.window) return;

    this.window = new BrowserWindow({
      icon: path.join(__dirname, process.env.STATIC!, "icon.png"),
      show: false,
      frame: false,
      type: "toolbar",
      backgroundColor: "#1f2937",
      skipTaskbar: true,
      focusable: true,
      resizable: false,
      width: 460,
      height: 600,
      webPreferences: {
        allowRunningInsecureContent: false,
        webviewTag: true,
        spellcheck: false,
      },
    });

    this.window.setMenu(
      Menu.buildFromTemplate([
        { role: "editMenu" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ]),
    );

    this.window.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url);
      return { action: "deny" };
    });

    // Escape dismissal is handled by uiohook in Shortcuts.ts (same as
    // the overlay), since this window may not have keyboard focus.

    // Hide when the price-check window itself loses focus (e.g. KDE
    // task switcher appears via alt+tab). The game active-change event
    // doesn't fire until a window is actually selected.
    this.window.on("blur", () => {
      if (this.window?.isVisible()) {
        this.hideWindow();
      }
    });

    this.window.on("closed", () => {
      this.window = null;
      this.rendererReady = false;
    });

    const url =
      process.env.VITE_DEV_SERVER_URL ||
      `http://localhost:${this.serverPort}/index.html`;
    const separator = url.includes("?") ? "&" : "?";
    this.window.loadURL(`${url}${separator}mode=price-check`);
  }

  showWithItem(payload: ItemTextPayload) {
    if (!this.window) {
      this.createWindow();
    }

    const bounds = payload.gameBounds ?? this.poeWindow.bounds;
    if (!bounds.width || !bounds.height) {
      this.logger.write(
        "error [LinuxPriceCheck] game bounds not available, cannot show",
      );
      return;
    }

    const scaleFactor = screen.getDisplayNearestPoint({
      x: bounds.x,
      y: bounds.y,
    }).scaleFactor;
    const fontSize = 16;
    const width = Math.round(28.75 * fontSize);
    const panelWidth = this.computePanelWidth(bounds, scaleFactor);
    const middleX = bounds.x + bounds.width / 2;
    const side = payload.position.x > middleX ? "inventory" : "stash";

    // OverlayController.targetBounds and uiohook coordinates are physical
    // pixels on X11. BrowserWindow.setBounds expects logical pixels.
    const logicalBounds = {
      x: Math.round(bounds.x / scaleFactor),
      y: Math.round(bounds.y / scaleFactor),
      width: Math.round(bounds.width / scaleFactor),
      height: Math.round(bounds.height / scaleFactor),
    };

    const screenX =
      side === "inventory"
        ? logicalBounds.x + logicalBounds.width - panelWidth - width
        : logicalBounds.x + panelWidth;

    this.window!.setBounds({
      x: screenX,
      y: logicalBounds.y,
      width,
      height: logicalBounds.height,
    });

    this.logger.write(
      `debug [LinuxPriceCheck] showing window at x=${screenX} y=${logicalBounds.y} ` +
        `${width}x${logicalBounds.height} side=${side} scale=${scaleFactor}`,
    );

    // Use alwaysOnTop with 'screen-saver' level to stack above the game.
    // Unlike override-redirect, WM-managed windows receive focus normally.
    // show() both maps and focuses in a single WM operation (showInactive +
    // focus was not reliably transferring focus on KWin).
    this.window!.setAlwaysOnTop(true, "screen-saver");
    // Suppress the game-blur that our show() will cause — we are
    // intentionally stealing focus, not the user leaving the game.
    this.poeWindow.suppressNextBlur();
    this.window!.show();

    if (this.rendererReady) {
      this.dispatchItemText(payload);
    } else {
      this.pendingPayload = payload;
    }
  }

  hideWindow() {
    if (!this.window?.isVisible()) return;
    this.logger.write("debug [LinuxPriceCheck] hiding window");
    this.window.hide();
  }

  get isVisible() {
    return this.window?.isVisible() ?? false;
  }

  private dispatchItemText(payload: ItemTextPayload) {
    if (!this.window) return;
    // Deliver item-text directly to this window's webContents via
    // executeJavaScript. Using sendEventTo("last-active") is unreliable
    // because the overlay may have reclaimed lastActiveClient, causing
    // item-text to render inside the click-through overlay instead.
    const eventJson = JSON.stringify({
      name: "MAIN->CLIENT::item-text",
      payload,
    });
    this.window.webContents
      .executeJavaScript(
        `document.dispatchEvent(new CustomEvent('__price-check-item', { detail: ${eventJson} }))`,
      )
      .then(() => {
        this.logger.write("debug [LinuxPriceCheck] item-text dispatched to renderer");
      })
      .catch((err: Error) => {
        this.logger.write(
          `error [LinuxPriceCheck] dispatchItemText failed: ${err.message}`,
        );
      });
  }

  private computePanelWidth(
    bounds: { x: number; y: number; width: number; height: number },
    scaleFactor: number,
  ): number {
    // sidebar is 986px at Wx1600H, same ratio as OverlayWindow.vue
    const ratio = 986 / 1600;
    return Math.round((bounds.height * ratio) / scaleFactor);
  }
}
