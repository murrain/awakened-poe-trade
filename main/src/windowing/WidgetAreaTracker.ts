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
      } else {
        this.closeThreshold = opts.closeThreshold
        this.from = opts.from
        this.area = opts.area
      }

      this.debugMoveCount = 0
      this.debugDownCount = 0
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
          ` inArea=${isPointInsideRect(e, this.area)}`
        )
      }
      if (distance > this.closeThreshold) {
        this.server.sendEventTo('broadcast', {
          name: 'MAIN->OVERLAY::hide-exclusive-widget',
          payload: undefined
        })
        this.removeListeners()
      }
    } else if (isPointInsideRect(e, this.area)) {
      this.overlay.assertOverlayActive()
    } else if (this.overlay.isInteractable) {
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
