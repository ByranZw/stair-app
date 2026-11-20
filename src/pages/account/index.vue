<script setup lang="ts">
import SelectionSheet from '../../components/SelectionSheet.vue'
import { usePageSelection } from '../../composables/useSelection'
usePageSelection(true)
import { usePageSheetBack } from '../../composables/useSheetBack'
usePageSheetBack()
import { computed, ref } from 'vue'
import { refreshAll, watchState } from '../../state/watchlist'
import { bookState, selectedAccountId, projection } from '../../state/book'
import { portfolio } from '../../state/portfolio'
import { planReminders } from '../../state/plan-reminders'
import { D, formatMoney } from '../../domain/money'
import AppIcon from '../../components/AppIcon.vue'
import BookActions from '../../components/BookActions.vue'
import AppToast from '../../components/AppToast.vue'
import CapitalSummary from '../../components/CapitalSummary.vue'
const actions = ref<InstanceType<typeof BookActions>>(),
  hidden = ref(false),
  filter = ref('全部'),
  showReturns = ref(false)
const pending = computed(() =>
  bookState.data.trades.filter(
    (trade) =>
      trade.status === 'pending' &&
      (!selectedAccountId.value || trade.accountId === selectedAccountId.value),
  ),
)
const executionReminders = computed(() =>
  planReminders.value
    .filter((reminder) => reminder.actionable)
    .sort((a, b) => Number(b.kind === 'sell') - Number(a.kind === 'sell')),
)
/** 超过两项时进入完整计划列表，首页不铺成长提醒清单。 */
function openReminders(): void {
  uni.switchTab({ url: '/pages/plans/index' })
}
/** 直接定位提醒的计划及所属账户，不让用户进入列表后再次查找。 */
function openExecution(planId: string): void {
  const reminder = executionReminders.value.find((row) => row.planId === planId)
  if (!reminder) return
  uni.navigateTo({
    url: `/pages/detail/index?id=${encodeURIComponent(reminder.plan.instrumentId)}&accountId=${encodeURIComponent(reminder.plan.accountId)}&planId=${encodeURIComponent(planId)}`,
  })
}
const accountName = computed(
  () => bookState.data.accounts.find((a) => a.id === selectedAccountId.value)?.name || '全部账户',
)
const rows = computed(() =>
  portfolio.value.rows.filter(
    (p) =>
      filter.value === '全部' ||
      (filter.value === 'ETF' && p.item.type === 'ETF') ||
      (filter.value === '场外基金' && p.item.type === 'FUND') ||
      (filter.value === '积存金' && p.item.type === 'GOLD'),
  ),
)
/** 首页金额隐藏同时覆盖持仓列表，不只遮住资产大数字。 */
function display(value: string | number | undefined, places = 2): string {
  return hidden.value ? '••••' : value === undefined ? '—' : formatMoney(value, places)
}
/** 已持仓标的不依赖自选身份，路由携带真实账户避免多账户混看。 */
function detail(id: string, accountId: string): void {
  uni.navigateTo({
    url: `/pages/detail/index?id=${encodeURIComponent(id)}&accountId=${encodeURIComponent(accountId)}`,
  })
}
/** 同账户同标的显示本轮状态，已结束计划不继续冒充建仓中。 */
function positionStatus(accountId: string, id: string): string {
  const plan = bookState.data.plans.find(
    (p) =>
      p.accountId === accountId && p.instrumentId === id && !projection.value.plans[p.id].ended,
  )
  return plan
    ? planReminders.value.find((row) => row.planId === plan.id)?.title || '跟踪中'
    : '未关联计划'
}
/** 空持仓沿用自选入口，新计划不用从首页反复搜索。 */
function openWatchlist(): void {
  uni.switchTab({ url: '/pages/watchlist/index' })
}
</script>
<template>
  <view class="screen">
    <view class="page-head"
      ><view class="page-title">我的账户</view
      ><button class="circle-btn" aria-label="刷新行情" @click="refreshAll">
        <AppIcon name="refresh" /></button
    ></view>
    <view v-if="bookState.error || bookState.lastSaveError" class="error book-error">{{
      bookState.error || bookState.lastSaveError
    }}</view>
    <view v-if="!bookState.data.accounts.length" class="card onboarding">
      <view class="section-title">先建立你的账户</view
      ><view class="muted">录入初始现金，开始管理持仓和计划。</view>
      <button class="btn primary full" @click="actions?.open('account')">＋ 创建账户</button>
    </view>
    <view v-else class="hero"
      ><view class="row"
        ><button class="account-switch picker-trigger" @click="actions?.open('accounts')">
          {{ accountName }}</button
        ><button class="circle-btn" aria-label="显示或隐藏金额" @click="hidden = !hidden">
          <AppIcon name="eye" tone="white" /></button></view
      ><view class="small muted" style="margin-top: 15px"
        >总资产（元）{{ portfolio.unpriced ? ' · 部分资产待报价' : '' }}</view
      ><view class="asset-number num">{{
        bookState.data.accounts.length ? display(portfolio.assets.toString()) : '—'
      }}</view
      ><view class="hero-stats"
        ><view
          ><button class="returns-toggle" aria-label="收益明细" @click="showReturns = !showReturns">
            累计收益 {{ showReturns ? '⌃' : '⌄' }}</button
          ><text class="stat-value num">{{ display(portfolio.totalPnl.toString()) }}</text></view
        ><view
          ><text class="small muted">持仓收益</text
          ><text class="stat-value num">{{ display(portfolio.pnl.toString()) }}</text></view
        ><view
          ><text class="small muted">可用现金</text
          ><text class="stat-value num">{{ display(portfolio.available.toString()) }}</text></view
        ></view
      ><view v-if="showReturns" class="returns-detail">
        <view class="row"
          ><text>已实现收益</text
          ><text class="num">{{ display(portfolio.realized.toString()) }}</text></view
        >
        <view class="row"
          ><text>持仓收益率</text
          ><text class="num"
            >{{ display(portfolio.pct?.toString()) }}{{ portfolio.pct && !hidden ? '%' : '' }}</text
          ></view
        >
      </view>
    </view>

    <view v-if="executionReminders.length" class="execution-card">
      <view class="row execution-heading">
        <text
          >策略提醒 <text class="execution-count">{{ executionReminders.length }}</text></text
        >
        <button v-if="executionReminders.length > 2" class="text-btn blue" @click="openReminders">
          查看全部 ›
        </button>
      </view>
      <scroll-view class="execution-scroll" scroll-x :show-scrollbar="false">
        <view class="execution-track" :class="{ single: executionReminders.length === 1 }">
          <button
            v-for="reminder in executionReminders.slice(0, 2)"
            :key="reminder.planId"
            class="execution-entry"
            :class="{ 'sell-reminder': reminder.kind === 'sell' }"
            @click="openExecution(reminder.planId)"
          >
            <view class="execution-top">
              <view class="execution-status"
                ><view class="execution-icon"
                  ><AppIcon :name="reminder.kind === 'buy' ? 'plus' : 'trade'" tone="white" /></view
                ><text>{{ reminder.kind === 'buy' ? '加仓一份' : '回撤止盈' }}</text></view
              >
              <text class="execution-link">查看计划 ›</text>
            </view>
            <view class="execution-content">
              <view class="execution-product"
                ><view class="execution-name">{{
                  bookState.data.instruments.find((item) => item.id === reminder.plan.instrumentId)
                    ?.name
                }}</view>
                <view v-if="!selectedAccountId" class="execution-account">{{
                  bookState.data.accounts.find((account) => account.id === reminder.plan.accountId)
                    ?.name
                }}</view>
              </view>
              <view v-if="reminder.kind === 'buy'" class="execution-amount num"
                >¥{{
                  display(new D(reminder.plan.budget).div(reminder.plan.parts).toString())
                }}</view
              >
              <view v-else class="execution-amount sell-label">卖出持仓</view>
            </view>
          </button>
        </view>
      </scroll-view>
    </view>
    <button
      v-if="pending.length"
      class="task-entry pending-task"
      @click="actions?.open('records', '', 'buy', '', 'pending')"
    >
      <text>交易待确认 {{ pending.length }} 笔</text><text>去确认 ›</text>
    </button>
    <CapitalSummary
      v-if="bookState.data.accounts.length"
      :hidden="hidden"
      :market="portfolio.assets.minus(portfolio.cash).toString()"
      @funding="actions?.open('funding')"
      @accounts="actions?.open('accounts')"
    />
    <template v-if="bookState.data.accounts.length">
      <view class="quick-grid"
        ><button @click="actions?.open('trade')">
          <view class="quick-icon"><AppIcon name="trade" /></view><text>记一笔</text></button
        ><button @click="actions?.open('allocation')">
          <view class="quick-icon"><AppIcon name="chart" /></view><text>资产分析</text></button
        ><button @click="actions?.open('records')">
          <view class="quick-icon"><AppIcon name="plan" /></view><text>交易记录</text>
        </button></view
      >
      <view class="row section-title"
        ><text
          >我的持仓 <text class="muted small">{{ portfolio.rows.length }}</text></text
        ><button class="text-btn" @click="actions?.open('import')">导入持仓 ＋</button></view
      >
      <view class="chips"
        ><button
          v-for="label in ['全部', 'ETF', '场外基金', '积存金']"
          :key="label"
          :class="{ active: filter === label }"
          @click="filter = label"
        >
          {{ label }}
        </button></view
      >
      <view v-if="!rows.length" class="card empty"
        ><view class="empty-icon"><AppIcon name="account" /></view
        ><view class="empty-title">{{
          filter === '全部'
            ? pending.length
              ? '申请待确认'
              : '还没有持仓记录'
            : `暂无${filter}持仓`
        }}</view
        ><view>{{
          pending.length
            ? ''
            : portfolio.rows.length
              ? '当前筛选下暂无持仓。'
              : '导入持仓，或记一笔买入。'
        }}</view
        ><button
          class="add-watch"
          style="margin-bottom: 0"
          @click="
            pending.length ? actions?.open('records', '', 'buy', '', 'pending') : openWatchlist()
          "
        >
          {{ pending.length ? '处理待确认记录' : '＋ 添加自选标的' }}
        </button></view
      >
      <button
        v-for="row in rows"
        :key="row.accountId + '/' + row.instrumentId"
        class="position"
        @click="detail(row.instrumentId, row.accountId)"
      >
        <view class="row"
          ><view class="position-title"
            ><text class="position-name">{{ row.item.name }}</text
            ><text class="badge" :class="{ gold: row.item.type === 'GOLD' }">{{
              row.item.type === 'GOLD' ? '积存金' : row.item.type === 'ETF' ? 'ETF' : '场外基金'
            }}</text></view
          ><text class="muted">›</text></view
        >
        <view class="position-code"
          >{{ bookState.data.accounts.find((a) => a.id === row.accountId)?.name }} ·
          {{ row.item.code }} · {{ hidden ? '••••' : row.qty }}
          {{ row.item.type === 'GOLD' ? '克' : '份' }}</view
        >
        <view class="position-values"
          ><view
            ><text class="position-number num">{{ display(row.value?.toString()) }}</text
            ><text class="position-label">持仓市值</text></view
          ><view
            ><text class="position-number num" :class="row.pnl?.gte(0) ? 'up' : 'down'">{{
              display(row.pnl?.toString())
            }}</text
            ><text class="position-label">持仓收益</text></view
          ><view
            ><text class="position-number num" :class="row.pnl?.gte(0) ? 'up' : 'down'"
              >{{ display(row.pnl?.div(row.totalCost).mul(100).toString())
              }}{{ row.pnl && !hidden ? '%' : '' }}</text
            ><text class="position-label">收益率</text></view
          ></view
        >
        <view class="position-bottom"
          ><text>{{ positionStatus(row.accountId, row.instrumentId) }}</text
          ><text>{{
            row.stale ? '缓存报价' : watchState.cache[row.instrumentId]?.quote.date || '等待报价'
          }}</text></view
        >
      </button>
    </template>
    <BookActions ref="actions" tab-page /><AppToast />
    <SelectionSheet />
  </view>
</template>

<style scoped>
.onboarding .btn {
  margin-top: 18px;
}
.returns-toggle {
  display: block;
  margin: 0;
  padding: 0;
  color: #e2eaff;
  background: transparent;
  font-size: 12px;
  line-height: inherit;
}
.returns-detail {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #ffffff30;
  font-size: 14px;
}
.quick-grid {
  padding: 8px 0 12px;
  margin-bottom: 8px;
}
.quick-grid button {
  display: flex;
  flex-direction: row;
  justify-content: center;
  gap: 8px;
  align-items: center;
}
.quick-grid .quick-icon {
  width: 28px;
  height: 28px;
  margin: 0;
}
.execution-card {
  margin-bottom: 14px;
}
.execution-heading {
  font-size: 15px;
  font-weight: 650;
  margin-bottom: 10px;
  padding: 0 2px;
}
.execution-count {
  display: inline-block;
  margin-left: 5px;
  padding: 1px 6px;
  border-radius: 6px;
  background: #e6ecfb;
  color: #2858df;
  font-size: 12px;
  vertical-align: middle;
}
.execution-scroll {
  width: 100%;
}
.execution-track {
  display: flex;
  gap: 12px;
  padding-bottom: 2px;
}
.execution-entry {
  flex: 0 0 calc(100% - 32px);
  box-sizing: border-box;
  min-width: 0;
  padding: 14px;
  border: 1px solid #dfe7fb;
  border-radius: 16px;
  background: linear-gradient(115deg, #eef3ff, #f5f8ff);
  text-align: left;
  line-height: 1.4;
}
.execution-track.single .execution-entry {
  flex-basis: 100%;
}
.execution-top,
.execution-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.execution-top {
  margin-bottom: 14px;
}
.execution-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #2858df;
  font-size: 13px;
  font-weight: 600;
}
.execution-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 9px;
  background: #3864e7;
}
.execution-icon .icon {
  width: 16px;
  height: 16px;
}
.execution-link {
  flex-shrink: 0;
  color: #5371b7;
  font-size: 12px;
}
.execution-product {
  flex: 1;
  min-width: 0;
}
.execution-name {
  font-size: 15px;
  font-weight: 650;
  color: #17263d;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.execution-account {
  margin-top: 4px;
  font-size: 13px;
  color: #75849c;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.execution-amount {
  flex-shrink: 0;
  color: #2858df;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.5px;
}
.sell-reminder {
  background: linear-gradient(115deg, #fff4e6, #fffaf2);
  border-color: #f3dfc1;
}
.sell-reminder .execution-status,
.sell-reminder .execution-amount {
  color: #a76c25;
}
.sell-reminder .execution-icon {
  background: #bf883c;
}
.sell-reminder .execution-link {
  color: #9b784b;
}
.sell-label {
  font-size: 19px;
  letter-spacing: 0;
}
.task-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 13px 12px;
  border-radius: 12px;
  background: #edf2ff;
  color: #2858df;
  font-size: 14px;
}
.pending-task {
  margin-bottom: 12px;
  background: #fff3e8;
  color: #a45e20;
}
</style>
