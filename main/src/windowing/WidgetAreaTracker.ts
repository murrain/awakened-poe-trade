import { Rectangle, Point, screen } from 'electron'
import { uIOhook, UiohookMouseEvent } from 'uiohook-napi'
import type { OverlayWindow } from './OverlayWindow'
import type { ServerEvents } from '../server'
import type { Logger } from '../RemoteLogger'

export class WidgetAreaTracker {
  private holdKey!: string
  private from!: Point
  private area!: Rectangle
  private closeThreshold!: number
  private hasEnteredArea = false
  private debugMoveCount = 0
  private debugDownCount = 0

  constructor (
    private server: ServerEvents,
    private overlay: OverlayWindow,
    private logger: Logger
  ) {
    this.server.onEventAnyClient('OVERLAY->MAIN::track-area', (opts) => {
      this.holdKey = opts.holdKey
      if (process.platform === 'win32') {
        this.closeThreshold = opts.closeThreshold * opts.dpr
        this.from = screen.dipToScreenPoint(opts.from)
        // NOTE: bug in electron accepting only integers
        this.area = screen.dipToScreenRect(null, {
          x: Math.round(opts.area.x),
          y: Math.round(opts.area.y),
          width: Math.round(opts.area.width),
          height: Math.round(opts.area.height)
        })
      } else if (process.platform === 'linux') {
        // Linux invariant: track-area coordinates are already physical X11
        // virtual-desktop pixels and are compared directly with uiohook.
        // No DIP/CSS conversion is allowed in this path.
        this.closeThreshold = Math.round(opts.closeThreshold * opts.dpr)
        this.from = normalizePoint(opts.from)
        this.area = normalizeRect(opts.area)

        console.info('[WidgetAreaTracker][Linux] register track-area', {
          holdKey: opts.holdKey,
          from: this.from,
          area: this.area,
          closeThreshold: this.closeThreshold
        })
      } else {
        this.closeThreshold = opts.closeThreshold
        this.from = opts.from
        this.area = opts.area
      }

      this.debugMoveCount = 0
      this.debugDownCount = 0
      this.hasEnteredArea = isPointInsideRect(this.from, this.area)
      this.logger.write(
        `debug [WidgetAreaTracker] track-area: from=(${this.from.x},${this.from.y})` +
        ` area=(${this.area.x},${this.area.y} ${this.area.width}x${this.area.height})` +
        ` holdKey=${opts.holdKey} dpr=${opts.dpr}`
      )

      this.removeListeners()
      this.overlay.armInputRegionReactivation()
      uIOhook.addListener('mousemove', this.handleMouseMove)
      uIOhook.addListener('mousedown', this.handleMouseDown)
    })
  }

  removeListeners () {
    this.overlay.disarmInputRegionReactivation()
    uIOhook.removeListener('mousemove', this.handleMouseMove)
    uIOhook.removeListener('mousedown', this.handleMouseDown)
  }

  private readonly handleMouseMove = (e: UiohookMouseEvent) => {
    const inside = isPointInsideRect(e, this.area)
    const modifier = e.ctrlKey ? 'Ctrl' : (e.altKey ? 'Alt' : undefined)
    if (!this.overlay.isInteractable && modifier !== this.holdKey) {
      const distance = Math.hypot(e.x - this.from.x, e.y - this.from.y)
      // Log the first few move events so a debug log can show whether
      // uiohook coords and the tracked area are in the same space.
      if (this.debugMoveCount < 5) {
        this.debugMoveCount++
        this.logger.write(
          `debug [WidgetAreaTracker] mousemove #${this.debugMoveCount}:` +
          ` pos=(${e.x},${e.y}) dist=${distance.toFixed(0)} threshold=${this.closeThreshold.toFixed(0)}` +
          ` inArea=${inside}`
        )
      }
      if (distance > this.closeThreshold) {
        this.server.sendEventTo('broadcast', {
          name: 'MAIN->OVERLAY::hide-exclusive-widget',
          payload: undefined
        })
        this.removeListeners()
      }
    } else if (inside) {
      this.hasEnteredArea = true
      this.overlay.assertOverlayActive()
    } else if (this.overlay.isInteractable) {
      if (!this.hasEnteredArea) return
      if (process.platform === 'linux') {
        // On Linux the X11 input shape mask already handles click-through for
        // regions outside the active widget area. Stop tracking but keep the
        // overlay active so the price-check window stays interactive while the
        // user reads it. Focus returns to the game via Escape / Ctrl+W, the
        // close button (OVERLAY->MAIN::focus-game), or a game-window click
        // detected by handlePoeWindowActiveChange.
        this.removeListeners()
        return
      }
      this.removeListeners()
      this.overlay.assertGameActive()
    }
  }

  private readonly handleMouseDown = (e: UiohookMouseEvent) => {
    const inside = isPointInsideRect(e, this.area)
    if (this.debugDownCount < 5) {
      this.debugDownCount++
      this.logger.write(
        `debug [WidgetAreaTracker] mousedown #${this.debugDownCount}: pos=(${e.x},${e.y}) inArea=${inside}` +
        ` area=(${this.area.x},${this.area.y} ${this.area.width}x${this.area.height})`
      )
    }
    if (inside) {
      this.removeListeners()
      this.overlay.assertOverlayActive()
    } else if (this.overlay.isInteractable) {
      this.removeListeners()
      this.overlay.assertGameActive()
    }
  }
}

function isPointInsideRect (point: Point, rect: Rectangle) {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  )
}

function normalizePoint (point: Point): Point {
  return {
    x: Math.round(point.x),
    y: Math.round(point.y)
  }
}

function normalizeRect (rect: Rectangle): Rectangle {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
}
