import { ref } from 'vue'

/** App生命周期提供真实前后台状态，详情页离开和应用隐藏都必须停止采集。 */
export const appVisible = ref(true)
