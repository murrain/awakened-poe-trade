import { createApp, watch } from 'vue'
import App from './web/App.vue'
import PriceCheckStandalone from './web/price-check/PriceCheckStandalone.vue'
import * as I18n from './web/i18n'
import * as Data from './assets/data'
import { initConfig, AppConfig } from './web/Config'
import { Host } from './web/background/IPC'

const isPriceCheckMode = new URLSearchParams(window.location.search).has('mode', 'price-check')

;(async function () {
  try {
    await initConfig()
    const i18nPlugin = await I18n.init(AppConfig().language)
    await Data.init(AppConfig().language)
    await Host.init()

    watch(() => AppConfig().language, async () => {
      await Data.loadForLang(AppConfig().language)
      await I18n.loadLang(AppConfig().language)
    })

    createApp(isPriceCheckMode ? PriceCheckStandalone : App)
      .use(i18nPlugin)
      .mount('#app')
  } catch (e) {
    document.getElementById('app')!.innerHTML =
      `<pre style="color:red;padding:1em">${e}\n${(e as Error).stack}</pre>`
  }
})()
