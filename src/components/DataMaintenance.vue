<script setup lang="ts">
import { instrumentUnit } from '../domain/currency'
import { computed, reactive, ref } from 'vue'
import BottomSheet from './BottomSheet.vue'
import AppPicker from './AppPicker.vue'
import SwipeRecord from './SwipeRecord.vue'
import InstrumentSearchSheet from './InstrumentSearchSheet.vue'
import type { CashFlow, OpeningPosition } from '../domain/book'
import type { Instrument } from '../domain/market'
import { formatMoney } from '../domain/money'
import { openingCost } from '../domain/opening-cost'
import {
  bookState,
  saveOpeningCorrection,
  deleteSavedOpening,
  saveCashFlowCorrection,
  deleteSavedCashFlow,
} from '../state/book'
import { readFormDraft, saveFormDraft, clearFormDraft } from '../state/form-drafts'
import { useDialog } from '../composables/useDialog'
import { showToast } from '../state/feedback'

/** 数量按原始标的类别展示，股票使用股、积存金使用克。 */
function recordUnit(id: string): string {
  const item = bookState.data.instruments.find((row) => row.id === id)
  return item ? instrumentUnit(item) : '份'
}
const dialog = useDialog()
const props = defineProps<{ tabPage?: boolean }>()
const visible = ref(false),
  editing = ref(false),
  searching = ref(false),
  busy = ref(false),
  error = ref('')
const kind = ref<'openings' | 'cash'>('openings'),
  filter = ref('')
const baseline = ref<OpeningPosition | CashFlow>()
const form = reactive({
  accountId: '',
  instrument: undefined as Instrument | undefined,
  date: '',
  qty: '',
  unitCost: '',
  totalCost: '',
  basis: 'total' as 'unit' | 'total',
  source: '',
  amount: '',
  side: 'in' as 'in' | 'out',
})
const accounts = computed(() => bookState.data.accounts)
const filters = computed(() => [{ id: '', name: '全部账户' }, ...accounts.value])
const openings = computed(() =>
  bookState.data.openings
    .filter((row) => !filter.value || row.accountId === filter.value)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date)),
)
const cashFlows = computed(() =>
  bookState.data.cashFlows
    .filter((row) => !filter.value || row.accountId === filter.value)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.sequence - a.sequence),
)
const draftKey = computed(() => `maintenance/${kind.value}/${baseline.value?.id || ''}`)
/** 统一入口保留账户筛选，也支持从账户面板直接查看资金流水。 */
function open(next: 'openings' | 'cash' = 'openings', accountId = ''): void {
  kind.value = next
  filter.value = accountId
  error.value = ''
  visible.value = true
}
/** 名称取自已入账身份，移除自选后仍能维护历史。 */
function instrumentName(id: string): string {
  return bookState.data.instruments.find((row) => row.id === id)?.name || id
}
/** 列表和编辑器共用账户名称。 */
function accountName(id: string): string {
  return accounts.value.find((row) => row.id === id)?.name || '选择账户'
}
/** 打开记录时恢复独立草稿及其原始版本，避免用新版本冒充旧草稿的基准。 */
function edit(next: 'openings' | 'cash', id: string): void {
  const row =
    next === 'openings'
      ? bookState.data.openings.find((item) => item.id === id)
      : bookState.data.cashFlows.find((item) => item.id === id)
  if (!row) {
    showToast('记录已删除')
    return
  }
  kind.value = next
  baseline.value = JSON.parse(JSON.stringify(row))
  Object.assign(form, {
    accountId: row.accountId,
    date: row.date,
    instrument: undefined,
    qty: '',
    unitCost: '',
    totalCost: '',
    basis: 'total',
    source: '',
    amount: '',
    side: 'in',
  })
  if ('qty' in row) {
    form.instrument = bookState.data.instruments.find((item) => item.id === row.instrumentId)
    form.qty = row.qty
    form.totalCost = form.source = row.totalCost
    recalculate()
  } else {
    form.amount = row.amount
    form.side = row.side
  }
  const draft = readFormDraft<{ form: typeof form; baseline: OpeningPosition | CashFlow }>(
    draftKey.value,
  )
  if (draft) {
    Object.assign(form, draft.form)
    baseline.value = draft.baseline
  }
  error.value = ''
  editing.value = true
}
/** 用户主动载入最新记录时丢弃当前草稿，解决旧编辑基准冲突。 */
function reloadRecord(): void {
  if (!baseline.value || busy.value) return
  const id = baseline.value.id
  clearFormDraft(draftKey.value)
  edit(kind.value, id)
}
/** 持仓详情直接进入该标的初始记录，不要求先找管理列表。 */
function editOpening(id: string): void {
  edit('openings', id)
}
/** 蒙版或系统返回只收起表单，未保存的输入留在本机草稿。 */
function dismiss(value: boolean): void {
  if (!value && baseline.value) {
    try {
      saveFormDraft(draftKey.value, { form, baseline: baseline.value })
    } catch {
      showToast('草稿保存失败，本次输入仍保留在页面')
    }
  }
  editing.value = value
}
/** 成本价和总成本平铺联动，最后输入的字段保持为计算依据。 */
function recalculate(): void {
  try {
    const value = openingCost(form.qty, form.source, form.basis)
    if (form.basis === 'total') form.unitCost = value.unitCost
    else form.totalCost = value.totalCost
  } catch {
    if (form.basis === 'total') form.unitCost = ''
    else form.totalCost = ''
  }
}
/** 单价或总成本输入后立刻换算另一项，不要求切换模式。 */
function setCost(event: Event, basis: 'unit' | 'total'): void {
  form.basis = basis
  form.source = (event as unknown as { detail: { value: string } }).detail.value
  if (basis === 'unit') form.unitCost = form.source
  else form.totalCost = form.source
  recalculate()
}
/** 切换标的保留用户填写数值，归属更正仍由账本验证关联冲突。 */
function selectInstrument(item: Instrument): void {
  form.instrument = item
}
/** 保存只修改当前记录，错误留在编辑器，成功才清除草稿。 */
async function save(): Promise<void> {
  if (busy.value || !baseline.value) return
  busy.value = true
  error.value = ''
  try {
    if (kind.value === 'openings') {
      if (!form.instrument) throw new Error('请选择投资标的')
      await saveOpeningCorrection(
        baseline.value.id,
        {
          accountId: form.accountId,
          instrumentId: form.instrument.id,
          date: form.date,
          qty: form.qty,
          totalCost: openingCost(form.qty, form.source, form.basis).totalCost,
        },
        form.instrument,
        baseline.value as OpeningPosition,
      )
    } else
      await saveCashFlowCorrection(
        baseline.value.id,
        {
          accountId: form.accountId,
          date: form.date,
          side: form.side,
          amount: form.amount,
        },
        baseline.value as CashFlow,
      )
    clearFormDraft(draftKey.value)
    editing.value = false
    showToast('已保存')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败'
  } finally {
    busy.value = false
  }
}
/** 删除绑定用户确认时的账本版本；仅一次确认，失败不隐藏记录。 */
async function remove(next: 'openings' | 'cash', id: string): Promise<void> {
  if (busy.value) return
  const revision = bookState.data.revision
  const row =
    next === 'openings'
      ? bookState.data.openings.find((item) => item.id === id)
      : bookState.data.cashFlows.find((item) => item.id === id)
  if (!row) return
  busy.value = true
  try {
    const confirmed = await dialog.confirm({
      title: next === 'openings' ? '删除初始持仓？' : '删除资金流水？',
      detail: `${row.date} · ${accountName(row.accountId)}\n${'qty' in row ? `${instrumentName(row.instrumentId)} · ${row.qty} · 成本 ¥${formatMoney(row.totalCost)}` : `${row.side === 'in' ? '转入' : '转出'} ¥${formatMoney(row.amount)}`}`,
      confirmText: '删除',
      destructive: true,
    })
    if (!confirmed) return
    if (next === 'openings') await deleteSavedOpening(id, revision)
    else await deleteSavedCashFlow(id, revision)
    clearFormDraft(`maintenance/${next}/${id}`)
    if (editing.value && baseline.value?.id === id) editing.value = false
    error.value = ''
    showToast('已删除')
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '删除失败'
    if (editing.value) error.value = message
    else showToast(message)
  } finally {
    busy.value = false
  }
}
/** 编辑页的删除按钮复用相同单次确认路径。 */
function removeCurrent(): void {
  if (baseline.value) void remove(kind.value, baseline.value.id)
}
defineExpose({ open, editOpening })
</script>
<template>
  <BottomSheet v-model="visible" title="数据管理" :tab-page="props.tabPage">
    <view class="maintenance-tabs">
      <button :class="kind === 'openings' ? 'selected' : ''" @click="kind = 'openings'">
        初始持仓
      </button>
      <button :class="kind === 'cash' ? 'selected' : ''" @click="kind = 'cash'">资金流水</button>
    </view>
    <AppPicker
      title="筛选账户"
      :range="filters"
      range-key="name"
      :value="filters.findIndex((row) => row.id === filter)"
      @change="filter = filters[Number($event.detail.value)].id"
    >
      <view class="maintenance-filter"
        >{{ accountName(filter) === '选择账户' ? '全部账户' : accountName(filter)
        }}<text>›</text></view
      >
    </AppPicker>
    <template v-if="kind === 'openings'">
      <view v-if="!openings.length" class="empty">暂无初始持仓</view>
      <SwipeRecord
        v-for="row in openings"
        :key="row.id"
        @open="edit('openings', row.id)"
        @delete="remove('openings', row.id)"
      >
        <view class="maintenance-row"
          ><view class="row"
            ><text class="maintenance-name">{{ instrumentName(row.instrumentId) }}</text
            ><text>{{ row.qty }} {{ recordUnit(row.instrumentId) }}</text></view
          ><view class="row sub"
            ><text>{{ accountName(row.accountId) }} · {{ row.date }}</text
            ><text>成本 ¥{{ formatMoney(row.totalCost) }}</text></view
          ></view
        >
      </SwipeRecord>
    </template>
    <template v-else>
      <view v-if="!cashFlows.length" class="empty">暂无资金流水</view>
      <SwipeRecord
        v-for="row in cashFlows"
        :key="row.id"
        @open="edit('cash', row.id)"
        @delete="remove('cash', row.id)"
      >
        <view class="maintenance-row"
          ><view class="row"
            ><text class="maintenance-name">{{ row.side === 'in' ? '现金转入' : '现金转出' }}</text
            ><text :class="row.side === 'in' ? 'blue' : ''"
              >{{ row.side === 'in' ? '+' : '−' }}{{ formatMoney(row.amount) }}</text
            ></view
          ><view class="sub">{{ accountName(row.accountId) }} · {{ row.date }}</view></view
        >
      </SwipeRecord>
    </template>
  </BottomSheet>
  <BottomSheet
    :model-value="editing"
    :title="kind === 'openings' ? '修改初始持仓' : '修改资金流水'"
    :tab-page="props.tabPage && !visible"
    @update:model-value="dismiss"
  >
    <view class="maintenance-form">
      <view class="field"
        ><text class="label">所属账户</text
        ><AppPicker
          title="选择账户"
          :range="accounts"
          range-key="name"
          :value="accounts.findIndex((row) => row.id === form.accountId)"
          @change="form.accountId = accounts[Number($event.detail.value)].id"
          ><view class="form-select">{{ accountName(form.accountId) }}</view></AppPicker
        ></view
      >
      <view v-if="kind === 'openings'" class="field"
        ><text class="label">投资标的</text
        ><button class="form-select full maintenance-instrument" @click="searching = true">
          {{ form.instrument?.name || '搜索投资标的' }}
        </button></view
      >
      <view class="field"
        ><text class="label">{{ kind === 'openings' ? '持仓基准日期' : '日期' }}</text
        ><AppPicker mode="date" :value="form.date" @change="form.date = $event.detail.value"
          ><view class="form-select">{{ form.date }}</view></AppPicker
        ></view
      >
      <template v-if="kind === 'openings'">
        <view class="field"
          ><text class="label">{{
            form.instrument?.type === 'GOLD'
              ? '持仓克重（克）'
              : form.instrument?.type === 'STOCK'
                ? '持仓数量（股）'
                : '持仓数量（份）'
          }}</text
          ><input v-model="form.qty" class="input" type="digit" @input="recalculate"
        /></view>
        <view class="maintenance-costs"
          ><view class="field"
            ><text class="label">{{
              form.instrument?.type === 'GOLD'
                ? '成本价（元/克）'
                : form.instrument?.type === 'STOCK'
                  ? '成本价（人民币元/股）'
                  : '成本价（元/份）'
            }}</text
            ><input
              :value="form.unitCost"
              class="input"
              type="digit"
              @input="setCost($event, 'unit')" /></view
          ><view class="field"
            ><text class="label">持仓总成本（元）</text
            ><input
              :value="form.totalCost"
              class="input"
              type="digit"
              @input="setCost($event, 'total')" /></view
        ></view>
      </template>
      <template v-else
        ><view class="maintenance-tabs"
          ><button :class="form.side === 'in' ? 'selected' : ''" @click="form.side = 'in'">
            转入</button
          ><button :class="form.side === 'out' ? 'selected' : ''" @click="form.side = 'out'">
            转出
          </button></view
        ><view class="field"
          ><text class="label">金额（元）</text
          ><input v-model="form.amount" class="input" type="digit" /></view
      ></template>
      <view v-if="error" class="error">{{ error }}</view>
      <button v-if="error.includes('已修改')" class="secondary full" @click="reloadRecord">
        载入最新记录
      </button>
    </view>
    <template #footer
      ><view class="maintenance-actions"
        ><button class="secondary" :disabled="busy" @click="removeCurrent">删除记录</button
        ><button class="primary" :disabled="busy" @click="save">
          {{ busy ? '处理中…' : '保存修改' }}
        </button></view
      ></template
    >
  </BottomSheet>
  <InstrumentSearchSheet
    v-model="searching"
    :items="bookState.data.instruments"
    :selected-id="form.instrument?.id || ''"
    @select="selectInstrument"
  />
</template>
<style scoped>
.maintenance-tabs {
  display: flex;
  gap: 8px;
  padding: 4px;
  background: #f3f5fb;
  border-radius: 12px;
  margin-bottom: 18px;
}
.maintenance-tabs button {
  flex: 1;
  padding: 10px;
  font-size: 14px;
  color: #71809b;
  background: transparent;
  border-radius: 9px;
  line-height: 1.5;
}
.maintenance-tabs .selected {
  color: #3457d7;
  background: #fff;
  box-shadow: 0 2px 8px #1e35500a;
  font-weight: 600;
}
.maintenance-filter {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 2px 16px;
  color: #71809b;
  font-size: 13px;
}
.maintenance-row {
  text-align: left;
  padding: 18px 0;
  border-bottom: 1px solid #edf0f5;
  font-size: 14px;
}
.maintenance-name {
  font-weight: 600;
}
.maintenance-costs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.maintenance-instrument {
  text-align: left;
  font-size: 14px;
  line-height: 1.6;
}
.maintenance-actions {
  display: grid;
  grid-template-columns: 1fr 1.6fr;
  gap: 12px;
}
.maintenance-form .field {
  margin-bottom: 18px;
}
</style>
