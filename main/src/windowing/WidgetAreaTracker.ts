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
      if (inside) {
        // Mouse reached the widget area without the hold-key modifier.
        // Activate on all platforms: previously this case was structurally
        // unreachable because the outer `if` consumed the event before the
        // `else if (inside)` branch could run, so the user had to keep the
        // modifier held the entire way. Now a tap-then-walk works.
        this.logger.write(
          `debug [WidgetAreaTracker] activate: cursor inside area without holdKey` +
          ` (modifier=${modifier ?? 'none'} holdKey=${this.holdKey})`
        )
        this.hasEnteredArea = true
        this.overlay.assertOverlayActive()
      } else if (distance > this.closeThreshold) {
        if (process.platform !== 'linux') {
          // On Linux keep the widget alive so the user can still reach it.
          // Clicks outside the X11 input shape already pass through to the
          // game, so there is no penalty for leaving the widget visible.
          this.logger.write(
            `debug [WidgetAreaTracker] dismiss: distance ${distance.toFixed(0)} > threshold ${this.closeThreshold.toFixed(0)}, hiding widget`
          )
          this.server.sendEventTo('broadcast', {
            name: 'MAIN->OVERLAY::hide-exclusive-widget',
            payload: undefined
          })
          this.removeListeners()
        } else {
          this.logger.write(
            `debug [WidgetAreaTracker] distance ${distance.toFixed(0)} > threshold ${this.closeThreshold.toFixed(0)}, keeping widget (Linux shape mask)`
          )
        }
      }
    } else if (inside) {
      this.hasEnteredArea = true
      this.overlay.assertOverlayActive()
    } else if (this.overlay.isInteractable) {
      if (!this.hasEnteredArea) return
      this.logger.write(
        `debug [WidgetAreaTracker] mouse left area: isInteractable=true hasEnteredArea=true platform=${process.platform}`
      )
      if (process.platform === 'linux') {
        // On Linux the X11 input shape mask already handles click-through for
        // regions outside the active widget area. Stop tracking but keep the
        // overlay active so the price-check window stays interactive while the
        // user reads it. Re-arm input-enter so that moving the mouse back into
        // a widget region after a game-click can reactivate the overlay.
        // Focus returns to the game via Escape / Ctrl+W, the close button
        // (OVERLAY->MAIN::focus-game), or a game-window click detected by
        // handlePoeWindowActiveChange.
        this.removeListeners()
        this.overlay.armInputRegionReactivation()
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
      this.logger.write('debug [WidgetAreaTracker] mousedown outside area while interactable, returning to game')
      this.removeListeners()
      this.overlay.assertGameActive()
    } else if (process.platform === 'linux') {
      this.logger.write('debug [WidgetAreaTracker] mousedown outside area while not interactable (Linux), dismissing widget')
      // On Linux the distance-based dismiss in handleMouseMove is suppressed,
      // so listeners can persist while the user walks to the widget. A click
      // outside the area while the overlay is still not interactable is a clear
      // signal the user changed their mind — clean up to prevent a stale
      // listener pair from persisting until the next track-area event.
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
