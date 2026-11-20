import { ref } from 'vue'
export const toastMessage = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
/** 沿用Demo底部提示样式；新消息替换旧提示，不堆叠定时器。 */
export function showToast(message: string): void {
  if (timer) clearTimeout(timer)
  toastMessage.value = message
  timer = setTimeout(() => {
    toastMessage.value = ''
    timer = undefined
  }, 1800)
}
