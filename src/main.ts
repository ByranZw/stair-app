import { createSSRApp } from 'vue'
import App from './App.vue'

/** 双端共享应用入口，不在启动时创建示例资金或交易。 */
export function createApp() {
  return { app: createSSRApp(App) }
}
