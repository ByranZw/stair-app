/** 页面内的浮层按打开顺序处理返回，退场期间仍保留拦截。 */
export function createSheetBackStack() {
  const layers: Array<() => void> = []
  return {
    /** 选择面板只在没有下层浮层时接管Tab栏的隐藏与恢复。 */
    hasLayers(): boolean {
      return layers.length > 0
    },
    /** 注册当前打开的浮层，返回清理函数供退场完成或卸载时调用。 */
    register(close: () => void) {
      layers.push(close)
      return () => {
        const index = layers.indexOf(close)
        if (index >= 0) layers.splice(index, 1)
      }
    },
    /** 只关闭最上层；关闭被表单拒绝或正在退场时也不返回页面。 */
    back(): boolean {
      const close = layers[layers.length - 1]
      if (!close) return false
      close()
      return true
    },
  }
}
