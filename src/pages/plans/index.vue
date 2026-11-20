<script setup lang="ts">
import AppPicker from '../../components/AppPicker.vue'
import SelectionSheet from '../../components/SelectionSheet.vue'
import { usePageSelection } from '../../composables/useSelection'
usePageSelection(true)
import { usePageSheetBack } from '../../composables/useSheetBack'
usePageSheetBack()
import { computed, ref } from 'vue'
import { bookState, projection, selectedAccountId } from '../../state/book'
import { D, formatMoney } from '../../domain/money'
import { summarizePlanSales } from '../../domain/plan-sales'
import type { Plan } from '../../domain/book'
import BookActions from '../../components/BookActions.vue'
import AppIcon from '../../components/AppIcon.vue'
import AppToast from '../../components/AppToast.vue'
import CapitalSummary from '../../components/CapitalSummary.vue'
import { planReminders } from '../../state/plan-reminders'
import { refreshAll, watchState } from '../../state/watchlist'
const actions = ref<InstanceType<typeof BookActions>>()
const reminders = computed(() =>
  planReminders.value.filter((row) => row.actionable || row.kind === 'blocked'),
)
const refreshing = computed(() => Object.values(watchState.loading).some(Boolean))
const completed = computed(() =>
  visiblePlans.value.filter((p) => projection.value.plans[p.id].ended),
)
const groups = computed(() => [
  { title: '进行中', plans: active.value, ended: false },
  { title: '已结束', plans: completed.value, ended: true },
])
const visiblePlans = computed(() =>
  bookState.data.plans.filter(
    (p) => !selectedAccountId.value || p.accountId === selectedAccountId.value,
  ),
)
const active = computed(() =>
  visiblePlans.value
    .filter((p) => !projection.value.plans[p.id].ended)
    .sort((a, b) => Number(!!threshold(b)?.actionable) - Number(!!threshold(a)?.actionable)),
)
const accountOptions = computed(() => [{ id: '', name: '全部账户' }, ...bookState.data.accounts])
const accountIndex = computed(() =>
  Math.max(
    0,
    accountOptions.value.findIndex((a) => a.id === selectedAccountId.value),
  ),
)
/** 账户筛选共用首页选中身份，使汇总、计划卡片和后续编辑保持相同范围。 */
function selectAccount(event: { detail: { value: string | number } }): void {
  selectedAccountId.value = accountOptions.value[Number(event.detail.value)].id
}
/** 整张卡片可点击，携带所属账户和计划，不能只让标题响应。 */
function detail(plan: Plan): void {
  uni.navigateTo({
    url: `/pages/detail/index?id=${encodeURIComponent(plan.instrumentId)}&accountId=${encodeURIComponent(plan.accountId)}&planId=${encodeURIComponent(plan.id)}`,
  })
}
/** 无成交基准时不从平均成本猜测下个买点。 */
function nextBuy(plan: Plan): string {
  const price = projection.value.plans[plan.id].lastBuy
  return price
    ? formatMoney(new D(price).mul(new D(1).minus(new D(plan.drop).div(100))), 4)
    : '待建仓'
}
/** 卡片使用同一提醒的阈值，避免观察中加仓时误显示止盈线。 */
function threshold(plan: Plan) {
  return planReminders.value.find((row) => row.planId === plan.id)
}
/** 黄金报价与卡片当前阈值方向一致；基金只展示来源已披露的正式净值。 */
function latestPrice(plan: Plan) {
  const instrument = bookState.data.instruments.find((item) => item.id === plan.instrumentId)
  const quote = watchState.cache[plan.instrumentId]?.quote
  const selling = threshold(plan)?.thresholdLabel === '回撤止盈价'
  const gold = instrument?.type === 'GOLD'
  const value = gold && !selling ? quote?.buyValue : quote?.value
  return {
    label: gold
      ? selling
        ? '最新卖出价'
        : '最新买入价'
      : instrument?.type === 'FUND'
        ? '最新净值'
        : '最新价',
    value: value ? formatMoney(value, gold ? 2 : 4) : '—',
    date: quote?.date.slice(5, 16) || '',
  }
}
/** 卡片与集中提醒共用有效性判断，缓存旧信号不能标成当前待执行。 */
function status(plan: Plan): string {
  return planReminders.value.find((row) => row.planId === plan.id)?.title || '跟踪中'
}
/** 结束卡仅汇总本轮已关联的真实卖出，不把预算当成本或把未关联历史归入本轮。 */
function outcome(plan: Plan) {
  return summarizePlanSales(bookState.data, projection.value, plan.id)
}
</script>
<template>
  <view class="screen"
    ><view class="page-head"
      ><view class="page-title">投资计划</view
      ><view class="row" style="gap: 10px"
        ><button
          class="circle-btn"
          aria-label="刷新策略行情"
          :disabled="refreshing"
          @click="refreshAll"
        >
          <AppIcon name="refresh" /></button
        ><button class="circle-btn" aria-label="新建投资计划" @click="actions?.open('plan')">
          <AppIcon name="plus" /></button></view
    ></view>
    <AppPicker
      :range="accountOptions"
      range-key="name"
      :value="accountIndex"
      @change="selectAccount"
    >
      <view class="plan-account-select picker-trigger">{{
        accountOptions[accountIndex].name
      }}</view>
    </AppPicker>
    <CapitalSummary
      budget-view
      @funding="actions?.open('funding')"
      @accounts="actions?.open('accounts')"
    />
    <view v-if="!visiblePlans.length" class="card empty"
      ><view class="empty-icon"><AppIcon name="plan" /></view
      ><view class="empty-title">暂无投资计划</view><view>从自选选择标的，独立设置本轮预算。</view
      ><button class="add-watch" @click="actions?.open('plan')">＋ 创建投资计划</button></view
    >
    <template v-for="group in groups" :key="group.title">
      <view v-if="group.plans.length" class="section-title"
        >{{ group.title }} <text class="small muted">{{ group.plans.length }}</text><text
          v-if="!group.ended && reminders.length"
          class="pending-count blue"
          >{{ reminders.length }} 项待处理</text
        ></view
      >
      <button
        v-for="plan in group.plans"
        :key="plan.id"
        class="card plan-card full"
        @click="detail(plan)"
      >
        <view class="row full"
          ><view class="plan-head"
            ><view
              class="product-icon"
              :class="{
                gold:
                  bookState.data.instruments.find((i) => i.id === plan.instrumentId)?.type ===
                  'GOLD',
              }"
              >{{
                bookState.data.instruments.find((i) => i.id === plan.instrumentId)?.type === 'GOLD'
                  ? 'Au'
                  : bookState.data.instruments.find((i) => i.id === plan.instrumentId)?.type ===
                      'ETF'
                    ? 'ETF'
                    : '基'
              }}</view
            ><view
              ><view class="asset-name">{{
                bookState.data.instruments.find((i) => i.id === plan.instrumentId)?.name
              }}</view
              ><view class="sub">{{
                bookState.data.accounts.find((a) => a.id === plan.accountId)?.name
              }}</view></view
            ></view
          ><text class="badge" :class="{ green: plan.observing }">{{ status(plan) }}</text></view
        >
        <view v-if="group.ended" class="ended-summary">
          <view
            ><text class="small muted">本轮已投</text
            ><view class="num">¥{{ formatMoney(projection.plans[plan.id].used) }}</view></view
          >
          <view
            ><text class="small muted">净卖出回款</text
            ><view class="num">¥{{ formatMoney(outcome(plan).net) }}</view></view
          >
          <view
            ><text class="small muted">卖出已实现</text
            ><view class="num" :class="outcome(plan).pnl.gte(0) ? 'up' : 'down'"
              >¥{{ formatMoney(outcome(plan).pnl) }}</view
            ></view
          >
          <view
            ><text class="small muted">卖出收益率</text
            ><view class="num" :class="outcome(plan).pnl.gte(0) ? 'up' : 'down'">{{
              outcome(plan).pct === undefined ? '—' : formatMoney(outcome(plan).pct!) + '%'
            }}</view></view
          >
        </view>
        <view v-else class="plan-stats"
          ><view
            ><text class="small muted">{{ threshold(plan)?.thresholdLabel || '下一加仓价' }}</text
            ><view class="plan-number num blue">{{
              threshold(plan)?.threshold
                ? formatMoney(threshold(plan)!.threshold!, 4)
                : nextBuy(plan)
            }}</view></view
          ><view class="plan-latest"
            ><text class="small muted">{{ latestPrice(plan).label }}</text
            ><view class="plan-number num">{{ latestPrice(plan).value }}</view
            ><view v-if="latestPrice(plan).date" class="plan-quote-date">{{
              latestPrice(plan).date
            }}</view></view
          ><view style="text-align: right"
            ><text class="small muted">每份投入</text
            ><view class="plan-number num"
              >¥{{ formatMoney(new D(plan.budget).div(plan.parts), 2).replace(/\.00$/, '') }}</view
            ></view
          ></view
        >
        <view v-if="!group.ended" class="progress"
          ><view
            class="progress-fill"
            :style="{
              width:
                Math.min(
                  100,
                  (Number(projection.plans[plan.id].used) / Number(plan.budget)) * 100,
                ) + '%',
            }" /></view
        ><view v-if="!group.ended" class="row small muted"
          ><text>已投 ¥{{ formatMoney(projection.plans[plan.id].used) }}</text
          ><text>预算 ¥{{ formatMoney(plan.budget) }}</text></view
        >
      </button>
    </template>
    <view v-if="!visiblePlans.length" class="card"
      ><view class="section-title" style="font-size: 14px">默认 4% 投资策略</view
      ><view class="metric-grid"
        ><view
          v-for="rule in [
            ['资金份数', '10 份'],
            ['下跌加仓', '4%'],
            ['止盈观察', '15%'],
            ['高点回撤', '4%'],
          ]"
          :key="rule[0]"
          ><view class="metric-label">{{ rule[0] }}</view
          ><text class="metric-value">{{ rule[1] }}</text></view
        ></view
      ></view
    ><BookActions ref="actions" tab-page /><AppToast /><SelectionSheet />
  </view>
</template>

<style scoped>
.plan-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  align-items: start;
}
.plan-stats .plan-number {
  font-size: 17px;
  overflow-wrap: anywhere;
}
.plan-latest {
  text-align: center;
}
.plan-quote-date {
  margin-top: 5px;
  font-size: 11px;
  line-height: 1.3;
  color: #8793a8;
}
.pending-count {
  float: right;
  font-size: 14px;
  font-weight: 500;
}
.ended-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 18px;
}
.ended-summary .num {
  margin-top: 7px;
  font-size: 14px;
  overflow-wrap: anywhere;
}

.plan-account-select {
  margin-bottom: 16px;
  padding: 13px 16px;
  background: #ffffff;
  border: 1px solid #e8edf7;
  border-radius: 12px;
  color: #2858df;
  font-size: 13px;
}
</style>
