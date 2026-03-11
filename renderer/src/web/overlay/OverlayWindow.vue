<template>
  <div id="overlay-window" class="overflow-hidden relative w-full h-full"
    :style="{ '--game-panel': poePanelWidth.toFixed(4) + 'px' }">
    <!-- <div style="border: 4px solid red; top: 0; left: 0; height: 100%; width: 100%; position: absolute;"></div> -->
    <div style="top: 0; left: 0; height: 100%; width: 100%; position: absolute;"
      :style="{ background: overlayBackground }"
      @click="handleBackgroundClick"></div>
    <template v-for="widget of widgets" :key="widget.wmId">
      <component
        v-show="isVisible(widget.wmId)"
        :config="widget"
        :id="`widget-${widget.wmId}`"
        :is="registry.getWidgetComponent(widget.wmType)" />
    </template>
    <pre v-if="showLogs"
      class="widget-default-style p-4 mx-auto mt-6 overflow-hidden"
      style="max-width: 38rem; z-index: 999; position: absolute; left: 0; right: 0;"
    >{{ logs }}</pre>
    <loading-animation />
    <div v-if="showEditingNotification"
      class="widget-default-style p-6 bg-blue-600 mx-auto text-center text-base mt-6"
      style="min-width: 30rem; z-index: 998; width: fit-content; position: absolute; left: 0; right: 0;">
      <i18n-t keypath="reopen_settings">
        <span class="bg-blue-800 rounded px-1">{{ overlayKey }}</span>
      </i18n-t>
    </div>
    <!-- <div v-show="!gameFocused && !active">
      <div style="right: 24px; bottom: 24px; position: absolute;" class="bg-red-500 p-2 rounded">Game window is not active</div>
    </div> -->
  </div>
</template>

<script lang="ts">
import { defineComponent, provide, shallowRef, watch, readonly, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Host } from '@/web/background/IPC'
import { Widget, WidgetManager } from './interfaces'
import { registry } from './widget-registry.js'
import { AppConfig, saveConfig, pushHostConfig } from '@/web/Config'
import LoadingAnimation from './LoadingAnimation.vue'
// ---
import { usePoeninja } from '@/web/background/Prices'
import { useLeagues } from '@/web/background/Leagues'
import { handleLine } from '@/web/client-log/client-log'

type WMID = Widget['wmId']

export default defineComponent({
  components: {
    LoadingAnimation
  },
  setup () {
    usePoeninja()
    useLeagues().load()

    const active = shallowRef(!Host.isElectron)
    const gameFocused = shallowRef(false)
    const hideUI = shallowRef(false)
    const showEditingNotification = shallowRef(false)

    watch(active, (active) => {
      if (active) {
        showEditingNotification.value = false
      }
    })

    const widgets = computed<Widget[]>({
      get () {
        return AppConfig().widgets
      },
      set (value) {
        AppConfig().widgets = value
      }
    })

    window.addEventListener('blur', () => {
      nextTick(() => { saveConfig() })
    })
    window.addEventListener('focus', () => {
      Host.sendEvent({
        name: 'CLIENT->MAIN::used-recently',
        payload: { isOverlay: Host.isElectron }
      })
    })

    Host.onEvent('MAIN->CLIENT::config-changed', () => {
      const widget = topmostOrExclusiveWidget.value
      if (widget.wmType === 'settings') {
        hide(widget.wmId)
      }
    })

    Host.onEvent('MAIN->OVERLAY::focus-change', (state) => {
      active.value = state.overlay
      gameFocused.value = state.game

      if (active.value === false) {
        for (const w of widgets.value) {
          if (w.wmFlags.includes('hide-on-blur')) {
            hide(w.wmId)
          }
        }
      } else {
        for (const w of widgets.value) {
          if (w.wmFlags.includes('hide-on-focus')) {
            hide(w.wmId)
          }
        }
      }
    })
    Host.onEvent('MAIN->OVERLAY::visibility', (e) => {
      hideUI.value = !e.isVisible
    })

    Host.onEvent('MAIN->CLIENT::game-log', (e) => {
      for (const line of e.lines) {
        handleLine(line)
      }
    })

    onMounted(() => {
      nextTick(() => {
        Host.sendEvent({
          name: 'CLIENT->MAIN::used-recently',
          payload: { isOverlay: Host.isElectron }
        })
        pushHostConfig()
      })
    })

    const size = (() => {
      const size = shallowRef({
        width: window.innerWidth,
        height: window.innerHeight
      })
      window.addEventListener('resize', () => {
        size.value = {
          width: window.innerWidth,
          height: window.innerHeight
        }
      })
      return readonly(size)
    })()

    function show (wmId: WMID) {
      bringToTop(wmId)
      const topmostWidget = topmostOrExclusiveWidget.value
      if (topmostWidget.wmZorder === 'exclusive') {
        hide(topmostWidget.wmId)
      }
      widgets.value.find(_ => _.wmId === wmId)!.wmWants = 'show'
    }

    function hide (wmId: WMID) {
      widgets.value.find(_ => _.wmId === wmId)!.wmWants = 'hide'
    }

    function remove (wmId: WMID) {
      widgets.value = widgets.value.filter(_ => _.wmId !== wmId)
    }

    function setFlag (wmId: WMID, flag: Widget['wmFlags'][number], state: boolean) {
      const widget = AppConfig().widgets.find(_ => _.wmId === wmId)!
      const hasFlag = widget.wmFlags.includes(flag)
      if (state === false && hasFlag === true) {
        widget.wmFlags = widget.wmFlags.filter(_ => _ !== flag)
        return true
      }
      if (state === true && hasFlag === false) {
        widget.wmFlags.push(flag)
        return true
      }
      return false
    }

    function bringToTop (wmId: WMID) {
      if (wmId === topmostWidget.value.wmId) return

      const widget = AppConfig().widgets.find(_ => _.wmId === wmId)!
      if (widget.wmZorder !== 'exclusive') {
        widget.wmZorder = (topmostWidget.value.wmZorder as number) + 1
      }
    }

    function create (wmType: Widget['wmType']) {
      AppConfig().widgets.push({
        wmId: Math.max(0, ...AppConfig().widgets.map(_ => _.wmId)) + 1,
        wmType,
        wmTitle: '',
        wmWants: 'hide',
        wmZorder: null,
        wmFlags: ['uninitialized']
      })
    }

    const visibilityState = computed(() => {
      let showExclusive = AppConfig().widgets
        .find(w => w.wmZorder === 'exclusive' && w.wmWants === 'show')
      if (!active.value && showExclusive && showExclusive.wmFlags.includes('invisible-on-blur')) {
        showExclusive = undefined
      }

      return AppConfig().widgets.map(w => ({
        wmId: w.wmId,
        isVisible:
          hideUI.value ? (active.value && w.wmWants === 'show' && w.wmFlags.includes('ignore-ui-visibility'))
            : !active.value && w.wmFlags.includes('invisible-on-blur') ? false
                : showExclusive ? w === showExclusive
                  : w.wmWants === 'show'
      }))
    })

    const topmostWidget = computed<Widget>(() => {
      // guaranteed to always exist because of the 'widget-menu'
      return AppConfig().widgets
        .filter(w => w.wmZorder !== 'exclusive' && w.wmZorder != null)
        .sort((a, b) => (b.wmZorder as number) - (a.wmZorder as number))[0]
    })

    const topmostOrExclusiveWidget = computed<Widget>(() => {
      const showExclusive = AppConfig().widgets
        .find(w => w.wmZorder === 'exclusive' && w.wmWants === 'show')

      return showExclusive || topmostWidget.value
    })

    watch(topmostOrExclusiveWidget, (widget, wasWidget) => {
      showEditingNotification.value = (widget.wmType === 'settings')
      // TODO: hack, should find a better way to save config
      if (wasWidget && wasWidget.wmZorder === 'exclusive' && wasWidget.wmType !== 'settings') {
        saveConfig()
      }
    }, { immediate: false })

    const poePanelWidth = computed(() => {
      if (!Host.isElectron) return 0
      // sidebar is 986px at Wx1600H
      const ratio = 986 / 1600
      return size.value.height * ratio
    })

    provide<WidgetManager>('wm', {
      poePanelWidth,
      size,
      active,
      widgets: computed(() => AppConfig().widgets),
      show,
      hide,
      remove,
      bringToTop,
      create,
      setFlag
    })

    // --- X11 input shape region tracking ---
    // On Linux, the overlay is a fullscreen transparent window. We use X11
    // input shape masks so only the actual widget content areas capture
    // mouse input — everything else passes through to the game.
    //
    // Widget root elements (#widget-N) are full-screen positioned wrappers.
    // The actual interactive content is marked with data-input-region
    // attributes (set in Widget.vue, PriceCheckWindow, SettingsWindow).
    // We measure those elements to get accurate clickable bounds.
    //
    // Timing: we debounce 50ms to coalesce rapid visibility changes, then
    // use nextTick (wait for Vue DOM flush) + requestAnimationFrame (wait
    // for browser layout) before measuring, so getBoundingClientRect()
    // returns the final rendered positions.
    if (Host.isElectron && navigator.platform.startsWith('Linux')) {
      let inputRegionTimer: ReturnType<typeof setTimeout> | null = null
      let inputRegionRaf: number | null = null
      let loggedEnv = false

      function updateInputRegions () {
        nextTick(() => {
          inputRegionRaf = requestAnimationFrame(() => {
            inputRegionRaf = null
            const regions: Array<{ x: number, y: number, width: number, height: number }> = []
            const dpr = window.devicePixelRatio || 1

            if (!loggedEnv) {
              loggedEnv = true
              Host.sendEvent({
                name: 'OVERLAY->MAIN::debug-log',
                payload: {
                  message: `renderer env: screenX=${window.screenX} screenY=${window.screenY}` +
                    ` innerSize=${window.innerWidth}x${window.innerHeight}` +
                    ` dpr=${dpr} platform=${navigator.platform}`
                }
              })
            }

            for (const entry of visibilityState.value) {
              if (!entry.isVisible) continue
              const el = document.getElementById(`widget-${entry.wmId}`)
              if (!el) continue
              const contentEls = el.querySelectorAll('[data-input-region]')
              for (const target of contentEls) {
                const rect = target.getBoundingClientRect()
                if (rect.width <= 0 || rect.height <= 0) continue
                // xcb_shape_rectangles operates in X11 device pixels,
                // while getBoundingClientRect returns CSS pixels.
                // Multiply by devicePixelRatio for HiDPI displays.
                // Clamp negative coords to 0 — elements mid-animation
                // (e.g. SettingsWindow's slideInDown) report their
                // animated position, but we want the final resting spot.
                regions.push({
                  x: Math.round(Math.max(0, rect.x) * dpr),
                  y: Math.round(Math.max(0, rect.y) * dpr),
                  width: Math.round(rect.width * dpr),
                  height: Math.round(rect.height * dpr)
                })
              }
            }

            Host.sendEvent({
              name: 'OVERLAY->MAIN::set-input-regions',
              payload: { regions }
            })
          })
        })
      }

      function scheduleInputRegionUpdate () {
        if (inputRegionTimer != null) clearTimeout(inputRegionTimer)
        if (inputRegionRaf != null) { cancelAnimationFrame(inputRegionRaf); inputRegionRaf = null }
        inputRegionTimer = setTimeout(updateInputRegions, 50)
      }

      // visibilityState depends on active, so watching it covers both.
      watch(visibilityState, scheduleInputRegionUpdate, { immediate: true })
      watch(size, scheduleInputRegionUpdate)

      onUnmounted(() => {
        if (inputRegionTimer != null) clearTimeout(inputRegionTimer)
        if (inputRegionRaf != null) cancelAnimationFrame(inputRegionRaf)
      })
    }
    // --- end input shape region tracking ---

    function handleBackgroundClick () {
      if (!Host.isElectron) {
        const widget = topmostOrExclusiveWidget.value
        if (widget.wmZorder === 'exclusive') {
          hide(widget.wmId)
        }
      } else if (AppConfig().overlayBackgroundClose) {
        Host.sendEvent({ name: 'OVERLAY->MAIN::focus-game', payload: undefined })
      }
    }

    const isLinuxOverlay = Host.isElectron && navigator.platform.startsWith('Linux')

    const overlayBackground = computed<string | undefined>(() => {
      // On Linux, X11 input shape masks handle click-through at the window
      // manager level — clicks outside widget regions never reach the overlay.
      // The semi-transparent backdrop would just obscure the game for no reason.
      if (isLinuxOverlay) return undefined
      if (!active.value) return undefined
      return AppConfig().overlayBackground
    })

    function isVisible (wmId: Widget['wmId']): boolean {
      return visibilityState.value
        .find(_ => _.wmId === wmId)!
        .isVisible
    }

    document.addEventListener('click', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'file') {
        showEditingNotification.value = true
      }
    })

    function sliceLastLines (text: string, numLines: number) {
      let lfIndex = text.length - 1
      for (let i = 0; i < numLines; i++) {
        lfIndex = text.lastIndexOf('\n', lfIndex - 1)
        if (lfIndex === -1) return text
      }
      return text.slice(lfIndex + 1)
    }

    const { t } = useI18n()

    return {
      t,
      poePanelWidth,
      overlayBackground,
      widgets: computed(() => AppConfig().widgets),
      handleBackgroundClick,
      isVisible,
      overlayKey: computed(() => AppConfig().overlayKey),
      get showLogs () { return !active.value && AppConfig().logKeys },
      logs: computed(() => sliceLastLines(Host.logs.value, 11)),
      showEditingNotification: computed(() => !active.value && showEditingNotification.value),
      registry
    }
  }
})
</script>
