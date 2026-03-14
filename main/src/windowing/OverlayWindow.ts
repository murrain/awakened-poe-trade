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
  // On Linux, a polling interval that re-asserts overlay focus while
  // isInteractable is true. Override-redirect windows can't regain focus
  // from user clicks (the WM doesn't manage them), and Electron's
  // blur/focus events are unreliable on X11. Instead of reacting to
  // each blur event with guards and timers, we enforce the desired state.
  private focusPollInterval: ReturnType<typeof setInterval> | null = null

  constructor (
    private server: ServerEvents,
    private logger: Logger,
    private poeWindow: GameWindow,
  ) {
    this.server.onEventAnyClient('OVERLAY->MAIN::focus-game', this.assertGameActive)
    this.poeWindow.on('active-change', this.handlePoeWindowActiveChange)
    this.poeWindow.onAttach(this.handleOverlayAttached)

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
      this.startFocusPoll()
    }
  }

  // Return focus to the game without tearing down the widget session.
  // Used by stashSearch and other actions that need game focus but should
  // not dismiss an active price-check widget on Linux.
  returnFocusToGame = () => {
    if (this.isInteractable) {
      this.logger.write('debug [Overlay] returnFocusToGame: deactivating (preserving session)')
      this.isInteractable = false
      this.stopFocusPoll()
      OverlayController.focusTarget()
      this.poeWindow.isActive = true
    }
  }

  assertGameActive = () => {
    if (this.isInteractable) {
      this.logger.write('debug [Overlay] assertGameActive: deactivating')
      this.isInteractable = false
      this.stopFocusPoll()
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

  private startFocusPoll () {
    if (process.platform !== 'linux') return
    this.stopFocusPoll()
    this.focusPollInterval = setInterval(() => {
      if (!this.window || this.window.isDestroyed()) {
        this.stopFocusPoll()
        return
      }
      if (this.isInteractable && !this.window.isFocused()) {
        this.logger.write('debug [Overlay] focus poll: re-asserting focus')
        OverlayController.activateOverlay()
      }
    }, 100)
  }

  private stopFocusPoll () {
    if (this.focusPollInterval != null) {
      clearInterval(this.focusPollInterval)
      this.focusPollInterval = null
    }
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

  private handlePoeWindowActiveChange = (isActive: boolean) => {
    if (process.platform === 'linux') {
      // On Linux, the focus poll enforces overlay focus. Game focus changes
      // are noise — compositor bounces, click-through via shape mask, etc.
      // Only explicit dismiss (keybind, close button) should deactivate.
      // We still send focus-change so the renderer knows the game state,
      // but we never change isInteractable here.
      this.logger.write(`debug [Overlay] focus-change: game=${isActive} overlay=${this.isInteractable}`)
      this.server.sendEventTo('broadcast', {
        name: 'MAIN->OVERLAY::focus-change',
        payload: {
          game: isActive,
          overlay: this.isInteractable,
          usingHotkey: this.isOverlayKeyUsed
        }
      })
      this.isOverlayKeyUsed = false
      return
    }

    if (isActive && this.isInteractable) {
      this.logger.write('debug [Overlay] game regained focus while interactable, deactivating overlay')
      this.isInteractable = false
    }
    this.logger.write(`debug [Overlay] focus-change: game=${isActive} overlay=${this.isInteractable}`)
    this.server.sendEventTo('broadcast', {
      name: 'MAIN->OVERLAY::focus-change',
      payload: {
        game: isActive,
        overlay: this.isInteractable,
        usingHotkey: this.isOverlayKeyUsed
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
