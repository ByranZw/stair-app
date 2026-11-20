/** 可见页面按请求完成后计时；停止不取消在途请求，但阻止旧会话重新创建定时器。 */
export function createVisiblePoller(refresh: () => Promise<void>, delay = 30000) {
  let visible = false,
    running = false,
    generation = 0,
    timer: ReturnType<typeof setTimeout> | undefined

  /** 同一实例串行刷新，返回前台期间的旧请求完成后立即接续新会话。 */
  async function run(): Promise<void> {
    if (!visible || running) return
    running = true
    const startedGeneration = generation
    try {
      await refresh()
    } catch {
      // 行情层负责呈现失败与旧缓存；单次失败不终止后续可见期间的刷新。
    } finally {
      running = false
      if (visible) {
        if (startedGeneration !== generation) void run()
        else timer = setTimeout(() => void run(), delay)
      }
    }
  }
  return {
    start: () => {
      if (visible) return
      visible = true
      generation++
      void run()
    },
    stop: () => {
      visible = false
      generation++
      clearTimeout(timer)
      timer = undefined
    },
  }
}
