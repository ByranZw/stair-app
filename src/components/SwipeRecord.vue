<script setup lang="ts">
import { ref } from 'vue'
defineProps<{ rowClass?: string }>()
const emit = defineEmits<{ open: []; delete: [] }>()
const width = 76
const offset = ref(0),
  dragging = ref(false)
let startX = 0,
  startY = 0,
  startOffset = 0
let direction: 'horizontal' | 'vertical' | '' = ''
let suppressClickUntil = 0
/** 手势只跟踪行内容，删除按钮本身仍须明确点击才执行。 */
function start(event: TouchEvent): void {
  const point = event.touches[0]
  if (!point || event.touches.length !== 1) return
  startX = point.clientX
  startY = point.clientY
  startOffset = offset.value
  direction = ''
  dragging.value = false
}
/** 先判断方向；竖向交给页面滚动，横向只移动当前行且不越过按钮宽度。 */
function move(event: TouchEvent): void {
  const point = event.touches[0]
  if (!point || event.touches.length !== 1) return
  const dx = point.clientX - startX,
    dy = point.clientY - startY
  if (!direction) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return
    direction = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
  }
  if (direction !== 'horizontal') return
  dragging.value = true
  offset.value = Math.max(-width, Math.min(0, startOffset + dx))
}
/** 松手后吸附到展开或关闭位置，屏蔽手势尾部合成点击，避免误进详情。 */
function finish(): void {
  if (direction === 'horizontal') {
    offset.value = offset.value <= -width / 2 ? -width : 0
    suppressClickUntil = Date.now() + 350
  }
  dragging.value = false
  direction = ''
}
/** 系统接管或打断手势时回到手势前位置，不把取消当成删除。 */
function cancel(): void {
  offset.value = startOffset
  dragging.value = false
  direction = ''
  suppressClickUntil = Date.now() + 350
}
/** 展开时点击内容只收起；普通点击才交由调用方展示详情。 */
function open(): void {
  if (Date.now() < suppressClickUntil) return
  if (offset.value !== 0) offset.value = 0
  else emit('open')
}
/** 按钮仅在完全展开后可用，确认和真实删除由账本入口统一负责。 */
function remove(): void {
  if (offset.value !== -width || dragging.value) return
  offset.value = 0
  emit('delete')
}
</script>
<template>
  <view class="swipe-record">
    <button
      class="swipe-delete"
      :disabled="offset !== -width || dragging"
      :tabindex="offset === -width ? 0 : -1"
      aria-label="删除这笔交易记录"
      @click.stop="remove"
    >
      删除
    </button>
    <button
      :class="['swipe-record-content', rowClass, { 'swipe-dragging': dragging }]"
      :style="{ transform: `translate3d(${offset}px, 0, 0)` }"
      @touchstart="start"
      @touchmove="move"
      @touchend="finish"
      @touchcancel="cancel"
      @click="open"
    >
      <slot />
    </button>
  </view>
</template>
<style scoped>
.swipe-record {
  position: relative;
  overflow: hidden;
  background: #fff;
}
.swipe-record-content {
  position: relative;
  z-index: 1;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  background: #fff;
  color: inherit;
  text-align: left;
  touch-action: pan-y;
  transition: transform 180ms ease-out;
}
.swipe-record-content.swipe-dragging {
  transition: none;
}
.swipe-delete {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 76px;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0;
  background: #dc4545;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  padding: 0;
}
.swipe-delete[disabled] {
  pointer-events: none;
  background: #dc4545;
  color: #fff;
}
</style>
