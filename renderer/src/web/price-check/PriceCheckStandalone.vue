<template>
  <div id="app" class="text-sm font-poe-sc">
    <div id="overlay-window" class="overflow-hidden relative w-full h-full"
      :style="{ '--game-panel': '0px' }">
      <PriceCheckWindow v-if="config" :config="config" />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, provide, shallowRef, readonly, computed, onMounted } from 'vue'
import PriceCheckWindow from './PriceCheckWindow.vue'
import { Host } from '@/web/background/IPC'
import { AppConfig } from '@/web/Config'
import { useLeagues } from '@/web/background/Leagues'
import type { WidgetManager, PriceCheckWidget } from '@/web/overlay/interfaces'

export default defineComponent({
  components: { PriceCheckWindow },
  setup () {
    const config = computed<PriceCheckWidget | undefined>(() => {
      return AppConfig().widgets.find(w => w.wmType === 'price-check') as PriceCheckWidget | undefined
    })

    useLeagues().load()

    const active = shallowRef(true)
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

    // Receive item-text dispatched via executeJavaScript from main process.
    // This bypasses the WebSocket lastActiveClient which is unreliable
    // (the overlay can reclaim it at any time).
    document.addEventListener('__price-check-item', ((e: CustomEvent) => {
      Host.selfDispatch(e.detail)
    }) as EventListener)

    // When the overlay broadcasts hide-exclusive-widget, dismiss via the
    // same focus-game signal that the close button uses.
    Host.onEvent('MAIN->OVERLAY::hide-exclusive-widget', () => {
      Host.sendEvent({ name: 'OVERLAY->MAIN::focus-game', payload: undefined })
    })

    provide('standaloneMode', true)

    provide<WidgetManager>('wm', {
      poePanelWidth: computed(() => 0),
      size: readonly(size),
      active,
      widgets: computed(() => config.value ? [config.value] : []),
      show: (_wmId: number) => {
        if (config.value) {
          config.value.wmWants = 'show'
        }
      },
      hide: (_wmId: number) => {
        if (config.value) {
          config.value.wmWants = 'hide'
        }
      },
      remove: () => {},
      bringToTop: () => {},
      create: () => {},
      setFlag: (wmId: number, flag: string, state: boolean) => {
        if (!config.value || config.value.wmId !== wmId) return
        const hasFlag = config.value.wmFlags.includes(flag)
        if (state && !hasFlag) {
          config.value.wmFlags.push(flag)
        } else if (!state && hasFlag) {
          config.value.wmFlags = config.value.wmFlags.filter(f => f !== flag)
        }
      }
    })

    // Signal readiness via a dedicated event that does NOT participate
    // in lastActiveClient rotation (unlike used-recently).
    onMounted(() => {
      Host.sendEvent({
        name: 'CLIENT->MAIN::price-check-ready',
        payload: undefined
      })
    })

    return { config }
  }
})
</script>

<style>
@import url('@fortawesome/fontawesome-free/css/all.min.css');
@import url('animate.css/animate.css');
@import url('../../assets/font.css');
@tailwind base;
@tailwind components;
@tailwind utilities;

#app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;

  :focus {
    outline: 0;
  }
}

.layout-column {
  display: flex;
  flex-direction: column;
  height: 100%;
}

::-webkit-scrollbar {
  width: 0.875rem;
}

::-webkit-scrollbar-track {
  -webkit-box-shadow: inset 0 0 0.375rem rgba(0,0,0,0.3);
}

::-webkit-scrollbar-thumb {
  -webkit-box-shadow: inset 0 0 0.375rem rgba(0,0,0,0.5);
}

input[type=number]::-webkit-inner-spin-button,
input[type=number]::-webkit-outer-spin-button {
  -webkit-appearance: none;
}

.btn {
  @apply bg-gray-700;
  @apply px-2 py-1;
  @apply text-gray-400;
  @apply leading-none;
  @apply rounded;
}

.btn-icon {
  @apply text-xs text-gray-600;
}
</style>
