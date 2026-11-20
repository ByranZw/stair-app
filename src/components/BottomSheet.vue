<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, nextTick, ref, watch } from 'vue'
import { sheetBackKey } from '../composables/useSheetBack'
import { showToast } from '../state/feedback'
const props = defineProps<{
  modelValue: boolean
  title: string
  tabPage?: boolean
  contained?: boolean
  height?: string
  variant?: 'sheet' | 'dialog'
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; closed: [] }>()
const rendered = ref(false),
  leaving = ref(false)
let preparing = false,
  tabHidden = false,
  disposed = false
let leaveTimer: ReturnType<typeof setTimeout> | undefined
const backStack = inject(sheetBackKey)
let releaseBack: (() => void) | undefined
/** 抽屉只关闭自身，退场期间保留内容，不提交表单或创建交易。 */
function close() {
  if (props.modelValue) emit('update:modelValue', false)
}
/** 退场或卸载才释放返回拦截，避免连续返回穿透到下一级页面。 */
function unregisterBack() {
  releaseBack?.()
  releaseBack = undefined
}
/** 仅恢复本组件隐藏过的导航；非Tab详情页不调用导航API。 */
function restoreTabBar() {
  if (!tabHidden) return
  tabHidden = false
  uni.showTabBar({ animation: false })
}
/** 等待原生导航隐藏后再挂载，避免浮层出现时导航还压在上面。 */
function open() {
  if (!props.modelValue || preparing || rendered.value || disposed) return
  preparing = true
  if (props.tabPage) {
    tabHidden = true
    uni.hideTabBar({
      animation: false,
      success: show,
      fail: () => {
        preparing = false
        restoreTabBar()
        if (!disposed) {
          close()
          showToast('打开浮层失败，请重试')
        }
      },
    })
  } else show()
}
/** 隐藏回调可能晚于关闭或卸载，只在当前仍需要时呈现浮层。 */
function show() {
  preparing = false
  if (disposed || !props.modelValue) {
    unregisterBack()
    restoreTabBar()
    emit('closed')
    return
  }
  leaving.value = false
  rendered.value = true
}
/** 退场完成才移除内容和恢复导航；快速重开先完成本次退场。 */
function afterAnimation() {
  if (!leaving.value) return
  rendered.value = false
  leaving.value = false
  if (props.modelValue) {
    // 等待本轮移除提交后重新挂载，确保下一次入场动画也能触发。
    nextTick(open)
  } else {
    unregisterBack()
    restoreTabBar()
    emit('closed')
  }
}
watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      if (!releaseBack) releaseBack = backStack?.register(close)
      // 等本轮属性更新完成再读取Tab归属，避免动态选择面板先开后隐藏导航。
      nextTick(open)
    } else if (rendered.value && !leaving.value) {
      leaving.value = true
      // App-vue不转发CSS animationend；220ms退场后留一帧再恢复原生导航。
      nextTick(() => {
        leaveTimer = setTimeout(afterAnimation, 240)
      })
    } else if (!preparing && !rendered.value) {
      unregisterBack()
      emit('closed')
    }
  },
  { immediate: true, flush: 'sync' },
)
// #ifdef H5
/** 浏览器调试保留Demo的Escape关闭交互，不让监听跨组件生命周期残留。 */
function onKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !props.modelValue || event.defaultPrevented) return
  event.preventDefault()
  if (backStack) backStack.back()
  else close()
}
onMounted(() => window.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
// #endif
/** 卸载后禁止迟到的隐藏回调重新拉起浮层，并最终恢复原生导航。 */
onBeforeUnmount(() => {
  disposed = true
  unregisterBack()
  clearTimeout(leaveTimer)
  if (!preparing) restoreTabBar()
})
</script>
<template>
  <view
    v-if="rendered"
    class="overlay"
    :class="{ 'sheet-leaving': leaving, 'dialog-overlay': variant === 'dialog' }"
  >
    <view class="sheet-mask" @click="close" />
    <view
      class="sheet"
      :style="height ? { height } : undefined"
      :role="variant === 'dialog' ? 'alertdialog' : 'dialog'"
      aria-modal="true"
      :aria-label="title"
    >
      <view class="sheet-header">
        <view v-if="variant !== 'dialog'" class="handle" /><view class="sheet-head"
          ><view class="sheet-title">{{ title }}</view
          ><button class="close" aria-label="关闭" @click="close">×</button></view
        >
      </view>
      <view class="sheet-body" :class="{ 'sheet-body-contained': contained }"><slot /></view>
      <view v-if="$slots.footer" class="sheet-footer"><slot name="footer" /></view>
    </view>
  </view>
</template>
