import path from 'path'
import { BrowserWindow, dialog, shell, Menu, WebContents } from 'electron'
import { OverlayController, OVERLAY_WINDOW_OPTS } from 'electron-overlay-window'
import type { ServerEvents } from '../server'
import type { Logger } from '../RemoteLogger'
import type { GameWindow } from './GameWindow'

export class OverlayWindow {
  public isInteractable = false
  public wasUsedRecently = true
  private window?: BrowserWindow
  private overlayKey: string = 'Shift + Space'
  private isOverlayKeyUsed = false
  private allowInputRegionReactivation = false

  constructor (
    private server: ServerEvents,
    private logger: Logger,
    private poeWindow: GameWindow,
  ) {
    this.server.onEventAnyClient('OVERLAY->MAIN::focus-game', this.assertGameActive)
    this.poeWindow.on('active-change', this.handlePoeWindowActiveChange)
    this.poeWindow.onAttach(this.handleOverlayAttached)
    if (process.platform === 'linux') {
      OverlayController.events.on('input-enter', this.handleOverlayInputEnter)
    }

    this.server.onEventAnyClient('CLIENT->MAIN::used-recently', (e) => {
      this.wasUsedRecently = e.isOverlay
    })

    // Forward input region updates from the renderer to the native overlay.
    // The renderer calculates which widget bounding boxes are currently visible
    // and sends them here so that only those areas receive mouse input.
    // Linux only — the renderer also guards the send, but we enforce the
    // platform check here independently so neither side relies on the other.
    let lastRegionSummary = ''
    this.server.onEventAnyClient('OVERLAY->MAIN::set-input-regions', (e) => {
      if (process.platform === 'linux') {
        try {
          if (hasSetInputRegions(OverlayController)) {
            OverlayController.setInputRegions(e.regions)
          } else {
            this.logger.write('warn [Overlay] setInputRegions unavailable in current electron-overlay-window build')
            return
          }
          const summary = e.regions.length === 0
            ? 'none'
            : e.regions.map(r => `(${r.x},${r.y} ${r.width}x${r.height})`).join(' ')
          if (summary !== lastRegionSummary) {
            lastRegionSummary = summary
            this.logger.write(`debug [Overlay] setInputRegions: ${e.regions.length} region(s): ${summary}`)
          }
        } catch (err) {
          this.logger.write(`warn [Overlay] setInputRegions failed: ${err}`)
        }
      }
    })

    this.server.onEventAnyClient('OVERLAY->MAIN::debug-log', (e) => {
      this.logger.write(`debug [renderer] ${e.message}`)
    })

    if (process.argv.includes('--no-overlay')) return

    this.window = new BrowserWindow({
      icon: path.join(__dirname, process.env.STATIC!, 'icon.png'),
      ...OVERLAY_WINDOW_OPTS,
      width: 800,
      height: 600,
      webPreferences: {
        allowRunningInsecureContent: false,
        webviewTag: true,
        spellcheck: false
      }
    })

    this.window.setMenu(Menu.buildFromTemplate([
      { role: 'editMenu' },
      { role: 'reload' },
      { role: 'toggleDevTools' }
    ]))

    this.window.webContents.on('before-input-event', this.handleExtraCommands)
    this.window.webContents.on('did-attach-webview', (_, webviewWebContents) => {
      webviewWebContents.on('before-input-event', this.handleExtraCommands)
    })

    this.window.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    this.window.on('focus', () => {
      this.logger.write('debug [Overlay] BrowserWindow: focus')
    })
    this.window.on('blur', () => {
      this.logger.write('debug [Overlay] BrowserWindow: blur')
    })
  }

  loadAppPage (port: number) {
    const url = process.env.VITE_DEV_SERVER_URL ||
      `http://localhost:${port}/index.html`

    if (!this.window) {
      shell.openExternal(url)
      return
    }

    if (process.env.VITE_DEV_SERVER_URL) {
      this.window.loadURL(url)
      this.window.webContents.openDevTools({ mode: 'detach', activate: false })
    } else {
      this.window.loadURL(url)
    }
  }

  assertOverlayActive = () => {
    if (!this.isInteractable) {
      this.logger.write('debug [Overlay] assertOverlayActive: activating')
      this.isInteractable = true
      OverlayController.activateOverlay()
      this.poeWindow.isActive = false
    }
  }

  // Return focus to the game without tearing down the widget session.
  // Used by stashSearch and other actions that need game focus but should
  // not dismiss an active price-check widget on Linux.
  returnFocusToGame = () => {
    if (this.isInteractable) {
      this.logger.write('debug [Overlay] returnFocusToGame: deactivating (preserving session)')
      this.isInteractable = false
      OverlayController.focusTarget()
      this.poeWindow.isActive = true
    }
  }

  assertGameActive = () => {
    if (this.isInteractable) {
      this.logger.write('debug [Overlay] assertGameActive: deactivating')
      this.isInteractable = false
      // Disarm input-enter reactivation on explicit dismiss (Escape, close
      // button, overlay key). This ensures the subsequent focus-change sends
      // preserveWidgets=false so hide-on-blur actually hides the widget.
      // Game-click focus changes go through handlePoeWindowActiveChange
      // instead, which does NOT disarm — keeping the widget alive.
      if (this.allowInputRegionReactivation) {
        this.allowInputRegionReactivation = false
        this.logger.write('debug [Overlay] input-enter reactivation: disarmed (explicit dismiss)')
      }
      OverlayController.focusTarget()
      this.poeWindow.isActive = true
    }
  }

  toggleActiveState = () => {
    this.isOverlayKeyUsed = true
    if (this.isInteractable) {
      this.assertGameActive()
    } else {
      this.assertOverlayActive()
    }
  }

  updateOpts (overlayKey: string, windowTitle: string) {
    this.overlayKey = overlayKey
    this.poeWindow.attach(this.window, windowTitle)
  }

  armInputRegionReactivation () {
    this.allowInputRegionReactivation = true
    this.logger.write('debug [Overlay] input-enter reactivation: armed')
  }

  disarmInputRegionReactivation () {
    this.allowInputRegionReactivation = false
    this.logger.write('debug [Overlay] input-enter reactivation: disarmed')
  }

  private handleExtraCommands = (event: Electron.Event, input: Electron.Input) => {
    if (input.type !== 'keyDown') return

    let { code, control: ctrlKey, shift: shiftKey, alt: altKey } = input

    if (code.startsWith('Key')) {
      code = code.slice('Key'.length)
    } else if (code.startsWith('Digit')) {
      code = code.slice('Digit'.length)
    }

    if (shiftKey && altKey) code = `Shift + Alt + ${code}`
    else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`
    else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`
    else if (altKey) code = `Alt + ${code}`
    else if (ctrlKey) code = `Ctrl + ${code}`
    else if (shiftKey) code = `Shift + ${code}`

    switch (code) {
      case 'Escape':
      case 'Ctrl + W': {
        event.preventDefault()
        this.logger.write(`debug [Overlay] keyboard dismiss: ${code}`)
        process.nextTick(this.assertGameActive)
        break
      }
      case this.overlayKey: {
        event.preventDefault()
        process.nextTick(this.toggleActiveState)
        break
      }
    }
  }

  private handleOverlayAttached = (hasAccess?: boolean) => {
    if (hasAccess === false) {
      this.logger.write('error [Overlay] PoE is running with administrator rights')

      dialog.showErrorBox(
        'PoE window - No access',
        // ----------------------
        'Path of Exile is running with administrator rights.\n' +
        '\n' +
        'You need to restart Awakened PoE Trade with administrator rights.'
      )
    } else {
      this.server.sendEventTo('broadcast', {
        name: 'MAIN->OVERLAY::overlay-attached',
        payload: undefined
      })
    }
  }

  private handleOverlayInputEnter = () => {
    if (!this.allowInputRegionReactivation || this.isInteractable) {
      this.logger.write(
        `debug [Overlay] input-enter: ignored (armed=${this.allowInputRegionReactivation} isInteractable=${this.isInteractable})`
      )
      return
    }
    this.logger.write('debug [Overlay] input-enter: reactivating overlay')
    this.assertOverlayActive()
  }

  private handlePoeWindowActiveChange = (isActive: boolean) => {
    if (isActive && this.isInteractable) {
      this.logger.write('debug [Overlay] game regained focus while interactable, deactivating overlay')
      this.isInteractable = false
    }
    // On Linux, when input-enter reactivation is armed and the game regains
    // focus, we tell the renderer to keep hide-on-blur widgets visible.
    // Otherwise their data-input-region elements get removed from the DOM,
    // which clears the X11 input shape mask and prevents input-enter from
    // ever firing to reactivate the overlay.
    const preserveWidgets = isActive && process.platform === 'linux' && this.allowInputRegionReactivation
    this.logger.write(`debug [Overlay] focus-change: game=${isActive} overlay=${this.isInteractable} preserveWidgets=${preserveWidgets}`)
    this.server.sendEventTo('broadcast', {
      name: 'MAIN->OVERLAY::focus-change',
      payload: {
        game: isActive,
        overlay: this.isInteractable,
        usingHotkey: this.isOverlayKeyUsed,
        preserveWidgets
      }
    })
    this.isOverlayKeyUsed = false
  }
}

function hasSetInputRegions (
  value: typeof OverlayController
): value is typeof OverlayController & { setInputRegions: (regions: Array<{ x: number, y: number, width: number, height: number }>) => void } {
  return typeof (value as { setInputRegions?: unknown }).setInputRegions === 'function'
}
