import { inject, onBeforeUnmount, provide, type InjectionKey } from 'vue'
import { onHide } from '@dcloudio/uni-app'
import { createDialogController } from '../services/dialog'
const dialogKey: InjectionKey<ReturnType<typeof createDialogController> & { tabPage: boolean }> =
  Symbol('dialog')

/** 每页独立持有确认请求，隐藏或卸载页面时取消待处理操作。 */
export function usePageDialog(tabPage = false) {
  const dialog = { ...createDialogController(), tabPage }
  provide(dialogKey, dialog)
  onHide(() => dialog.cancel())
  onBeforeUnmount(() => dialog.cancel())
  return dialog
}

/** 业务组件使用所属页面的确认宿主，避免弹窗挂到已隐藏的Tab页面。 */
export function useDialog() {
  return inject(dialogKey)!
}
