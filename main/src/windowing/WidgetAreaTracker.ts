import { Rectangle, Point, screen } from "electron";
import { uIOhook, UiohookMouseEvent } from "uiohook-napi";
import type { OverlayWindow } from "./OverlayWindow";
import type { ServerEvents } from "../server";
import type { Logger } from "../RemoteLogger";

export class WidgetAreaTracker {
  private holdKey!: string;
  private from!: Point;
  private area!: Rectangle;
  private closeThreshold!: number;
  private hasEnteredArea = false;

  constructor(
    private server: ServerEvents,
    private overlay: OverlayWindow,
    private logger: Logger,
  ) {
    this.overlay.onDeactivate(() => this.removeListeners());

    this.server.onEventAnyClient("OVERLAY->MAIN::track-area", (opts) => {
      this.holdKey = opts.holdKey;
      if (process.platform === "win32") {
        this.closeThreshold = opts.closeThreshold * opts.dpr;
        this.from = screen.dipToScreenPoint(opts.from);
        // NOTE: bug in electron accepting only integers
        this.area = screen.dipToScreenRect(null, {
          x: Math.round(opts.area.x),
          y: Math.round(opts.area.y),
          width: Math.round(opts.area.width),
          height: Math.round(opts.area.height),
        });
      } else if (process.platform === "linux") {
        // Linux: track-area coordinates are already physical X11 pixels,
        // directly comparable with uiohook mouse events.
        this.closeThreshold = opts.closeThreshold;
        this.from = { x: Math.round(opts.from.x), y: Math.round(opts.from.y) };
        this.area = {
          x: Math.round(opts.area.x),
          y: Math.round(opts.area.y),
          width: Math.round(opts.area.width),
          height: Math.round(opts.area.height),
        };
      } else {
        this.closeThreshold = opts.closeThreshold;
        this.from = opts.from;
        this.area = opts.area;
      }

      this.hasEnteredArea = isPointInsideRect(this.from, this.area);
      this.removeListeners();
      uIOhook.addListener("mousemove", this.handleMouseMove);
      uIOhook.addListener("mousedown", this.handleMouseDown);
      if (process.platform === "linux") {
        this.logger.write(
          "debug [WidgetAreaTracker] track-area registered on Linux, activating overlay immediately",
        );
        this.overlay.assertOverlayActive();
      }
    });
  }

  removeListeners() {
    uIOhook.removeListener("mousemove", this.handleMouseMove);
    uIOhook.removeListener("mousedown", this.handleMouseDown);
  }

  private readonly handleMouseMove = (e: UiohookMouseEvent) => {
    const modifier = e.ctrlKey ? "Ctrl" : e.altKey ? "Alt" : undefined;
    const inside = isPointInsideRect(e, this.area);

    if (!this.overlay.isInteractable) {
      if (this.overlay.isAwaitingInputEnterReactivation) {
        if (inside) {
          this.logger.write(
            "debug [WidgetAreaTracker] input-enter: cursor returned to tracked area",
          );
          this.hasEnteredArea = true;
          this.overlay.handleInputEnter();
        }
        return;
      }

      if (modifier === this.holdKey) {
        if (inside) {
          this.hasEnteredArea = true;
          this.overlay.assertOverlayActive();
        }
        return;
      }

      const distance = Math.hypot(e.x - this.from.x, e.y - this.from.y);
      if (inside) {
        this.logger.write(
          `debug [WidgetAreaTracker] activate: cursor inside area without holdKey` +
            ` (modifier=${modifier ?? "none"} holdKey=${this.holdKey})`,
        );
        this.hasEnteredArea = true;
        this.overlay.assertOverlayActive();
      } else if (distance > this.closeThreshold) {
        if (process.platform === "linux") {
          this.logger.write(
            `debug [WidgetAreaTracker] distance ${distance.toFixed(0)} > threshold ${this.closeThreshold.toFixed(0)}, keeping widget armed on Linux`,
          );
        } else {
          this.logger.write(
            `debug [WidgetAreaTracker] dismiss: distance ${distance.toFixed(0)} > threshold ${this.closeThreshold.toFixed(0)}, hiding widget`,
          );
          this.server.sendEventTo("broadcast", {
            name: "MAIN->OVERLAY::hide-exclusive-widget",
            payload: undefined,
          });
          this.removeListeners();
        }
      }
      return;
    }

    if (inside) {
      this.hasEnteredArea = true;
      this.overlay.assertOverlayActive();
      return;
    }

    if (this.overlay.isInteractable) {
      if (!this.hasEnteredArea) return;
      this.logger.write(
        `debug [WidgetAreaTracker] mouse left area: isInteractable=true hasEnteredArea=true platform=${process.platform}`,
      );
      if (process.platform === "linux") {
        this.overlay.returnFocusToGame();
        return;
      }
      this.removeListeners();
      this.overlay.assertGameActive();
    }
  };

  private readonly handleMouseDown = (e: UiohookMouseEvent) => {
    const inside = isPointInsideRect(e, this.area);
    if (inside) {
      this.logger.write(
        "debug [WidgetAreaTracker] mousedown inside area, activating overlay",
      );
      if (
        this.overlay.isAwaitingInputEnterReactivation &&
        !this.overlay.isInteractable
      ) {
        this.overlay.handleInputEnter();
        return;
      }
      this.removeListeners();
      this.overlay.assertOverlayActive();
      return;
    }

    if (
      this.overlay.isInteractable ||
      this.overlay.isAwaitingInputEnterReactivation
    ) {
      this.logger.write(
        "debug [WidgetAreaTracker] mousedown outside area, dismissing widget session",
      );
      this.overlay.assertGameActive();
      return;
    }

    if (process.platform === "linux") {
      this.logger.write(
        "debug [WidgetAreaTracker] mousedown outside area while not interactable, dismissing widget",
      );
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::hide-exclusive-widget",
        payload: undefined,
      });
      this.removeListeners();
    }
  };
}

function isPointInsideRect(point: Point, rect: Rectangle) {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  );
}
