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

        this.logger.write(
          `debug [WidgetAreaTracker] register track-area (Linux):` +
          ` holdKey=${opts.holdKey} from=(${this.from.x},${this.from.y})` +
          ` area=(${this.area.x},${this.area.y} ${this.area.width}x${this.area.height})` +
          ` closeThreshold=${this.closeThreshold}`
        )
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
      uIOhook.addListener('mousemove', this.handleMouseMove)
      uIOhook.addListener('mousedown', this.handleMouseDown)
    })
  }

  removeListeners () {
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
      if (inside) {
        // Mouse reached the widget area without the hold-key modifier.
        this.logger.write(
          `debug [WidgetAreaTracker] activate: cursor inside area without holdKey` +
          ` (modifier=${modifier ?? 'none'} holdKey=${this.holdKey})`
        )
        this.hasEnteredArea = true
        this.overlay.assertOverlayActive()
      } else if (distance > this.closeThreshold) {
        if (process.platform === 'linux') {
          // On Linux the X11 input shape mask handles click-through and the
          // focus poll keeps the overlay alive. No distance-based dismiss.
          if (this.debugMoveCount <= 5) {
            this.logger.write(
              `debug [WidgetAreaTracker] distance ${distance.toFixed(0)} > threshold, keeping widget (Linux)`
            )
          }
        } else {
          this.logger.write(
            `debug [WidgetAreaTracker] dismiss: distance ${distance.toFixed(0)} > threshold ${this.closeThreshold.toFixed(0)}, hiding widget`
          )
          this.server.sendEventTo('broadcast', {
            name: 'MAIN->OVERLAY::hide-exclusive-widget',
            payload: undefined
          })
          this.removeListeners()
        }
      }
    } else if (inside) {
      this.hasEnteredArea = true
      this.overlay.assertOverlayActive()
    } else if (this.overlay.isInteractable) {
      if (!this.hasEnteredArea) return
      this.logger.write(
        `debug [WidgetAreaTracker] mouse left area: isInteractable=true platform=${process.platform}`
      )
      if (process.platform === 'linux') {
        // On Linux the focus poll keeps the overlay active and the shape
        // mask handles click-through. Just stop tracking — the overlay
        // stays up until the user explicitly dismisses (Escape, close button).
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
      this.logger.write('debug [WidgetAreaTracker] mousedown inside area, activating overlay')
      this.removeListeners()
      this.overlay.assertOverlayActive()
    } else if (this.overlay.isInteractable) {
      if (process.platform === 'linux') {
        // On Linux, clicks outside the widget pass through via shape mask.
        // The overlay stays up — only keybinds dismiss.
        return
      }
      this.logger.write('debug [WidgetAreaTracker] mousedown outside area while interactable, returning to game')
      this.removeListeners()
      this.overlay.assertGameActive()
    } else if (process.platform !== 'linux') {
      // Non-Linux: click outside while not interactable is a dismiss signal.
      // On Linux the focus poll and shape mask handle this — no dismiss needed.
      this.logger.write('debug [WidgetAreaTracker] mousedown outside area while not interactable, dismissing widget')
      this.server.sendEventTo('broadcast', {
        name: 'MAIN->OVERLAY::hide-exclusive-widget',
        payload: undefined
      })
      this.removeListeners()
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
