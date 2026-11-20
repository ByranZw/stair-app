<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Plan, PlanEvent, PlanSnapshot } from '../domain/book'
import { formatMoney } from '../domain/money'
import { formatDateTime } from '../domain/display-time'
import BottomSheet from './BottomSheet.vue'
const props = defineProps<{ plan: Plan }>()
const visible = ref(false),
  limit = ref(20),
  expanded = ref('')
const events = computed(() => (props.plan.history || []).slice().reverse())
/** 每次打开从最近记录开始，旧记录分批展开，避免长计划一次渲染全部节点。 */
function open(): void {
  limit.value = 20
  expanded.value = ''
  visible.value = true
}
/** 参数历史同时展示前后版本，当前编辑不会改写旧参数。 */
function rules(snapshot: PlanSnapshot): string {
  return `预算 ¥${formatMoney(snapshot.budget)} · ${snapshot.parts}份 · 跌${snapshot.drop}% / 盈利${snapshot.observe}%观察 / 回撤${snapshot.retrace}%`
}
/** 用业务事件名区分参数、行情提醒和真实成交，提醒不冒充交易。 */
function title(event: PlanEvent): string {
  return {
    created: '创建计划',
    parameters: '调整参数',
    paused: '暂停计划',
    resumed: '恢复计划',
    quote:
      event.snapshot.signal === 'buy'
        ? '加仓提醒'
        : event.snapshot.signal === 'sell'
          ? '止盈提醒'
          : '行情跟踪',
    trade: '交易与申请',
    restored: '恢复账本',
    'corporate-action': '事件待核对',
    opening: '初始持仓调整',
  }[event.kind]
}
</script>
<template>
  <button class="setting-row full" aria-label="查看计划历史" @click="open">
    <text>计划历史</text><text class="small muted">{{ events.length }} 条记录 ›</text>
  </button>
  <BottomSheet v-model="visible" title="计划历史">
    <view v-if="!events.length" class="empty">暂无历史记录</view>
    <view v-for="event in events.slice(0, limit)" :key="event.id" class="history-event">
      <button
        class="history-event-toggle full"
        @click="expanded = expanded === event.id ? '' : event.id"
      >
        <view class="row"
          ><text class="history-event-title">{{ title(event) }}</text
          ><text class="badge">v{{ event.snapshot.version }}</text></view
        >
        <view class="sub">{{ formatDateTime(event.recordedAt) }}</view>
        <view v-if="event.quote" class="small blue"
          >{{
            event.quote.buyValue ? '客户卖出价' : event.quote.kind === 'nav' ? '正式净值' : '市场价'
          }}
          {{ event.quote.value
          }}<text v-if="event.quote.buyValue"> · 客户买入价 {{ event.quote.buyValue }}</text> ·
          {{ event.quote.date }}</view
        >
        <view class="small muted" style="margin-top: 8px">{{
          expanded === event.id ? '收起详情 ⌃' : '展开详情 ⌄'
        }}</view>
      </button>
      <view v-if="expanded === event.id" class="history-evidence">
        <view class="history-reason">{{ event.reason }}</view>
        <view v-if="event.previous && event.kind === 'parameters'" class="small muted"
          >调整前 v{{ event.previous.version }}：{{ rules(event.previous) }}</view
        >
        <view class="small">当时参数：{{ rules(event.snapshot) }}</view>
        <view v-if="event.snapshot.initialLastBuy" class="small"
          >导入前上次实际买价 {{ event.snapshot.initialLastBuy }}</view
        >
        <view v-if="event.basis" class="small">
          <view
            >已投 ¥{{ formatMoney(event.basis.used) }} · 预留 ¥{{
              formatMoney(event.basis.reserved)
            }}</view
          >
          <view v-if="event.basis.unitCost"
            >当时单位成本 {{ formatMoney(event.basis.unitCost, 4) }}</view
          >
          <view v-if="event.basis.lastBuy">上次实际买价 {{ event.basis.lastBuy }}</view>
          <view v-if="event.basis.buyAt">当时下一买点 {{ formatMoney(event.basis.buyAt, 4) }}</view>
          <view v-if="event.basis.sellAt"
            >当时回撤止盈线 {{ formatMoney(event.basis.sellAt, 4) }}</view
          >
        </view>
        <view v-if="event.snapshot.high" class="small">当时采样高点 {{ event.snapshot.high }}</view>
        <view v-if="event.quote" class="sub">来源：{{ event.quote.source }}</view>
        <view v-if="event.tradeId" class="sub">关联流水：{{ event.tradeId }}</view>
      </view>
    </view>
    <button v-if="events.length > limit" class="secondary full" @click="limit += 20">
      加载更早记录
    </button>
  </BottomSheet>
</template>
<style scoped>
.history-event {
  border-bottom: 1px solid #edf0f5;
  padding: 14px 0;
}
.history-event-toggle {
  padding: 0;
  text-align: left;
  background: transparent;
  line-height: 1.6;
}
.history-event-title {
  font-size: 14px;
  font-weight: 700;
}
.history-reason {
  font-size: 13px;
  margin: 8px 0;
  color: #4f5d75;
}
.history-evidence {
  margin-top: 12px;
  padding: 12px;
  background: #f5f7fb;
  border-radius: 12px;
  line-height: 1.8;
}
</style>
