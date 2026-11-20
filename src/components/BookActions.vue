<script setup lang="ts">
import { formatDateTime } from '../domain/display-time'
import AppPicker from './AppPicker.vue'
import { computed, reactive, ref, onBeforeUnmount, watch } from 'vue'
import BottomSheet from './BottomSheet.vue'
import SwipeRecord from './SwipeRecord.vue'
import { saveFormDraft, readFormDraft, clearFormDraft } from '../state/form-drafts'
import { usePickerGuard } from '../composables/usePickerGuard'
const { pickerSettling, settlePicker } = usePickerGuard()
import {
  bookState,
  projection,
  selectedAccountId,
  createAccount,
  saveAccountCorrection,
  importPosition,
  recordCashFlow,
  saveTrade,
  correctSavedTrade,
  deleteSavedTrade,
  savePlan,
  pausePlan,
  cancelPending,
  newId,
} from '../state/book'
import { watchState } from '../state/watchlist'
import type { Instrument } from '../domain/market'
import type { Account, Plan, Trade } from '../domain/book'
import { positionKey } from '../domain/book'
import { D, today, formatMoney } from '../domain/money'
import { summarizeCapital } from '../domain/capital'
import { convertGold } from '../domain/gold-entry'
import { showToast } from '../state/feedback'
const props = defineProps<{ tabPage?: boolean }>()
const visible = ref(false),
  mode = ref(''),
  error = ref(''),
  saving = ref(false),
  tradeId = ref(''),
  confirmationId = ref(''),
  correctionId = ref(''),
  detailId = ref(''),
  editingPlanId = ref('')
const form = reactive({
  accountId: '',
  instrumentId: '',
  name: '',
  cash: '0',
  date: today(),
  time: '',
  qty: '',
  price: '',
  fee: '0',
  totalCost: '',
  side: 'buy',
  status: 'confirmed',
  pendingAmount: '',
  planId: '',
  budget: '',
  parts: '10',
  drop: '4',
  observe: '15',
  retrace: '4',
  lastBuy: '',
  goldMode: '克',
  goldAmount: '',
})
/** 草稿保留录入上下文和稳定成交ID，不将未保存内容混入真实账本。 */
interface EntryDraft {
  form: typeof form
  tradeId: string
  confirmationId: string
  correctionId: string
  editingPlanId: string
  revision: number
  accountBaseline?: Pick<Account, 'name' | 'openingCash' | 'date'> | null
}
const accountBaseline = ref<Pick<Account, 'name' | 'openingCash' | 'date'> | null>()
const accountFormVersion = ref(0)
let draftKey = ''
/** 在关闭和切换前同步落本机；失败保留当前浮层及输入。 */
function retainDraft(): void {
  if (
    !draftKey ||
    !['account', 'edit-account', 'cash', 'import', 'trade', 'plan'].includes(mode.value)
  )
    return
  saveFormDraft(draftKey, {
    form,
    tradeId: tradeId.value,
    confirmationId: confirmationId.value,
    correctionId: correctionId.value,
    editingPlanId: editingPlanId.value,
    revision: bookState.data.revision,
    accountBaseline: accountBaseline.value || null,
  })
}
/** 所有关闭入口共用草稿保存，保存失败不允许蒙版丢弃输入。 */
function dismiss(value: boolean): void {
  if (value || saving.value) return
  try {
    retainDraft()
    visible.value = false
  } catch {
    showToast('草稿保存失败，请保留当前输入后重试')
  }
}
onBeforeUnmount(() => {
  if (visible.value) {
    try {
      retainDraft()
    } catch {
      showToast('草稿保存失败，请勿清除应用数据')
    }
  }
})
const gold: Instrument = {
  id: 'GOLD:CMB-GOLD',
  code: 'CMB-GOLD',
  name: '招行黄金账户',
  type: 'GOLD',
}
const items = computed(() => [
  ...new Map(
    [...watchState.items, ...bookState.data.instruments, gold].map((i) => [i.id, i]),
  ).values(),
])
const instrument = computed(() => items.value.find((i) => i.id === form.instrumentId))
const accounts = computed(() => bookState.data.accounts)
const linkedPlans = computed(() =>
  bookState.data.plans.filter(
    (p) =>
      p.accountId === form.accountId &&
      p.instrumentId === form.instrumentId &&
      !projection.value.plans[p.id].ended,
  ),
)
const recordsAccount = ref('')
const recordsPending = ref(false)
const recordAccounts = computed(() => [{ id: '', name: '全部账户' }, ...accounts.value])
const recordAccountIndex = computed(() =>
  Math.max(
    0,
    recordAccounts.value.findIndex((a) => a.id === recordsAccount.value),
  ),
)
/** 记录筛选仅作用于当前列表，不切换首页账户。 */
function selectRecordAccount(event: { detail: { value: string | number } }): void {
  recordsAccount.value = recordAccounts.value[Number(event.detail.value)].id
}
const records = computed(() =>
  bookState.data.trades
    .filter(
      (t) =>
        (!recordsAccount.value || t.accountId === recordsAccount.value) &&
        (!recordsPending.value || t.status === 'pending'),
    )
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.sequence - a.sequence),
)
const detail = computed(() => bookState.data.trades.find((t) => t.id === detailId.value))
const outcome = computed(() => projection.value.trades[detailId.value])
const realizedTotal = computed(() =>
  records.value.reduce(
    (sum, row) => sum.plus(projection.value.trades[row.id]?.realizedPnl || 0),
    new D(0),
  ),
)
const fundingAccount = ref('')
const funding = computed(() =>
  summarizeCapital(bookState.data, projection.value, fundingAccount.value),
)
const planPreview = computed(() => {
  try {
    const budget = new D(form.budget || 0),
      parts = new D(form.parts || 0)
    if (budget.lte(0) || !parts.isInteger() || parts.lte(0)) return undefined
    const summary = summarizeCapital(bookState.data, projection.value, form.accountId)
    const existing = summary.plans.find((p) => p.planId === editingPlanId.value)
    const remaining = D.max(budget.minus(existing?.used || 0).minus(existing?.pending || 0), 0)
    return {
      perPart: budget.div(parts).toFixed(2),
      free: new D(summary.free)
        .plus(existing?.remaining || 0)
        .minus(remaining)
        .toFixed(2),
    }
  } catch {
    return undefined
  }
})
/** 资金规划独立选择展示范围，不把全部账户当作可写入账户。 */
function selectFundingAccount(event: { detail: { value: string | number } }): void {
  fundingAccount.value = Number(event.detail.value)
    ? accounts.value[Number(event.detail.value) - 1].id
    : ''
  settlePicker()
}
/** 新计划沿当前规划账户创建，并按账户隔离尚未保存的预算草稿。 */
function createFundingPlan(): void {
  const accountId = fundingAccount.value || selectedAccountId.value || accounts.value[0]?.id || ''
  if (!open('plan', '', 'buy', '', 'funding:' + accountId)) form.accountId = accountId
}
/** 从资金规划进入原有计划编辑，锁定真实账户及标的。 */
function editFundingPlan(id: string): void {
  const plan = bookState.data.plans.find((p) => p.id === id)!
  open('plan', plan.instrumentId, 'buy', id)
}
const titles: Record<string, string> = {
  accounts: '选择账户',
  account: '新建账户',
  'edit-account': '管理账户',
  funding: '资金规划',
  cash: '转入 / 转出',
  import: '导入已有持仓',
  trade: '记录交易',
  plan: '投资计划',
  records: '交易记录',
  detail: '交易详情',
  allocation: '资产分布',
}
const title = computed(() =>
  mode.value === 'trade' && correctionId.value ? '修改交易' : titles[mode.value] || '我的账户',
)
const goldHint = computed(() => {
  try {
    if (!form.price || new D(form.price).lte(0)) return '填写成交价后自动换算'
    const gross = new D(form.goldAmount || new D(form.qty || 0).mul(form.price)).toDecimalPlaces(2)
    const net = form.side === 'buy' ? gross.plus(form.fee || 0) : gross.minus(form.fee || 0)
    return `${form.side === 'buy' ? '总支出' : '净到账'} ${formatMoney(net)} 元`
  } catch {
    return '请填写有效数字'
  }
})
/** 同一入口优先恢复草稿与稳定成交ID；新录入才初始化，正式确认沿用原申请ID。 */
function open(
  next: string,
  itemId = '',
  side = 'buy',
  planId = '',
  recordContext = '',
  recordsAccountId = selectedAccountId.value,
): boolean {
  if (saving.value) return true
  if (next === 'records') {
    recordsAccount.value = recordsAccountId
    recordsPending.value = recordContext === 'pending'
  }
  if (next === 'funding') fundingAccount.value = selectedAccountId.value
  try {
    if (visible.value) retainDraft()
  } catch {
    showToast('草稿保存失败，请先保留输入')
    return true
  }
  draftKey = JSON.stringify([
    next,
    selectedAccountId.value || accounts.value[0]?.id || '',
    itemId,
    side,
    planId,
    recordContext,
  ])
  try {
    const draft = readFormDraft<EntryDraft>(draftKey)
    if (draft) {
      Object.assign(form, draft.form)
      // 旧版缺少编辑基准的草稿保持失效身份，关闭重开也不授予覆盖账户的权限。
      accountBaseline.value = draft.accountBaseline || null
      tradeId.value = draft.tradeId
      confirmationId.value = draft.confirmationId
      correctionId.value = draft.correctionId
      editingPlanId.value = draft.editingPlanId
      mode.value = next
      error.value = ''
      visible.value = true
      return true
    }
  } catch {
    showToast('草稿读取失败，请勿清除应用数据')
  }
  error.value = ''
  mode.value = next
  accountBaseline.value = undefined
  visible.value = true
  confirmationId.value = ''
  correctionId.value = ''
  editingPlanId.value = ''
  tradeId.value = newId('trade')
  Object.assign(form, {
    accountId: selectedAccountId.value || accounts.value[0]?.id || '',
    instrumentId: itemId || items.value[0]?.id || '',
    date: today(),
    time: '',
    qty: '',
    price: '',
    fee: '0',
    totalCost: '',
    side,
    status: 'confirmed',
    pendingAmount: '',
    planId,
    name: '',
    cash: '0',
    budget: '',
    parts: '10',
    drop: '4',
    observe: '15',
    retrace: '4',
    lastBuy: '',
    goldMode: '克',
    goldAmount: '',
  })
  if (next === 'edit-account') {
    const account = accounts.value.find((a) => a.id === itemId)!
    accountBaseline.value = {
      name: account.name,
      openingCash: account.openingCash,
      date: account.date,
    }
    Object.assign(form, {
      accountId: account.id,
      name: account.name,
      cash: account.openingCash,
      date: account.date,
    })
  }
  if (next === 'trade' && !planId) form.planId = linkedPlans.value[0]?.id || ''
  if (next === 'trade') fillGoldPrice()
  if (next === 'plan' && planId) {
    const plan = bookState.data.plans.find((p) => p.id === planId)!
    editingPlanId.value = planId
    Object.assign(form, {
      accountId: plan.accountId,
      instrumentId: plan.instrumentId,
      budget: plan.budget,
      parts: String(plan.parts),
      drop: plan.drop,
      observe: plan.observe,
      retrace: plan.retrace,
      lastBuy: plan.initialLastBuy || '',
    })
  }
  return false
}
/** 下拉框按稳定ID更新；改变归属时清除旧计划，避免关联其他账户。 */
function selectAccount(event: { detail: { value: string | number } }): void {
  settlePicker()
  form.accountId = accounts.value[Number(event.detail.value)].id
  form.planId = linkedPlans.value[0]?.id || ''
}
/** 标的从自选或历史账本选择，真实成交值仍由用户确认。 */
function selectItem(event: { detail: { value: string | number } }): void {
  settlePicker()
  form.instrumentId = items.value[Number(event.detail.value)].id
  form.planId = linkedPlans.value[0]?.id || ''
  form.status = 'confirmed'
  form.qty = ''
  form.price = ''
  form.goldAmount = ''
  form.goldMode = '克'
  fillGoldPrice()
}
/** 新录入的黄金只预填新鲜的对应客户侧报价，成交仍须用户按确认单核对。 */
function fillGoldPrice(): void {
  if (mode.value !== 'trade' || instrument.value?.type !== 'GOLD') return
  const quote = watchState.cache[form.instrumentId]?.quote
  const age = quote ? Date.now() - Date.parse(quote.fetchedAt) : Infinity
  form.price =
    quote &&
    !watchState.errors[form.instrumentId] &&
    quote.tradable !== false &&
    age >= 0 &&
    age < 900000
      ? (form.side === 'buy' ? quote.buyValue : quote.value) || ''
      : ''
  recalculateGold()
}
/** 按最后编辑的一侧重算另一侧，编辑未完成时保留原始输入而清空派生值。 */
function recalculateGold(): void {
  if (instrument.value?.type !== 'GOLD') return
  try {
    const converted = convertGold(
      form.goldMode === '克' ? form.qty : form.goldAmount,
      form.price,
      form.goldMode as '克' | '元',
    )
    if (form.goldMode === '克') form.goldAmount = converted
    else form.qty = converted
  } catch {
    if (form.goldMode === '克') form.goldAmount = ''
    else form.qty = ''
  }
}
/** 克数输入优先；基金数量继续保留份额，不进入黄金换算。 */
function setQty(event: Event): void {
  form.qty = (event as unknown as { detail: { value: string } }).detail.value
  if (instrument.value?.type === 'GOLD') {
    form.goldMode = '克'
    recalculateGold()
  }
}
/** 按元录入以不含费金额为依据，克重由实际单价换算；核对克重可切回按克。 */
function setGoldAmount(event: Event): void {
  form.goldAmount = (event as unknown as { detail: { value: string } }).detail.value
  form.goldMode = '元'
  recalculateGold()
}
/** 修改实际单价后沿用最后编辑的一侧，避免两项显示相互矛盾。 */
function setPrice(event: Event): void {
  form.price = (event as unknown as { detail: { value: string } }).detail.value
  recalculateGold()
}
/** 切换交易方向后重取对应黄金客户价，基金不采用行情代替实际净值。 */
function setSide(side: string): void {
  if (form.side === side) return
  form.side = side
  fillGoldPrice()
}
/** 日期确认后先完成选择面板退场，再允许提交下层表单。 */
function setDate(event: { detail: { value: string } }): void {
  form.date = event.detail.value
  settlePicker()
}
/** 时间选择器同样存在关闭动画，不能在尚未收起时卸载。 */
function setTime(event: { detail: { value: string } }): void {
  form.time = event.detail.value
  settlePicker()
}
/** 关联计划按当前账户可用列表定位，不保留其他标的的旧关联。 */
function selectPlan(event: { detail: { value: string | number } }): void {
  settlePicker()
  const index = Number(event.detail.value)
  form.planId = index ? linkedPlans.value[index - 1].id : ''
}
/** 全部账户只是展示范围，不作为可写入的虚拟账户。 */
function chooseAccount(id: string): void {
  if (saving.value) return
  selectedAccountId.value = id
  visible.value = false
}
/** 交易详情展示重放得到的历史成本，不能用当前均价反算。 */
function showRecord(id: string): void {
  if (saving.value) return
  detailId.value = id
  mode.value = 'detail'
  visible.value = true
}
/** 正式确认填写到账日、实际数量与净值，保留原申请归属。 */
function confirmPending(): void {
  const row = detail.value!
  if (open('trade', row.instrumentId, row.side, row.planId, 'confirm:' + row.id)) return
  confirmationId.value = row.id
  tradeId.value = row.id
  form.accountId = row.accountId
  form.planId = row.planId || ''
  form.qty = row.side === 'sell' ? row.qty : ''
  form.fee = row.fee
}
/** 沿用原成交ID编辑，原值留痕与账本重算由领域层完成。 */
function editTrade(): void {
  const row = detail.value!
  if (open('trade', row.instrumentId, row.side, row.planId, 'correct:' + row.id)) return
  correctionId.value = row.id
  tradeId.value = row.id
  Object.assign(form, {
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    date: row.date,
    time: row.time,
    qty: row.qty,
    price: row.price,
    fee: row.fee,
    planId: row.planId || '',
    status: 'confirmed',
    goldAmount:
      row.inputAmount ||
      (instrument.value?.type === 'GOLD'
        ? formatMoney(new D(row.qty).mul(row.price)).replace(/,/g, '')
        : ''),
    goldMode: row.inputBasis || (row.inputAmount ? '元' : '克'),
  })
}
/** 撤销申请保留记录并释放预留，不删除已经发生的成交。 */
async function cancelApplication(): Promise<void> {
  try {
    await cancelPending(detailId.value)
    showToast('申请已撤销')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '撤销失败'
  }
}
/** 开关计划会清除旧观察高点；恢复从下一次新行情重新跟踪。 */
async function togglePause(): Promise<void> {
  try {
    const plan = bookState.data.plans.find((p) => p.id === editingPlanId.value)!
    await pausePlan(plan.id, !plan.paused)
    clearFormDraft(draftKey)
    draftKey = ''
    visible.value = false
    showToast(plan.paused ? '已恢复计划' : '已暂停计划')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  }
}
/** 用户主动重载时以最新账户替换旧编辑基准，不让行情变化打断正常输入。 */
function reloadAccount(): void {
  const account = accounts.value.find((a) => a.id === form.accountId)
  if (!account) return
  accountBaseline.value = {
    name: account.name,
    openingCash: account.openingCash,
    date: account.date,
  }
  Object.assign(form, { name: account.name, cash: account.openingCash, date: account.date })
  accountFormVersion.value += 1
  error.value = ''
}
/** 所有表单走事务账本，提交成功才关闭；失败保留原输入供核对。 */
async function submit(): Promise<void> {
  if (saving.value || pickerSettling.value) return
  saving.value = true
  error.value = ''
  try {
    if (!bookState.ready) throw new Error(bookState.error || '账本正在读取，请稍后')
    if (mode.value === 'account') await createAccount(form.name, form.cash, form.date)
    else if (mode.value === 'edit-account') {
      if (!accountBaseline.value) throw new Error('账户已更新，请载入最新账户后修改')
      await saveAccountCorrection(
        form.accountId,
        { name: form.name, openingCash: form.cash, date: form.date },
        bookState.data.revision,
        accountBaseline.value,
      )
    } else if (mode.value === 'cash')
      await recordCashFlow({
        accountId: form.accountId,
        date: form.date,
        amount: form.cash,
        side: form.side === 'sell' ? 'out' : 'in',
      })
    else if (mode.value === 'import')
      await importPosition(
        {
          accountId: form.accountId,
          instrumentId: form.instrumentId,
          date: form.date,
          qty: form.qty,
          totalCost: form.totalCost,
        },
        instrument.value!,
      )
    else if (mode.value === 'plan') {
      const plan: Omit<Plan, 'version' | 'createdAt' | 'paused' | 'observing'> = {
        id: editingPlanId.value || newId('plan'),
        accountId: form.accountId,
        instrumentId: form.instrumentId,
        budget: form.budget,
        parts: Number(form.parts),
        drop: form.drop,
        observe: form.observe,
        retrace: form.retrace,
        ...(form.lastBuy ? { initialLastBuy: form.lastBuy } : {}),
      }
      await savePlan(plan, instrument.value!)
    } else if (mode.value === 'trade') {
      const trade: Trade = {
        id: tradeId.value,
        accountId: form.accountId,
        instrumentId: form.instrumentId,
        ...(form.planId ? { planId: form.planId } : {}),
        side: form.side as 'buy' | 'sell',
        status: form.status as 'confirmed' | 'pending',
        date: form.date,
        time: form.time,
        sequence: bookState.data.trades.find((t) => t.id === tradeId.value)?.sequence || Date.now(),
        orderConfirmed: false,
        qty: form.qty,
        price: form.price,
        fee: form.fee,
        pendingAmount: form.pendingAmount,
      }
      if (instrument.value?.type === 'GOLD' && form.goldAmount) {
        trade.inputAmount = form.goldAmount
        trade.inputBasis = form.goldMode as '克' | '元'
      }
      // 未填写时刻的同日交易沿用录入顺序；更正保留原 sequence，领域层仍校验余额和持仓。
      if (correctionId.value) await correctSavedTrade(trade, instrument.value!, true)
      else await saveTrade(trade, instrument.value!, true, confirmationId.value || undefined)
    }
    clearFormDraft(draftKey)
    draftKey = ''
    visible.value = false
    showToast('已保存')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败，请保留输入'
  } finally {
    saving.value = false
  }
}
/** 展示名称只查本地账本，删除自选后仍保留原成交标的。 */
function itemName(id: string): string {
  return items.value.find((i) => i.id === id)?.name || id
}
/** 交易与账户隔离，在列表明确显示所属账户。 */
function accountName(id: string): string {
  return accounts.value.find((a) => a.id === id)?.name || '选择账户'
}
/** 记录价格只用于这笔成交的核对，不代表实时估值。 */
function labelTrade(row: Trade): string {
  return `${row.side === 'buy' ? '买入' : '卖出'}${row.status === 'pending' ? ' · 待确认' : row.status === 'cancelled' ? ' · 已撤销' : ''}`
}
/** 申请展示已知金额，已确认成交展示账本重放后的净额。 */
function tradeAmount(row: Trade): string {
  const result = projection.value.trades[row.id]
  if (row.status === 'pending')
    return row.side === 'buy' ? `申请 ¥${formatMoney(row.pendingAmount)}` : `申请 ${row.qty} 份`
  return result ? `¥${formatMoney(result.net)}` : '—'
}
/** 删除需再次确认并使用打开确认时的账本版本；失败显示完整原因，不移除列表。 */
async function removeRecord(id: string): Promise<void> {
  const row = bookState.data.trades.find((t) => t.id === id)
  if (!row || saving.value) return
  const revision = bookState.data.revision
  uni.showModal({
    title: '删除这笔记录？',
    content: `${itemName(row.instrumentId)} · ${labelTrade(row)}\n${row.date} ${row.time || ''} · ${accountName(row.accountId)}\n${row.qty || '待确认'} ${items.value.find((i) => i.id === row.instrumentId)?.type === 'GOLD' ? '克' : '份'} · ${tradeAmount(row)}\n删除后将更新余额和持仓。`,
    confirmText: '删除',
    confirmColor: '#d94d58',
    success: async (result) => {
      if (!result.confirm) return
      saving.value = true
      try {
        await deleteSavedTrade(id, revision)
        if (detailId.value === id) {
          mode.value = 'records'
          detailId.value = ''
        }
        showToast('已删除')
      } catch (e) {
        uni.showModal({
          title: '未能删除',
          content: e instanceof Error ? e.message : '删除失败，原账本未改变',
          showCancel: false,
        })
      } finally {
        saving.value = false
      }
    },
  })
}
defineExpose({ open, showRecord, removeRecord })
</script>
<template>
  <BottomSheet
    :model-value="visible"
    @update:model-value="dismiss"
    :title="title"
    :tab-page="props.tabPage"
  >
    <view v-if="bookState.error" class="error"
      >{{ bookState.error }} · 已停止写入，请保留本地数据</view
    >
    <template v-if="mode === 'accounts'">
      <button class="setting-row" @click="chooseAccount('')">
        <text>全部账户</text><text class="blue">{{ !selectedAccountId ? '✓' : '›' }}</text>
      </button>
      <view v-for="account in accounts" :key="account.id" class="account-manage-row">
        <button class="setting-row account-choice" @click="chooseAccount(account.id)">
          <view
            ><text>{{ account.name }}</text
            ><view class="sub"
              >可用 {{ formatMoney(projection.availableCash[account.id]) }} 元</view
            ></view
          ><text class="blue">{{ selectedAccountId === account.id ? '✓' : '›' }}</text>
        </button>
        <button class="small-action" @click="open('edit-account', account.id)">管理</button>
      </view>
    </template>
    <template v-else-if="mode === 'funding'">
      <view class="field"
        >账户范围<AppPicker
          title="账户范围"
          :value="fundingAccount ? accounts.findIndex((a) => a.id === fundingAccount) + 1 : 0"
          :range="['全部账户', ...accounts.map((a) => a.name)]"
          @change="selectFundingAccount"
          ><view class="form-select">{{
            fundingAccount ? accountName(fundingAccount) : '全部账户'
          }}</view></AppPicker
        ></view
      >
      <view class="capital-summary metric-grid">
        <view
          v-for="metric in [
            ['现金余额', funding.cash],
            ['待确认占用', funding.pending],
            ['可用现金', funding.available],
            ['活动计划总预算', funding.budget],
            ['本轮累计已投', funding.used],
            ['计划待投入', funding.remaining],
          ]"
          :key="metric[0]"
          ><view class="metric-label">{{ metric[0] }}</view
          ><view class="metric-value num">{{ formatMoney(metric[1]) }}</view></view
        >
      </view>
      <view class="capital-free" :class="Number(funding.free) < 0 ? 'down' : 'blue'"
        >{{ Number(funding.free) < 0 ? '预算缺口' : '未分配资金' }} ¥{{
          formatMoney(Math.abs(Number(funding.free)))
        }}</view
      >
      <view
        v-if="funding.accounts.length > 1 && Number(funding.shortfall) > 0"
        class="capital-account-shortfall"
      >
        <view class="down">部分账户预算缺口合计 ¥{{ formatMoney(funding.shortfall) }}</view>
        <view
          v-for="account in funding.accounts.filter((a) => Number(a.free) < 0)"
          :key="account.accountId"
          class="sub"
          >{{ account.name }}：缺口 ¥{{ formatMoney(new D(account.free).abs()) }}</view
        >
      </view>

      <view v-if="!funding.plans.length" class="empty"
        >暂无投资计划，可以先为这个账户分配预算。</view
      >
      <button
        v-for="row in funding.plans"
        :key="row.planId"
        class="capital-plan full"
        :disabled="row.ended"
        @click="editFundingPlan(row.planId)"
      >
        <view class="row"
          ><text class="asset-name">{{ itemName(row.instrumentId) }}</text
          ><text class="blue">{{ row.ended ? '本轮已结束' : '调整预算 ›' }}</text></view
        >
        <view class="sub"
          >{{ accountName(row.accountId) }} ·
          {{ row.ended ? '不再预留' : row.paused ? '已暂停 · 保留预留' : '进行中' }}</view
        >
        <view class="metric-grid"
          ><view
            ><view class="metric-label">总预算 / 份数</view
            ><view>¥{{ formatMoney(row.budget) }} / {{ row.parts }}份</view></view
          ><view
            ><view class="metric-label">每份投入</view
            ><view>¥{{ formatMoney(row.perPart) }}</view></view
          ><view
            ><view class="metric-label">本轮已投 / 待确认</view
            ><view>{{ formatMoney(row.used) }} / {{ formatMoney(row.pending) }}</view></view
          ><view
            ><view class="metric-label">计划待投入</view
            ><view class="blue">¥{{ formatMoney(row.remaining) }}</view></view
          ></view
        >
      </button>
    </template>
    <template v-else-if="mode === 'records'">
      <AppPicker
        title="选择账户"
        :range="recordAccounts"
        range-key="name"
        :value="recordAccountIndex"
        @change="selectRecordAccount"
      >
        <view class="form-select"
          >{{ recordAccounts[recordAccountIndex].name }} · {{ records.length }} 笔</view
        >
      </AppPicker>
      <view class="chips" style="margin-top: 12px">
        <button :class="{ active: !recordsPending }" @click="recordsPending = false">
          全部记录
        </button>
        <button :class="{ active: recordsPending }" @click="recordsPending = true">待确认</button>
      </view>
      <view v-if="records.length && !recordsPending" class="card" style="background: #f5f7fb"
        ><view class="metric-label">卖出盈亏</view
        ><view class="metric-value num" :class="realizedTotal.gte(0) ? 'up' : 'down'"
          >¥{{ formatMoney(realizedTotal) }}</view
        ></view
      >
      <view v-if="!records.length" class="empty">暂无交易记录</view>
      <SwipeRecord
        v-for="row in records"
        :key="row.id"
        row-class="setting-row record-row"
        @open="showRecord(row.id)"
        @delete="removeRecord(row.id)"
      >
        <view
          ><view class="asset-name">{{ itemName(row.instrumentId) }}</view
          ><view class="sub">{{ row.date }} · {{ accountName(row.accountId) }}</view></view
        ><view style="text-align: right"
          ><view :class="row.side === 'buy' ? 'blue' : 'up'">{{ labelTrade(row) }}</view
          ><view class="sub">{{ tradeAmount(row) }}</view
          ><view v-if="projection.trades[row.id]?.realizedPnl !== undefined" class="sub"
            >已实现 {{ formatMoney(projection.trades[row.id].realizedPnl!) }} 元</view
          ></view
        >
      </SwipeRecord>
    </template>
    <template v-else-if="mode === 'detail' && detail">
      <view class="row"
        ><text class="asset-name">{{ itemName(detail.instrumentId) }}</text
        ><text class="badge">{{ labelTrade(detail) }}</text></view
      >
      <view class="sub"
        >{{ accountName(detail.accountId) }} · {{ detail.date }} {{ detail.time || '' }}</view
      >
      <view v-if="detail.applicationDate" class="sub">原申请日：{{ detail.applicationDate }}</view>
      <view class="metric-grid" style="margin-top: 20px"
        ><view
          ><view class="metric-label">数量 / 单价</view
          ><view class="metric-value"
            >{{ detail.qty || '—' }} / {{ detail.price || '—' }}</view
          ></view
        ><view
          ><view class="metric-label">手续费</view
          ><view class="metric-value">{{ formatMoney(detail.fee) }}</view></view
        ><view v-if="outcome"
          ><view class="metric-label">{{ detail.side === 'buy' ? '买入支出' : '卖出到账' }}</view
          ><view class="metric-value">{{ formatMoney(outcome.net) }}</view></view
        ><view v-if="outcome?.realizedPnl !== undefined"
          ><view class="metric-label">已实现盈利（扣费）</view
          ><view class="metric-value" :class="Number(outcome.realizedPnl) >= 0 ? 'up' : 'down'">{{
            formatMoney(outcome.realizedPnl)
          }}</view></view
        ><view v-if="outcome?.costBasis"
          ><view class="metric-label">卖出对应成本</view
          ><view class="metric-value">{{ formatMoney(outcome.costBasis) }}</view></view
        ><view v-if="outcome?.returnPct"
          ><view class="metric-label">本笔收益率</view
          ><view class="metric-value">{{ formatMoney(outcome.returnPct) }}%</view></view
        ></view
      >
      <view v-if="detail.status === 'pending'" class="tip"
        >申请金额 {{ detail.pendingAmount || '—' }} 元。</view
      >

      <template v-if="detail.corrections?.length"
        ><view class="section-title" style="font-size: 14px; margin-top: 18px">更正记录</view
        ><view
          v-for="(entry, index) in detail.corrections.slice().reverse()"
          :key="index"
          class="tip"
          >{{ formatDateTime(entry.recordedAt) }} · 原{{
            entry.previous.side === 'buy' ? '买入' : '卖出'
          }}
          {{ itemName(entry.previous.instrumentId) }} · {{ accountName(entry.previous.accountId)
          }}<view
            >{{ entry.previous.date }} {{ entry.previous.time }} · {{ entry.previous.qty }} ×
            {{ entry.previous.price }} · 手续费 {{ entry.previous.fee }}</view
          ></view
        ></template
      >
    </template>
    <template v-else-if="mode === 'allocation'">
      <view
        v-for="position in Object.values(projection.positions).filter(
          (p) => Number(p.qty) > 0 && (!selectedAccountId || p.accountId === selectedAccountId),
        )"
        :key="positionKey(position.accountId, position.instrumentId)"
        class="setting-row"
        ><view
          ><view>{{ itemName(position.instrumentId) }}</view
          ><view class="sub"
            >{{ accountName(position.accountId) }} · {{ position.qty }} 份/克</view
          ></view
        ><text>{{
          watchState.cache[position.instrumentId]
            ? formatMoney(
                new D(position.qty).mul(watchState.cache[position.instrumentId].quote.value),
              ) + ' 元'
            : '待报价'
        }}</text></view
      >
    </template>
    <template v-else>
      <view v-if="mode !== 'account' && !accounts.length" class="empty"
        >先建立一个账户，再记录投资。</view
      >
      <template v-else>
        <template v-if="['account', 'edit-account'].includes(mode)" :key="accountFormVersion"
          ><label class="field"
            >账户名称<input
              v-model="form.name"
              placeholder="例如：招商银行"
              maxlength="30" /></label
          ><label class="field">初始现金（元）<input v-model="form.cash" type="digit" /></label
          ><view class="tip">不含已有持仓。</view></template
        >
        <template v-else
          ><view class="field"
            >所属账户<AppPicker
              title="所属账户"
              :value="accounts.findIndex((a) => a.id === form.accountId)"
              :range="accounts"
              range-key="name"
              :disabled="!!confirmationId || !!editingPlanId"
              @change="selectAccount"
              ><view class="form-select">{{ accountName(form.accountId) }}</view></AppPicker
            ></view
          >
          <view v-if="mode !== 'cash'" class="field"
            >投资标的<AppPicker
              title="投资标的"
              :value="items.findIndex((i) => i.id === form.instrumentId)"
              :range="items"
              range-key="name"
              :disabled="!!confirmationId || !!editingPlanId"
              @change="selectItem"
              ><view class="form-select">{{ itemName(form.instrumentId) }}</view></AppPicker
            ></view
          ></template
        >
        <view v-if="mode !== 'plan'" class="field"
          >{{
            ['account', 'edit-account'].includes(mode)
              ? '现金基准日'
              : mode === 'import'
                ? '持仓基准日'
                : form.status === 'pending'
                  ? '申请日期'
                  : '日期'
          }}<AppPicker mode="date" :value="form.date" :end="today()" @change="setDate"
            ><view class="form-select">{{ form.date }}</view></AppPicker
          ></view
        >
        <template v-if="mode === 'cash'"
          ><view class="chips"
            ><button :class="{ active: form.side === 'buy' }" @click="form.side = 'buy'">
              转入</button
            ><button :class="{ active: form.side === 'sell' }" @click="form.side = 'sell'">
              转出
            </button></view
          ><label class="field">金额（元）<input v-model="form.cash" type="digit" /></label
        ></template>
        <template v-if="mode === 'import'"
          ><label class="field"
            >{{ instrument?.type === 'GOLD' ? '持有克重' : '持有份额'
            }}<input v-model="form.qty" type="digit" /></label
          ><label class="field"
            >持仓总成本（元，含历史费用）<input v-model="form.totalCost" type="digit" /></label
          ><view class="tip">导入持仓不扣现金。</view></template
        >
        <template v-if="mode === 'trade'">
          <view class="chips"
            ><button
              :disabled="!!confirmationId"
              :class="{ active: form.side === 'buy' }"
              @click="setSide('buy')"
            >
              买入</button
            ><button
              :disabled="!!confirmationId"
              :class="{ active: form.side === 'sell' }"
              @click="setSide('sell')"
            >
              卖出
            </button></view
          >
          <view v-if="instrument?.type === 'FUND' && !confirmationId && !correctionId" class="chips"
            ><button
              :class="{ active: form.status === 'confirmed' }"
              @click="form.status = 'confirmed'"
            >
              已成交</button
            ><button
              :class="{ active: form.status === 'pending' }"
              @click="form.status = 'pending'"
            >
              待确认
            </button></view
          >
          <view v-if="instrument?.type === 'GOLD'" class="chips"
            ><button
              v-for="unit in ['克', '元']"
              :key="unit"
              :class="{ active: form.goldMode === unit }"
              @click="form.goldMode = unit"
            >
              按{{ unit }}录入
            </button></view
          >
          <label v-if="form.status === 'pending' && form.side === 'buy'" class="field"
            >申请金额（元，不含预估费用）<input v-model="form.pendingAmount" type="digit"
          /></label>
          <template v-else-if="instrument?.type === 'GOLD'">
            <label v-if="form.goldMode === '克'" class="field"
              >克重（克）<input
                v-model="form.qty"
                type="digit"
                placeholder="输入克重"
                @input="setQty"
            /></label>
            <label v-else class="field"
              >成交金额（元，不含手续费）<input
                v-model="form.goldAmount"
                type="digit"
                placeholder="输入成交金额"
                @input="setGoldAmount"
            /></label>
            <label class="field"
              >成交价（元/克）<input v-model="form.price" type="digit" @input="setPrice"
            /></label>
            <view class="gold-conversion">
              <view class="metric-label">{{
                form.goldMode === '克' ? '换算成交金额（元，不含手续费）' : '换算克重（克）'
              }}</view>
              <view class="metric-value">{{
                (form.goldMode === '克' ? form.goldAmount : form.qty) || '—'
              }}</view>
              <view class="tip">{{ goldHint }}</view>
            </view>
          </template>
          <template v-else>
            <view class="field-pair">
              <label class="field"
                >份额<input
                  v-model="form.qty"
                  type="digit"
                  placeholder="以确认结果为准"
                  @input="setQty"
              /></label>
              <label v-if="form.status === 'confirmed'" class="field"
                >成交价 / 净值<input v-model="form.price" type="digit" @input="setPrice"
              /></label>
            </view>
          </template>
          <label class="field"
            >{{ form.status === 'pending' ? '预留手续费' : '手续费' }}（元）<input
              v-model="form.fee"
              type="digit"
          /></label>
          <view v-if="form.status === 'confirmed'" class="field"
            >成交时间（可选）<AppPicker mode="time" :value="form.time" @change="setTime"
              ><view class="form-select">{{ form.time || '未填写' }}</view></AppPicker
            ></view
          >
          <view class="field"
            >投资计划（可选）<AppPicker
              title="关联计划"
              :value="form.planId ? linkedPlans.findIndex((p) => p.id === form.planId) + 1 : 0"
              :range="['不关联', ...linkedPlans.map((p) => '本轮预算 ' + p.budget + ' 元')]"
              :disabled="!!confirmationId"
              @change="selectPlan"
              ><view class="form-select">{{
                form.planId ? '已关联投资计划' : '不关联'
              }}</view></AppPicker
            ></view
          >
        </template>
        <template v-if="mode === 'plan'"
          ><label class="field">本轮总预算（元）<input v-model="form.budget" type="digit" /></label
          ><view class="field-pair"
            ><label class="field">资金份数<input v-model="form.parts" type="number" /></label
            ><label class="field">下跌加仓（%）<input v-model="form.drop" type="digit" /></label
            ><label class="field">止盈观察（%）<input v-model="form.observe" type="digit" /></label
            ><label class="field"
              >高点回撤（%）<input v-model="form.retrace" type="digit" /></label></view
          ><view v-if="planPreview" class="capital-summary"
            ><view class="metric-label">每份投入</view
            ><view class="metric-value blue">¥{{ formatMoney(planPreview.perPart) }}</view
            ><view class="tip" :class="Number(planPreview.free) < 0 ? 'down' : ''"
              >{{ Number(planPreview.free) < 0 ? '调整后预算缺口' : '调整后未分配资金' }} ¥{{
                formatMoney(Math.abs(Number(planPreview.free)))
              }}</view
            ></view
          ><label class="field"
            >上次买入价（可选）<input
              v-model="form.lastBuy"
              type="digit"
              placeholder="填写上一笔买入的成交价" /></label
        ></template>
      </template>
    </template>

    <template #footer v-if="!['records', 'allocation'].includes(mode)">
      <view v-if="error" class="error" role="alert">{{ error }}</view>
      <button
        v-if="mode === 'edit-account' && error.includes('账户已更新')"
        class="secondary full"
        @click="reloadAccount"
      >
        载入最新账户
      </button>
      <template v-if="mode === 'accounts'">
        <button class="primary full" @click="open('account')">＋ 新建账户</button
        ><button v-if="accounts.length" class="secondary full" @click="open('cash')">
          记录现金转入 / 转出
        </button>
      </template>
      <template v-else-if="mode === 'funding'">
        <button class="primary full" @click="createFundingPlan">＋ 新建投资计划</button>
      </template>
      <template v-else-if="mode === 'detail' && detail">
        <button v-if="detail.status === 'pending'" class="primary full" @click="confirmPending">
          确认成交</button
        ><button
          v-if="detail.status === 'pending'"
          class="secondary full"
          @click="cancelApplication"
        >
          撤销申请
        </button>
        <button v-if="detail.status === 'confirmed'" class="secondary full" @click="editTrade">
          修改交易
        </button>
      </template>
      <button
        v-else-if="mode !== 'account' && !accounts.length"
        class="primary full"
        @click="open('account')"
      >
        新建账户
      </button>
      <template v-else-if="mode !== 'detail'">
        <button v-if="mode === 'plan' && editingPlanId" class="secondary full" @click="togglePause">
          {{
            bookState.data.plans.find((p) => p.id === editingPlanId)?.paused
              ? '恢复计划'
              : '暂停计划'
          }}
        </button>
        <button
          class="primary full"
          :disabled="saving || pickerSettling || !bookState.ready"
          @click="submit"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </template>
    </template>
  </BottomSheet>
</template>

<style scoped>
.entry-help {
  margin-top: 16px;
}
.entry-help .text-btn {
  min-height: 32px;
  text-align: left;
}

.account-manage-row {
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid #eef1f6;
}
.account-choice {
  flex: 1;
  min-width: 0;
  border-bottom: 0;
}
.capital-summary {
  background: #f5f7fb;
  border-radius: 14px;
  padding: 16px;
  margin: 12px 0;
}
.capital-free {
  font-size: 21px;
  font-weight: 700;
  padding: 12px 0;
}
.capital-plan {
  text-align: left;
  padding: 18px 0;
  border-bottom: 1px solid #eef1f6;
  border-radius: 0;
}
.capital-plan .metric-grid {
  margin-top: 16px;
}
</style>

<style scoped>
.order-confirmation {
  display: flex;
  align-items: center;
  margin: 4px 0 18px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #fff5eb;
  color: #986025;
  font-size: 13px;
  line-height: 1.6;
}
</style>
