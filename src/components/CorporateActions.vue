<script setup lang="ts">
import { instrumentUnit, isForeign } from '../domain/currency'
import AppPicker from './AppPicker.vue'
import { computed, reactive, ref, onBeforeUnmount } from 'vue'
import type { CorporateAction } from '../domain/book'
import { bookState, newId, saveCorporateAction } from '../state/book'
import { formatMoney, today } from '../domain/money'
import { showToast } from '../state/feedback'
import BottomSheet from './BottomSheet.vue'
import { saveFormDraft, readFormDraft, clearFormDraft } from '../state/form-drafts'
import { usePickerGuard } from '../composables/usePickerGuard'
const { pickerSettling, settlePicker } = usePickerGuard()
const props = defineProps<{ accountId: string; instrumentId: string }>()
const instrument = computed(() =>
  bookState.data.instruments.find((item) => item.id === props.instrumentId),
)
const unit = computed(() => (instrument.value ? instrumentUnit(instrument.value) : '份'))
const foreign = computed(() => !!instrument.value && isForeign(instrument.value))
const visible = ref(false),
  editing = ref(false),
  saving = ref(false),
  error = ref('')
const form = reactive<CorporateAction>({
  id: '',
  accountId: '',
  instrumentId: '',
  date: today(),
  type: 'dividend',
  status: 'pending',
  referenceQty: '',
  cashPerShare: '',
  cashAmount: '',
  ratio: '',
  addedQty: '',
  source: '',
  orderConfirmed: false,
})
/** 权益草稿按账户和标的隔离，保留未提交的输入。 */
interface ActionDraft {
  form: CorporateAction
  editing: boolean
}
const draftKey = computed(() => 'equity:' + props.accountId + ':' + props.instrumentId)
/** 蒙版与关闭按钮先保存输入，失败时留在原浮层。 */
function dismiss(value: boolean): void {
  if (value || saving.value) return
  try {
    if (editing.value) saveFormDraft(draftKey.value, { form, editing: true })
    visible.value = false
  } catch {
    showToast('草稿保存失败，请保留当前输入')
  }
}
onBeforeUnmount(() => {
  if (editing.value) {
    try {
      saveFormDraft(draftKey.value, { form, editing: true })
    } catch {
      showToast('权益草稿保存失败')
    }
  }
})
const events = computed(() =>
  (bookState.data.corporateActions || [])
    .filter((a) => a.accountId === props.accountId && a.instrumentId === props.instrumentId)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date)),
)
/** 生效日与账户归属固定；确认待核对事件时沿用原ID，避免重复计入权益。 */
function edit(event?: CorporateAction): void {
  error.value = ''
  Object.assign(
    form,
    event || {
      id: newId('action'),
      accountId: props.accountId,
      instrumentId: props.instrumentId,
      date: today(),
      type: 'dividend',
      status: 'pending',
      referenceQty: '',
      cashPerShare: '',
      cashAmount: '',
      ratio: '',
      addedQty: '',
      source: '',
      orderConfirmed: false,
    },
  )
  form.cashDate = event?.cashDate || form.date
  editing.value = true
}
/** 等待日期选择面板退场后再允许提交，避免卸载仍在动画中的组件。 */
function setDate(event: { detail: { value: string } }): void {
  if (form.cashDate === form.date) form.cashDate = event.detail.value
  form.date = event.detail.value
  settlePicker()
}
/** 公告发放日只是预填，确认时必须核对银行实际到账/再投份额确认日。 */
function setCashDate(event: { detail: { value: string } }): void {
  form.cashDate = event.detail.value
  settlePicker()
}
/** 入账按钮提交已发生权益；待核对只登记事件并暂停策略，计算仍由领域层校验。 */
async function save(asConfirmed: boolean): Promise<void> {
  if (saving.value || pickerSettling.value) return
  saving.value = true
  error.value = ''
  try {
    await saveCorporateAction({
      ...form,
      status: asConfirmed ? 'confirmed' : 'pending',
      orderConfirmed: asConfirmed,
    })
    clearFormDraft(draftKey.value)
    editing.value = false
    showToast(asConfirmed ? '已入账' : '已保存待核对，策略已暂停')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '权益事件保存失败'
  } finally {
    saving.value = false
  }
}
/** 明确区分三种权益，不能把红利再投作为额外现金投入。 */
function label(type: CorporateAction['type']): string {
  return { dividend: '现金分红', reinvest: '红利再投', split: '份额拆分' }[type]
}
/** 打开时恢复同账户和标的的未提交输入。 */
function open(): void {
  if (saving.value) return
  editing.value = false
  try {
    const draft = readFormDraft<ActionDraft>(draftKey.value)
    if (draft) {
      Object.assign(form, draft.form)
      editing.value = draft.editing
    }
  } catch {
    showToast('权益草稿读取失败')
  }
  form.orderConfirmed = false
  error.value = ''
  visible.value = true
}
</script>
<template>
  <button class="setting-row full" @click="open">
    <text>分红与拆分</text><text class="small muted">{{ events.length }} 条 ›</text>
  </button>
  <BottomSheet :model-value="visible" @update:model-value="dismiss" title="分红与拆分">
    <template v-if="!editing">
      <view v-if="!events.length" class="empty">暂无权益事件</view>
      <view
        v-for="event in events"
        :key="event.id"
        class="card"
        style="padding: 16px; background: #f5f7fb"
      >
        <view class="row"
          ><text class="asset-name">{{ label(event.type) }}</text
          ><text class="badge">{{
            event.status === 'confirmed' ? '已入账' : '待核对 · 策略暂停'
          }}</text></view
        >
        <view class="sub">{{ event.date }} · {{ event.source }}</view>
        <view v-if="event.cashDate && event.type !== 'split'" class="sub"
          >到账 / 再投确认日期 {{ event.cashDate }}</view
        >
        <view v-if="event.status === 'confirmed'" class="tip"
          >权益数量 {{ event.referenceQty }} {{ unit }} ·
          {{
            event.type === 'split'
              ? '拆分倍数 ' + event.ratio
              : event.type === 'reinvest'
                ? '再投 ' + event.addedQty + ' ' + unit + ' / ¥' + formatMoney(event.cashAmount)
                : '实际到账 ¥' + formatMoney(event.cashAmount)
          }}</view
        >
        <button v-else class="secondary full" @click="edit(event)">填写入账信息</button>
      </view>
    </template>
    <template v-else>
      <view class="chips"
        ><button
          v-for="kind in ['dividend', 'reinvest', 'split'] as const"
          :key="kind"
          :class="{ active: form.type === kind }"
          @click="form.type = kind"
        >
          {{ label(kind) }}
        </button></view
      >
      <view class="field"
        >生效日期<AppPicker
          mode="date"
          :value="form.date"
          :end="today()"
          :disabled="events.some((a) => a.id === form.id)"
          @change="setDate"
          ><view class="form-select">{{ form.date }}</view></AppPicker
        ></view
      >
      <label class="field"
        >来源<input v-model="form.source" placeholder="例如：基金公告" maxlength="200"
      /></label>
      <label class="field"
        >生效前数量（{{ unit }}）<input
          v-model="form.referenceQty"
          type="digit"
          placeholder="生效前实际持有数量"
      /></label>
      <template v-if="form.type === 'split'"
        ><label class="field"
          >拆分后数量倍数<input
            v-model="form.ratio"
            type="digit"
            placeholder="例如：1变2，填2" /></label
      ></template>
      <template v-else>
        <view class="field"
          >到账日期<AppPicker
            mode="date"
            :value="form.cashDate || form.date"
            :start="form.date"
            :end="today()"
            @change="setCashDate"
            ><view class="form-select">{{ form.cashDate || form.date }}</view></AppPicker
          ></view
        >
        <label class="field"
          >每{{ unit }}分红（{{ foreign ? '折合人民币元' : '元' }}）<input
            v-model="form.cashPerShare"
            type="digit"
        /></label>
        <label class="field"
          >{{ form.type === 'reinvest' ? '再投确认金额' : '分红实际到账' }}（元）<input
            v-model="form.cashAmount"
            type="digit"
        /></label>
        <label v-if="form.type === 'reinvest'" class="field"
          >再投增加数量（{{ unit }}）<input v-model="form.addedQty" type="digit" /></label
      ></template>
    </template>
    <template #footer>
      <button v-if="!editing" class="primary full" @click="edit()">登记权益事件</button>
      <template v-else>
        <view v-if="error" class="error" role="alert">{{ error }}</view>
        <button class="primary full" :disabled="saving || pickerSettling" @click="save(true)">
          {{ saving ? '保存中…' : '确认入账' }}
        </button>
        <button class="secondary full" :disabled="saving || pickerSettling" @click="save(false)">
          保存待核对
        </button>
        <button class="secondary full" @click="editing = false">返回事件列表</button>
      </template>
    </template>
  </BottomSheet>
</template>
