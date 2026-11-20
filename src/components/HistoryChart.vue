<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { HistoryPoint } from '../domain/market'
import type { Trade } from '../domain/book'
import type { ChartReference } from '../domain/chart'
import { startsHistorySegment } from '../domain/chart'
const props = defineProps<{
  points: HistoryPoint[]
  mini?: boolean
  trades?: Trade[]
  cost?: string
  references?: ChartReference[]
  candles?: boolean
  minute?: boolean
  active?: boolean
}>()
const emit = defineEmits<{ selectTrade: [id: string] }>()
const instance = getCurrentInstance(),
  canvasId = `history-${instance?.uid}`
const count = ref(props.minute ? 250 : 120),
  offset = ref(0),
  selected = ref(-1),
  moving = ref(false),
  expanded = ref(false)
const showCost = ref(true),
  showBuy = ref(false),
  showSell = ref(false)
const visible = computed(() => {
  if (props.mini) return props.points
  const end = Math.max(1, props.points.length - offset.value)
  return props.points.slice(Math.max(0, end - count.value), end)
})
const pointer = computed(() => visible.value[selected.value])
const height = computed(() => (props.mini ? 23 : expanded.value ? 300 : 204))
let ready = false,
  width = 0
let markers: { x: number; y: number; id: string }[] = [],
  lastSelected = ''
let startX = 0,
  startOffset = 0,
  startCount = 0,
  startDistance = 0

/** 缩放以末端为锚，最多覆盖已加载历史，不把空白当新行情。 */
function zoom(factor: number): void {
  count.value = Math.min(props.points.length, Math.max(10, Math.round(count.value * factor)))
  selected.value = -1
}
/** 翻阅固定窗口，起止日期始终在图下显示。 */
function pan(direction: number): void {
  offset.value = Math.max(
    0,
    Math.min(
      Math.max(0, props.points.length - count.value),
      offset.value + Math.round(count.value / 2) * direction,
    ),
  )
  selected.value = -1
}
/** 全屏改变容器尺寸；退出及页面卸载恢复竖屏。 */
function toggleExpanded(): void {
  expanded.value = !expanded.value
  // #ifdef APP-PLUS
  plus.screen.lockOrientation(expanded.value ? 'landscape-primary' : 'portrait-primary')
  // #endif
  void draw()
}
/** 转成画布局部坐标，兼容H5/App触摸与点击。 */
function locate(event: unknown, callback: (x: number, y: number) => void): void {
  const e = event as {
    detail?: { x?: number; y?: number }
    touches?: { clientX: number; clientY: number; x?: number; y?: number }[]
    changedTouches?: { clientX: number; clientY: number; x?: number; y?: number }[]
  }
  const touch = e.touches?.[0] || e.changedTouches?.[0]
  uni
    .createSelectorQuery()
    .in(instance?.proxy)
    .select(`#${canvasId}`)
    .boundingClientRect((rect) => {
      if (!rect || Array.isArray(rect) || rect.left === undefined || rect.top === undefined) return
      callback(
        touch?.x ?? (touch ? touch.clientX - rect.left : (e.detail?.x ?? rect.left) - rect.left),
        touch?.y ?? (touch ? touch.clientY - rect.top : (e.detail?.y ?? rect.top) - rect.top),
      )
    })
    .exec()
}
/** 指针吸附真实数据点，不插值生成不存在的价格。 */
function selectAt(x: number): void {
  selected.value = Math.max(
    0,
    Math.min(
      visible.value.length - 1,
      Math.round(((x - 39) / Math.max(1, width - 47)) * (visible.value.length - 1)),
    ),
  )
}
/** 命中成交点循环选择同位置记录；其他位置显示十字线。 */
function tap(event: unknown): void {
  if (props.mini || moving.value) return
  locate(event, (x, y) => {
    const hits = markers.filter((marker) => Math.hypot(marker.x - x, marker.y - y) < 18)
    if (hits.length) {
      const index = hits.findIndex((marker) => marker.id === lastSelected)
      const chosen = hits[(index + 1) % hits.length]
      lastSelected = chosen.id
      emit('selectTrade', chosen.id)
    } else selectAt(x)
  })
}
/** App画布通过桥传递可枚举的局部x/y，浏览器触摸还保留client坐标。 */
interface CanvasTouch {
  x?: number
  y?: number
  clientX: number
  clientY: number
}
/** App桥的触点是数字索引对象；统一为数组，并在同一坐标系内计算距离。 */
function touchPoints(event: unknown): { x: number; y: number }[] {
  return Object.values((event as { touches: Record<string, CanvasTouch> }).touches).map(
    (touch) => ({
      x: touch.x ?? touch.clientX,
      y: touch.y ?? touch.clientY,
    }),
  )
}
/** 记录手势起点，双指缩放与单指移动使用独立的用户模式。 */
function touchStart(event: unknown): void {
  const touches = touchPoints(event)
  startX = touches[0].x
  startOffset = offset.value
  startCount = count.value
  startDistance =
    touches.length > 1 ? Math.hypot(touches[1].x - startX, touches[1].y - touches[0].y) : 0
}
/** 手势仅改变可视窗口，不借移动发起持续网络请求。 */
function touchMove(event: unknown): void {
  const touches = touchPoints(event)
  if (touches.length > 1 && startDistance) {
    const distance = Math.hypot(touches[1].x - touches[0].x, touches[1].y - touches[0].y)
    if (distance > 0)
      count.value = Math.max(
        10,
        Math.min(props.points.length, Math.round((startCount * startDistance) / distance)),
      )
  } else if (moving.value)
    offset.value = Math.max(
      0,
      Math.min(
        Math.max(0, props.points.length - count.value),
        startOffset + Math.round(((touches[0].x - startX) / Math.max(1, width - 47)) * count.value),
      ),
    )
  else locate(event, (x) => selectAt(x))
}
/** 异步测量前后重新读取页面状态，隐藏或卸载后不再使用当前页的原生上下文。 */
function canDraw(): boolean {
  return ready && props.active !== false
}
/** 延续Demo蓝色曲线；日K红涨绿跌，参考线按历史快照分段，成交使用实际价格。 */
async function draw(): Promise<void> {
  if (!canDraw()) return
  await nextTick()
  if (!canDraw()) return
  uni
    .createSelectorQuery()
    .in(instance?.proxy)
    .select(`#${canvasId}`)
    .boundingClientRect((rect) => {
      if (!canDraw() || !rect || Array.isArray(rect) || !rect.width) return
      width = rect.width
      const h = height.value,
        points = visible.value,
        context = uni.createCanvasContext(canvasId, instance?.proxy)
      context.clearRect(0, 0, width, h)
      markers = []
      if (!points.length) {
        context.draw()
        return
      }
      const left = props.mini ? 0 : 39,
        right = props.mini ? 0 : 8,
        top = props.mini ? 1 : 12,
        bottom = props.mini ? 1 : 16
      const first = points[0].startDate || points[0].date,
        last = points[points.length - 1].date
      const trades = (props.trades || []).filter(
        (t) =>
          t.status === 'confirmed' &&
          (props.minute
            ? !!t.time &&
              `${t.date} ${t.time.slice(0, 5)}` >= first &&
              `${t.date} ${t.time.slice(0, 5)}` <= last
            : t.date >= first.slice(0, 10) && t.date <= last.slice(0, 10)),
      )
      const references = points.map((point) =>
        [...(props.references || [])].reverse().find((r) => r.date <= point.date.slice(0, 10)),
      )
      const values = points.flatMap((p) =>
        props.candles ? [Number(p.value), Number(p.high), Number(p.low)] : [Number(p.value)],
      )
      if (!props.mini) {
        values.push(...trades.map((t) => Number(t.price)))
        for (const r of references) {
          if (showCost.value && r?.cost) values.push(Number(r.cost))
          if (showBuy.value && r?.buy) values.push(Number(r.buy))
          if (showSell.value && r?.sell) values.push(Number(r.sell))
        }
        if (!props.references && showCost.value && Number(props.cost) > 0)
          values.push(Number(props.cost))
      }
      const low = Math.min(...values),
        high = Math.max(...values),
        padding = Math.max((high - low) * 0.15, high * 0.002, 0.0001),
        min = low - padding,
        span = high - low + padding * 2
      const xAt = (index: number) =>
        left + (points.length === 1 ? 0.5 : index / (points.length - 1)) * (width - left - right)
      const yAt = (value: string | number) =>
        h - bottom - ((Number(value) - min) / span) * (h - top - bottom)
      if (!props.mini) {
        context.setStrokeStyle('#edf0f5')
        context.setLineWidth(1)
        context.setFillStyle('#9aa5b5')
        context.setFontSize(8)
        context.setTextAlign('left')
        for (let line = 0; line < 4; line++) {
          const y = top + (line * (h - top - bottom)) / 3
          context.beginPath()
          context.moveTo(left, y)
          context.lineTo(width - right, y)
          context.stroke()
          context.fillText((min + span * (1 - line / 3)).toFixed(3), 1, y + 3)
        }
      }
      if (props.candles && !props.mini) {
        const bodyWidth = Math.max(1, Math.min(12, ((width - left - right) / points.length) * 0.65))
        points.forEach((p, index) => {
          if (!p.open || !p.high || !p.low) return
          const color = Number(p.value) >= Number(p.open) ? '#e55c62' : '#299985'
          context.setStrokeStyle(color)
          context.setFillStyle(color)
          context.beginPath()
          context.moveTo(xAt(index), yAt(p.high))
          context.lineTo(xAt(index), yAt(p.low))
          context.stroke()
          context.fillRect(
            xAt(index) - bodyWidth / 2,
            Math.min(yAt(p.open), yAt(p.value)),
            bodyWidth,
            Math.max(1, Math.abs(yAt(p.open) - yAt(p.value))),
          )
        })
      } else {
        if (!props.mini && !points.some((_, i) => i > 0 && startsHistorySegment(points, i))) {
          const gradient = context.createLinearGradient(0, 0, 0, h)
          gradient.addColorStop(0, 'rgba(40,88,223,.14)')
          gradient.addColorStop(1, 'rgba(40,88,223,0)')
          context.setFillStyle(gradient)
          context.beginPath()
          context.moveTo(xAt(0), h - bottom)
          points.forEach((p, i) => context.lineTo(xAt(i), yAt(p.value)))
          context.lineTo(xAt(points.length - 1), h - bottom)
          context.closePath()
          context.fill()
        }
        context.setStrokeStyle('#2858df')
        context.setLineWidth(props.mini ? 1.3 : 2)
        context.beginPath()
        points.forEach((p, i) => {
          if (startsHistorySegment(points, i)) context.moveTo(xAt(i), yAt(p.value))
          else context.lineTo(xAt(i), yAt(p.value))
        })
        context.stroke()
      }
      points.forEach((point, index) => {
        if (points.length !== 1 && !point.sampledAt) return
        context.setFillStyle('#2858df')
        context.beginPath()
        context.arc(xAt(index), yAt(point.value), props.mini ? 1.5 : 3, 0, Math.PI * 2)
        context.fill()
      })
      if (!props.mini) {
        for (const [key, enabled, color] of [
          ['cost', showCost.value, '#9aa5b5'],
          ['buy', showBuy.value, '#dfab45'],
          ['sell', showSell.value, '#e55c62'],
        ] as const) {
          if (!enabled) continue
          context.setStrokeStyle(color)
          context.setLineWidth(1)
          context.setLineDash([4, 3], 0)
          context.beginPath()
          let previous: string | undefined
          points.forEach((_, i) => {
            const value =
              references[i]?.[key] || (!props.references && key === 'cost' ? props.cost : undefined)
            if (value && Number(value) > 0) {
              if (previous) {
                context.lineTo(xAt(i), yAt(previous))
                context.lineTo(xAt(i), yAt(value))
              } else context.moveTo(xAt(i), yAt(value))
              previous = value
            } else previous = undefined
          })
          context.stroke()
          context.setLineDash([], 0)
        }
        for (const trade of trades) {
          const date = props.minute ? `${trade.date} ${trade.time.slice(0, 5)}` : trade.date,
            index = points.findIndex((p) => p.date >= date)
          if (index < 0) continue
          const x = xAt(index),
            y = yAt(trade.price)
          markers.push({ x, y, id: trade.id })
          context.setFillStyle(trade.side === 'buy' ? '#2858df' : '#e55c62')
          context.beginPath()
          context.arc(x, y, 7, 0, Math.PI * 2)
          context.fill()
          context.setFillStyle('#fff')
          context.setFontSize(8)
          context.setTextAlign('center')
          context.fillText(trade.side === 'buy' ? 'B' : 'S', x, y + 3)
        }
        if (pointer.value) {
          const x = xAt(selected.value),
            y = yAt(pointer.value.value)
          context.setStrokeStyle('#8ba5e9')
          context.setLineWidth(1)
          context.setLineDash([2, 3], 0)
          context.beginPath()
          context.moveTo(x, top)
          context.lineTo(x, h - bottom)
          context.moveTo(left, y)
          context.lineTo(width - right, y)
          context.stroke()
          context.setLineDash([], 0)
        }
      }
      context.draw()
    })
    .exec()
}
/** 挂载后读取真实宽度，避免初始化零尺寸。 */
onMounted(() => {
  ready = true
  uni.onWindowResize(draw)
  void draw()
})
/** 页面退出释放横屏状态，避免下一页继承图表方向。 */
onBeforeUnmount(() => {
  ready = false
  uni.offWindowResize(draw)
  // #ifdef APP-PLUS
  if (expanded.value) plus.screen.lockOrientation('portrait-primary')
  // #endif
})
watch(
  () => props.active,
  (active) => {
    if (active) void draw()
  },
)
watch(
  () => [props.points, props.minute, props.candles],
  () => {
    offset.value = 0
    selected.value = -1
    count.value = props.minute ? 250 : 120
    void draw()
  },
)
watch(
  () => [
    visible.value,
    props.trades,
    props.references,
    props.cost,
    selected.value,
    showCost.value,
    showBuy.value,
    showSell.value,
    expanded.value,
  ],
  () => {
    void draw()
  },
)
</script>
<template>
  <view class="history-chart" :class="{ expanded }">
    <view v-if="!mini" class="chart-tools">
      <button @click="pan(1)" aria-label="查看更早区间">‹</button
      ><button @click="zoom(0.65)" aria-label="放大图表">＋</button
      ><button @click="zoom(1.5)" aria-label="缩小图表">−</button
      ><button @click="pan(-1)" aria-label="查看更晚区间">›</button>
      <button :class="{ active: moving }" @click="moving = !moving">
        {{ moving ? '移动中' : '指针' }}</button><button @click="toggleExpanded">
        {{ expanded ? '退出全屏' : '全屏' }}
      </button>
    </view>
    <view v-if="!mini && pointer" class="chart-pointer num"
      >{{ pointer.date }} · {{ candles ? '收 ' : '' }}{{ pointer.value
      }}<text v-if="candles">
        · 开 {{ pointer.open }} 高 {{ pointer.high }} 低 {{ pointer.low }}</text
      ></view
    >
    <canvas
      :id="canvasId"
      :canvas-id="canvasId"
      :disable-scroll="true"
      :style="{ width: '100%', height: height + 'px' }"
      @click="tap"
      @touchstart="touchStart"
      @touchmove="touchMove"
    />
    <view v-if="!mini && visible.length" class="chart-labels"
      ><text>{{ visible[0].startDate || visible[0].date }}</text
      ><text>{{ visible[visible.length - 1].date }}</text></view
    >
    <view v-if="!mini && (!minute || references?.length)" class="chart-lines"
      ><button :class="{ active: showCost }" @click="showCost = !showCost">成本线</button
      ><button :class="{ active: showBuy }" @click="showBuy = !showBuy">下一买点</button
      ><button :class="{ active: showSell }" @click="showSell = !showSell">止盈线</button></view
    >
    <view v-if="expanded" class="tip"
      >双指缩放；切换移动后单指平移。点击 B / S 查看成交，同位置记录可重复点击切换。</view
    >
  </view>
</template>
<style scoped>
.history-chart {
  position: relative;
}
.history-chart.expanded {
  position: fixed;
  inset: 0;
  z-index: 1500;
  background: #fff;
  padding: 16px 24px;
  overflow: auto;
  padding-top: max(16px, env(safe-area-inset-top));
}
.chart-tools,
.chart-lines {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0;
}
.chart-tools button,
.chart-lines button {
  padding: 5px 9px;
  margin: 0;
  font-size: 10px;
  line-height: 1.5;
  color: #8795aa;
  background: #f5f7fb;
  border-radius: 7px;
}
.chart-tools button.active,
.chart-lines button.active {
  color: #2858df;
  background: #edf2ff;
}
.chart-pointer {
  position: absolute;
  z-index: 2;
  top: 38px;
  left: 40px;
  right: 8px;
  padding: 7px;
  background: rgba(245, 247, 251, 0.95);
  font-size: 10px;
  color: #536582;
  border-radius: 6px;
  pointer-events: none;
}
</style>
