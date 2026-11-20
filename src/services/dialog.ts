import { ref, shallowRef } from 'vue'

/** 应用内确认框使用简明说明与独立记录摘要，避免把关键信息挤进长段落。 */
export interface DialogRequest {
  title: string
  message?: string
  detail?: string
  confirmText?: string
  destructive?: boolean
  alert?: boolean
}

/** 页面独立管理一次确认，退场结束才执行操作，避免连续弹窗互相覆盖。 */
export function createDialogController() {
  const request = shallowRef<DialogRequest>()
  const visible = ref(false)
  let resolve: ((value: boolean) => void) | undefined
  let answer = false
  return {
    request,
    visible,
    /** 同时只接受一个待确认请求，重复点击不能覆盖当前确认对象。 */
    confirm(input: DialogRequest): Promise<boolean> {
      if (resolve) return Promise.resolve(false)
      request.value = { ...input }
      answer = false
      visible.value = true
      return new Promise<boolean>((done) => {
        resolve = done
      })
    },
    /** 确认、蒙版、关闭按钮和系统返回都先进入统一退场。 */
    answer(value: boolean): void {
      if (!resolve || !visible.value) return
      answer = value
      visible.value = false
    },
    /** 浮层完成退场后只结算一次，随后业务才开始写入或显示下一条提示。 */
    finish(): void {
      const done = resolve
      resolve = undefined
      request.value = undefined
      visible.value = false
      done?.(answer)
    },
    /** 离开页面取消未完成确认，不把稍后返回当成之前已经同意。 */
    cancel(): void {
      answer = false
      this.finish()
    },
  }
}
