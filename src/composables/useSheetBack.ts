import { provide, type InjectionKey } from 'vue'
import { onBackPress } from '@dcloudio/uni-app'
import { createSheetBackStack } from '../services/sheet-back'

export const sheetBackKey: InjectionKey<ReturnType<typeof createSheetBackStack>> =
  Symbol('sheetBack')

/** 在页面注册同步返回钩子，子浮层共享该页面的栈，不影响其他页面。 */
export function usePageSheetBack() {
  const stack = createSheetBackStack()
  provide(sheetBackKey, stack)
  onBackPress(() => stack.back())
}
