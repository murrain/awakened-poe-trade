import { Rectangle, Point, screen } from 'electron'
import { uIOhook, UiohookMouseEvent } from 'uiohook-napi'
import type { OverlayWindow } from './OverlayWindow'
import type { ServerEvents } from '../server'

export class WidgetAreaTracker {
  private holdKey!: string
  private from!: Point
  private area!: Rectangle
  private closeThreshold!: number

  constructor (
    private server: ServerEvents,
    private overlay: OverlayWindow
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
        this.closeThreshold = Math.round(opts.closeThreshold)
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
    if (isPointInsideRect(e, this.area)) {
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
