import { inject, provide, ref, shallowRef, type InjectionKey, type Ref, type ShallowRef } from 'vue'

/** 选择面板只持有临时选择；确认后才调用业务字段原有的change处理器。 */
export interface SelectionRequest {
  title: string
  mode: 'selector' | 'date' | 'time'
  options: string[]
  value: string
  start: string
  end: string
  select: (value: string) => void
}
/** 每个页面独立提供选择状态，宿主放在页面末尾以免被业务浮层裁切。 */
export function usePageSelection(tabPage = false) {
  const state = { request: shallowRef<SelectionRequest>(), visible: ref(false), tabPage }
  provide(selectionKey, state)
}
const selectionKey: InjectionKey<{
  request: ShallowRef<SelectionRequest | undefined>
  visible: Ref<boolean>
  tabPage: boolean
}> = Symbol('selection')

/** 触发器与页面宿主共享同一状态，不把选择挂到已隐藏的其他页面。 */
export function useSelection() {
  return inject(selectionKey)!
}
