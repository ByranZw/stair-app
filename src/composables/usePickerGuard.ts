import { onBeforeUnmount, ref } from 'vue'

/** 选择面板收起时短暂锁住下层提交，避免退场未完成就卸载整个表单。 */
export function usePickerGuard() {
  const pickerSettling = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 留出浮层240ms退场动画及一帧余量，不延迟字段本身的更新。 */
  function settlePicker(): void {
    pickerSettling.value = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      pickerSettling.value = false
      timer = undefined
    }, 300)
  }
  /** 弹窗或页面卸载时取消本组件计时器，不保留失效响应式引用。 */
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })
  return { pickerSettling, settlePicker }
}
