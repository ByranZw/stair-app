<script setup lang="ts">
import AppPicker from '../../components/AppPicker.vue'
import PageOverlays from '../../components/PageOverlays.vue'
import { usePageSelection } from '../../composables/useSelection'
usePageSelection()
import { usePageDialog } from '../../composables/useDialog'
import { usePageSheetBack } from '../../composables/useSheetBack'
usePageSheetBack()
usePageDialog()
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app'
import { appVisible } from '../../state/app-visibility'
import { createVisiblePoller } from '../../services/visible-poller'
import { goldToday, goldSampleChanges } from '../../domain/gold-history'
import { sgeSessionLabel, sgeMinutePoints } from '../../domain/sge-session'
import {
  watchState,
  refreshInstrument,
  refreshMinute,
  loadMoreHistory,
  refreshGoldHistory,
} from '../../state/watchlist'
import { aggregateCandles, chartReferences } from '../../domain/chart'
import HistoryChart from '../../components/HistoryChart.vue'
import PlanHistory from '../../components/PlanHistory.vue'
import PlanReminderNotice from '../../components/PlanReminderNotice.vue'
import { allPlanReminders } from '../../state/plan-reminders'
import CorporateActions from '../../components/CorporateActions.vue'
import AppToast from '../../components/AppToast.vue'
import { showToast } from '../../state/feedback'
import AppIcon from '../../components/AppIcon.vue'
import DataMaintenance from '../../components/DataMaintenance.vue'
import BookActions from '../../components/BookActions.vue'
import SwipeRecord from '../../components/SwipeRecord.vue'
import { bookState, projection, selectedAccountId, initializeBook } from '../../state/book'
import { positionKey } from '../../domain/book'
import { D, formatMoney } from '../../domain/money'
const maintenance = ref<InstanceType<typeof DataMaintenance>>()
const opening = computed(() =>
  bookState.data.openings.find(
    (row) => row.accountId === accountId.value && row.instrumentId === id.value,
  ),
)
const id = ref(''),
  pageVisible = ref(false),
  chartClock = ref(new Date()),
  today = ref(goldToday()),
  sampleLimit = ref(10),
  chartVisible = ref(true),
  chartHelp = ref(false),
  range = ref(90),
  chartMode = ref<'line' | 'minute' | 'day' | 'week' | 'month'>('line'),
  accountId = ref(''),
  planId = ref(''),
  actions = ref<InstanceType<typeof BookActions>>()
// 原生选择器以当前页面为上下文，后台页面不能跨页测量自己的画布。
onShow(() => {
  chartVisible.value = true
  pageVisible.value = true
})
onHide(() => {
  chartVisible.value = false
  pageVisible.value = false
})
const item = computed(() =>
    [...watchState.items, ...bookState.data.instruments].find((row) => row.id === id.value),
  ),
  cached = computed(() => watchState.cache[id.value])
const marketReference = computed(() => item.value?.type === 'GOLD')
const chartHistory = computed(() => cached.value?.history)
const chartMinute = computed(() => cached.value?.minute)
const goldPoller = createVisiblePoller(async () => {
  chartClock.value = new Date()
  today.value = goldToday()
  if (item.value?.type === 'GOLD') {
    await refreshInstrument(item.value)
    if (chartMode.value === 'minute') await refreshGoldHistory(item.value, true)
  }
})
// 页面和App都可见才开始；隐藏/卸载后旧请求完成不能续建定时器。
watch(
  () => [pageVisible.value, appVisible.value, item.value?.type],
  () => {
    if (pageVisible.value && appVisible.value && item.value?.type === 'GOLD') goldPoller.start()
    else goldPoller.stop()
  },
)
onUnload(() => goldPoller.stop())
onBeforeUnmount(() => goldPoller.stop())
/** 时间段按所属日期回看，不能把90个交易日误标成近三个月。 */
const dailyPoints = computed(() => {
  const all = chartHistory.value?.points || []
  if (!all.length) return []
  const cutoff = new Date(
    Date.parse(
      (item.value?.type === 'GOLD' ? today.value : all[all.length - 1].date) + 'T00:00:00Z',
    ) -
      range.value * 86400000,
  )
    .toISOString()
    .slice(0, 10)
  return all.filter((point) => point.date >= cutoff)
})
const points = computed(() => {
  if (chartMode.value === 'minute') {
    const minutes = chartMinute.value?.points || []
    return item.value?.type === 'GOLD' ? sgeMinutePoints(minutes, chartClock.value) : minutes
  }
  if (chartMode.value === 'line') return dailyPoints.value
  return aggregateCandles(
    dailyPoints.value.filter((p) => p.open && p.high && p.low),
    chartMode.value,
  )
})
/** 分时独立查询；旧缓存缺开高低价时回补，不能把收盘序列冒充日K。 */
async function selectChart(mode: typeof chartMode.value): Promise<void> {
  if (!item.value) return
  chartMode.value = mode
  if (mode === 'minute') {
    if (marketReference.value) await refreshGoldHistory(item.value, true)
    else await refreshMinute(item.value)
  } else if (marketReference.value) await refreshGoldHistory(item.value)
  else if (mode !== 'line' && cached.value?.history.points.some((p) => !p.open))
    await loadMoreHistory(item.value)
}
/** 扩大范围才请求较早历史；实际覆盖由图下日期说明。 */
async function selectRange(days: number): Promise<void> {
  range.value = days
  sampleLimit.value = 10
  if (item.value?.type === 'GOLD') {
    chartMode.value = 'line'
    if (!chartHistory.value?.points.length) await refreshGoldHistory(item.value)
  } else if (days > 180 && item.value) await loadMoreHistory(item.value)
}
const sampleChanges = computed(() => {
  const dates = new Set(dailyPoints.value.map((point) => point.date))
  return goldSampleChanges(chartHistory.value?.points || [])
    .filter((point) => dates.has(point.date))
    .reverse()
})
const sampleExpanded = ref(false)
const change = computed(() =>
  cached.value?.quote.previous
    ? (Number(cached.value.quote.value) / Number(cached.value.quote.previous) - 1) * 100
    : undefined,
)
/** 页面从稳定标的恢复身份，失败保留原缓存。 */
onLoad((options) => {
  // App保留路由参数编码，H5可能已解码；标识不含百分号，统一解码一次。
  try {
    id.value = decodeURIComponent(String(options?.id || ''))
    accountId.value = decodeURIComponent(String(options?.accountId || ''))
    planId.value = decodeURIComponent(String(options?.planId || ''))
  } catch {
    showToast('详情链接无效，请返回重新选择')
    return
  }
  void initializeBook()
    .then(() => {
      accountId.value ||= selectedAccountId.value || bookState.data.accounts[0]?.id || ''
      if (item.value?.type === 'GOLD') {
        chartMode.value = 'minute'
        void refreshInstrument(item.value).then(() => {
          if (item.value) void refreshGoldHistory(item.value)
        })
      } else if (item.value) void refreshInstrument(item.value)
    })
    .catch(() => showToast(bookState.error || '账本读取失败'))
})
/** 返回被浮层正常拦截时不切换Tab；直接打开详情无上级时才回自选。 */
function back() {
  if (getCurrentPages().length > 1) uni.navigateBack({ fail: () => undefined })
  else uni.switchTab({ url: '/pages/watchlist/index' })
}
/** 刷新复用同标的在途请求，不因连点重复获取。 */
function refresh() {
  if (item.value) {
    void refreshInstrument(item.value).then(() => {
      if (item.value && marketReference.value)
        void refreshGoldHistory(item.value, chartMode.value === 'minute')
    })
  }
}
const position = computed(() => projection.value.positions[positionKey(accountId.value, id.value)])
const plan = computed(
  () =>
    bookState.data.plans.find((p) => p.id === planId.value) ||
    bookState.data.plans.find(
      (p) =>
        p.accountId === accountId.value &&
        p.instrumentId === id.value &&
        !projection.value.plans[p.id].ended,
    ),
)
const reminder = computed(() => allPlanReminders.value.find((row) => row.planId === plan.value?.id))
const trades = computed(() =>
  bookState.data.trades
    .filter((t) => t.accountId === accountId.value && t.instrumentId === id.value)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.sequence - a.sequence),
)
const realizedTotal = computed(() =>
  trades.value.reduce(
    (sum, row) => sum.plus(projection.value.trades[row.id]?.realizedPnl || 0),
    new D(0),
  ),
)
const references = computed(() =>
  chartMode.value === 'minute' && !marketReference.value
    ? []
    : chartReferences(
        bookState.data,
        accountId.value,
        id.value,
        (chartMode.value === 'minute' ? points.value : dailyPoints.value).map((p) => p.date),
        plan.value,
      ),
)
const marketValue = computed(() =>
  position.value && cached.value
    ? new D(position.value.qty).mul(cached.value.quote.value)
    : undefined,
)
/** 交易入口固定详情账户，但仍由表单确认实际成交数值。 */
function trade(side: string): void {
  selectedAccountId.value = accountId.value
  actions.value?.open(
    'trade',
    id.value,
    side,
    plan.value && !projection.value.plans[plan.value.id].ended ? plan.value.id : '',
  )
}
/** 同标的多账户持仓隔离，切换时清除上个账户的计划定位。 */
function switchAccount(event: { detail: { value: string | number } }): void {
  accountId.value = bookState.data.accounts[Number(event.detail.value)].id
  planId.value = ''
}
/** 计划详情复用同一编辑表单，不让参数修改产生实际交易。 */
function editPlan(): void {
  selectedAccountId.value = accountId.value
  actions.value?.open(
    'plan',
    id.value,
    'buy',
    plan.value && !projection.value.plans[plan.value.id].ended ? plan.value.id : '',
  )
}
</script>
<template>
  <view v-if="item" class="screen detail-screen">
    <view class="page-head"
      ><button class="back" @click="back">
        <AppIcon name="back" tone="muted" /><text>标的详情</text></button
      ><button class="circle-btn" aria-label="刷新行情" @click="refresh">
        <AppIcon name="refresh" /></button
    ></view>
    <view class="row"
      ><view
        ><view style="font-size: 19px; font-weight: 700">{{ item.name }}</view
        ><view class="sub"
          >{{ item.code }} ·
          {{ item.type === 'GOLD' ? '积存金' : item.type === 'ETF' ? 'ETF' : '场外基金' }}</view
        ></view
      ><text class="badge">{{
        item.type === 'GOLD' ? '元/克 · 卖出价' : item.type === 'ETF' ? '市场价' : '正式单位净值'
      }}</text></view
    >
    <view
      class="detail-quote num"
      :class="change !== undefined ? (change >= 0 ? 'up' : 'down') : ''"
      >{{ cached?.quote.value || '—' }}</view><view
      class="small"
      :class="change !== undefined ? (change >= 0 ? 'up' : 'down') : 'muted'"
      >{{ change === undefined ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` }}
      <text class="muted" style="margin-left: 12px">{{
        cached?.quote.date || '等待行情'
      }}</text></view
    >
    <view v-if="watchState.errors[id]" class="error"
      >{{ watchState.errors[id] }}{{ cached ? ' · 当前为缓存数据' : '' }}</view
    >
    <view v-if="item.type === 'GOLD' && cached" class="card gold-quote-card">
      <view class="metric-grid"
        ><view
          ><view class="metric-label">买入价（元/克）</view
          ><view class="metric-value num">{{ cached.quote.buyValue || '—' }}</view></view
        ><view
          ><view class="metric-label">卖出价（元/克）</view
          ><view class="metric-value num">{{ cached.quote.value }}</view></view
        ></view
      >
      <view v-if="cached.quote.tradable === false" class="sub">暂停报价</view>
    </view>
    <view v-if="plan" class="card plan-detail"
      ><view class="row section-title"><text style="font-size: 14px">本轮投资计划</text></view
      ><view v-if="plan" class="metric-grid"
        ><view
          ><view class="metric-label">本轮预算 / 已投</view
          ><view class="metric-value"
            >{{ formatMoney(plan.budget) }} /
            {{ formatMoney(projection.plans[plan.id].used) }}</view
          ></view
        ><view
          ><view class="metric-label">每份投入</view
          ><view class="metric-value"
            >¥{{ formatMoney(new D(plan.budget).div(plan.parts)) }}</view
          ></view
        ></view
      ><view v-if="reminder?.threshold && !reminder.actionable" class="plan-next row"
        ><text class="muted">{{ reminder.thresholdLabel }}</text
        ><text class="num">{{ formatMoney(reminder.threshold, 4) }}</text></view
      ><PlanReminderNotice
        v-if="
          reminder &&
          (reminder.actionable || reminder.kind === 'pending' || reminder.kind === 'blocked')
        "
        :reminder="reminder"
        style="margin-top: 16px"
      >
        <button
          v-if="reminder.actionable"
          class="primary full"
          style="margin-top: 12px"
          @click="trade(reminder.kind === 'buy' ? 'buy' : 'sell')"
        >
          记录{{ reminder.kind === 'buy' ? '买入' : '卖出' }}
        </button>
        <button
          v-else-if="reminder.kind === 'pending'"
          class="secondary full"
          style="margin-top: 12px"
          @click="actions?.open('records', '', 'buy', '', 'pending', accountId)"
        >
          确认交易
        </button>
        <button
          v-else-if="reminder.kind === 'verify'"
          class="text-btn blue"
          style="margin-top: 10px"
          @click="refresh"
        >
          更新行情
        </button>
      </PlanReminderNotice>
      <button class="secondary full" @click="editPlan">
        {{
          plan && !projection.plans[plan.id].ended ? '编辑计划' : '创建投资计划'
        }}</button><PlanHistory v-if="plan" :plan="plan"
    /></view>
    <view class="chart-card"
      ><view v-if="item.type === 'GOLD'" class="chart-tabs gold-chart-modes">
        <button :class="{ active: chartMode === 'minute' }" @click="selectChart('minute')">
          分时
        </button>
        <button
          v-for="option in [
            [30, '近一月'],
            [90, '近三月'],
            [180, '近半年'],
            [365, '近一年'],
          ]"
          :key="option[1]"
          :class="{ active: chartMode !== 'minute' && range === option[0] }"
          @click="selectRange(Number(option[0]))"
        >
          {{ option[1] }}
        </button> </view
      ><view v-if="item.type === 'ETF'" class="chart-tabs">
        <button
          v-for="mode in [
            { key: 'minute', label: '分时' },
            { key: 'line', label: '走势' },
            { key: 'day', label: '日K' },
            { key: 'week', label: '周K' },
            { key: 'month', label: '月K' },
          ] as const"
          :key="mode.key"
          :class="{ active: chartMode === mode.key }"
          @click="selectChart(mode.key)"
        >
          {{ mode.label }}
        </button> </view
      ><view v-if="chartMode !== 'minute' && item.type !== 'GOLD'" class="chart-tabs"
        ><button
          v-for="option in [
            [30, '近一月'],
            [90, '近三月'],
            [180, '近半年'],
            [365, '近一年'],
          ]"
          :key="option[1]"
          :class="{ active: range === option[0] }"
          @click="selectRange(Number(option[0]))"
        >
          {{ option[1] }}
        </button></view
      ><HistoryChart
        v-if="points.length"
        :active="chartVisible"
        :points="points"
        :trades="trades"
        :cost="position?.unitCost"
        :references="references"
        :candles="['day', 'week', 'month'].includes(chartMode)"
        :minute="chartMode === 'minute'"
        @select-trade="actions?.showRecord($event)"
      /><view v-else class="empty">{{
        item.type === 'GOLD' && chartMode === 'minute' ? '暂无分时数据' : '所选区间暂无历史数据'
      }}</view
      ><view class="legends"
        ><text class="small muted"
          >{{
            item.type === 'GOLD'
              ? '上金所 Au99.99 · 元/克'
              : item.type === 'ETF'
                ? chartMode === 'minute'
                  ? '来源分钟价'
                  : chartMode === 'line'
                    ? '未复权收盘价'
                    : '未复权K线'
                : '正式单位净值'
          }}
          {{
            watchState.loading[id + '/minute'] || watchState.loading[id + '/history']
              ? ' · 正在加载'
              : ''
          }}</text
        ></view
      ><view v-if="watchState.errors[id + '/minute'] && chartMode === 'minute'" class="error"
        >{{ watchState.errors[id + '/minute'] }}{{ points.length ? ' · 当前显示缓存' : '' }}</view
      ><view v-if="watchState.errors[id + '/history'] && chartMode !== 'minute'" class="error"
        >{{ watchState.errors[id + '/history'] }}{{ points.length ? ' · 当前显示缓存' : '' }}</view
      >
      <view v-if="item.type === 'GOLD' && chartMode === 'minute'" class="gold-coverage">{{
        sgeSessionLabel(chartClock)
      }}</view>
      <button
        class="text-btn chart-help-toggle"
        :aria-expanded="chartHelp"
        @click="chartHelp = !chartHelp"
      >
        图表操作
        <view class="chart-help-chevron" :class="{ expanded: chartHelp }" aria-hidden="true" />
      </button>
      <view v-if="chartHelp" class="tip chart-help">
        <view v-if="item.type === 'GOLD'"
          >市场参考来自上金所 Au99.99。账户估值、加仓及止盈使用招行实际买卖报价。</view
        >
        <view>B / S 是实际成交价，点击查看记录。</view>
        <view>双指缩放，切换“移动”后可平移。成本和策略参考线按当时记录展示。</view>
      </view>
    </view>
    <view v-if="item.type === 'GOLD' && chartMode === 'line'" class="card gold-samples">
      <button class="row full daily-toggle" @click="sampleExpanded = !sampleExpanded">
        <text>每日涨跌</text><text class="muted">{{ sampleExpanded ? '收起 ⌃' : '展开 ⌄' }}</text>
      </button>
      <template v-if="sampleExpanded">
        <view v-if="sampleChanges.length" class="gold-sample-row gold-sample-head">
          <text>日期</text><text class="gold-sample-price">收盘价</text
          ><text class="gold-sample-change">日涨跌</text>
        </view>
        <view v-if="!sampleChanges.length" class="empty">所选区间暂无数据</view>
        <view
          v-for="row in sampleChanges.slice(0, sampleLimit)"
          :key="row.date"
          class="gold-sample-row"
        >
          <view>{{ row.date }}</view>
          <view class="gold-sample-price num">{{ row.value }}</view>
          <view class="gold-sample-change">
            <view
              class="num"
              :class="
                row.changePercent === undefined
                  ? 'muted'
                  : new D(row.changePercent).gte(0)
                    ? 'up'
                    : 'down'
              "
              >{{
                row.changePercent === undefined
                  ? '—'
                  : `${new D(row.changePercent).gte(0) ? '+' : ''}${row.changePercent}%`
              }}</view
            >
          </view>
        </view>
        <button
          v-if="sampleLimit < sampleChanges.length"
          class="secondary full"
          @click="sampleLimit += 10"
        >
          查看更多
        </button>
      </template>
    </view>
    <view class="card">
      <view class="row section-title"
        ><text style="font-size: 14px">我的持仓</text
        ><AppPicker
          title="选择账户"
          :value="bookState.data.accounts.findIndex((a) => a.id === accountId)"
          :range="bookState.data.accounts"
          range-key="name"
          @change="switchAccount"
          ><text class="badge picker-trigger"
            >{{ bookState.data.accounts.find((a) => a.id === accountId)?.name || '尚未建账' }}
          </text></AppPicker
        ></view
      >
      <view class="metric-grid"
        ><view
          ><view class="metric-label">持有{{ item.type === 'GOLD' ? '克重' : '份额' }}</view
          ><view class="metric-value">{{ position?.qty || '0' }}</view></view
        ><view
          ><view class="metric-label">单位成本</view
          ><view class="metric-value">{{
            position ? formatMoney(position.unitCost, 4) : '—'
          }}</view></view
        ><view
          ><view class="metric-label">持仓市值</view
          ><view class="metric-value">{{
            marketValue ? formatMoney(marketValue) : '—'
          }}</view></view
        ><view
          ><view class="metric-label">持仓收益</view
          ><view
            class="metric-value"
            :class="marketValue?.gte(position?.totalCost || 0) ? 'up' : 'down'"
            >{{ marketValue ? formatMoney(marketValue.minus(position!.totalCost)) : '—' }}</view
          ></view
        ></view
      >
      <button v-if="opening" class="setting-row full" @click="maintenance?.editOpening(opening.id)">
        <text>管理初始持仓</text><text class="muted">修改 / 删除 ›</text>
      </button>
    </view>
    <button v-if="!plan" class="secondary full create-plan" @click="editPlan">创建投资计划</button>
    <CorporateActions
      v-if="accountId && item.type !== 'GOLD'"
      :account-id="accountId"
      :instrument-id="id"
    />
    <view class="card"
      ><view class="section-title" style="font-size: 14px">执行记录</view
      ><view v-if="trades.length" class="tip"
        >卖出已实现盈亏合计（扣费）<text class="num" :class="realizedTotal.gte(0) ? 'up' : 'down'">
          ¥{{ formatMoney(realizedTotal) }}</text
        ></view
      ><view v-if="!trades.length" class="empty">暂无成交记录</view
      ><SwipeRecord
        v-for="row in trades"
        :key="row.id"
        row-class="setting-row record-row"
        @open="actions?.showRecord(row.id)"
        @delete="actions?.removeRecord(row.id)"
      >
        <view
          ><view :class="row.side === 'buy' ? 'blue' : 'up'"
            >{{ row.side === 'buy' ? '买入' : '卖出' }} ·
            {{
              row.status === 'confirmed' ? '已确认' : row.status === 'pending' ? '待确认' : '已撤销'
            }}</view
          ><view class="sub"
            >{{ row.date }} · {{ row.qty || '—' }} {{ item.type === 'GOLD' ? '克' : '份' }}</view
          ></view
        ><view
          ><view>{{
            row.status === 'pending'
              ? row.side === 'buy'
                ? '申请 ¥' + formatMoney(row.pendingAmount)
                : '申请 ' + row.qty + ' 份'
              : projection.trades[row.id]
                ? formatMoney(projection.trades[row.id].net) + ' 元'
                : '—'
          }}</view
          ><view v-if="projection.trades[row.id]?.realizedPnl !== undefined" class="sub"
            >盈利 {{ formatMoney(projection.trades[row.id].realizedPnl!) }} 元</view
          ></view
        >
      </SwipeRecord></view
    >
    <view class="detail-actions"
      ><button class="secondary" @click="trade('sell')">记录卖出</button
      ><button class="primary" @click="trade('buy')">记录买入</button></view
    >
    <AppToast />
    <BookActions ref="actions" /><DataMaintenance ref="maintenance" /><PageOverlays /> </view
  ><view v-else class="screen empty">该标的尚未加入自选或账本，请返回重新选择。 </view>
</template>
<style scoped>
.plan-next {
  margin-top: 16px;
  font-size: 15px;
}
.daily-toggle {
  background: transparent;
  padding: 0;
  font-size: 15px;
  text-align: left;
}
.daily-toggle + view {
  margin-top: 16px;
}
.create-plan {
  margin-bottom: 20px;
}
.plan-detail > .secondary {
  margin-top: 14px;
}
.gold-chart-modes {
  margin-bottom: 12px;
}
.gold-coverage {
  margin-top: 12px;
  color: #8593ac;
  font-size: 11px;
  line-height: 1.8;
}
.gold-sample-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 1.3fr);
  gap: 8px;
  padding: 15px 0;
  border-bottom: 1px solid #edf0f6;
  font-size: 12px;
}
.gold-sample-row:last-of-type {
  border-bottom: 0;
}
.gold-sample-price,
.gold-sample-change {
  text-align: right;
}
.gold-sample-row .sub {
  font-size: 10px;
  line-height: 1.7;
}
.gold-samples .secondary {
  margin-top: 14px;
}
.chart-help-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 32px;
  margin: 10px auto 0;
  color: #8593ac;
}
.chart-help-chevron {
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  opacity: 0.65;
  transform: translateY(-2px) rotate(45deg);
  transition: transform 180ms ease;
}
.chart-help-chevron.expanded {
  transform: translateY(1px) rotate(225deg);
}
.chart-help {
  line-height: 1.8;
}
.gold-sample-head {
  padding-top: 0;
  color: #8593ac;
  font-size: 11px;
}
</style>
