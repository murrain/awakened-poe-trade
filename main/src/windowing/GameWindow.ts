import type { BrowserWindow } from 'electron'
import { EventEmitter } from 'events'
import { OverlayController, AttachEvent } from 'electron-overlay-window'

export interface GameWindow {
  on: (event: 'active-change', listener: (isActive: boolean) => void) => this
}
export class GameWindow extends EventEmitter {
  private _isActive = false
  private _isTracking = false
  // Debounce timer for game-blur events. On X11, _NET_ACTIVE_WINDOW can
  // bounce (game → none → game) when the overlay is override-redirect.
  // Without debouncing, the intermediate blur reaches handlePoeWindowActiveChange
  // with preserveWidgets=false and destroys hide-on-blur widgets irreversibly.
  // Game-focus (true) is always emitted immediately; game-blur (false) waits
  // for the bounce window to close.
  private _blurTimer: ReturnType<typeof setTimeout> | null = null

  get bounds () { return OverlayController.targetBounds }

  get isActive () { return this._isActive }

  set isActive (active: boolean) {
    if (active) {
      // Game gaining focus: emit immediately, cancel any pending blur.
      if (this._blurTimer) {
        clearTimeout(this._blurTimer)
        this._blurTimer = null
      }
      if (!this._isActive) {
        this._isActive = true
        this.emit('active-change', true)
      }
    } else if (this._isActive && !this._blurTimer) {
      // Game losing focus: debounce to absorb X11 _NET_ACTIVE_WINDOW bounces.
      this._blurTimer = setTimeout(() => {
        this._blurTimer = null
        if (this._isActive) {
          this._isActive = false
          this.emit('active-change', false)
        }
      }, 60)
    }
  }

  get uiSidebarWidth () {
    // sidebar is 370px at 800x600
    const ratio = 370 / 600
    return Math.round(this.bounds.height * ratio)
  }

  constructor () {
    super()
  }

  attach (window: BrowserWindow | undefined, title: string) {
    if (!this._isTracking) {
      OverlayController.events.on('focus', () => { this.isActive = true })
      OverlayController.events.on('blur', () => { this.isActive = false })
      OverlayController.attachByTitle(window, title, { hasTitleBarOnMac: true })
      this._isTracking = true
    }
  }

  onAttach (cb: (hasAccess: boolean | undefined) => void) {
    OverlayController.events.on('attach', (e: AttachEvent) => {
      cb(e.hasAccess)
    })
  }

  screenshot () {
    return OverlayController.screenshot()
  }
}
